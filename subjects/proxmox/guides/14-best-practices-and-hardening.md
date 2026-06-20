# Best practices and hardening

## What you'll be able to do

By the end of this guide you will be able to harden a single SSH-only Proxmox node without ever
locking yourself out: key-only SSH through a drop-in config, [fail2ban](GLOSSARY.md) protecting SSH
and the API, a firewall baseline, sane memory and swap tuning, and security-only automatic updates.
You will follow a day-1 / day-2 / ongoing checklist, and every change is made from the shell, with
no web GUI and no graphical console. The golden rule running through all of it is simple: never
disconnect the safety net before you have proven the new path works.

## The golden rule: never lock yourself out

The single rule that protects you through every change in this guide: keep a second,
already-authenticated SSH session open until you have re-verified login in a third, brand-new
session. The open session is your lifeline. If a change breaks new logins, the established session
is still live and can undo it; an already-established connection keeps working even when new ones
are being refused, so it is your way back in.

These are the traps that most often lock a beginner out of a headless single node. Each one is
avoidable if you know it is coming:

- Setting `PermitRootLogin no` instead of `prohibit-password`. On a single node your only
  administrative login is `root@pam`; `no` removes it entirely. Use `prohibit-password` (root by key
  only).
- Enabling the firewall before adding allow rules for SSH and the API. Once the datacenter firewall
  is on, the default input policy becomes DROP, so the allow rules must already be present.
- The pmxcfs root-key trap. `/root/.ssh/authorized_keys` is a symlink into the cluster filesystem
  under `/etc/pve`. If [pve-cluster](GLOSSARY.md) (pmxcfs) fails to start, that file disappears and
  key-only SSH breaks even though your key is correct.
- Disabling password authentication before a key login is proven. Always confirm a key login works
  in a second session before turning passwords off.
- Forgetting `sshd -t` before a reload. A typo in a drop-in file makes sshd refuse to start; an open
  session survives, but new logins fail.

Every file you create or edit in this guide is an ordinary file on the root disk (not a pmxcfs
file), so you write it with the accessible, non-interactive shell form (a here-doc, `tee`, or a
drop-in `.d/` file), never a terminal editor like vim or nano. The full menu of accessible editing
methods is in the "Editing files accessibly" section of guide
[02 -- The shell and the API](02-the-shell-and-the-api.md). The one exception, as always, is
anything under `/etc/pve`: those pmxcfs files are written through their CLI tool.

## Key-only SSH (a drop-in config)

Debian 13 and PVE 9 ship an sshd that reads `/etc/ssh/sshd_config.d/*.conf` through an `Include`
near the top of `/etc/ssh/sshd_config`. The clean approach is to put all your hardening in a drop-in
and let it carry the policy.

Before you touch sshd, confirm a key login already works in a second window. Then create
`/etc/ssh/sshd_config.d/99-hardening.conf`:

```bash
tee /etc/ssh/sshd_config.d/99-hardening.conf <<'EOF'
# Root may log in with keys only (needed for root@pam and cluster/migration ops)
PermitRootLogin prohibit-password
# Disable all password-based auth (keys only)
PasswordAuthentication no
KbdInteractiveAuthentication no
# Optional extra hardening
PubkeyAuthentication yes
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
EOF
```

Why `prohibit-password` and not `no`: on a single node the only administrative login is `root@pam`.
`PermitRootLogin no` removes it entirely. `prohibit-password` keeps root reachable by SSH key while
refusing root passwords, which is the official Proxmox recommendation; cluster migrations also rely
on root SSH.

Apply it safely, in this exact order. The order matters because a mistake here is a lockout:

```bash
# 1. A key login already works in another window (confirmed above).
# 2. Validate syntax BEFORE touching the running daemon:
sshd -t
# 3. Reload without dropping existing sessions:
systemctl reload ssh
```

On Debian 13 the unit is `ssh.service`, with `sshd.service` as an alias, so `systemctl reload ssh`
works. A reload re-reads the config without killing live connections, so your open session is the
safety net while you test.

### Verify it worked

From a separate, brand-new terminal, confirm you can still log in by key and that password auth is
now refused:

```bash
ssh root@HOST
ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no root@HOST
```

The first should succeed. The second should be refused (a "Permission denied" with no password
prompt accepted), which proves passwords are off. Keep your original session open until both checks
pass.

## fail2ban: protect SSH and the API

[fail2ban](GLOSSARY.md) watches authentication logs and temporarily bans IPs that fail too often,
which blunts brute-force attempts against both SSH and the Proxmox API. Install it:

```bash
apt update && apt install -y fail2ban
```

Do not edit `jail.conf` directly; put overrides in `/etc/fail2ban/jail.local`. Set `ignoreip` to
YOUR admin IP or subnet first, so you can never ban yourself; loopback is always ignored regardless.

File `/etc/fail2ban/jail.local`:

```bash
tee /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
# Exempt your own management IP/subnet so you can never ban yourself.
# Replace 192.0.2.10 with your real admin IP(s); loopback is always ignored.
# WARNING: if you leave 192.0.2.10 unchanged, fail2ban will load without
# error but will protect an address you do not own -- you still have no
# self-ban protection and can lock yourself out. You must replace it with
# your actual admin IP or subnet before starting fail2ban.
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
EOF
```

The `[proxmox]` jail needs a custom filter. Create `/etc/fail2ban/filter.d/proxmox.conf`:

```bash
tee /etc/fail2ban/filter.d/proxmox.conf <<'EOF'
[Definition]
failregex = pvedaemon\[.*authentication failure; rhost=<HOST> user=.* msg=.*
ignoreregex =
journalmatch = _SYSTEMD_UNIT=pvedaemon.service
EOF
```

One important caveat: the `[proxmox]` jail only catches failures against PVE authentication
[realms](GLOSSARY.md) (for example `root@pve` and other Proxmox-realm users). Logins via PAM
(`root@pam`) over the web are not logged the same way and are not caught by this jail; SSH brute
force against `root@pam` is covered by the `[sshd]` jail instead. Because PVE 9 logs to the systemd
journal, `backend = systemd` is correct and no separate log-file path is needed.

Enable and verify:

```bash
systemctl enable --now fail2ban
fail2ban-client status              # lists active jails
fail2ban-client status sshd         # banned IPs and failure counts
fail2ban-client status proxmox
# If you ever lock yourself out despite ignoreip, recover with:
fail2ban-client set sshd unbanip <IP>
```

### Verify it worked

```bash
fail2ban-client status
```

This lists the active jails; you should see both `sshd` and `proxmox`. If a jail is missing,
re-check `enabled = true` and the filter path.

## Firewall hardening baseline

Guide [11 -- Firewall](11-firewall.md) taught the firewall model and the full safe-enable procedure
in depth. This section gives only the recommended single-node hardening baseline ruleset; the
enabling itself is deferred to guide 11, because that is where the lockout-proof sequence lives.

In PVE 9 the firewall is iptables-based by default. PVE 9 also ships an nftables-based backend, but
it is opt-in: leave it on the iptables default until the node is otherwise stable. Guide 11 covers
the backend choice.

The recommended baseline for a single node. Edit `/etc/pve/firewall/cluster.fw` (a pmxcfs file, so
you manage it through the firewall tooling, as guide 11 shows) so its `[RULES]` section reads:

```text
[RULES]
IN SSH(ACCEPT) -log nolog                  # port 22, SSH
IN ACCEPT -p tcp -dport 8006 -log nolog    # Proxmox web UI / API
IN ACCEPT -p icmp                          # optional: ping for diagnostics
```

Note one deliberate omission. A general firewall baseline often also opens TCP `5900:5999` for the
noVNC and SPICE graphical consoles. You are a shell-only operator and never use those graphical
consoles for daily operation (the one exception is the attended install, guide
[08 -- Windows guests](08-windows-guests.md)); you reach guests through the serial console and
`pct enter`, so that rule is left out on purpose. The attended install does not need it either: it
connects over the already-open API port (8006) and the SPICE proxy (3128), not the `5900:5999`
console range, so opening that range would only widen your exposed surface for nothing.

Tighten further by restricting the API to your admin IP, so only your control station can reach port
8006:

```text
IN ACCEPT -source 192.0.2.10 -p tcp -dport 8006
```

Now defer the actual enabling to guide [11 -- Firewall](11-firewall.md) and follow its safe-enable
checklist exactly: keep a second SSH session open, run `pve-firewall compile` and confirm the SSH
and 8006 ACCEPT rules appear in the compiled output before anything can drop your source IP, then
set `enable: 1` in `cluster.fw [OPTIONS]`, and finally re-prove SSH and API access from a brand-new
session. Do not enable the firewall from this guide; the lockout-proof dance belongs to guide 11.

One more service to account for: if you installed `avahi-daemon` for `.local` name resolution in
guide [10 -- Networking](10-networking.md), it adds UDP `5353` (link-local multicast) and, on a host
with bridges, answers on every interface unless you scope it. Guide 10 hardens this with
`allow-interfaces=vmbr0` so it stays on the management LAN only. For a minimal host you can skip
avahi entirely and reach the host by its static IP, which keeps UDP `5353` off the box altogether.

## Stop using daily root

Reserve `root@pam` for recovery and do routine work as a dedicated `pve`-realm admin, with scoped
[API tokens](GLOSSARY.md) for scripts, cron, and monitoring so a leaked token never exposes the root
credential. Guide [13 -- Users, permissions, and API tokens](13-users-permissions-and-api-tokens.md)
teaches the full setup ([pveum](GLOSSARY.md), the dedicated admin, [roles](GLOSSARY.md) and
[ACLs](GLOSSARY.md), and tokens, including a read-only `PVEAuditor` token for monitoring); follow it
there rather than repeating it here. The principle is the one constant: `root@pam` is the
break-glass account you keep for emergencies, not your daily login.

## Memory and swap tuning

### Swap

A RAM-rich virtualization host should be reluctant to swap out VM memory. Lower the
[swappiness](GLOSSARY.md) sysctl to 10.

File `/etc/sysctl.d/99-swappiness.conf`:

```bash
tee /etc/sysctl.d/99-swappiness.conf <<'EOF'
vm.swappiness = 10
EOF

sysctl --system
```

Never place swap on a ZFS zvol: it can deadlock the host or cause IO storms, especially during
backups. With a btrfs root, keep swap small and on solid ground: a small dedicated swap partition on
the NVMe is cleanest, or a swapfile made correctly for btrfs (btrfs needs the file marked
`chattr +C` / nodatacow, or a properly preallocated swapfile). On 24 GB of RAM you can keep swap
small and lean mostly on RAM.

### ZFS ARC (when you import the external pool)

Because the root filesystem is btrfs and this guide adds ZFS later for an external pool, do not
assume the Proxmox installer already wrote the ZFS [ARC](GLOSSARY.md) cap you want. Check
`/etc/modprobe.d/zfs.conf`; if it is missing, says `zfs_arc_max=0`, or sets a cap too high for your
VM workload, set the cap yourself before you trust the external pool in regular use. Guide
[09 -- Storage](09-storage.md) covers the full rationale; the steps here are the cap itself.

Pick a modest cap for a USB-attached secondary pool, for example 4 GiB, which is `4294967296` bytes.
Edit `/etc/modprobe.d/zfs.conf`:

```bash
tee /etc/modprobe.d/zfs.conf <<'EOF'
options zfs zfs_arc_max=4294967296
EOF
```

If your chosen `zfs_arc_max` falls below `zfs_arc_min` (default roughly 1/32 of RAM), also set
`zfs_arc_min` to at most `zfs_arc_max` minus 1. Then rebuild the initramfs and reboot so the module
picks it up at boot:

```bash
update-initramfs -u -k all
reboot
```

After the reboot, verify the cap took effect:

```bash
cat /sys/module/zfs/parameters/zfs_arc_max
```

This should print the byte value you set. The point is to verify the actual running cap on this
host, not to rely on assumptions about what the installer did; see guide 09 for why and for the
storage context.

### Other tuning (optional)

Two more knobs, both genuinely optional on this hardware:

- CPU governor. Install the tool, then list the governors your CPU actually offers before you set
  one: `apt install -y linux-cpupower`, then `cpupower frequency-info` (or
  `cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors`). On this AMD Ryzen, if the
  kernel runs the `amd-pstate` driver in active mode only `performance` and `powersave` are offered;
  in passive or `acpi-cpufreq` mode you also get `ondemand`/`schedutil`. Set a power-aware one with
  `cpupower frequency-set -g ondemand` (or `schedutil`, the modern kernel default), and use
  `performance` only if you see latency-sensitive VM stalls. Make the choice persistent across
  reboots through a small systemd unit or `cpufrequtils`.
- [KSM (Kernel Samepage Merging)](GLOSSARY.md) and transparent hugepages are fine as they ship.
  `ksmtuned` is enabled by default but only fires above roughly 80% memory pressure, so it rarely
  activates on a lightly loaded node. Transparent hugepages default to `madvise`, which is the sane
  choice for a KVM host. Leave both as-is unless you are profiling a specific workload.

## Unattended upgrades: security only, Proxmox held back

Scope automatic updates to Debian security fixes only, and explicitly hold back Proxmox packages,
because an unattended `pve-manager`, kernel, or `pve-qemu-kvm` upgrade can change behaviour or
demand a reboot you did not schedule. That is the role of [unattended-upgrades](GLOSSARY.md) here.
Install it:

```bash
apt update && apt install -y unattended-upgrades apt-listchanges
```

File `/etc/apt/apt.conf.d/52unattended-upgrades-proxmox`:

```bash
tee /etc/apt/apt.conf.d/52unattended-upgrades-proxmox <<'EOF'
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
EOF
```

Enable the schedule. File `/etc/apt/apt.conf.d/20auto-upgrades`:

```bash
tee /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
```

Confirm the scope before you trust it:

```bash
unattended-upgrades --dry-run --debug 2>&1 | less
```

Proxmox itself is then upgraded manually and deliberately with `apt update && apt full-upgrade`,
after reading the release notes, and you reboot on your own schedule.

### Verify it worked

```bash
unattended-upgrades --dry-run --debug 2>&1 | less
```

Read the output and confirm that only Debian security packages appear in scope and that no Proxmox
or virtualization-core packages (`pve-manager`, the kernel packages, `pve-qemu-kvm`, `zfs.*`, and so
on) are listed for upgrade. If a held-back package shows up, re-check the `Package-Blacklist` block.

## Time sync (chrony)

[chrony](GLOSSARY.md) is the right NTP daemon for a server on Debian 13; installing it removes the
lighter-weight `systemd-timesyncd`. Accurate time matters for TLS, backups, logs, and the cluster
filesystem.

```bash
apt install -y chrony      # installing chrony removes systemd-timesyncd
systemctl enable --now chrony
chronyc tracking           # offset, stratum, last sync
chronyc sources -v         # configured time sources
timedatectl status         # look for "System clock synchronized: yes"
```

The config lives in `/etc/chrony/chrony.conf`; the Debian default `pool` lines are fine for a
homelab. Note that `ntpdate` is gone from trixie, so do not reach for it.

## Accessibility practices (a consolidation)

These principles run through the whole corpus; this section gathers them with cross-references
rather than re-deriving them. They are what make a shell-only, screen-reader workflow safe and
complete:

- Serial console on every VM. Add `--serial0 socket` and set the display to `serial0`, then attach
  with `qm terminal <vmid>` for a text console you can read. This replaces the inaccessible
  graphical console. Taught in guides
  [04 -- Talking to guests without a GUI](04-talking-to-guests-without-a-gui.md) and
  [06 -- Virtual machines with qm](06-virtual-machines-with-qm.md); do not re-derive it.
- Containers use `pct enter <vmid>` (or `pct console <vmid>`), both fully text-based; see guides
  [04 -- Talking to guests without a GUI](04-talking-to-guests-without-a-gui.md) and
  [05 -- Containers with pct](05-containers-with-lxc-and-pct.md).
- Drive everything through the API with `pvesh ... --output-format yaml` (or `json`), because the
  default text output uses ASCII-art borders that read poorly. The REST API is the canonical
  accessible control surface; see guide [02 -- The shell and the API](02-the-shell-and-the-api.md).
- The pmxcfs root-key safeguard. Because `/root/.ssh/authorized_keys` is a symlink into pmxcfs, a
  failed `pve-cluster` removes your key. Keep an independent copy in a real file outside `/etc/pve`
  so key login survives a pmxcfs failure:

  ```bash
  cp /etc/pve/priv/authorized_keys /root/.ssh/authorized_keys2
  chmod 600 /root/.ssh/authorized_keys2
  ```

  OpenSSH reads `authorized_keys2` by default (because the default `AuthorizedKeysFile` directive is
  `.ssh/authorized_keys .ssh/authorized_keys2`; if you have previously hardened `AuthorizedKeysFile`
  to a single path, this safeguard would not take effect and you should confirm which value is
  active), so the second file still lets you in when the first has vanished. Re-copy after changing
  keys. Guide [13 -- Users, permissions, and API tokens](13-users-permissions-and-api-tokens.md)
  explains the trap in full.

- Never disable password authentication on the only login path until a key login is proven in a
  separate session, and keep an emergency local-console recovery path in mind for the worst case.

## The checklist: day 1, day 2, ongoing

### Day 1 (initial hardening, done with two SSH sessions open)

1. Confirm SSH key login works for root in a second session.
2. Add the pmxcfs key safeguard:
   `cp /etc/pve/priv/authorized_keys /root/.ssh/authorized_keys2 ; chmod 600 /root/.ssh/authorized_keys2`.
3. Create `/etc/ssh/sshd_config.d/99-hardening.conf` (`prohibit-password`,
   `PasswordAuthentication no`); run `sshd -t`; `systemctl reload ssh`; re-verify login from a new
   session.
4. Add the firewall allow rules for SSH and 8006 in `cluster.fw`, then enable per the safe-enable
   checklist in guide [11 -- Firewall](11-firewall.md); re-verify SSH and API access.
5. Install and enable [chrony](GLOSSARY.md); confirm `timedatectl status` shows the clock
   synchronized.
6. Install [fail2ban](GLOSSARY.md) with the `[sshd]` and `[proxmox]` jails and the proxmox filter;
   set `ignoreip` to your admin IP; check `fail2ban-client status`.
7. Create the dedicated admin user and a read-only `PVEAuditor` monitoring token per guide
   [13 -- Users, permissions, and API tokens](13-users-permissions-and-api-tokens.md). The token is
   for external, remote, or cron monitoring tooling that hits the REST API over HTTPS; the on-host
   weekly `pvesh` reads in guide
   [15 -- Monitoring, maintenance, and notifications](15-monitoring-maintenance-and-notifications.md)
   run as `root@pam` at the host shell, not through this token.
8. Set `vm.swappiness = 10`; confirm no swap is on a ZFS zvol.
9. Set the ZFS ARC cap in `/etc/modprobe.d/zfs.conf`; `update-initramfs -u -k all`; reboot; verify
   `zfs_arc_max`.

### Day 2 (tuning and monitoring setup)

1. Configure [unattended-upgrades](GLOSSARY.md): Debian security only, Proxmox blacklisted,
   auto-reboot off; confirm with the dry-run.
2. Set the CPU governor (`ondemand` or `schedutil`) and make it persistent.
3. Set up [smartd](GLOSSARY.md) self-tests, filesystem scrubs, persistent [journald](GLOSSARY.md),
   and `glances` for live monitoring. These are taught in guide
   [15 -- Monitoring, maintenance, and notifications](15-monitoring-maintenance-and-notifications.md);
   follow it there.
4. Install `qemu-guest-agent` inside each guest for clean shutdowns and consistent backups; see
   guides [06 -- Virtual machines with qm](06-virtual-machines-with-qm.md) and
   [07 -- Cloud-init templates](07-cloud-init-templates.md).

### Ongoing

- Weekly: take a `pvereport` snapshot, read node status with
  `pvesh get /nodes/$(hostname)/status --output-format yaml`, and review `journalctl -p err -b`.
  These monitoring tasks are covered in guide
  [15 -- Monitoring, maintenance, and notifications](15-monitoring-maintenance-and-notifications.md).
- Weekly: a SMART check on the NVMe and a glance at `fail2ban-client status sshd` for attack volume
  (SMART detail is in guide 15).
- Monthly: confirm scrubs ran clean and run an NVMe extended (long) self-test; see guide 15.
- As needed: a deliberate, manual Proxmox upgrade (`apt update && apt full-upgrade` after reading
  the release notes), then reboot on your schedule.
- After any change to keys or the firewall, re-prove SSH and API access in a fresh session before
  closing your safety session, and rotate or expire API tokens on a schedule.

## Sources

- `research/round2-pve9/19-pve9-hardening-and-monitoring.md` -- the authoritative source for this
  guide, using its hardening half: the lockout pitfalls and golden rule; the SSH drop-in
  (`prohibit-password`, `PasswordAuthentication no`, the optional extras, the `sshd -t` then
  `systemctl reload ssh` apply order, and the `ssh.service` unit note); the fail2ban `jail.local`
  and `proxmox.conf` filter with the realm-only caveat; the firewall baseline ruleset and the
  restrict-to-admin-IP idea; the swappiness sysctl and the never-swap-on-a-zvol warning; the ZFS ARC
  cap (`zfs_arc_max`, `update-initramfs -u -k all`, the verify); the CPU-governor, KSM, and
  transparent-hugepage notes; the unattended-upgrades origins pattern and package blacklist; the
  chrony setup; the accessibility practices; and the day-1 / day-2 / ongoing checklist.
- `GLOSSARY.md` -- the canonical definitions reused here of [fail2ban](GLOSSARY.md),
  [swappiness](GLOSSARY.md), [KSM (Kernel Samepage Merging)](GLOSSARY.md), [chrony](GLOSSARY.md),
  [unattended-upgrades](GLOSSARY.md), [ARC](GLOSSARY.md), and [pve-firewall](GLOSSARY.md); plus the
  role names `Administrator` and `PVEAuditor` reused from guide
  [13 -- Users, permissions, and API tokens](13-users-permissions-and-api-tokens.md).
- [Sysadmin chapter (ZFS ARC limit, swappiness, swap-on-ZFS)](https://pve.proxmox.com/pve-docs/chapter-sysadmin.html)
  -- the memory and swap tuning details.
- [Proxmox VE Firewall chapter](https://pve.proxmox.com/pve-docs/chapter-pve-firewall.html) -- the
  enable procedure and the SSH and 8006 allow rules behind the baseline.
- [Fail2ban wiki](https://pve.proxmox.com/wiki/Fail2ban) -- the `[proxmox]` jail, the `proxmox.conf`
  filter, and the systemd backend.
- [Time Synchronization wiki](https://pve.proxmox.com/wiki/Time_Synchronization) -- chrony as the
  default NTP daemon.
- [pveum(1) manual](https://pve.proxmox.com/pve-docs/pveum.1.html) -- the dedicated admin and API
  tokens deferred to guide 13.

---

Previous: [13 -- Users, permissions, and API tokens](13-users-permissions-and-api-tokens.md) | Next:
[15 -- Monitoring, maintenance, and notifications](15-monitoring-maintenance-and-notifications.md)
