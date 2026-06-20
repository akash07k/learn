# Repositories, updates, and the host

## What you'll be able to do

By the end of this guide your fresh Proxmox host will be in a correct, updatable state: the right
APT repositories enabled, the system fully upgraded, and the host internals a shell admin must know
laid out plainly. This is your first real configuration work on the host. Up to now (guides 01
and 02) you installed the host and toured it read-only; here you make the first changes that stick,
so the safety notes matter.

Everything below is done over SSH as root on the Proxmox host, the way guide 02 left you. Before you
start, confirm the version you are on, because some of this is specific to Proxmox VE 9:

```bash
pveversion
```

You should see a `9.x` release. If you are on 8.x, the repository format differs (one-line `.list`
files instead of deb822 `.sources`); the migration note in the next section covers crossing that
gap.

## Fix the repositories

A fresh Proxmox VE 9 install ships with the **enterprise** repository enabled. That repository
requires a paid subscription key, and without one, `apt update` fails on it with a 401 error. For a
single-node lab you want the opposite: the enterprise repo disabled, and the free
**pve-no-subscription** repo enabled. This is the first thing to fix, because nothing else updates
until `apt update` runs clean.

### The deb822 .sources format

Proxmox VE 9 (on Debian 13 "trixie") uses the deb822 `.sources` format for APT repositories:
multi-line stanzas in `*.sources` files under `/etc/apt/sources.list.d/`. This replaces the old
one-line `deb https://...` entries in `*.list` files that Proxmox VE 8 used. Both formats still
work, but a fresh 9 install ships only `.sources` files, and the docs recommend the new format.

Each repository is one stanza, and the fields are capitalized and colon-terminated:

- `Types:` - usually `deb` (binary packages); `deb-src` adds source packages.
- `URIs:` - the mirror base URL.
- `Suites:` - the release codename, here `trixie`.
- `Components:` - the repository's component, such as `pve-enterprise`, `pve-no-subscription`, or
  `main`.
- `Signed-By:` - the absolute path to the keyring that must have signed the repository.
- `Enabled:` - optional; `Enabled: no` disables a stanza without deleting it.

One thing trips up returning Proxmox VE 8 users: editing the file you remember
(`pve-enterprise.list`) does nothing, because the live config is now in `pve-enterprise.sources`.
Always look at the `*.sources` files first.

### The archive keyring

Proxmox repositories in version 9 are verified by a keyring shipped in the `proxmox-archive-keyring`
package, installed at `/usr/share/keyrings/proxmox-archive-keyring.gpg`. Every Proxmox `.sources`
stanza points at it with `Signed-By:`. (In Proxmox VE 8 this was `proxmox-release-bookworm.gpg`.) On
a normal install the package is already present and the key is in place, so you do not normally
fetch it by hand. The Debian base repositories use the distribution keyring at
`/usr/share/keyrings/debian-archive-keyring.gpg` instead.

### Disable the enterprise repo

The cleanest shell-only way to disable a repository is to append `Enabled: no` to its stanza. This
keeps the file in place as a template and is fully scriptable, which is why it is preferred here
over deleting the file.

The enterprise repository lives in this file. To create or change any of the flat config files in
this guide (the `.sources` files here, `/etc/default/grub`, and `/etc/hosts` later) without a
terminal editor, use the shell-only methods (a here-doc, `tee`, or `sed`) or VS Code Remote-SSH from
guide 02's "Editing files accessibly".

Edit `/etc/apt/sources.list.d/pve-enterprise.sources`. As shipped it holds this single stanza:

```text
Types: deb
URIs: https://enterprise.proxmox.com/debian/pve
Suites: trixie
Components: pve-enterprise
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
```

Because the file holds a single stanza, appending one line disables it:

```bash
echo 'Enabled: no' >> /etc/apt/sources.list.d/pve-enterprise.sources
```

Run this once, not on every pass: a bare `>>` appends a fresh `Enabled: no` line each time, and a
stanza with two `Enabled:` lines is ambiguous. Confirm there is exactly one with
`grep -c '^Enabled:' /etc/apt/sources.list.d/pve-enterprise.sources` (it should print `1`); if you
see more, delete the extras so a single `Enabled:` line remains. To stay idempotent on a host you
may re-run, set the line in place instead of appending:

```bash
sed -i '/^Enabled:/d' /etc/apt/sources.list.d/pve-enterprise.sources
echo 'Enabled: no' >> /etc/apt/sources.list.d/pve-enterprise.sources
```

To re-enable it later (once you have a subscription key), delete that line or set the single
`Enabled:` line to `Enabled: yes`.

### Enable the no-subscription repo

Note the filename here carefully. The Proxmox-managed non-enterprise repositories live in
`proxmox.sources`, not in a file named after the component. The no-subscription and test components
are both expressed as components of this same file and URI.

Create or edit `/etc/apt/sources.list.d/proxmox.sources` so it contains the no-subscription stanza:

```text
Types: deb
URIs: http://download.proxmox.com/debian/pve
Suites: trixie
Components: pve-no-subscription
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
```

The no-subscription repository is freely accessible and is the standard choice for a non-production
single node. There is also a `pve-test` component (same URI, `Components: pve-test`) for trying
brand-new fixes before they reach no-subscription, but you should not leave it enabled on a host you
care about. Run only one of `pve-enterprise`, `pve-no-subscription`, or `pve-test` at a time.

If a `ceph.sources` file exists and you do not run Ceph (a single node with no cluster does not need
it), disable it the same way you disabled enterprise, because a stale Ceph repository is a common
cause of `apt update` errors on a fresh host.

### The Debian base repositories

The Debian base lives in deb822 too, in `/etc/apt/sources.list.d/debian.sources` (in Proxmox VE 8
these were lines in `/etc/apt/sources.list`). A correct single-node base looks like this, and it is
worth reading now because the microcode step later depends on the `non-free-firmware` component
being present.

File `/etc/apt/sources.list.d/debian.sources`:

```text
Types: deb deb-src
URIs: http://deb.debian.org/debian
Suites: trixie trixie-updates
Components: main contrib non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb deb-src
URIs: http://security.debian.org/debian-security
Suites: trixie-security
Components: main contrib non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
```

You can drop `deb-src` from the `Types:` lines if you never build from source; it makes `apt update`
slightly faster.

### Migrating from Proxmox VE 8 (one-line .list files)

If you came from Proxmox VE 8 and still have one-line `.list` files, the official way to convert
them is the APT 3.0 subcommand on trixie:

```bash
apt modernize-sources
```

It rewrites each `.list` file into an equivalent `.sources` file and keeps the original as a `.bak`,
disabling the old entry so it does not double-load. The Proxmox VE 9 admin guide recommends running
it to avoid apt issues on trixie. After you verify the new `.sources` files, you can delete the
leftover `.bak` files. On a fresh 9 install there is nothing to modernize; this is purely a
migration step.

### The GUI subscription nag (ignore it)

After login the web GUI shows a "No valid subscription" popup when no key is present. It is purely
cosmetic and has zero effect on a shell-only workflow: `apt`, `pct`, `qm`, and `pvesh` all work
identically with or without it. Since you never open the GUI, you can simply ignore it. Removing it
is a one-file JavaScript patch that gets overwritten on the next package update, so for a CLI-only
operator it is not worth the bother.

### Verify the repositories

With enterprise disabled and no-subscription enabled, the package index updates with no errors:

```bash
apt update
```

A clean run prints the repositories it hit and ends without any 401 error and without a Ceph or
duplicate-source error. If you see a 401, the enterprise repo is still enabled; re-check that
`Enabled: no` line. If you see a Ceph error, disable the stale `ceph.sources`.

## Update safely

Now bring the host fully up to date. There is one hard rule here.

Always use `full-upgrade`, never plain `apt upgrade`:

```bash
apt update
apt full-upgrade
```

The reason is important. Proxmox kernel and core-package transitions frequently need to install new
packages and remove obsolete ones. Plain `apt upgrade` refuses to add or remove packages, so it will
hold the kernel and core updates back, leaving a half-updated system that may not boot after a
reboot. `apt full-upgrade` (the same operation the older `apt-get dist-upgrade` did) is allowed to
make those changes, so it lands a complete, consistent update. This is a hard rule in the Proxmox
docs for both routine updates and the 8-to-9 major upgrade.

Proxmox also ships a thin wrapper that does the same apt workflow and additionally warns you about
kernel updates that need a reboot and about running guests:

```bash
pveupgrade
```

On a single node either path is fine: `pveupgrade` is equivalent to `apt update && apt full-upgrade`
plus those safety checks.

After upgrading, check what you have. This is the canonical "what versions am I running" command,
and the first thing to paste when asking for help:

```bash
pveversion -v
```

It prints the running kernel plus every key Proxmox package version (pve-manager, the kernel,
qemu-server, and the rest), each on its own labelled line, which reads cleanly with a screen reader.

If the upgrade installed a new kernel, the host needs a reboot to run it. You can do the reboot
together with the microcode reboot later in this guide rather than rebooting twice.

## The daemons

Proxmox runs a small set of systemd services that together make the host work. You inspect and
control them with ordinary `systemctl` and `journalctl`, and on a single node there is exactly one
you may safely turn off. Know them by name.

- `pve-cluster` (the binary is `pmxcfs`) is the heart of the install. It provides the `/etc/pve`
  filesystem (pmxcfs) you met in guide 02, the single source of truth for all config. It runs even
  on a standalone node, and if it is down, `/etc/pve` is unavailable and almost nothing else works.
  Never disable it. Disabling pmxcfs is the most common dangerous mistake on a single node, because
  it bricks config access.
- `pvedaemon` is the local REST API server. It listens on `127.0.0.1:85` only and runs as root;
  every privileged API call goes through it.
- `pveproxy` is the API proxy and web server, listening on port 8006 as the `www-data` user. It
  serves the API (and the GUI you do not use) to the network and forwards privileged calls to
  `pvedaemon`. If the API is unreachable but the host is up, this is usually the service to restart.
- `pvestatd` is the status daemon. It polls the status of guests and storages and publishes it. If
  status or graphs go stale, restart this.
- `pvescheduler` is the scheduler daemon. It runs scheduled jobs: backup jobs (from `jobs.cfg`) and
  other periodic work. It is central in Proxmox VE 9, having taken over duties older versions ran
  from cron.

Inspect any of them with `systemctl status`, and read one service's log with `journalctl -u`:

```bash
systemctl status pve-cluster.service
systemctl status pveproxy.service pvedaemon.service pvestatd.service pvescheduler.service
journalctl -u pveproxy -b --no-pager
```

If you ever need to restart them after an upgrade or a certificate change, order matters: bring up
`pve-cluster` first (pmxcfs must be healthy), then `pvedaemon`, then `pveproxy`, then `pvestatd` and
`pvescheduler`. Restarting `pveproxy` before pmxcfs is healthy can leave the API failing to serve.

Do not try to save resources by disabling `pvedaemon`, `pveproxy`, `pvestatd`, or `pvescheduler`.
They are functional, not cluster overhead; turning them off breaks the API, status, and scheduled
backups respectively.

### High-availability services on a single node

Two services exist only to serve clustering and high availability, and on a single standalone node
they do nothing useful: `pve-ha-lrm` (the local resource manager) and `pve-ha-crm` (the cluster
resource manager). They have no purpose without a cluster and occasionally write a timestamp to
disk. It is safe to stop and disable them on a single node:

```bash
systemctl disable --now pve-ha-lrm pve-ha-crm
```

Prefer `disable --now` over `mask` here. Masking a Proxmox service can make `apt`/`dpkg` upgrades
print noisy errors, because the package scripts try to restart units they expect to exist. A
disabled unit still will not start on boot, and it keeps upgrades quiet. (The `corosync` service is
the cluster transport; on a never-clustered node it has no config file and never starts, so leave it
alone.)

## Boot on a btrfs root

This host has its root on btrfs, and that fact changes where boot configuration lives. The important
gotcha: a btrfs-root Proxmox host boots via **GRUB**, not systemd-boot, so kernel and serial-console
command-line changes go in `/etc/default/grub`, and the file `/etc/kernel/cmdline` is ignored here.
Getting this wrong is a classic trap.

The selection rule the installer follows is: a ZFS root on UEFI with Secure Boot off uses
systemd-boot; every other layout, including btrfs root, uses GRUB. So this btrfs node uses GRUB in
UEFI mode. The installer also placed a 512 MB EFI System Partition (the ESP) on the NVMe, and that
ESP is managed by `proxmox-boot-tool`, which copies the kernel and initrd onto it and configures
GRUB to boot from them.

Confirm what your host is actually doing before trusting any of this. The box's own output is
authoritative:

```bash
proxmox-boot-tool status
proxmox-boot-tool kernel list
findmnt /
```

`proxmox-boot-tool status` lists the managed ESP and prints a `(grub)` (or `grub-uefi`) marker,
which is the proof that GRUB is the bootloader and the tool is in charge.
`proxmox-boot-tool kernel list` shows every bootable kernel and which (if any) is pinned.
`findmnt /` confirms the root filesystem is btrfs.

### The gotcha, stated plainly

Because this node uses GRUB, the kernel command line lives in `/etc/default/grub`, in the
`GRUB_CMDLINE_LINUX_DEFAULT` line. After editing it, run `proxmox-boot-tool refresh` directly so the
managed ESP is regenerated and synced. Current Proxmox docs also describe `update-grub` as a valid
GRUB apply path, and on proxmox-boot-tool systems it can trigger the refresh hook, but this corpus
uses `proxmox-boot-tool refresh` as the explicit command because it names the ESP sync step.

Do not edit `/etc/kernel/cmdline` on this host. That file is the systemd-boot path, and under GRUB
it is silently ignored. If you put kernel or serial-console flags there and they have no effect,
this is why.

For example, to add a serial console to the host's own boot (so even the GRUB menu and the kernel
boot messages come over the serial line, which is the single biggest early-boot accessibility win)
you would set the cmdline in `/etc/default/grub`.

Edit `/etc/default/grub`:

```text
GRUB_CMDLINE_LINUX_DEFAULT="quiet console=tty0 console=ttyS0,115200n8"
```

Then apply it with the explicit proxmox-boot-tool sync path:

```bash
proxmox-boot-tool refresh
```

The last `console=` listed becomes the primary console, so putting `ttyS0` last sends the boot log
and login prompt to serial while still keeping the screen. The point to carry from here is the path:
kernel cmdline goes in `/etc/default/grub`, then this guide applies it with
`proxmox-boot-tool refresh`. One caveat to set expectations honestly: a host serial console only
helps if this node actually has a serial port or IPMI (Intelligent Platform Management Interface)
Serial-over-LAN, and a mini-PC reached entirely over the network often has neither. So treat the
serial cmdline above as a boot-output accessibility aid where the hardware exists, not as a
guaranteed way back in. The corpus does not rely on a host serial console for lockout recovery: the
break-glass story in the networking and firewall guides is the live second SSH session, the
independent `authorized_keys2` key, and, as a physical last resort, the Proxmox installer ISO in
Rescue Boot.

## Rescue Boot from the installer ISO (the physical last resort)

The serial console above, a second SSH session, and the `authorized_keys2` key all assume the host
still boots and still reaches the network. When none of that is true (a bad kernel, a broken
bootloader, or a network or firewall edit that survives a reboot), the last resort is to boot the
Proxmox installer ISO and choose "Rescue Boot" from its boot menu. Rescue Boot does not reinstall
anything: it boots your existing on-disk system using the kernel from the ISO, so you land in your
real root filesystem with a local root shell. From there you fix whatever broke and reboot normally:
`pve-firewall stop` to undo a firewall lockout, edit `/etc/network/interfaces` then `ifreload -a` to
fix networking, or pin a known-good kernel with `proxmox-boot-tool`.

The honest accessibility caveat: selecting the "Rescue Boot" entry happens on the installer's boot
menu, which is an on-screen video stream a screen reader cannot read. So this step needs either a
sighted helper for a moment, or an IP-KVM or the host's IPMI remote console (which a mini-PC often
does not have). That is exactly why this is the last rung of the lockout ladder, below the live
second SSH session and the `authorized_keys2` key, both of which need no screen. If the host cannot
be recovered in place even this way, the full remote rebuild is guide
[20 -- Reinstalling the host remotely](20-reinstalling-the-host-remotely.md).

## AMD microcode

This host has an AMD Ryzen CPU, and it ships with whatever microcode the mini-PC's UEFI baked in,
which is often old. The `amd64-microcode` package lets Linux load a newer AMD microcode revision at
early boot, fixing CPU errata and security vulnerabilities. A patched microcode is also usually
faster than running with the kernel's software mitigations on unpatched silicon. It is loaded fresh
at every boot (it is not written to the CPU permanently), so it is re-applied each time the host
starts. This is worth doing on the Ryzen.

The package comes from Debian's `non-free-firmware` component, which is why the `debian.sources`
stanza above includes `non-free-firmware` in its `Components:` line. With that component present,
install it and rebuild the early-boot image:

```bash
apt update
apt install amd64-microcode
update-initramfs -u -k all
```

The `update-initramfs -u -k all` rebuilds the initramfs for every installed kernel, embedding the
new microcode so it loads early at boot. (The package's own install step usually does this, so this
is belt-and-suspenders.) On a proxmox-boot-tool host, `update-initramfs` automatically triggers a
refresh that copies the new initramfs to the ESP, so you do not call `proxmox-boot-tool refresh`
separately here.

Microcode is applied at boot, so a reboot is required for it to take effect:

```bash
reboot
```

If the upgrade earlier installed a new kernel, this single reboot lands both the new kernel and the
new microcode.

### Verify the microcode

After the host comes back, confirm the microcode loaded early:

```bash
dmesg | grep -i microcode
```

You want a line like "microcode updated early to revision 0x...". That confirms the early load
worked. If you only see a late or "will be updated" message, the initramfs was not rebuilt or the
ESP was not refreshed; re-run `update-initramfs -u -k all` and reboot.

## Host identity and time

Two host basics underpin everything else: the hostname must resolve to a real IP, and the clock must
be accurate.

### The hostname must resolve to the management IP

Proxmox derives the node name from the system hostname, and the pmxcfs node directory
`/etc/pve/nodes/<name>/` is named after it. Proxmox requires that hostname to resolve to the host's
real, non-loopback **management IP** through `/etc/hosts`.

The management IP is simply the Proxmox host's address on your LAN: the IPv4 address you SSH to. It
must not be a loopback address (`127.0.0.1` or `127.0.1.1`). This is a classic single-node footgun:
if the hostname only resolves to a loopback address, pmxcfs and the services that depend on it
misbehave (the API may bind to the wrong address, certificates can be wrong).

The `/etc/hosts` file must contain a line mapping the management IP to the fully qualified name and
the short name.

File `/etc/hosts`, the line to get right (use the FQDN you set in guide 01, for example
`pve.home.arpa`):

```text
192.168.1.10 pve.home.arpa pve
```

The format is: IP address, one or more spaces, the FQDN, a space, then the short hostname. Use the
host's actual management IP and names, not the loopback. To change one existing line in place
without a terminal editor, `sed` it (taking a backup) and read it back, the accessible way from
guide 02's "Editing files accessibly":

```bash
sed -i.bak 's/^.*\bpve\.home\.arpa\b.*$/192.168.1.10 pve.home.arpa pve/' /etc/hosts
```

To inspect the current state:

```bash
cat /etc/hosts
getent hosts $(hostname)
```

`cat /etc/hosts` shows the raw file. `getent hosts $(hostname)` resolves the hostname through the
system's name-service stack and must print the management IP, not a `127.x` address. If it returns a
loopback address, edit `/etc/hosts` so the correct line is present and the hostname does not appear
on any `127.x` line.

One more caution: because guest config files live under `/etc/pve/nodes/<name>/`, renaming the host
after you have created guests is disruptive. Decide the name now and treat it as fixed once guests
exist.

### Time synchronization with chrony

The default time daemon since Proxmox VE 7 (so also in 9) is **chrony**, and a fresh install ships
it preconfigured against public NTP servers. Accurate time matters even on a single node, for TLS
certificate validity, for backup and scheduler timing, and for log correlation.

You usually do not need to change anything; you just confirm it is synchronized:

```bash
timedatectl
chronyc sources
```

`timedatectl` should report "NTP service: active" and "System clock synchronized: yes".
`chronyc sources` lists the time sources and their state. If you want to point at specific servers,
add them in `/etc/chrony/chrony.conf` (lines of the form `server ntp1.example.com iburst`) and
restart with `systemctl restart chronyd`. The timezone is set separately with
`timedatectl set-timezone`, for example `timedatectl set-timezone America/New_York`.

## Verify the whole host

Run these from the shell after the work above (and after the reboot for the kernel and microcode).
Each is text-only and reads cleanly.

The package index updates with no repository errors:

```bash
apt update
```

A clean run ends with no 401 (enterprise) error, no Ceph error, and no duplicate-source warning.

The component versions list:

```bash
pveversion -v
```

This prints the running kernel and every key Proxmox package on its own line. Confirm the `release`
is the `9.x` you expected and that a kernel line is present.

The bootloader and ESP are healthy:

```bash
proxmox-boot-tool status
```

This lists the managed ESP with a `(grub)` marker. Seeing the ESP listed (not "uninitialized")
confirms `proxmox-boot-tool` is managing boot, which is what makes the `/etc/default/grub` plus
`proxmox-boot-tool refresh` path correct.

The microcode loaded early:

```bash
dmesg | grep -i microcode
```

A "microcode updated early to revision 0x..." line confirms the AMD microcode is active.

If all four read as described, the host is in a correct, updatable state: repositories clean, fully
upgraded, booting via the right path, microcode loaded, identity and time correct. Part B of the
series, beginning with guide
[04 -- Talking to guests without a GUI](04-talking-to-guests-without-a-gui.md), builds on this
baseline.

## Sources

- `research/round2-pve9/03-pve9-repositories-and-updates.md` - the deb822 `.sources` format and
  field anatomy, the exact `pve-enterprise.sources` / `proxmox.sources` / `debian.sources` stanzas,
  the `proxmox-archive-keyring` and `Signed-By` path, the `Enabled: no` disable approach,
  `apt modernize-sources`, the `apt full-upgrade` (never plain `upgrade`) rule, `pveupgrade`,
  `pveversion -v`, and the cosmetic GUI subscription nag.
- `research/round2-pve9/05-pve9-host-and-services.md` - the core daemons (`pve-cluster`/pmxcfs must
  never be disabled, `pvedaemon`, `pveproxy`, `pvestatd`, `pvescheduler`), inspecting and restarting
  them with `systemctl`/`journalctl`, the safe `disable --now pve-ha-lrm pve-ha-crm` on a single
  node, the hostname-to-management-IP requirement in `/etc/hosts` (not loopback), and chrony time
  sync with `timedatectl` and `chronyc sources`.
- `research/round2-pve9/04-pve9-boot-kernel-microcode.md` - btrfs root boots via GRUB, the kernel
  and serial cmdline in `/etc/default/grub` then the explicit `proxmox-boot-tool refresh` path (not
  `/etc/kernel/cmdline`), `proxmox-boot-tool status` and `kernel list`, installing `amd64-microcode`
  from `non-free-firmware`, `update-initramfs -u -k all`, and verifying with
  `dmesg | grep -i microcode`.
- `GLOSSARY.md` and `CONTEXT.md` - the canonical definitions of deb822 `.sources`, pmxcfs,
  `proxmox-boot-tool`, btrfs, the Proxmox host, and the control station.
- Proxmox VE documentation:
  [Package Repositories](https://pve.proxmox.com/wiki/Package_Repositories),
  [the sysadmin chapter](https://pve.proxmox.com/pve-docs/chapter-sysadmin.html),
  [Host Bootloader](https://pve.proxmox.com/wiki/Host_Bootloader),
  [Firmware Updates](https://pve.proxmox.com/wiki/Firmware_Updates),
  [Service daemons](https://pve.proxmox.com/wiki/Service_daemons), and
  [Time Synchronization](https://pve.proxmox.com/wiki/Time_Synchronization).

---

Previous: [02 -- The shell and the API](02-the-shell-and-the-api.md) | Next:
[04 -- Talking to guests without a GUI](04-talking-to-guests-without-a-gui.md)
