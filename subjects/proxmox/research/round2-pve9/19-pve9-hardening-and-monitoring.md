# PVE 9 Hardening, Performance Tuning, and Text-Based Monitoring

Target: Proxmox VE 9.x on Debian 13 "trixie" (mid-2026). Single node, AMD Ryzen 6800H, 24 GB RAM,
single NVMe with btrfs root, external USB drive for backups and an external ZFS pool, no RAID. Host
reached only over SSH. Reader is a blind screen-reader user working shell-only.

This document marks each recommendation as official (Proxmox wiki / pve-docs) or community. Every
command is meant to be run as root over SSH unless noted.

## TL;DR of the biggest lockout pitfalls (read this first)

These are the mistakes that most often lock a beginner out of a single SSH-only node:

1. Setting `PermitRootLogin no` instead of `prohibit-password`. On a single node you log in as
   `root@pam`; `no` kills that immediately. Use `prohibit-password` (key-only root). Official.
2. Enabling the firewall before adding allow rules for port 22 (SSH) and 8006 (web/API). The PVE
   firewall defaults to DROP on input once enabled. Add the rules first, keep a second SSH session
   open, then enable. Official.
3. The pmxcfs root-key trap. Proxmox symlinks `/root/.ssh/authorized_keys` to
   `/etc/pve/priv/authorized_keys`, which lives on the cluster filesystem (pmxcfs). If
   `pve-cluster.service` fails to start, `/etc/pve` is empty and your root key vanishes to key-only
   SSH locks you out even though the key is "correct". Mitigation below in Accessibility Practices.
   Community-documented, important.
4. `PasswordAuthentication no` with no working key installed yet. Always confirm a key login works
   in a second session before disabling passwords.
5. Forgetting `sshd -t` before reload. A typo in a drop-in file makes sshd refuse to start; an open
   session survives but new logins fail.

Golden rule for every change in this document: keep a second, already-authenticated SSH session open
until you have re-verified login in a third new session.

## SSH hardening (key-only, drop-in config)

PVE 9 / Debian 13 ship an sshd that reads `/etc/ssh/sshd_config.d/*.conf` via an `Include` near the
top of `/etc/ssh/sshd_config`. Because the include is at the top, the FIRST matching keyword wins,
so a drop-in only overrides the main file if the main file does not set the same keyword earlier.
The clean approach is to put all hardening in a drop-in and ensure the main file does not contradict
it.

Create `/etc/ssh/sshd_config.d/99-hardening.conf`:

```text
# Root may log in with keys only (needed for root@pam and any cluster/migration ops)
PermitRootLogin prohibit-password
# Disable all password-based auth (keys only)
PasswordAuthentication no
KbdInteractiveAuthentication no
# Optional extra hardening
PubkeyAuthentication yes
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
```

Why `prohibit-password` and not `no`: on a single node the only administrative login is `root@pam`.
`PermitRootLogin no` removes it entirely. `prohibit-password` keeps root reachable by SSH key while
refusing root passwords. This is the official Proxmox recommendation; cluster migrations also rely
on root SSH.

Apply safely (this exact order matters):

```bash
# 1. Make sure your key is installed and a key login already works in another window
# 2. Validate syntax BEFORE touching the running daemon:
sshd -t
# 3. Reload without dropping existing sessions:
systemctl reload ssh # service is "ssh" on Debian; "sshd" alias also works
# 4. From a SEPARATE new terminal, confirm you can still log in:
# ssh root@<host>
```

Note: on Debian 13 the unit is `ssh.service` (with `sshd.service` as an alias).
`systemctl reload ssh` re-reads config without killing live connections, so an open session is your
safety net.

## fail2ban: [sshd] and [proxmox] (port 8006) jails

Install and configure:

```bash
apt update && apt install -y fail2ban
```

fail2ban does not edit `jail.conf` directly; put overrides in `/etc/fail2ban/jail.local`.

`/etc/fail2ban/jail.local`:

```ini
[DEFAULT]
# Exempt your own management IP/subnet so you can never ban yourself.
# Replace with your real admin IP(s); loopback is always ignored.
ignoreip = 127.0.0.1/8 ::1 192.0.2.10
backend = systemd
# Escalating bans: 1h, then x24 each repeat, capped at 30d
bantime.increment = true
bantime.factor = 24
bantime.maxtime = 30d

[sshd]
enabled = true
mode = aggressive
port = ssh
maxretry = 4
findtime = 1h
bantime = 1h

[proxmox]
enabled = true
port = https,http,8006
filter = proxmox
backend = systemd
maxretry = 3
findtime = 2d
bantime = 1h
```

The `[proxmox]` jail needs a custom filter. Create `/etc/fail2ban/filter.d/proxmox.conf` (official
Proxmox wiki content):

```ini
[Definition]
failregex = pvedaemon\[.*authentication failure; rhost=<HOST> user=.* msg=.*
ignoreregex =
journalmatch = _SYSTEMD_UNIT=pvedaemon.service
```

Important caveat (official): this filter only catches failures against PVE authentication realms
(e.g. `root@pve`, Proxmox-realm users). Logins via PAM (`root@pam`) over the web UI are NOT logged
the same way and are not caught by this jail; SSH brute force against `root@pam` is covered by the
`[sshd]` jail instead.

Enable and verify:

```bash
systemctl enable --now fail2ban
fail2ban-client status # lists active jails
fail2ban-client status sshd # banned IPs, failures
fail2ban-client status proxmox
# To unban yourself if needed:
fail2ban-client set sshd unbanip <IP>
```

Because PVE 9 logs to the systemd journal, `backend = systemd` is correct and no separate log file
path is needed. (Official wiki uses systemd backend.)

## Firewall baseline (and the nftables note)

PVE 9 ships `proxmox-firewall`, an nftables-based implementation, but it is OPT-IN: the daemon runs
yet does nothing until you switch the backend to nftables. The default backend remains the
iptables-based firewall, using the same config files and format. You can leave the default backend;
the rules below work either way.

Three layers, all default-off until enabled:

- Datacenter: `/etc/pve/firewall/cluster.fw`
- Host (node): `/etc/pve/nodes/<node>/host.fw`
- Per-guest: `/etc/pve/firewall/<vmid>.fw`

If the datacenter firewall is disabled, nothing below it takes effect; if it is enabled, the default
input policy becomes DROP, so you MUST pre-add allow rules.

Recommended single-node baseline. Edit `/etc/pve/firewall/cluster.fw`:

```text
[OPTIONS]
enable: 1
policy_in: DROP
policy_out: ACCEPT

[RULES]
IN SSH(ACCEPT) -log nolog # port 22
IN ACCEPT -p tcp -dport 8006 -log nolog # Proxmox web UI / API
IN ACCEPT -p tcp -dport 5900:5999 -log nolog # optional: noVNC/SPICE consoles
IN ACCEPT -p icmp # optional: ping for diagnostics
```

Tighten further by restricting source to your admin IP, e.g.
`IN ACCEPT -source 192.0.2.10 -p tcp -dport 8006`.

Safe enable procedure:

```bash
# Keep a second SSH session open. Then:
pve-firewall compile # sanity-check rules compile
pve-firewall status # shows enabled/disabled and whether rules loaded
# Set enable:1 only after the SSH + 8006 ACCEPT rules exist.
```

To switch to the nftables backend later (optional), set `nftables: 1` in the host firewall
`[OPTIONS]` (or via the web UI Host > Firewall > Options). Leave it on the default until the node is
otherwise stable. (Official: nftables is opt-in in PVE 9.)

## Dedicated admin user and API tokens (stop using daily root)

Create a PVE-realm admin user, give it the Administrator role, and use API tokens for
scripts/automation so the root password and SSH key are reserved for emergencies.

```bash
# Create an admin user in the PVE realm (separate from root@pam)
pveum user add akash@pve --comment "Daily admin"
pveum passwd akash@pve
# Grant full admin (or scope down with a custom role for least privilege)
pveum acl modify / --users akash@pve --roles Administrator

# Create an API token for non-interactive use (pvesh, scripts, monitoring)
pveum user token add akash@pve automation --privsep 1
# ^ prints the token secret ONCE -- store it now, it cannot be retrieved later.

# Grant the token its own ACL (privilege separation keeps token <= user rights)
pveum acl modify / --tokens 'akash@pve!automation' --roles PVEAuditor
```

Use a read-only `PVEAuditor` role for monitoring tokens so a leaked monitoring token cannot change
anything. Use the token via header `Authorization: PVEAPIToken=akash@pve!automation=<secret>` or
with `pvesh`'s token environment. (Official: `pveum user token add`, ACLs.)

Keep `root@pam` for: console/recovery, firewall lockout recovery, and cluster ops. Everything
routine goes through the admin user / token.

## Unattended upgrades: Debian SECURITY only, Proxmox held back, no auto-reboot

On Debian 13, scope automatic updates to security only and explicitly exclude Proxmox packages,
because an unattended `pve-manager`/kernel/`pve-qemu-kvm` upgrade can change behavior or demand a
reboot you did not schedule.

```bash
apt update && apt install -y unattended-upgrades apt-listchanges
```

`/etc/apt/apt.conf.d/52unattended-upgrades-proxmox`:

```text
Unattended-Upgrade::Origins-Pattern {
 // Debian 13 security only
 "origin=Debian,codename=trixie-security,label=Debian-Security";
};

// Never auto-upgrade Proxmox or virtualization core packages
Unattended-Upgrade::Package-Blacklist {
 "proxmox-ve";
 "pve-manager";
 "pve-kernel.*";
 "proxmox-kernel.*";
 "pve-qemu-kvm";
 "qemu-server";
 "pve-container";
 "libpve.*";
 "zfs.*";
 "ceph.*";
};

// Do NOT auto-reboot a single hypervisor; reboot on YOUR schedule
Unattended-Upgrade::Automatic-Reboot "false";
```

Enable the schedule in `/etc/apt/apt.conf.d/20auto-upgrades`:

```text
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
```

Dry-run to confirm scope before trusting it:

```bash
unattended-upgrades --dry-run --debug 2>&1 | less
```

Proxmox itself is then upgraded manually and deliberately: `apt update && apt full-upgrade` (after
reading the release notes). Community consensus + Proxmox guidance both favor holding Proxmox
packages out of automation.

## chrony time sync (Debian 13)

PVE has used chrony as the default NTP daemon since PVE 7; on Debian 13 it remains the right choice
for a server (better than the lightweight systemd-timesyncd). `ntpdate` is gone from trixie.

```bash
apt install -y chrony # installing chrony removes systemd-timesyncd
systemctl enable --now chrony
chronyc tracking # offset, stratum, last sync
chronyc sources -v # configured time sources
timedatectl status # "System clock synchronized: yes", "NTP service: active"
```

Config lives in `/etc/chrony/chrony.conf`; the Debian default `pool` lines are fine for a homelab.
(Official: Time Synchronization wiki.)

## Performance tuning for this hardware

### ZFS ARC cap for the external pool (verify it, because ZFS is added later)

Critical point: because the root filesystem is btrfs and this external ZFS pool is added later by
hand, do not assume the Proxmox installer wrote the ZFS ARC cap you want. Check
`/etc/modprobe.d/zfs.conf` and the runtime parameter after importing ZFS. If the cap is absent, `0`,
or too high for this VM workload, set it yourself.

Pick a modest cap for a USB-attached backup/secondary pool, e.g. 2-4 GB. Example 4 GiB = 4294967296
bytes.

`/etc/modprobe.d/zfs.conf`:

```text
options zfs zfs_arc_max=4294967296
```

If your chosen `zfs_arc_max` is below `zfs_arc_min` (default ~1/32 of RAM), also set `zfs_arc_min`
to at most `zfs_arc_max - 1`. Then rebuild initramfs and reboot:

```bash
update-initramfs -u -k all
reboot
# Verify after reboot:
cat /sys/module/zfs/parameters/zfs_arc_max
zarcstat # or: cat /proc/spl/kstat/zfs/arcstats
```

Temporary (no reboot) for testing only:

```bash
echo $((4 * 1024*1024*1024)) > /sys/module/zfs/parameters/zfs_arc_max
```

(Official: pve-docs "Limit ZFS Memory Usage".) Note current PVE 9.2 ships ZFS 2.4; `arcstat` was
renamed `zarcstat` and pvereport uses the new name.

### Swap: swappiness 10, and never swap on a zvol

`/etc/sysctl.d/99-swappiness.conf`:

```text
vm.swappiness = 10
```

Apply now: `sysctl --system`. (Official.) On 24 GB this keeps the host from swapping out VM memory
prematurely.

Never place swap on a ZFS zvol -- it can deadlock the host or cause IO storms, especially during
backups (official warning). With a btrfs root, swap should be a plain swap partition or a swapfile
on btrfs created correctly (btrfs needs `chattr +C`/nodatacow or a properly preallocated swapfile).
Best on this box: a small dedicated swap partition on the NVMe, or simply rely on RAM (24 GB) and
keep swap small.

### CPU governor (Ryzen 6800H)

```bash
apt install -y linux-cpupower
cpupower frequency-info # current governor + available ones
cpupower frequency-set -g ondemand # responsive + power-aware (laptop SoC)
# or 'schedutil' (kernel default on modern systems), or 'performance' for max throughput
```

Make it persistent across reboots via a systemd unit or `cpufrequtils`. For a laptop-class 6800H,
`ondemand`/`schedutil` saves power and heat; use `performance` only if you see latency-sensitive VM
stalls. (Community tuning; cpupower is the correct tool.)

### KSM and transparent hugepages

KSM (Kernel Samepage Merging) dedupes identical guest memory pages and can reclaim RAM when several
similar VMs run. `ksmtuned` is enabled by default and only kicks in above ~80% memory pressure
(tunable via `KSM_THRES_COEF` in `/etc/ksmtuned.conf`). On a single 24 GB node with few VMs it
rarely activates; leave it as-is. You can opt a specific VM out with `allow-ksm=0`
(security-sensitive guests). Check:

```bash
cat /sys/kernel/mm/ksm/pages_sharing # 0 means KSM is not currently merging
```

Transparent Hugepages: Debian/PVE default is `madvise`, which is the sane choice for a KVM host
(QEMU advises THP where it helps without forcing it system-wide). Leave it at `madvise` unless
profiling a specific workload:

```bash
cat /sys/kernel/mm/transparent_hugepage/enabled # expect [madvise]
```

### Sensible VM defaults

For every new VM, prefer:

- Machine type: `q35`
- Firmware: OVMF (UEFI) -- with an EFI disk; needed for modern guests/secure boot
- SCSI controller: `virtio-scsi-single` (enables per-disk IO threads)
- Disk: VirtIO/SCSI with `discard=on,ssd=1` (NVMe-backed), cache default (`none`)
- Network: `virtio` (paravirtual NIC)
- CPU type: `host` (exposes full Ryzen feature set; fine on a single node since you never migrate to
  a different CPU)
- QEMU Guest Agent: enabled

Example creating a Linux VM entirely from the shell (accessibility-friendly):

```bash
qm create 100 \
 --name debian-test --ostype l26 \
 --machine q35 --bios ovmf \
 --efidisk0 local-btrfs:1,efitype=4m,pre-enrolled-keys=0 \
 --cpu host --cores 4 --sockets 1 \
 --memory 4096 --balloon 2048 \
 --scsihw virtio-scsi-single \
 --scsi0 local-btrfs:32,discard=on,ssd=1,iothread=1 \
 --net0 virtio,bridge=vmbr0 \
 --agent enabled=1 \
 --serial0 socket --vga serial0 # serial console -- see Accessibility section
qm set 100 --boot order=scsi0
```

(VirtIO recommendation is official; q35/OVMF/virtio-scsi-single are Proxmox standard defaults.)

### qemu-guest-agent in every guest

Install inside each guest so the host can do clean shutdowns, filesystem freeze for consistent
backups, and report guest IPs:

```bash
# Debian/Ubuntu guest:
apt install -y qemu-guest-agent && systemctl enable --now qemu-guest-agent
```

Then confirm from the host: `qm agent 100 ping` should return cleanly. (Official.)

## Text-based monitoring (screen-reader friendly)

Everything here produces plain text or YAML -- no web dashboards, no ASCII-art tables when you ask
for machine formats.

### Node and cluster status via pvesh

```bash
# Full node status as YAML (clean for a screen reader -- no ASCII borders):
pvesh get /nodes/$(hostname)/status --output-format yaml

# All resources (VMs, containers, storage) in one list:
pvesh get /cluster/resources --output-format yaml
pvesh get /cluster/resources --type vm --output-format yaml

# Storage status:
pvesh get /nodes/$(hostname)/storage --output-format yaml

# Disks the node sees (includes SMART health summary):
pvesh get /nodes/$(hostname)/disks/list --output-format yaml
```

Prefer `--output-format yaml` (or `json`) over the default `text`, because the default uses
ASCII-art borders that read poorly with a screen reader.

### Guest inventory and per-guest detail

```bash
qm list # VMs: id, name, status, mem, disk, pid
pct list # containers
qm config 100 # full config of one VM
qm status 100 # running/stopped + qmpstatus
pct config 101 ; pct status 101
```

### pvereport (one big text snapshot)

```bash
pvereport > /root/pvereport-$(date +%F).txt
```

Captures host versions, storage, network, ZFS (`zarcstat` in PVE 9), running guests, replication,
and more in one plain-text file -- excellent to read end to end or to attach when asking for help.
(Official; PVE 9 updated it to `zarcstat`.)

### SMART / NVMe health with smartmontools + smartd

smartmontools is preinstalled. For the NVMe:

```bash
# Full health + identify:
smartctl -a /dev/nvme0
# Just overall health verdict:
smartctl -H /dev/nvme0
# NVMe-specific log (wear, spare, temperature, media errors):
smartctl -l error /dev/nvme0
nvme smart-log /dev/nvme0 # if nvme-cli installed; very detailed
```

Key NVMe endurance fields to watch:

- `Percentage Used` -- wear estimate; 100% = rated endurance reached (drive may still work, but plan
  replacement).
- `Available Spare` vs `Available Spare Threshold` -- replace if spare drops near the threshold.
- `Media and Data Integrity Errors` -- should stay 0.

NVMe self-tests (supported on most modern NVMe):

```bash
smartctl -t short /dev/nvme0 # quick self-test
smartctl -t long /dev/nvme0 # extended
smartctl -l selftest /dev/nvme0 # results log
```

Configure smartd for scheduled tests + notifications via the Proxmox notification system. smartd
auto-scans `/dev/nvme[0-99]` and emails root on problems every 30 minutes by default (official). To
add scheduled self-tests and route alerts, edit `/etc/smartd.conf`:

```text
# nvme0: monitor all, short test daily 2am, long test 1st of month 3am, mail root
/dev/nvme0 -a -o on -S on -s (S/../.././02|L/../01/./03) -m root -M exec /usr/share/smartmontools/smartd-runner
```

`-m root` sends to local root mail; Proxmox's notification system picks up root/system mail and can
forward via your configured notification targets (Datacenter > Notifications). Confirm smartd is
running:

```bash
systemctl enable --now smartd
systemctl status smartd
```

(Official: Disk Health Monitoring wiki; smartd man pages for self-test schedules.)

### journald: persistent storage + size cap

Make logs survive reboots (so you can investigate a crash after rebooting) and cap disk use. Edit
`/etc/systemd/journald.conf`:

```ini
[Journal]
Storage=persistent
SystemMaxUse=1G
SystemKeepFree=2G
MaxRetentionSec=1month
```

Apply and verify:

```bash
mkdir -p /var/log/journal
systemctl restart systemd-journald
journalctl --disk-usage
# One-off manual trim if it ever grows:
journalctl --vacuum-size=500M
journalctl --vacuum-time=14d
# Reading logs:
journalctl -u pve-cluster -e # a specific service, jump to end
journalctl -p err -b # this boot, errors and worse
journalctl -k # kernel ring buffer
```

### Filesystem scrubs (btrfs root + external ZFS pool)

btrfs root integrity:

```bash
btrfs scrub start / # start a scrub of the root fs
btrfs scrub status / # progress + errors (read-friendly text)
btrfs device stats / # cumulative error counters per device
```

External ZFS pool:

```bash
zpool scrub <poolname> # start
zpool status -v <poolname> # state, errors, scrub progress (plain text)
zpool list # capacity/health one-liner per pool
```

Schedule scrubs monthly. btrfs has no built-in scrub timer by default; add a systemd timer or cron
entry (e.g. first Sunday) running `btrfs scrub start`. ZFS on Debian ships
`zfs-scrub-monthly@<pool>.timer` you can enable:

```bash
systemctl enable --now zfs-scrub-monthly@<poolname>.timer
```

### glances for a live text overview (accessible alternative to dashboards)

```bash
apt install -y glances
glances --stdout cpu.total,mem.percent,load,fs # plain stdout, no curses UI
glances --stdout-csv cpu.total,mem.used # CSV for scripting
```

`glances --stdout` prints periodic plain-text lines instead of a full-screen TUI, which a screen
reader can follow. This is the recommended live monitor here instead of a web dashboard. (Community;
widely used.)

### Optional external metric servers -- and the accessibility caveat

PVE can push metrics to Graphite, InfluxDB, or OpenTelemetry, defined in `/etc/pve/status.cfg`.
Example InfluxDB v2 (HTTP) entry:

```text
influxdb: mylocalinflux
 server 127.0.0.1
 port 8086
 organization proxmox
 bucket proxmox
 token <influx-api-token>
 proto http
 influxdbproto http
```

Graphite example:

```text
graphite: mygraphite
 server 127.0.0.1
 port 2003
 path proxmox
 proto udp
```

`prometheus-pve-exporter` is the common Prometheus-ecosystem option (it scrapes the PVE API and
exposes `/metrics`). OpenTelemetry is now a built-in push target in current PVE 9.x, but it serves
the same dashboard/collector category for this guide's purposes.

ACCESSIBILITY FLAG: these metric servers exist to FEED graphical dashboards or observability
collectors (Grafana, Prometheus+Grafana, Chronograf, OpenTelemetry backends). They produce data, not
an accessible text interface. For a screen-reader, shell-only workflow they add complexity with
little benefit. Recommendation: skip the metric-server + Grafana stack and rely on the CLI tools
above (`pvesh ... --output-format yaml`, `pvereport`, `glances --stdout`, `journalctl`, `smartctl`,
`zpool/btrfs status`). Only set up an external metric server if a sighted collaborator will use the
dashboard. (Official: External Metric Server chapter; accessibility judgement is this report's.)

## Accessibility practices (shell-only, blind operator)

- Always enable a serial console on every VM and use it. Add `--serial0 socket` and set
  `--vga serial0` (or `serial0` as the display) so `qm terminal <vmid>` gives a text console you can
  read; configure the guest to put a getty + kernel console on ttyS0 (`console=ttyS0,115200` on the
  kernel cmdline). This replaces the inaccessible noVNC/SPICE graphical console.

```bash
qm set <vmid> --serial0 socket --vga serial0
qm terminal <vmid> # attach to the guest's serial console (text)
# detach with Ctrl-O
```

- Prefer SSH into guests once they have an IP; the serial console is the fallback for boot problems,
  network breakage, and installers.

- For containers, use `pct enter <vmid>` (or `pct console <vmid>`) -- both are fully text-based.

- Drive everything via `pvesh` with `--output-format yaml`/`json`. The PVE REST API is the canonical
  accessible control surface; the web UI is optional. Wrap common reads in shell aliases (e.g. a
  `pvestat` alias for the node-status YAML command).

- Keep the host serial console / IPMI-equivalent reachable. On this laptop-class box that means a
  physically attached keyboard/USB-serial as the absolute last resort, plus the persistent journald
  logs so post-reboot diagnosis is possible.

- The pmxcfs root-key safeguard (prevents the worst lockout): because `/root/.ssh/authorized_keys`
  is a symlink into `/etc/pve` (pmxcfs), a failed `pve-cluster.service` removes your key. Defend
  against it by also placing the key in a NON-pmxcfs file that sshd reads:

```bash
cp /etc/pve/priv/authorized_keys /root/.ssh/authorized_keys2
chmod 600 /root/.ssh/authorized_keys2
# sshd reads authorized_keys2 by default (AuthorizedKeysFile .ssh/authorized_keys .ssh/authorized_keys2)
```

This guarantees key-only SSH still works even if pmxcfs is down. Re-copy after changing keys.

- Never disable password auth on the only login path until a key login is proven in a separate
  session. Consider keeping `root@pam` password auth available ONLY on the local console (not over
  the network) as an emergency recovery path.

## Day-1 / Day-2 / Ongoing checklist

### Day 1 (initial hardening -- do with two SSH sessions open)

1. Confirm SSH key login works for root in a second session.
2. Create `/etc/ssh/sshd_config.d/99-hardening.conf` (`prohibit-password`,
   `PasswordAuthentication no`); `sshd -t`; `systemctl reload ssh`; re-verify login.
3. Add the pmxcfs key safeguard (`authorized_keys2` copy).
4. Add firewall allow rules for 22 and 8006 in `cluster.fw`, `pve-firewall compile`, THEN set
   `enable: 1`; re-verify SSH + web access.
5. Install + configure chrony; `timedatectl status` shows synchronized.
6. Install fail2ban with `[sshd]` + `[proxmox]` jails and the proxmox filter; set `ignoreip` to your
   admin IP; `fail2ban-client status`.
7. Create the dedicated admin user and a `PVEAuditor` API token for monitoring.
8. Set `vm.swappiness=10`; ensure no swap-on-zvol; verify swap location.
9. Set the ZFS ARC cap in `/etc/modprobe.d/zfs.conf`; `update-initramfs -u -k all`; reboot; verify
   `zfs_arc_max`.

### Day 2 (tuning + monitoring setup)

1. Configure unattended-upgrades: Debian security only, Proxmox blacklisted, auto-reboot off;
   `--dry-run` to confirm.
2. Set CPU governor (`ondemand`/`schedutil`) and make it persistent.
3. Configure smartd self-tests + `-m root` notifications; enable smartd.
4. Set journald `Storage=persistent` + size cap; restart journald.
5. Enable monthly scrubs: ZFS timer + a btrfs scrub timer/cron.
6. Install glances; confirm `glances --stdout ...` reads well.
7. Set VM template defaults (q35/OVMF/virtio-scsi-single/virtio-net/cpu host/agent/ serial console);
   install qemu-guest-agent in existing guests.
8. Decide against the metric-server/Grafana stack unless a sighted helper needs it.

### Ongoing

- Weekly: `pvereport` snapshot; `pvesh get /nodes/$(hostname)/status --output-format yaml`; review
  `journalctl -p err -b`.
- Weekly: `smartctl -a /dev/nvme0` -- watch `Percentage Used`, `Available Spare`, media errors.
  `fail2ban-client status sshd` for attack volume.
- Monthly: confirm scrubs ran clean (`zpool status -v`, `btrfs scrub status /`); run an NVMe
  `smartctl -t long`.
- Monthly/as-needed: manual, deliberate Proxmox upgrade (`apt update && apt full-upgrade` after
  reading release notes), then reboot on your schedule.
- Rotate/expire API tokens; review `pveum acl list`.
- After any change to keys or firewall, re-prove SSH + web access in a fresh session before closing
  your safety session.

## Citations

Official (Proxmox wiki / pve-docs):

- pve-docs, System Administration (ZFS ARC limit, swappiness, swap-on-ZFS):
  [Host System Administration](https://pve.proxmox.com/pve-docs/chapter-sysadmin.html) and
  pve-admin-guide sections 3.9.8 / 3.9.9.
- Proxmox VE Firewall (enable procedure, open 22 + 8006, rule options):
  [Proxmox VE Firewall](https://pve.proxmox.com/pve-docs/chapter-pve-firewall.html)
- Firewall wiki (nftables opt-in, host.fw/cluster.fw, backend):
  [Firewall](https://pve.proxmox.com/wiki/Firewall)
- Fail2ban wiki ([proxmox] jail, proxmox.conf filter, systemd backend):
  [Fail2ban](https://pve.proxmox.com/wiki/Fail2ban)
- Disk Health Monitoring (smartctl, smartd auto-scan, NVMe):
  [Disk Health Monitoring](https://pve.proxmox.com/wiki/Disk_Health_Monitoring)
- External Metric Server (status.cfg, InfluxDB/Graphite formats):
  [External Metric Server](https://pve.proxmox.com/wiki/External_Metric_Server)
- Time Synchronization (chrony default):
  [Time Synchronization](https://pve.proxmox.com/wiki/Time_Synchronization)
- pveum / API tokens: [pveum(1)](https://pve.proxmox.com/pve-docs/pveum.1.html)
- pvesh: [pvesh(1)](https://pve.proxmox.com/pve-docs/pvesh.1.html)
- qm: [qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html)
- Upgrade 8 to 9 (Debian 13 base):
  [Upgrade from 8 to 9](https://pve.proxmox.com/wiki/Upgrade_from_8_to_9)
- Proxmox VE 9.x release history (Debian 13, current 9.2 ZFS 2.4, pvereport zarcstat):
  [Proxmox Virtual Environment 9.0 with Debian 13 released](https://www.proxmox.com/en/about/company-details/press-releases/proxmox-virtual-environment-9-0)

Community (verified against multiple sources, flagged as community where used):

- SSH drop-in / prohibit-password discussion + pmxcfs authorized_keys lockout:
  [\[SOLVED\] - \[BUG\]\[SSH\] Lock yourself out of a node - PermitRootLogin prohibit-password](https://forum.proxmox.com/threads/bug-ssh-lock-yourself-out-of-a-node-permitrootlogin-prohibit-password.154806/)
- fail2ban on Proxmox 9:
  [Fail2ban Proxmox 9](https://forum.proxmox.com/threads/fail2ban-proxmox-9.175815/)
- CPU governor / cpupower tuning:
  [\[TUTORIAL\] - Fix always high CPU frequency in proxmox host.](https://forum.proxmox.com/threads/fix-always-high-cpu-frequency-in-proxmox-host.84270/)
- KSM/ksmtuned behavior: [Enable KSM](https://forum.proxmox.com/threads/enable-ksm.19355/)
- Debian 13 chrony vs timesyncd / ntpdate removed:
  [Debian 13 trixie : Configure NTP Client : Server World](https://www.server-world.info/en/note?os=Debian_13&p=ntp&f=3)
- glances for accessible text monitoring:
  [Btop, Glances, or Netdata? The Best Ways to Monitor Your Proxmox Server | by Mr.PlanB](https://medium.com/@PlanB./btop-glances-or-netdata-the-best-ways-to-monitor-your-proxmox-server-e98e1cddc223)
- unattended-upgrades on Proxmox guidance:
  [Can I use unattended-upgrades on Proxmox? - Proxmox help - VHT Forum](https://www.virtualizationhowto.com/community/proxmox-help/can-i-use-unattended-upgrades-on-proxmox/)
