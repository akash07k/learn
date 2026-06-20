# Topic 01: Installation, Host System Setup, and Package/Repository Management

Audience note: single Proxmox VE (PVE) node on a personal PC, driven entirely from the shell. No
clustering, HA, RAID, or Ceph cluster. Every step below is a shell command or an edit to a named
config file. Target: PVE 8.x (Debian 12 "bookworm"). Where PVE 9.x (Debian 13 "trixie") differs, it
is called out explicitly, because the 9.x line changed the APT repository format and several file
paths.

Version landscape (important context):

- PVE 8.x is built on Debian 12 "bookworm". APT repos use the classic one-line `deb ...` format in
  `/etc/apt/sources.list`.
- PVE 9.x is built on Debian 13 "trixie". APT repos moved to the **deb822** (`.sources`) format
  under `/etc/apt/sources.list.d/`, and the signing keyring is `proxmox-archive-keyring.gpg`. Both
  formats are covered below.
- Confirm your version at any time with `pveversion`.

---

## 1. Installing PVE on a single PC: ISO installer vs. on top of Debian

Source: PVE docs, "Installing Proxmox VE" / chapter-pve-installation.html
([Installing Proxmox VE](https://pve.proxmox.com/pve-docs/chapter-pve-installation.html))

### 1a. The official ISO installer (recommended path)

The official ISO is a full Debian system plus all PVE packages. It guides through partitioning,
basic system config, and package installation. For a blind/CLI user the relevant accessibility
points are:

- The graphical installer is **not** screen-reader friendly. Since PVE 8.1 there is a
  **terminal/console (TUI) installer** option in the ISO boot menu ("Install Proxmox VE (Terminal
  UI)" and "Terminal UI, Debug Mode"). This is the most accessible installer path and collects the
  same answers (target disk, filesystem, country/timezone/keymap, root password, admin email,
  management NIC, hostname/FQDN, IP/gateway/DNS).
- An even more automated route is the **automated/unattended installer**
  (`proxmox-auto-install-assistant`, PVE 8.2+): you bake an `answer.toml` into the ISO and it
  installs with zero interaction. Useful if the boot menu itself is hard to operate. Keys in
  answer.toml: `[global]` (keyboard, country, fqdn, mailto, timezone, root_password), `[network]`,
  `[disk-setup]`.
- Filesystem choice at install time for a single non-RAID disk: pick **ext4** (default, simplest) on
  LVM, or **ZFS (RAID0 / single disk)** if you want snapshots/compression. Avoid any
  mdraid/hardware-RAID expectations. ext4+LVM is the least surprising default.
- Default disk layout (ext4/LVM): an LVM volume group named `pve` with logical volumes `root` (the
  OS), `swap`, and `data` (a thin pool used for guest disks). On small disks the installer may skip
  the separate `data` thin pool.

After install, everything else in this guide is done over SSH or at the console.

### 1b. Installing PVE on top of an existing Debian 12 (advanced, brief)

Source: PVE docs "Install Proxmox VE on Debian" (chapter-pve-installation.html) and wiki "Install
Proxmox VE on Debian 12 Bookworm".

This is officially "recommended only for advanced users" - it requires a correct base Debian
install, manual network bridge setup, and correct local storage (LVM/ZFS) by hand. Outline:

1. Install a minimal Debian 12 with a static IP and a resolvable FQDN.
2. Ensure `/etc/hosts` maps the FQDN to the static IP (see Section 8).
3. Add the PVE no-subscription repo + key (Section 4), then:

```bash
apt update
apt install proxmox-default-kernel # installs and boots the PVE kernel first
reboot
apt install proxmox-ve postfix open-iscsi chrony
apt remove os-prober # avoid os-prober scanning guest disks
```

1. Optionally remove the stock Debian kernel after confirming the PVE kernel boots.

Gotcha: you must reboot into the Proxmox kernel **before** installing the `proxmox-ve` metapackage
on newer guides; install `proxmox-default-kernel` and reboot first. The ISO route avoids all of this
and is strongly preferred for a home lab.

---

## 2. System requirements / host sizing for a single node

Source: PVE docs "System Requirements" (chapter-pve-installation.html).

- 64-bit CPU with hardware virtualization: **Intel VT-x** or **AMD-V** (enable in BIOS/UEFI). For
  PCI(e) passthrough you additionally need **VT-d / AMD-Vi (IOMMU)**.
- Minimum RAM: ~2 GB for the PVE OS and services, **plus** RAM for every guest. ZFS wants extra RAM
  for its ARC cache (rule of thumb ~1 GB per TB of data, tunable).
- Storage: fast disks; **SSD/NVMe strongly recommended** for the OS and guest images.
- For a home lab single node, practical guidance: 16 GB+ RAM is comfortable, 8 GB is a tight floor
  once you run a couple of VMs. Separate the OS disk from bulk guest storage if you can, but a
  single disk is fully supported.
- Verify virtualization is active after install:

```bash
lscpu | grep -E 'Virtualization|vmx|svm'
egrep -c '(vmx|svm)' /proc/cpuinfo # >0 means HW virt present
```

- Verify IOMMU (only needed for passthrough): after adding `intel_iommu=on` (Intel) or
  `amd_iommu=on` (AMD) to the kernel cmdline and rebooting:

```bash
dmesg | grep -e DMAR -e IOMMU
```

---

## 3. First-boot shell configuration

After the ISO install and first boot, log in as `root` at the console or over SSH (`ssh root@<ip>`).
Recommended first steps, all CLI:

- Confirm version and node identity:

```bash
pveversion -v # full component/version list
hostnamectl # hostname
ip a # interfaces and the vmbr0 management bridge
```

- Set timezone and verify time sync (Section 9).
- Fix repositories so `apt update` is clean (Section 4) - by default the ISO enables the
  **enterprise** repo, which 403s without a subscription and breaks updates.
- Update the system (Section 6).
- (Optional) remove the GUI subscription nag if you ever open the web UI (Section 5).
- Create an unprivileged admin user / SSH key login and harden SSH as you would any Debian host
  (`/etc/ssh/sshd_config`). PVE keeps its own auth realm (`pam`/`pve`) for the API, but root over
  SSH still uses normal Linux/PAM.

The management bridge `vmbr0` is created by the installer and carries the host IP; guests attach to
it. Do not delete it.

---

## 4. Package repositories: enterprise vs. no-subscription vs. test, and Ceph

Source: PVE docs "Package Repositories" (chapter-sysadmin.html) and wiki
[Package Repositories](https://pve.proxmox.com/wiki/Package_Repositories).

PVE adds **three** Proxmox repos on top of the base Debian repos:

- **pve-enterprise** - stable, production, **requires a paid subscription** (enabled by default on
  the ISO; returns HTTP 401/403 without a valid key).
- **pve-no-subscription** - free, slightly less rigorously tested, the right choice for a home lab.
  NOT recommended for production by Proxmox, but standard for home use.
- **pve-test / pvetest** - bleeding-edge, for developers; avoid on a daily-driver host.

There is a matching trio of **Ceph** repos (`ceph-<release>`, e.g. `ceph-quincy`, `ceph-reef`,
`ceph-squid` on 8.x; `ceph-tentacle` on 9.x) with `enterprise`, `no-subscription`, and `test`
components. On a single non-cluster node you almost never need Ceph; only add a Ceph repo if you
deliberately install Ceph packages. Mixing Ceph repos causes install failures - keep at most one.

### 4a. PVE 8.x (bookworm) - classic one-line format

Default enterprise repo file (disable it): `/etc/apt/sources.list.d/pve-enterprise.list` contains:

```text
deb https://enterprise.proxmox.com/debian/pve bookworm pve-enterprise
```

Disable it by commenting the line out (prepend `#`), or delete the file:

```bash
sed -i 's/^deb/#deb/' /etc/apt/sources.list.d/pve-enterprise.list
```

There is usually a parallel `/etc/apt/sources.list.d/ceph.list` with an enterprise Ceph line -
comment it out the same way if present.

Add the no-subscription repo (e.g. its own file `/etc/apt/sources.list.d/pve-no-subscription.list`
or append to `/etc/apt/sources.list`):

```text
deb http://download.proxmox.com/debian/pve bookworm pve-no-subscription
```

Base Debian repos in `/etc/apt/sources.list` should look like:

```text
deb http://deb.debian.org/debian bookworm main contrib
deb http://deb.debian.org/debian bookworm-updates main contrib
deb http://security.debian.org/debian-security bookworm-security main contrib
```

PVE 8.x signing key (Debian ships it via the `proxmox-ve` package, but to add manually):

```bash
wget https://enterprise.proxmox.com/debian/proxmox-release-bookworm.gpg \
 -O /etc/apt/trusted.gpg.d/proxmox-release-bookworm.gpg
```

### 4b. PVE 9.x (trixie) - new deb822 `.sources` format

PVE 9 uses deb822 files and the keyring `/usr/share/keyrings/proxmox-archive-keyring.gpg`.

Enterprise (disable it): `/etc/apt/sources.list.d/pve-enterprise.sources`

```text
Types: deb
URIs: https://enterprise.proxmox.com/debian/pve
Suites: trixie
Components: pve-enterprise
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
```

Disable by adding a line `Enabled: no` to that stanza (the deb822 way to turn a repo off), or delete
the file.

No-subscription: `/etc/apt/sources.list.d/proxmox.sources`

```text
Types: deb
URIs: http://download.proxmox.com/debian/pve
Suites: trixie
Components: pve-no-subscription
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
```

(For the test repo use `Components: pve-test` in the same file.)

Base Debian: `/etc/apt/sources.list.d/debian.sources`

```text
Types: deb deb-src
URIs: http://deb.debian.org/debian/
Suites: trixie trixie-updates
Components: main non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
```

plus a security stanza with `Suites: trixie-security` from
`http://security.debian.org/debian-security/`.

Ceph (only if needed) lives in `/etc/apt/sources.list.d/ceph.sources`, e.g. no-subscription:

```text
Types: deb
URIs: http://download.proxmox.com/debian/ceph-tentacle
Suites: trixie
Components: no-subscription
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
```

PVE 9.x archive key (manual install):

```bash
wget https://enterprise.proxmox.com/debian/proxmox-archive-keyring-trixie.gpg \
 -O /usr/share/keyrings/proxmox-archive-keyring.gpg
# SHA256: 136673be77aba35dcce385b28737689ad64fd785a797e57897589aed08db6e45
```

### 4c. Converting old format to deb822

On a host upgraded into the 9.x era, Debian/Proxmox provides:

```bash
apt modernize-sources
```

which rewrites legacy `.list` files into `.sources` deb822 files (review the result).

### 4d. CLI helpers Proxmox ships for repo management

PVE includes `apt`/`pve` integration:

```bash
pvesh get /nodes/<nodename>/apt/repositories # inspect configured repos via API/CLI
pveupdate # = apt-get update + refresh subscription/appliance info
```

`pvesh` is the CLI binding to the same REST API the web GUI uses, so any "Repositories" GUI panel
maps to `pvesh get/set /nodes/<node>/apt/repositories`.

---

## 5. Removing the subscription "nag" from the shell

Source: community guides (homelab.casaursus.net, simplicitysolved.ca, tech-tales.blog). The "No
valid subscription" popup is purely a **web GUI** dialog; a CLI-only user never sees it. Documented
here only because the orchestrator asked. The nag lives in a JavaScript file shipped by
`proxmox-widget-toolkit`: `/usr/share/javascript/proxmox-widget-toolkit/proxmoxlib.js`.

One-time patch (PVE 8.x), make a backup then patch:

```bash
sed -i.bak "s/data.status.toLowerCase() !== 'active'/false/g" \
 /usr/share/javascript/proxmox-widget-toolkit/proxmoxlib.js
systemctl restart pveproxy.service
```

(An older widely-circulated variant:
`sed -i.bak '/.*data\.status.*{/{s/\!//;s/active/NoMoreNagging/}' /usr/share/javascript/proxmox-widget-toolkit/proxmoxlib.js`.)

Persisting across package updates - drop an APT post-invoke hook so the patch re-applies whenever
the widget toolkit is upgraded, written to `/etc/apt/apt.conf.d/no-nag-script`:

```text
DPkg::Post-Invoke { "dpkg -V proxmox-widget-toolkit | grep -q '/proxmoxlib\.js$'; if [ $? -eq 1 ]; then { echo 'Removing subscription nag from UI...'; sed -i '/data\.status.*{/{s/\!//;s/active/NoMoreNagging/}' /usr/share/javascript/proxmox-widget-toolkit/proxmoxlib.js; }; fi"; };
```

then `apt --reinstall install proxmox-widget-toolkit -y`.

Gotchas: must be re-applied (or kept via the hook) after each toolkit update; clear the browser
cache afterward. The cleaner root cause fix is simply to **disable the enterprise repo and use
no-subscription** (Section 4) so `apt update` no longer errors; the nag popup itself is cosmetic and
irrelevant to a shell user.

---

## 6. Updating the system: apt, pveupdate, pveupgrade, pveversion

Source: PVE docs chapter-sysadmin.html; wiki "Upgrade from 8 to 9".

Routine update (always use **dist-upgrade**, never plain `upgrade`, because PVE updates frequently
introduce new dependencies that plain `upgrade` would hold back):

```bash
apt update # or: pveupdate (also refreshes subscription/appliance metadata)
apt dist-upgrade # or: apt full-upgrade (same thing); pulls kernel + PVE updates
```

Proxmox CLI wrappers:

- `pveversion` - prints the running PVE version (e.g. `pve-manager/8.4.x/...`).
- `pveversion -v` - verbose: lists every key component (kernel, pve-manager, qemu-server,
  pve-cluster, etc.) with versions. First thing to paste when asking for support.
- `pveupdate` - wrapper around `apt-get update` that also refreshes subscription status, appliance
  template list, and AppArmor data.
- `pveupgrade` - convenience wrapper run after a dist-upgrade; checks whether a reboot is needed
  (new kernel) and warns about running guests. Typical sequence:

```bash
pveupdate
apt dist-upgrade
pveupgrade # tells you if a reboot into a new kernel is required
```

- Reboot after a kernel update to activate it:

```bash
systemctl reboot
```

- List/inspect installed kernels and pin/boot a specific one:

```bash
proxmox-boot-tool kernel list
proxmox-boot-tool kernel pin <version> # optional: pin a known-good kernel
```

(`proxmox-boot-tool` manages the boot loader, especially on ZFS/UEFI installs.)

Major-version upgrade (8 to 9) is a deliberate, documented procedure - run `pve8to9 --full` (the
upgrade checker) first, fix all warnings, switch repos from bookworm to trixie, then
`apt update && apt dist-upgrade`. Out of scope for routine maintenance but worth knowing the checker
exists (`pve7to8`, `pve8to9`).

Gotchas:

- Never run plain `apt upgrade` on PVE.
- Don't `apt autoremove` blindly right after install - it can suggest removing kernels.
- If `apt update` shows 401/403 from `enterprise.proxmox.com`, you haven't disabled the enterprise
  repo (Section 4).

---

## 7. Key daemons (relevant even on a single node)

Source: PVE docs "Service Daemons" / wiki Service_daemons; pmxcfs man page.

- **pve-cluster (pmxcfs)** - "the heart of any Proxmox VE installation." A database-backed FUSE
  filesystem mounted at **`/etc/pve`**, holding all PVE config, replicated in real time on clusters.
  **Required even on a single node** - if it isn't running, `/etc/pve` is empty and nothing works.
  Backing store: an SQLite DB at `/var/lib/pve-cluster/config.db`.
- **pvedaemon** - the privileged REST API backend; runs as **root**, listens on **localhost:85**.
  Executes privileged operations; pveproxy forwards to it.
- **pveproxy** - the public REST API proxy, runs as **www-data**, listens on **:8006** (this is the
  web UI / API port). Answers unprivileged calls directly, forwards privileged ones to pvedaemon,
  and on a cluster routes to the right node.
- **pvestatd** - the status daemon; polls VMs, containers, and storage and feeds the RRD graphs /
  status you see in `pvesh` and the GUI. If it's down, status/metrics go stale.
- **spiceproxy** - proxy for SPICE remote-display console connections (port 3128). Only matters if
  you use SPICE consoles.
- **pve-firewall** - applies the PVE firewall rules to iptables/nftables. Relevant on a single node
  if you enable the firewall.
- **pve-ha-lrm / pve-ha-crm** - High Availability Local/Cluster Resource Managers. **Cluster only**
- irrelevant on a single non-clustered node (they stay idle).

Check them all:

```bash
systemctl status pve-cluster pvedaemon pveproxy pvestatd
systemctl status pve-firewall
pvesh get /cluster/status # sanity check the API is answering
```

Restarting the API stack after config changes (e.g. certs, the nag patch):

```bash
systemctl restart pveproxy pvedaemon
```

---

## 8. The /etc/pve filesystem (pmxcfs) - what lives there

Source: PVE docs chapter-pmxcfs.html.

`/etc/pve` is **not** a normal directory - it is the pmxcfs FUSE mount provided by the `pve-cluster`
service. Properties: posix-like, size-limited (~30 MB / 128 MB depending on version), every write is
committed to the SQLite DB and (on clusters) replicated. Files are owned `root:www-data` so pveproxy
can read them. Notable contents:

- `/etc/pve/storage.cfg` - storage definitions (local, local-lvm, directories, NFS, etc.). This is
  THE file to edit/inspect for storage on a single node.
- `/etc/pve/user.cfg` - users, groups, ACLs for the PVE auth system.
- `/etc/pve/datacenter.cfg` - datacenter-wide options (default migration network, keyboard, console
  type, etc.). Single-node still uses it for defaults.
- `/etc/pve/qemu-server/<VMID>.conf` - per-VM configuration.
- `/etc/pve/lxc/<CTID>.conf` - per-container configuration.
- `/etc/pve/nodes/<nodename>/` - per-node dir; on a single node there is exactly one, named after
  your hostname. Contains that node's `qemu-server/` and `lxc/` config and the node's SSL cert
  (`pve-ssl.pem`, `pve-ssl.key`).
- `/etc/pve/local` - a symlink to `/etc/pve/nodes/<thishost>` (always points at "this node").
- `/etc/pve/priv/` - secrets (cluster auth key, etc.); root-only.
- `/etc/pve/authkey.pub`, `/etc/pve/pve-root-ca.pem` - PVE's internal CA and API auth keys.

Gotchas:

- Because the node dir is named after the hostname, **renaming the host is disruptive** - a new
  empty `/etc/pve/nodes/<newname>` appears and VM configs under the old name are stranded (you must
  move them). Decide the hostname before creating VMs (see Section 8b).
- If `/etc/pve` is empty, pmxcfs/pve-cluster is not mounted - fix that before anything else:
  `systemctl status pve-cluster && systemctl start pve-cluster`.
- Edit config files here with a normal editor; pmxcfs handles the DB commit transparently.

### 8b. Hostname / network identity

Source: PVE docs (host network), pmxcfs naming behavior.

PVE derives the node name from the system hostname and **requires** the hostname to resolve to the
node's real (non-loopback) management IP via `/etc/hosts`. Files:

- `/etc/hostname` - short hostname (e.g. `pve`).
- `/etc/hosts` - must contain a line mapping the management IP to FQDN + short name, e.g.:

```text
127.0.0.1 localhost.localdomain localhost
192.168.1.50 pve.home.lan pve
```

Do NOT map the FQDN to 127.0.0.1 - pmxcfs and the API need the real IP.

- Set hostname (only do this BEFORE creating guests):

```bash
hostnamectl set-hostname pve
```

then update `/etc/hosts` and `/etc/postfix/main.cf` accordingly and reboot.

Network interface config lives in `/etc/network/interfaces` (classic Debian ifupdown). The installer
creates the management bridge `vmbr0`. Example single-node static config:

```text
auto lo
iface lo inet loopback

iface eno1 inet manual

auto vmbr0
iface vmbr0 inet static
 address 192.168.1.50/24
 gateway 192.168.1.1
 bridge-ports eno1
 bridge-stp off
 bridge-fd 0
```

Apply network changes without rebooting (PVE 8.x supports this via ifupdown2):

```text
ifreload -a
```

DNS is set in `/etc/resolv.conf` (or `/etc/network/interfaces` dns-\* lines); PVE also reads
DNS/search domain from `/etc/pve/datacenter.cfg`-adjacent settings and
`pvesh set /nodes/<node>/dns`.

---

## 9. Timezone, NTP (chrony)

Source: PVE docs "Time Synchronization" (chapter-sysadmin.html).

PVE relies on accurate time. **chrony** is the default NTP daemon on PVE 7+ (PVE 6 used
systemd-timesyncd); it ships preconfigured with public NTP servers.

- Set timezone (CLI):

```bash
timedatectl set-timezone Europe/London # use your tz; list with: timedatectl list-timezones
timedatectl # verify time, tz, NTP sync status
```

- Custom NTP servers - edit `/etc/chrony/chrony.conf` (Debian splits sources into
  `/etc/chrony/sources.d/` on newer versions). Replace/add:

```text
server ntp1.example.com iburst
server ntp2.example.com iburst
server ntp3.example.com iburst
```

then:

```bash
systemctl restart chronyd
chronyc sources -v # show sync sources and which is selected
chronyc tracking # show clock offset/accuracy
journalctl --since -1h -u chrony # verify it selected a source
```

- If chrony isn't installed (e.g. an old/Debian-on-top install), install it; on a single node
  systemd-timesyncd also works but chrony is the PVE standard.

---

## 10. Quick-reference: the most important commands and files

Commands:

- `pveversion -v` - full version/component report (paste this for support).
- `apt update && apt dist-upgrade` - the only correct routine update (never plain upgrade).
- `pveupdate` / `pveupgrade` - Proxmox update wrappers; pveupgrade flags reboot-needed.
- `systemctl status pve-cluster pvedaemon pveproxy pvestatd` - health of the core stack.
- `proxmox-boot-tool kernel list` - installed kernels / boot management.
- `pvesh get /nodes/<node>/apt/repositories` - inspect repo config from CLI.
- `pvesh get /cluster/status` - confirm the API is answering.
- `timedatectl` / `chronyc sources -v` - timezone and NTP health.
- `ifreload -a` - apply `/etc/network/interfaces` changes live.
- `hostnamectl set-hostname <name>` - set node name (before creating guests!).

Files:

- `/etc/apt/sources.list` (8.x) and `/etc/apt/sources.list.d/*.sources` (9.x) - repos.
- `/etc/apt/sources.list.d/pve-enterprise.list|.sources` - the repo to DISABLE.
- `/etc/pve/` - pmxcfs config FS (storage.cfg, user.cfg, datacenter.cfg, qemu-server/, lxc/).
- `/etc/network/interfaces` - host networking and the `vmbr0` bridge.
- `/etc/hosts`, `/etc/hostname` - node identity; FQDN must map to the real management IP.
- `/etc/chrony/chrony.conf` - NTP servers.
- `/usr/share/javascript/proxmox-widget-toolkit/proxmoxlib.js` - GUI nag (cosmetic; CLI users can
  ignore).

---

## 11. Citations

- PVE docs: Installation -
  [Installing Proxmox VE](https://pve.proxmox.com/pve-docs/chapter-pve-installation.html)
- PVE docs: System Administration / Package Repositories / Time Sync -
  [Host System Administration](https://pve.proxmox.com/pve-docs/chapter-sysadmin.html)
- PVE docs: pmxcfs (/etc/pve) -
  [Proxmox Cluster File System (pmxcfs)](https://pve.proxmox.com/pve-docs/chapter-pmxcfs.html)
- PVE wiki: Package Repositories -
  [Package Repositories](https://pve.proxmox.com/wiki/Package_Repositories)
- PVE wiki: Service daemons - [Service daemons](https://pve.proxmox.com/wiki/Service_daemons)
- PVE wiki: Upgrade from 8 to 9 -
  [Upgrade from 8 to 9](https://pve.proxmox.com/wiki/Upgrade_from_8_to_9)
- Subscription nag removal (community):
  [Proxmox No Subscription Nag](https://homelab.casaursus.net/remove-no-subscription-notice/) ,
  [How to Remove the Proxmox VE Subscription Message (8.3+)](https://simplicitysolved.ca/2025/04/how-to-remove-the-proxmox-ve-subscription-message-8-3/)
  ,
  [Proxmox VE: Disable subscription nag | Tech Tales](https://tech-tales.blog/en/posts/2025/proxmox-disable-subscription-nag/)
