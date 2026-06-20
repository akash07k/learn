# Proxmox VE Best Practices, Hardening, Performance & Operational Hygiene

Single-node PVE home server, shell-only operator (web GUI inaccessible / screen reader). Target: PVE
8.x (Debian 12 "bookworm"). PVE 9.x (Debian 13 "trixie") noted where it diverges. All steps are
shell-actionable. No GUI steps. Risky steps (SSH / firewall lockout) are flagged.

Scope note: this is a SINGLE node - no cluster, no HA, no Ceph, no RAID. Cluster/Ceph hardening that
appears in some community guides is OUT OF SCOPE and intentionally omitted.

---

## 0. Critical safety rules for a remote shell-only operator

Read these first. They prevent the two ways you can lock yourself out of a headless box.

1. **Never enable the firewall or change SSH without a second open session.** Keep one SSH session
   live as a "safety rope" while you test a new session in a second terminal. If the new session
   works, you are safe; if not, the live session lets you undo.
2. **The cluster firewall has an implicit allow for the management host until you commit.** Still,
   always add the SSH (22) and API (8006) ACCEPT rules BEFORE setting `enable: 1`.
3. **Do not set `PermitRootLogin no` unless a non-root sudo user with a working key already logs
   in.** On PVE, `root@pam` is the primary admin identity; locking root SSH without a tested
   fallback is the #1 self-lockout.
4. **Test key auth BEFORE disabling password auth.** Open a fresh session with the key first.
5. **Use a `Match Address` allow-list rather than a global `PermitRootLogin no`** if you still want
   emergency root-over-SSH from your LAN.

---

## 1. The community post-install routine - actual underlying commands

The popular "Proxmox VE Post Install" script (tteck, now community-scripts.github.io) automates a
handful of steps. Below are the real commands it runs so you do not have to pipe a remote script
into bash. Sources: community-scripts.github.io, proxmoxpulse.com, syncbricks.com.

### 1.1 Disable the enterprise repo, enable no-subscription

PVE 8.x (legacy one-line `.list` format):

```bash
# Disable PVE enterprise repo
sed -i 's/^deb/#deb/' /etc/apt/sources.list.d/pve-enterprise.list
# Disable Ceph enterprise repo if present
sed -i 's/^deb/#deb/' /etc/apt/sources.list.d/ceph.list 2>/dev/null

# Enable PVE no-subscription repo
cat > /etc/apt/sources.list.d/pve-no-subscription.list <<'EOF'
deb http://download.proxmox.com/debian/pve bookworm pve-no-subscription
EOF
```

PVE 9.x moved apt to the **deb822 `.sources`** format. Default install ships `ceph.sources`,
`debian.sources`, and `pve-enterprise.sources` under `/etc/apt/sources.list.d/`. To switch to
no-subscription on 9.x:

```bash
# Neutralise the enterprise source (set Enabled: false rather than deleting)
# Easiest: just create the no-subscription source and disable enterprise.
cat > /etc/apt/sources.list.d/pve-no-subscription.sources <<'EOF'
Types: deb
URIs: http://download.proxmox.com/debian/pve
Suites: trixie
Components: pve-no-subscription
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
EOF

# Disable enterprise by appending an Enabled stanza
printf '\nEnabled: false\n' >> /etc/apt/sources.list.d/pve-enterprise.sources
```

Then update:

```bash
apt update && apt full-upgrade -y
```

Note: the no-subscription repo is "not recommended for production" by Proxmox but is the standard,
supported choice for home labs (Proxmox forum consensus). The **test** repo (`pvetest`) should NOT
be used on anything you care about.

### 1.2 Remove the "no valid subscription" nag

This patches the JS served by the web UI. It is cosmetic and irrelevant to a screen-reader user who
never opens the GUI - but it is harmless and gets re-applied by the script community, so documented
here. It must be re-run after each `proxmox-widget-toolkit` upgrade.

```bash
sed -Ezi.bak "s/(function\(orig_cmd\) \{)/\1\n\torig_cmd\(\);\n\treturn;/g" \
 /usr/share/javascript/proxmox-widget-toolkit/proxmoxlib.js
systemctl restart pveproxy.service
```

A simpler, widely-used variant (works on 8.3+):

```bash
sed -Ei.bak "s/NotFound/Active/g; s/notfound/active/g" \
 /usr/share/javascript/proxmox-widget-toolkit/proxmoxlib.js
systemctl restart pveproxy.service
```

Because GUI nag removal is GUI-only value, treat this as OPTIONAL for this operator.

### 1.3 Other things the post-install script offers (do manually)

- Update to latest packages (1.1 above).
- Add the **pve-no-subscription** repo for both PVE and Ceph (if Ceph installed - not for single
  node).
- Disable the High Availability services if you are a single node and never want HA:

```bash
systemctl disable --now pve-ha-lrm pve-ha-crm corosync 2>/dev/null
```

Only do this if you are sure you will never cluster. It frees a little RAM and removes noise.

---

## 2. Time synchronization (chrony)

PVE relies on accurate time (certs, logs, backups, 2FA TOTP). PVE ships `chrony` by default on
recent installs; `systemd-timesyncd` is the lighter alternative. Use one, not both.

```bash
apt install -y chrony
systemctl enable --now chrony
chronyc tracking # verify offset is small and "Leap status : Normal"
chronyc sources -v
```

Optional explicit servers in `/etc/chrony/chrony.conf`:

```text
server time.cloudflare.com iburst
server time.google.com iburst
pool 2.debian.pool.ntp.org iburst
driftfile /var/lib/chrony/chrony.drift
makestep 1.0 3
rtcsync
```

```bash
systemctl restart chrony
```

---

## 3. SSH hardening (key-only, root-safe, fail2ban)

### 3.1 Set up your key first (do not skip)

From your workstation:

```bash
ssh-copy-id root@<pve-host> # or manually append your pubkey to /root/.ssh/authorized_keys
```

Verify a fresh key-based login works in a SECOND terminal before changing anything.

### 3.2 sshd config - use a drop-in, never edit stock file blindly

Debian 12/13 recommend drop-ins in `/etc/ssh/sshd_config.d/`. Create
`/etc/ssh/sshd_config.d/10-hardening.conf`:

```text
# Key-only; root may still log in but ONLY with a key (safe default for PVE)
PermitRootLogin prohibit-password
PasswordAuthentication no
PubkeyAuthentication yes
ChallengeResponseAuthentication no
KbdInteractiveAuthentication no
X11Forwarding no
MaxAuthTries 3
LoginGraceTime 30
ClientAliveInterval 300
ClientAliveCountMax 2
```

`prohibit-password` is the recommended PVE value: root cannot use a password, only a key/cert. This
keeps `root@pam` usable over SSH (needed for many PVE/`pvesh`/cluster operations) without exposing a
password.

If you prefer to forbid root SSH entirely but keep a LAN escape hatch, use a Match block instead of
a blanket `no`:

```text
PermitRootLogin no
Match Address 192.168.1.0/24
 PermitRootLogin prohibit-password
Match all
```

Apply and verify (RISK: lockout - keep your safety-rope session open):

```bash
sshd -t # syntax check FIRST; non-zero exit = do not restart
systemctl reload ssh # 'ssh' on Debian 12/13 ('sshd' on some distros)
```

Test a brand-new session before closing the old one.

### 3.3 fail2ban

Official PVE wiki documents fail2ban for both SSH and the PVE API. Install:

```bash
apt install -y fail2ban
```

Create `/etc/fail2ban/jail.local` (never edit `jail.conf` - it is overwritten on upgrade):

```ini
[DEFAULT]
bantime = 1h
findtime = 2h
maxretry = 3
backend = systemd

[sshd]
enabled = true
port = ssh

[proxmox]
enabled = true
port = https,http,8006
filter = proxmox
backend = systemd
maxretry = 3
bantime = 1h
findtime = 2h
```

Create the PVE API filter `/etc/fail2ban/filter.d/proxmox.conf`:

```ini
[Definition]
failregex = pvedaemon\[.*authentication failure; rhost=<HOST> user=.* msg=.*
ignoreregex =
```

Enable and verify:

```bash
systemctl enable --now fail2ban
systemctl restart fail2ban
fail2ban-client status
fail2ban-client status sshd
fail2ban-client status proxmox
```

Built-in alternative: PVE has its own brute-force protection on the API; fail2ban adds IP-level
banning on top. Both are fine; fail2ban is the community default.

---

## 4. Accounts: keep root@pam safe, add a dedicated admin user + token

PVE authentication realms: `pam` (Linux users incl. `root@pam`) and `pve` (internal users).
`root@pam` is special and always exists; protect it, don't routinely use it for automation.

### 4.1 Create a dedicated admin user (pve realm - no Linux shell account needed)

```bash
pveum user add admin@pve --comment "Akash - PVE admin"
pveum passwd admin@pve
pveum acl modify / -user admin@pve -role Administrator
```

Or a PAM-backed sudo user (gives a real shell + PVE access):

```bash
adduser akash
usermod -aG sudo akash
pveum acl modify / -user akash@pam -role Administrator
# add your SSH key to /home/akash/.ssh/authorized_keys
```

### 4.2 Enable TOTP 2FA on the admin user (CLI)

```bash
# Generate a TOTP factor; this prints an otpauth:// URI you feed to your authenticator app
pveum user tfa add totp admin@pve --description "phone"
```

TOTP relies on correct time (see chrony, section 2).

### 4.3 API tokens for automation (do not script with root password)

```bash
# Create a privilege-separated token for scripts (pvesh, backups, monitoring)
pveum user token add admin@pve automation --privsep 1
# Grant the token its own ACL
pveum acl modify / -token 'admin@pve!automation' -role PVEVMAdmin
```

The command prints the secret ONCE. Store it in a `chmod 600` file. Use it with `pvesh` / API as
`Authorization: PVEAPIToken=admin@pve!automation=<secret>`.

Principle: root@pam for break-glass only; daily admin via `admin@pve` + 2FA; automation via tokens.

---

## 5. Firewall baseline (pve-firewall) - enable safely

PVE firewall has three scopes: datacenter (`/etc/pve/firewall/cluster.fw`), node
(`/etc/pve/nodes/<node>/host.fw`), and per-VM (`/etc/pve/firewall/<vmid>.fw`). On a single node the
datacenter + host levels are what matter. Official wiki strongly warns: **open an SSH session and
add allow rules before enabling.**

Minimum inbound ports to allow on the host:

- TCP 22 - SSH
- TCP 8006 - web UI / API (you still need the API even shell-only; `pvesh` uses it locally, but
  remote API clients and `qm`/`pct` remote management need 8006)
- TCP 3128 - SPICE proxy (only if you use SPICE; usually skip)
- TCP 5900-5999 - VNC for noVNC consoles (skip for a screen-reader user using serial instead)
- TCP 85 - pvedaemon (local only; do not expose)
- Plus whatever ports your guests serve (e.g. 80/443 for a web VM)

### 5.1 Datacenter rules first - `/etc/pve/firewall/cluster.fw`

```text
[OPTIONS]
enable: 0 # leave 0 until rules below are in place, then flip to 1

[RULES]
IN ACCEPT -p tcp -dport 22 -log nolog # SSH
IN ACCEPT -p tcp -dport 8006 -log nolog # PVE web/API
```

You can restrict source to your LAN for tighter control:

```text
IN ACCEPT -source 192.168.1.0/24 -p tcp -dport 22
IN ACCEPT -source 192.168.1.0/24 -p tcp -dport 8006
```

### 5.2 Enable via CLI (pvesh), with rules already present

```bash
# Add rules via API (equivalent to the file edits above)
pvesh create /cluster/firewall/rules -enable 1 -action ACCEPT -type in -proto tcp -dport 22
pvesh create /cluster/firewall/rules -enable 1 -action ACCEPT -type in -proto tcp -dport 8006

# Enable host firewall on the node
pvesh set /nodes/$(hostname)/firewall/options -enable 1

# ONLY NOW enable the datacenter firewall
pvesh set /cluster/firewall/options -enable 1
```

The default PVE rulesets already permit established/related traffic, cluster comms, and ICMP, so you
mostly add inbound service ports. The firewall is "default deny inbound" once enabled.

RISK: This is the second classic lockout. Keep the safety-rope SSH session open and confirm a new
SSH + a `pvesh get /version` still work before trusting it.

### 5.3 Per-VM firewall

Per-VM firewall is off by default and only takes effect when both the datacenter firewall AND the
VM's firewall option are enabled, and the NIC has `firewall=1`:

```bash
pvesh set /nodes/$(hostname)/qemu/<vmid>/firewall/options -enable 1
qm set <vmid> -net0 virtio,bridge=vmbr0,firewall=1
```

---

## 6. Automatic security updates (unattended-upgrades) - with PVE caveats

Consensus (allthingsopen.org, learnlinux.tv, virtualizationhowto): **enable unattended-upgrades for
Debian SECURITY updates, but do NOT auto-upgrade PVE packages** (kernel/qemu/pve-manager upgrades
can need a reboot and occasional manual intervention). Apply PVE upgrades by hand.

```bash
apt install -y unattended-upgrades apt-listchanges
```

`/etc/apt/apt.conf.d/20auto-upgrades`:

```text
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
```

In `/etc/apt/apt.conf.d/50unattended-upgrades`, keep ONLY the Debian security origin enabled and
blacklist PVE packages so they are never auto-installed:

```text
Unattended-Upgrade::Origins-Pattern {
 "origin=Debian,codename=${distro_codename},label=Debian-Security";
};
Unattended-Upgrade::Package-Blacklist {
 "pve-";
 "proxmox-";
};
Unattended-Upgrade::Mail "root";
Unattended-Upgrade::Automatic-Reboot "false";
```

```bash
systemctl enable --now unattended-upgrades
unattended-upgrade --dry-run --debug # verify what would be installed
```

`Mail "root"` routes results into PVE's notification system (section 9). Keep auto-reboot off so a
headless box never reboots unexpectedly; do kernel reboots on your schedule.

---

## 7. Memory & performance tuning (PC with limited RAM)

### 7.1 ZFS ARC limit (only relevant if root/storage is ZFS)

Since PVE 8.1, fresh ZFS installs cap ARC at 10% of RAM (max 16 GiB). Older installs let ARC grow to
50% of RAM - the classic "Proxmox ate all my memory" surprise. Rule of thumb: **2 GiB base + 1 GiB
per TiB of pool**. Set an explicit cap in bytes via a modprobe drop-in.

`/etc/modprobe.d/zfs.conf` (example: 4 GiB max, 1 GiB min):

```text
options zfs zfs_arc_max=4294967296
options zfs zfs_arc_min=1073741824
```

```bash
update-initramfs -u -k all
# Apply live without reboot (also persists via the file above on next boot):
echo 4294967296 > /sys/module/zfs/parameters/zfs_arc_max
```

Verify: `zarcsummary` on current PVE/ZFS, `arc_summary` on older ZFS, or
`cat /proc/spl/kstat/zfs/arcstats | grep -E '^c '`. Do not set ARC too low (e.g. <1 GiB) or read
performance collapses.

### 7.2 Swappiness

Default Linux swappiness is 60; PVE docs recommend **10** for servers. Lower keeps more in RAM.

```bash
echo 'vm.swappiness = 10' > /etc/sysctl.d/99-swappiness.conf
sysctl --system
```

ZFS caveat: do NOT put swap on a zvol / ZFS dataset - copy-on-write + ARC can deadlock under memory
pressure (e.g. during backups). If root is ZFS, either have no swap or use a swap file on a non-ZFS
partition / a small dedicated partition. On a memory-starved home box with fast SSD swap, some
operators raise swappiness instead - but the safe, documented default is 10.

### 7.3 CPU governor

Default is often `powersave`. For responsiveness set `performance` (costs more idle power; fine for
a home server, optional if you care about electricity).

```bash
apt install -y cpufrequtils
echo 'GOVERNOR="performance"' > /etc/default/cpufrequtils
systemctl restart cpufrequtils
# Verify
cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor | sort -u
```

### 7.4 KSM (Kernel Samepage Merging)

KSM dedupes identical memory pages across VMs - useful when overcommitting RAM with many similar
guests, but it has a (low) cross-VM information-leak concern and uses CPU. On a small home box with
few VMs the default (`ksmtuned` kicks in above ~80% memory use) is fine. Disable only if you have
specific reasons:

```bash
systemctl disable --now ksmtuned
echo 2 > /sys/kernel/mm/ksm/run
```

---

## 8. VM vs LXC, and sensible VM defaults

### 8.1 Choosing VM vs LXC

- **LXC container**: shares the host kernel; ~30 MB RAM / sub-second boot for a small service. Best
  for standard Linux apps with no kernel needs - web servers, databases, DNS, home automation,
  media. Far higher density (50-100 LXC vs 15-25 VMs on 32 GB).
- **KVM VM**: full kernel isolation, own OS. Use when you need a non-Linux OS (Windows), a
  different/custom kernel, kernel modules, nested virtualization, strong isolation for untrusted
  workloads, GPU/PCIe passthrough, or anything that must survive a host-kernel quirk.
- For a screen-reader operator: **both** are fully shell-manageable - LXC via `pct` (and
  `pct enter <id>` / `pct console <id>`), VMs via `qm` (and `qm terminal <id>` over serial).

Caveat: privileged LXC and bind-mounts weaken isolation; prefer **unprivileged** LXC by default.

### 8.2 Recommended VM defaults (modern Linux guest)

- **Machine type**: `i440fx` (SeaBIOS) is the default and is fine for most Linux guests. Use
  **`q35`** when you need PCIe passthrough or modern PCIe topology. Windows 11 and PCIe passthrough
  need **OVMF (UEFI)** instead of SeaBIOS; OVMF requires an EFI disk.
- **SCSI controller**: `virtio-scsi-single` - required to use IO threads (one I/O thread per disk
  means better throughput / lower latency). This is the modern recommended default.
- **Disk**: SCSI bus + `virtio-scsi-single`, `cache=none` (or `writeback` on battery-backed),
  `discard=on`, `ssd=1` for SSD-backed storage, `iothread=1`.
- **NIC**: `virtio` (paravirtualized, fastest).
- **CPU type**: `host` for best performance on a single node (no live migration to worry about).
- **Ballooning**: enable for memory flexibility on a RAM-limited box; set a sensible minimum.

Example creating a well-defaulted VM from the shell:

```bash
qm create 100 \
 --name web01 --ostype l26 \
 --machine q35 --bios ovmf --efidisk0 local-lvm:1,efitype=4m \
 --cpu host --cores 2 --sockets 1 \
 --memory 4096 --balloon 1024 \
 --scsihw virtio-scsi-single \
 --scsi0 local-lvm:32,iothread=1,discard=on,ssd=1 \
 --net0 virtio,bridge=vmbr0 \
 --agent enabled=1 \
 --serial0 socket --vga serial0 # serial console for accessibility (see section 11)
```

(For a plain Linux guest you can drop ovmf/efidisk and use the SeaBIOS default.)

### 8.3 qemu-guest-agent everywhere

Enable the agent on every VM. It lets PVE do clean shutdowns, filesystem-consistent backups
(fs-freeze), and report the guest IP. Two halves:

```bash
# Host side: tell PVE the agent is present
qm set <vmid> --agent enabled=1,fstrim_cloned_disks=1
```

```bash
# Guest side (inside the VM): install + enable the agent
apt install -y qemu-guest-agent # Debian/Ubuntu
systemctl enable --now qemu-guest-agent
# Verify from host:
qm agent <vmid> ping
qm guest cmd <vmid> network-get-interfaces
```

---

## 9. Monitoring & alerting basics

### 9.1 Notifications (PVE 8.1+ unified system)

Config lives in `/etc/pve/notifications.cfg` (and secrets in `/etc/pve/priv/notifications.cfg`).
Targets: `sendmail` (uses local MTA), `smtp` (talks directly to a relay, no local MTA needed), and
`gotify`. Local daemons like **smartd** and cron email `root`; PVE converts those into `system-mail`
notification events and routes them per your config - so configuring one SMTP target covers SMART
alerts, backup results, and unattended-upgrade reports.

Create an SMTP target via CLI:

```bash
pvesh create /cluster/notifications/endpoints/smtp \
 --name mailrelay \
 --server smtp.example.com --port 587 --mode starttls \
 --username "user@example.com" --password "<app-password>" \
 --from-address "pve@example.com" \
 --mailto "you@example.com"
```

Route the built-in `default` matcher (or all events) to it; ensure the matcher targets your
endpoint. Test:

```bash
# Older PVE also supports postfix + 'mailto-root' via sendmail target.
pvesh get /cluster/notifications/targets
```

If you prefer the classic route: install `postfix` (satellite/relay mode) + `libsasl2-modules`, set
a smarthost in `/etc/postfix/main.cf`, and use a `sendmail` target. SMTP target is simpler and
avoids running a local MTA.

### 9.2 SMART monitoring (single disk - still do it)

```bash
apt install -y smartmontools
smartctl -a /dev/nvme0n1 # or /dev/sda
```

Enable smartd with email alerts in `/etc/smartd.conf`:

```text
# Monitor all attributes, run short test daily / long weekly, mail on failure
/dev/sda -a -o on -S on -s (S/../.././02|L/../../6/03) -m root -M exec /usr/share/smartmontools/smartd-runner
```

```bash
systemctl enable --now smartd
```

`-m root` mails root, and PVE notifications relay it out. Even on a single disk, SMART pre-failure
warnings are the only early notice you get before a disk dies.

### 9.3 Logs / journald

- `journalctl -p err -b` - errors this boot.
- `journalctl -u pveproxy -u pvedaemon -u pve-firewall` - PVE services.
- Cap journal size in `/etc/systemd/journald.conf` (`SystemMaxUse=500M`) so logs do not fill the
  small root filesystem; `systemctl restart systemd-journald`.
- `pvereport` collects a full diagnostic bundle for troubleshooting / forum posts.

---

## 10. Backup discipline (3-2-1) with vzdump / PBS

The 3-2-1 rule: **3** copies, on **2** media, **1** offsite. Mapping to a home PVE node:

- Copy 1: the live VMs/CTs on the node.
- Copy 2: local backups via **vzdump** to a separate disk, OR (better) a **Proxmox Backup Server**
  (PBS) instance with block-level dedup (5-10x storage savings) + verification.
- Copy 3 (offsite): a PBS **sync job** to a second PBS (another box, a friend's house, a VPS) or
  copy vzdump archives to cloud/remote.

### 10.1 vzdump (built into PVE, no PBS needed)

Manual:

```bash
vzdump 100 --storage local --mode snapshot --compress zstd \
 --prune-backups keep-last=3,keep-daily=7,keep-weekly=4
```

Scheduled backup job (modern PVE uses jobs.cfg; create via CLI):

```bash
pvesh create /cluster/backup \
 --schedule "02:00" --storage local --mode snapshot --compress zstd \
 --all 1 --notes-template '{{guestname}}' \
 --prune-backups keep-daily=7,keep-weekly=4,keep-monthly=3 \
 --mailnotification failure
```

- `mode snapshot` keeps guests running (needs guest-agent fs-freeze for consistency).
- Configure retention/prune at the **storage** level so it applies consistently.

### 10.2 PBS (recommended for any serious setup)

Add a PBS datastore as PVE storage, then back up to it; retention set in the PVE backup job is
pushed to PBS automatically. Run PBS **garbage collection** + **verify** + **prune** on a schedule,
else deleted backups never free space and silent corruption goes unnoticed. Offsite via PBS **sync
job** to a remote PBS. (2026 community guidance extends this to "3-2-1-1-0": +1 offline/immutable
copy, 0 backup errors via verification.)

Test restores periodically - an untested backup is a hope, not a backup.

---

## 11. ACCESSIBILITY best practices (screen reader / shell-only)

This is the load-bearing section for this operator. The PVE web GUI's noVNC/xterm.js console is
effectively inaccessible to a screen reader; the fix is to never need it.

### 11.1 Always enable a serial console on every VM, then use `qm terminal`

`qm terminal` attaches to a real serial socket and runs in your own (accessible) terminal - unlike
noVNC. Make it the standard.

Host side:

```bash
qm set <vmid> -serial0 socket
# Optionally make the serial port the primary display so boot/GRUB output goes there:
qm set <vmid> -vga serial0
```

Guest side (Debian/Ubuntu) - make getty + kernel + GRUB talk to ttyS0:

```bash
# Inside the guest:
echo 'GRUB_CMDLINE_LINUX="console=tty0 console=ttyS0,115200"' >> /etc/default/grub
echo 'GRUB_TERMINAL="console serial"' >> /etc/default/grub
update-grub
systemctl enable --now serial-getty@ttyS0.service
reboot
```

Connect from the host:

```bash
qm terminal <vmid>
# press Enter again to get the login prompt
# EXIT with: Ctrl-O
```

Pre-9.0 / GRUB boot menu: to read the bootloader itself over serial you need the `GRUB_TERMINAL`
line above; otherwise GRUB only renders to the (graphical) console.

For Windows guests, serial text console is limited; for Linux this is the gold path.

### 11.2 LXC containers

LXC consoles are already text. Use:

```bash
pct console <vmid> # attach to container console (Ctrl-A Q to exit, or Ctrl-O depending)
pct enter <vmid> # get a root shell inside the container directly
```

### 11.3 Prefer SSH into guests

Once a guest has network + your SSH key, just SSH directly into it from your workstation. Serial is
the fallback for boot problems / network-down situations. Install `openssh-server` and push your key
as part of every guest template / cloud-init.

### 11.4 Use `pvesh` (and `qm`/`pct`) for everything

`pvesh` walks the entire PVE API tree from the shell - anything the GUI can do, `pvesh` can do, in
plain text a screen reader handles well:

```bash
pvesh ls / # browse the API tree
pvesh get /nodes/$(hostname)/status
pvesh get /cluster/resources --type vm
pvesh get /nodes/$(hostname)/qemu/100/status/current
pvesh create /nodes/$(hostname)/qemu/100/status/start
```

Combine with `--output-format json` and `jq` for scripting. Build a small set of shell aliases /
scripts for your common operations so you are never reaching for the GUI.

### 11.5 Cloud-init for repeatable, key-injected guests

Use cloud-init templates so every new VM comes up with your SSH key, a static/known IP, the
guest-agent, and serial console already configured - no GUI, no manual console typing:

```bash
qm set <vmid> --ciuser akash --sshkeys ~/.ssh/authorized_keys --ipconfig0 ip=dhcp
qm set <vmid> --ide2 local-lvm:cloudinit
```

---

## 12. Documentation / IaC hygiene

- Keep a plain-text/Markdown runbook (accessible) of: node IP, storage layout, each VMID and what it
  does, backup schedule, and recovery steps. The VM `--description` / notes field and
  `notes-template` on backups help too.
- Version-control your config: `/etc/pve` (the cluster filesystem), `/etc/network/interfaces`,
  firewall `.fw` files, `notifications.cfg`, sysctl/modprobe drop-ins. A simple git repo of `/etc`
  (etckeeper) captures drift.
- Prefer **declarative creation** (`qm create ...` scripts, cloud-init, Terraform/`bpg` provider, or
  Ansible `community.general.proxmox*`) over click-ops - reproducible and screen-reader friendly.
- Snapshot/back up `/etc/pve` separately; it is small and is your entire control-plane config.

---

## 13. Common beginner mistakes (and the fix)

1. **Enabling the firewall with no allow rules** locks you out. Add 22 + 8006 first; keep a session
   open. (Section 5.)
2. **`PermitRootLogin no` before a working sudo user** locks you out. Use `prohibit-password` and
   test a key login first. (Section 3.)
3. **Disabling password auth before testing the key** locks you out. Verify the key session first.
4. **Letting ZFS ARC eat all RAM**, then blaming PVE. Cap `zfs_arc_max`. (Section 7.1.)
5. **Swap on a zvol** can deadlock under pressure (esp. during backups). Keep swap off ZFS.
6. **Auto-upgrading PVE packages** unattended can cause surprise breakage/reboot. Blacklist
   `pve-`/`proxmox-`. (Section 6.)
7. **Using the `pvetest` repo** on a real box. Use `pve-no-subscription`.
8. **Running everything as root@pam / scripting with the root password.** Make an admin user + API
   tokens. (Section 4.)
9. **No backups, or backups on the same disk** is not a backup. Do 3-2-1 with PBS/vzdump. (Section
   10.)
10. **Never testing a restore.** Schedule a periodic test restore.
11. **Forgetting qemu-guest-agent**, so backups aren't filesystem-consistent and shutdowns hang.
12. **No serial console on VMs**, then needing the inaccessible noVNC. Always `serial0 socket`.
    (Section 11.)
13. **No time sync**, breaking certs/2FA/logs. Run chrony.
14. **Ignoring SMART on a single disk** - the one disk that fails is the one you didn't monitor.
15. **Privileged LXC by default** - prefer unprivileged.

---

## 14. Operational checklist: Day-1 / Day-2 / Ongoing

### Day-1 (immediately after install, in this order)

1. Open a SECOND SSH session as your safety rope.
2. Fix repos: disable enterprise, enable no-subscription; `apt update && apt full-upgrade`. (1.1)
3. Reboot if a new kernel landed.
4. Time sync: confirm chrony running, `chronyc tracking`. (2)
5. Push your SSH key; verify key login in a fresh session. (3.1)
6. Harden sshd via drop-in (`prohibit-password`, `PasswordAuthentication no`); `sshd -t` then
   reload; re-test. (3.2)
7. Create admin user + 2FA + an automation API token. (4)
8. ZFS ARC cap (if ZFS) + swappiness=10. (7.1, 7.2)
9. Configure notifications target (SMTP) and send a test. (9.1)
10. Install smartmontools + smartd with `-m root`. (9.2)
11. Stage firewall rules (22, 8006) in `cluster.fw`; enable host then datacenter firewall; re-test
    both SSH and `pvesh`. (5)
12. Install + configure fail2ban (sshd + proxmox jails). (3.3)
13. Configure unattended-upgrades for SECURITY only, blacklist pve-/proxmox-. (6)
14. Cap journald size. (9.3)

### Day-2 (first VMs / containers)

1. Decide VM vs LXC per workload; prefer unprivileged LXC for Linux services. (8.1)
2. Build a cloud-init VM template: virtio NICs, virtio-scsi-single + iothread, guest-agent, serial0
   socket + serial getty, your SSH key. (8.2, 11.5)
3. Install + enable qemu-guest-agent inside every VM; `qm agent <id> ping`. (8.3)
4. Confirm `qm terminal <id>` / `pct console <id>` works for every guest. (11)
5. CPU governor to performance if you want responsiveness. (7.3)
6. Create a scheduled backup job (vzdump or PBS) with retention + failure mail. (10)
7. Do one full test restore.
8. Start the `/etc` git repo / runbook. (12)

### Ongoing / periodic

- Weekly: review `journalctl -p err`, check backup job results email, `fail2ban-client status`.
- Weekly: confirm SMART status (`smartctl -H`), check free space (`df -h`, ARC size, pool health
  `zpool status`).
- Monthly: apply PVE package upgrades manually (`apt update && apt full-upgrade`), reboot on your
  schedule; re-apply the nag patch if you use it; run a TEST RESTORE.
- Monthly: PBS garbage collection + verify + prune (if using PBS).
- Quarterly: review users/tokens/ACLs, rotate API tokens, review firewall rules, update the runbook.
- After any change to sshd / firewall: always re-test from a fresh session with the safety rope
  open.

---

## 15. Official vs community guidance - quick flags

- **Official (Proxmox wiki/docs):** repo model (enterprise vs no-subscription), firewall scopes +
  "open SSH before enabling," fail2ban setup, notifications system, ZFS ARC defaults/sizing,
  swappiness=10, qemu-guest-agent, serial terminal, backup/prune semantics, PermitRootLogin
  guidance.
- **Community consensus (forums, virtualizationhowto, proxmoxpulse, ServeTheHome-style):** the
  post-install nag removal, performance CPU governor, `prohibit-password` over outright `no`,
  blacklisting pve- packages from unattended-upgrades, 3-2-1(-1-0), KSM-disable opinions, "defaults
  I leave alone vs change." Treat these as solid but opinionated - none contradict official docs.
- **Out of scope / avoid for a single node:** clustering, corosync/HA, Ceph hardening (these appear
  in enterprise hardening guides but add risk/complexity with no benefit on one node).

---

## Sources

- Proxmox VE wiki - Package Repositories:
  [Package Repositories](https://pve.proxmox.com/wiki/Package_Repositories)
- Proxmox VE wiki - Upgrade 8 to 9 (deb822 sources):
  [Upgrade from 8 to 9](https://pve.proxmox.com/wiki/Upgrade_from_8_to_9)
- Proxmox VE wiki - Fail2ban: [Fail2ban](https://pve.proxmox.com/wiki/Fail2ban)
- Proxmox VE docs - Firewall:
  [Proxmox VE Firewall](https://pve.proxmox.com/pve-docs/chapter-pve-firewall.html)
- Proxmox VE docs - Notifications:
  [Notifications](https://pve.proxmox.com/pve-docs/chapter-notifications.html)
- Proxmox VE wiki - Serial Terminal: [Serial Terminal](https://pve.proxmox.com/wiki/Serial_Terminal)
- Proxmox VE wiki - Qemu-guest-agent:
  [Qemu-guest-agent](https://pve.proxmox.com/wiki/Qemu-guest-agent)
- Proxmox VE wiki - QEMU/KVM Virtual Machines:
  [Qemu/KVM Virtual Machines](https://pve.proxmox.com/wiki/Qemu/KVM_Virtual_Machines)
- Proxmox VE wiki - ZFS on Linux: [ZFS on Linux](https://pve.proxmox.com/wiki/ZFS_on_Linux)
- Proxmox VE wiki - Backup and Restore:
  [Backup and Restore](https://pve.proxmox.com/wiki/Backup_and_Restore)
- HomeSecExplorer Proxmox Hardening Guide (CIS-based):
  [GitHub - HomeSecExplorer/Proxmox-Hardening-Guide: Security hardening guides for PVE and PBS, built on CIS Debian Benchmark with Proxmox specific best practices.](https://github.com/HomeSecExplorer/Proxmox-Hardening-Guide)
- HomeSecExplorer PVE9 hardening guide:
  [Proxmox-Hardening-Guide/docs/pve9-hardening-guide.md at main · HomeSecExplorer/Proxmox-Hardening-Guide](https://github.com/HomeSecExplorer/Proxmox-Hardening-Guide/blob/main/docs/pve9-hardening-guide.md)
- Proxmox Post-Install Checklist (proxmoxpulse):
  [Proxmox Post-Install Checklist: 15 Things to Configure First](https://proxmoxpulse.com/articles/proxmox-post-install-checklist/)
- VirtualizationHowto - PVE 9 hardening:
  [Top Security Hardening Steps for Proxmox VE 9](https://www.virtualizationhowto.com/2025/08/top-security-hardening-steps-for-proxmox-ve-9/)
- VirtualizationHowto - Defaults I leave alone / change:
  [Proxmox Defaults I Leave Alone (And the Ones I Always Change)](https://www.virtualizationhowto.com/2025/12/proxmox-defaults-i-leave-alone-and-the-ones-i-always-change/)
- VirtualizationHowto - Swap tweaks:
  [Proxmox Swap Tweaks Guide! Dedicated drive, Swappiness, Page Cluster](https://www.virtualizationhowto.com/2025/02/proxmox-swap-tweaks-guide-dedicated-drive-swappiness-page-cluster/)
- AllThingsOpen - automate PVE security updates:
  [Automate Proxmox security updates the right way | We Love Open Source - All Things Open](https://allthingsopen.org/articles/automate-proxmox-security-updates)
- LearnLinuxTV - unattended-upgrades tutorial:
  [Proxmox Security Updates Made Easy - Unattended Upgrades Tutorial](https://www.learnlinux.tv/proxmox-security-updates-made-easy-unattended-upgrades-tutorial/)
- ProxmoxR - LXC vs VM:
  [Proxmox LXC vs VM: Performance, Security, and When to Use Each](https://proxmoxr.com/blog/proxmox-lxc-vs-vm)
- ProxmoxR - vzdump explained:
  [Proxmox vzdump Explained: Backup Modes, Compression, and Hooks](https://proxmoxr.com/blog/proxmox-vzdump-explained)
- ProxmoxR - swap configuration:
  [Proxmox Swap Configuration: Tuning, ZFS Caveats, and Sizing Guide](https://proxmoxr.com/blog/proxmox-swap-configuration)
- Nimbus/RDEM - Proxmox backup best practices 2026 (3-2-1-1-0):
  [Proxmox Backup Best Practices 2026: PBS verify, 3-2-1-1-0](https://nimbus.rdem-systems.com/en/blog/complete-proxmox-backup-guide/)
- Thomas-Krenn wiki - mail notifications:
  [Configuration and creation of mail notifications in Proxmox VE - Thomas-Krenn-Wiki-en](https://www.thomas-krenn.com/en/wiki/Configuration_and_creation_of_mail_notifications_in_Proxmox_VE)
- community-scripts (successor to tteck) post-install:
  [Proxmox VE Helper-Scripts](https://community-scripts.github.io/ProxmoxVE/)
