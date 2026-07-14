# Glossary

One canonical definition per term, used consistently across every guide. Terms are listed
alphabetically. Each entry says what the thing is, not how to operate it; the guides teach the how.
Definitions target Proxmox VE 9.x on Debian 13 "trixie".

## .home.arpa

The home-network DNS domain (RFC 8375), served by the local DNS sinkhole for the host and every
static-IP guest. All permanent name-to-IP mappings in this corpus use `*.home.arpa` names (for
example `pve.home.arpa`, `adguard.home.arpa`). Taught in [10 -- Networking](10-networking.md) and
set up in detail in [01 -- DNS sinkhole](recipes/01-dns-sinkhole.md). Prefer it over invented TLDs
such as `.lan`, `.home`, or `.internal`.

## .local

The mDNS domain. `pve.local` resolves on any device with an mDNS resolver (most modern operating
systems) without any DNS server configuration, because `avahi-daemon` on the host publishes it by
multicast. It is an optional convenience for ad-hoc lookups; for permanent service names the corpus
uses the DNS sinkhole and `*.home.arpa` instead. See [10 -- Networking](10-networking.md). See also:
Avahi / mDNS.

## 3-2-1 backup rule

The standard resilience guideline: keep at least three copies of your data, on two different kinds
of media, with one copy off-site. In this corpus the primary Proxmox Backup Server datastore on the
external USB HDD is one copy, the independent copy on the Raspberry Pi is the second on different
hardware, and a rotated off-site USB disk is the off-site third.

## ACL (access control list entry)

In Proxmox VE, a permission binding of three things: a path (for example `/vms/100` or `/`), a
subject (a user, a group, or an API token), and a role, plus a propagate flag that makes it inherit
to deeper paths. ACLs are the whole permission model; set them with `pveum acl modify`, never by
editing files. The special role `NoAccess` cancels every other role on a path.

## ACME (host certificate automation)

The protocol Proxmox uses via `pvenode acme` to obtain and renew a trusted TLS certificate for the
node's API and web endpoint, replacing the default self-signed certificate. It supports HTTP-01
(which needs inbound port 80) and DNS-01 (which works behind NAT and supports wildcards). Once a
trusted certificate is installed you can drop `curl -k`.

## AdGuard Home

A DNS sinkhole engine distributed as a single Go binary with a YAML configuration file and a REST
API. It blocks ads and trackers network-wide by answering requests for those domains with a dead
address. In this corpus it is one of the two engine choices in the DNS sinkhole recipe, alongside
Pi-hole.

## answer.toml (automated installation)

The TOML file that drives the Proxmox VE installer with no interaction, so an install wipes the
target disk and configures the host entirely from the file and then reboots into the new system. It
has `[global]` (hostname, locale, root credential, SSH keys), `[network]`, and `[disk-setup]`
(filesystem and target disk) sections, and is prepared into bootable media with
`proxmox-auto-install-assistant` (which can bake the file into the ISO, read it from a labelled
partition, or fetch it over HTTP). Used for the first install in guide 01 and reused for the remote
host reinstall in guide 20, where it is booted either by a one-time UEFI USB boot (the recommended
route) or by `kexec` when no media can be inserted.

## Attended install / Unattended install

An attended install is the interactive OS installer driven by ear (Console-by-ear); an unattended
install is hands-off via an answer file (`autounattend.xml` for a Windows guest, `answer.toml` for
the Proxmox host). The unattended path is the default; the attended install is the documented
accessible fallback. Taught in [08 -- Windows guests](08-windows-guests.md).

## API token

A named credential tied to a Proxmox user that authenticates REST API calls without using the user's
password. It is sent in an HTTP header of the form `PVEAPIToken=USER@REALM!TOKENID=SECRET`. Tokens
are the preferred way to script against the host, because a leaked token never exposes the account
password and can be revoked on its own. Token secrets are stored in pmxcfs at
`/etc/pve/priv/token.cfg`.

## ARC

The Adaptive Replacement Cache: ZFS's in-RAM read cache. Because it lives in host memory, ZFS trades
RAM for read performance. On this single node the host root is btrfs (no ARC tax), and ZFS is used
only on an external disk, so the ARC size must be capped manually rather than relying on the
installer to cap it.

## ashift

A ZFS pool's per-vdev sector-size exponent, fixed at pool-creation time and never changeable
afterward. `ashift=12` means 4 KiB (2^12) sectors, the safe default for essentially every modern
disk; too small a value (such as 9) on a 4 KiB disk causes severe write amplification. Always pin it
with `zpool create -o ashift=12`.

## autounattend.xml

A Windows Setup answer file that drives a fully unattended Windows install. Placed at the root of
media Setup can read, it scripts disk setup, the product key, user creation, and first-boot actions,
so there is no interactive graphical installer. It is the Windows counterpart of the `answer.toml`
from guide 01.

## Avahi / mDNS

A link-local multicast name-resolution service. `avahi-daemon` on the Proxmox host publishes the
host as `pve.local` on the local network segment, making it reachable by name without configuring a
DNS server. It is the optional, zero-configuration counterpart to the `.home.arpa` names managed by
the DNS sinkhole; useful for quick one-off lookups but not used for permanent service addressing in
this corpus. See [10 -- Networking](10-networking.md) and
[01 -- DNS sinkhole](recipes/01-dns-sinkhole.md).

## backup fleecing

A Proxmox VE feature that inserts a fast local cache image during a running VM's backup so the guest
does not stall waiting on a slow backup target. When the guest writes to a not-yet-copied block, the
old block is copied into the local fleecing image first, the guest write proceeds, and the slow
target is fed in the background. It matters here because the backup target is an external USB HDD;
enable it for VM backups with `fleecing enabled=1,storage=local-btrfs` on this btrfs-root host.

## bind mount

A container mount point whose source is an absolute host directory path (for example
`mp0: /srv/media,mp=/media`), sharing existing host files into the container. Distinguished from a
volume mount by being an absolute path rather than a storage volume id. Bind mounts are not
snapshotted, not quota'd, and excluded from backups by default, and need uid/gid mapping care on
unprivileged containers.

## BootNext (UEFI one-time boot)

A UEFI variable that tells the firmware to boot a chosen entry exactly once on the next reboot, then
revert to the normal boot order. It is set on the host with `efibootmgr --bootnext <num>`, which
makes it the headless way to boot an installer USB stick one time without changing the persistent
boot order. Because the override is one-shot, a stick that fails to boot simply falls back to the
existing system, which is why guide 20 makes the one-time UEFI USB boot the recommended reinstall
route.

## break-glass account (root@pam)

The `root@pam` user authenticates through the host's Linux PAM stack, cannot be deleted, and
bypasses every ACL, so no role can constrain it. It is the guaranteed recovery path if a `pve`-realm
admin user is misconfigured or locked out. Keep it with a strong password and reserve it for
recovery; do day-to-day work as a dedicated, auditable user.

## btrfs

A copy-on-write Linux filesystem that provides data and metadata checksums, transparent compression,
snapshots, and subvolumes in one filesystem. It is the host root filesystem on this node. In Proxmox
VE 9 the btrfs integration is still labelled a technology preview. On a single disk it can detect
corruption via checksums but cannot self-heal data, because there is no second copy.

## btrfs balance

A btrfs maintenance operation that rewrites and consolidates block groups (chunks). On a single disk
it is not needed for redundancy, but the filtered form `btrfs balance start -dusage=10 /` reclaims
allocated-but-mostly-empty data chunks and cures the "ENOSPC even though `df` shows free space"
failure mode. Avoid a full unfiltered balance on a busy host.

## btrfs scrub

A maintenance pass that reads every allocated block on a btrfs filesystem and verifies it against
its stored checksum, surfacing bit-rot and read errors. On a redundant filesystem a scrub repairs
from the good copy; on this single-disk host it can repair duplicated metadata but can only report
data corruption, which is still valuable as an early, honest warning.

## Caddy

A small web server used here as a reverse proxy in its own LXC, fronting internal and Tailscale-only
web services with HTTPS. It obtains certificates automatically; for this corpus it uses the DNS-01
challenge through the Cloudflare DNS plugin, so it needs no inbound port 80 or 443. The stock Caddy
binary has no DNS plugins, so the Cloudflare module is added with `caddy add-package`.

## chrony

The NTP daemon Proxmox VE uses to keep the host clock accurate; on Debian 13 it is the right choice
for a server and installing it removes `systemd-timesyncd`. Accurate time matters for TLS, backups,
logs, and the cluster filesystem. Check it with `chronyc tracking` and `timedatectl status`.

## cloud image

A vendor-built, pre-installed disk image (a `.qcow2` or `.img`, for example Debian's `genericcloud`
build) that boots with no installer. Combined with cloud-init it produces a VM that comes up already
configured and SSH-reachable. Distinct from an OS template, which is for containers.

## cloud-init

An industry-standard mechanism for first-boot configuration of a virtual machine: it sets the
hostname, user accounts, SSH keys, and network from data supplied by the host. Proxmox feeds a VM
its cloud-init data through a small generated drive, which lets a cloned VM come up already
SSH-reachable without any console interaction.

## Cloudflare Access

A Cloudflare Zero Trust feature that puts a login gate in front of a hostname published through the
tunnel, so a private service is reachable from anywhere but only after the user authenticates.
Applications are deny-by-default; an Allow policy (for example "emails ending in your domain") lets
chosen identities through. Application and policy creation is dashboard or API driven, the least
shell-native step in the remote-access stack.

## Cloudflare Tunnel

A Cloudflare service in which a small outbound-only agent (`cloudflared`) on your network connects
to Cloudflare and publishes selected internal web services to the public internet, with no inbound
port forwarding. In this corpus it runs in a container and exposes the public-facing services.

## cloudflared

The Cloudflare Tunnel daemon. It makes only outbound connections to Cloudflare's edge, so it needs
no router port-forwarding and no inbound ports; run it in a small unprivileged LXC. A
locally-managed tunnel keeps its credentials JSON and an ingress `config.yml` on the node (the
shell-friendly model); a token-based tunnel keeps its ingress config in the Cloudflare dashboard.

## Console-by-ear

Driving a guest's own graphical installer or recovery environment by ear, using speech synthesized
inside the guest (Windows Narrator or Debian `espeakup`) and carried to the client over the SPICE
console's audio channel. It is the corpus's one documented use of a graphical guest console --
install and first-boot recovery only, never daily operation. The SPICE session carries audio but is
not read visually -- the term "SPICE GUI" misframes it and should be avoided. Taught in
[08 -- Windows guests](08-windows-guests.md).

## console.vv

The short-lived SPICE connection file that Proxmox's `spiceproxy` API issues when a SPICE session is
requested. Opening it in `remote-viewer` establishes the connection. Its ticket expires in roughly
30 seconds, so a fresh `console.vv` must be fetched from the API each time a session is started.
Taught in [08 -- Windows guests](08-windows-guests.md).

## content type

The label on a Proxmox storage that declares what kind of object it may hold. The types are `images`
(VM disks), `rootdir` (container root filesystems), `vztmpl` (container templates), `iso` (installer
images), `backup` (backup archives), `snippets` (hook scripts and cloud-init data), and `import`.
File-level backends can carry all types; block/volume backends carry only `images` and `rootdir`.

## control station

The operator's separate everyday computer (a Windows machine with a screen reader) from which they
SSH into the Proxmox host. It is never the machine Proxmox is installed on.

## datastore

In Proxmox Backup Server, the on-disk repository that holds backup data as content-addressed,
deduplicated chunks. A single datastore can contain many isolated namespaces, and a sync job can
copy one datastore to a second Proxmox Backup Server for an off-site copy.

## deb822 .sources

The multi-line APT repository format used by default in Proxmox VE 9 (Debian 13). Each repository is
a stanza in a `.sources` file under `/etc/apt/sources.list.d/`, with fields such as `Types`, `URIs`,
`Suites`, `Components`, and `Signed-By`. It replaces the old one-line `.list` entries used in
Proxmox VE 8.

## deduplication

The Proxmox Backup Server technique of splitting backup data into chunks, hashing each chunk, and
storing only chunks not already present. Identical blocks across guests, across snapshots, and
across time are kept once, which greatly reduces the space many similar backups consume.

## disk by-id

A stable device path under `/dev/disk/by-id/` derived from a disk's model and serial number (or
WWN), unlike `/dev/sdX` names which are assigned in probe order and reorder across reboots and USB
re-plugs. Always create ZFS pools and reference external or USB disks by their by-id path, never
`/dev/sdX`.

## DNS sinkhole

A local DNS resolver that answers requests for ad and tracker domains with a dead address, blocking
those domains network-wide before they reach a client browser or app. In this corpus it runs as
either Pi-hole or AdGuard Home inside an LXC container, optionally backed by Unbound for recursive
resolution.

## DNS-01 (ACME DNS challenge)

A way to prove domain control to a certificate authority by creating a TXT record in DNS rather than
answering on port 80 or 443. Because it needs no inbound web port, it issues certificates behind NAT
or a tunnel and can issue wildcards. Caddy and `pvenode acme` both support it through a DNS provider
plugin (here, Cloudflare).

## Docker Compose

A tool that defines and runs a multi-container Docker application from a single YAML file, applied
with `docker compose up`. In this corpus Docker is always run inside a VM, never an LXC container,
because the Linux kernel namespacing that LXC and Docker both rely on can conflict in an
unprivileged container.

## Drush

The command-line shell for Drupal (`drush status`, `drush cr`, `drush user:create`). It is the
accessible way to manage a Drupal site without the web admin UI, running maintenance,
cache-clearing, and user-management tasks over SSH.

## EMS / SAC

Windows Emergency Management Services and its Special Administration Console: a limited text console
exposed over a serial port for boot and recovery diagnosis (list and kill processes, restart, read
the IP, open a CMD channel). It is not a desktop, a login shell, or a screen-reader surface; you
reach it with `qm terminal`.

## fail2ban

A daemon that watches authentication logs and temporarily firewall-bans source IPs that fail to log
in too many times. On a Proxmox node it is configured with an `[sshd]` jail (SSH brute force) and a
`[proxmox]` jail (failed web/API logins on port 8006), with your own admin IP placed in `ignoreip`
so you can never ban yourself.

## fingerprint (PBS TLS fingerprint)

The SHA-256 fingerprint of a Proxmox Backup Server's TLS certificate, used so a client can trust a
self-signed PBS. For a self-signed PBS like the one here, Proxmox VE and `proxmox-backup-client`
refuse to connect unless the presented fingerprint matches the configured one; read it on the server
with `proxmox-backup-manager cert info | grep Fingerprint` and supply it in the `pbs:` storage
stanza or the `PBS_FINGERPRINT` variable.

## garbage collection (GC)

The Proxmox Backup Server maintenance task that actually frees disk space by deleting chunks no
longer referenced by any backup snapshot, after a grace period. It is the second half of retention:
a prune job only marks snapshots removable, and garbage collection is what reclaims the space. Run
it with `proxmox-backup-manager garbage-collection start <datastore>`, set its schedule with the
datastore's `gc-schedule` property, and run it after pruning.

## glances

A cross-platform monitor that, run as `glances --stdout`, prints periodic plain-text metric lines
instead of a full-screen visual dashboard. That stdout mode is the screen-reader-friendly way to
watch CPU, memory, load, and filesystem use live, and is preferred here over web dashboards.

## guest

A workload running on the Proxmox host: either a virtual machine or a container.

## HAOS (Home Assistant Operating System)

The official appliance OS image for Home Assistant, run as a dedicated KVM/QEMU VM rather than in a
container. It ships with the Supervisor process and the Add-on Store, giving access to the full Home
Assistant ecosystem including official add-ons and community integrations.

## HBA (host bus adapter)

A storage-controller card (for example a SAS or SATA controller, often flashed to plain "IT mode")
that presents its attached disks to the host. Because it is a self-contained PCI device, a whole HBA
can be passed through to a single VM so that guest owns the disks directly, which is the clean way
to give a storage-focused VM raw disk access without the host touching the drives.

## Helper-Scripts

The community-maintained collection of Proxmox VE setup scripts (the `community-scripts/ProxmoxVE`
project, successor to the tteck scripts) that automate creating containers and installing common
self-hosted apps. They are a fast shortcut; their interactive menus are the least
screen-reader-friendly part, and the curl-to-bash install pattern carries the usual read-first,
snapshot, and pin-a-commit caveats.

## idmap

The user/group id mapping that translates ids inside an unprivileged container to a high,
unprivileged range on the host (container root 0 maps to host 100000 by default). A custom
`lxc.idmap` can punch a 1:1 hole so one real host uid lines up inside the container, which is how a
host bind mount is made writable by the container.

## ifupdown2

The network-configuration engine Proxmox VE uses (default since PVE 7). It reads the single file
`/etc/network/interfaces` and applies changes live, without a reboot, via `ifreload -a`;
`ifreload -a -n` is a dry-run that shows what would change without touching the live network -- run
it before every real reload on a headless host.

## Infrastructure as Code (IaC)

Defining your machines and their configuration in version-controlled text files that a tool applies
idempotently, instead of clicking or running one-off commands. On a single node the native
`qm`/`pct`/`pvesh` plus the cloud-init template workflow cover most needs; Ansible is the first
useful step up, and Terraform/OpenTofu is usually overhead until you have many nodes.

## ingress rule

In a `cloudflared` tunnel's `config.yml`, an ordered mapping from a public hostname to a local
origin URL the tunnel forwards to. The list is evaluated top to bottom, first match wins, and it
must end with a catch-all rule with no hostname (the docs use `service: http_status:404`) or
`cloudflared` rejects the config.

## IOMMU

The CPU/chipset unit that lets a device be safely assigned to a VM by giving it its own isolated
view of memory. On this AMD host the hardware support is on by default; PCI(e) passthrough adds
`iommu=pt` to the kernel command line and reboots. The IOMMU sorts devices into groups, and the hard
rule of passthrough is that a whole group moves to the guest together, never a single function in
isolation. Enabling it and verifying the groups are the first steps of PCI passthrough in guide 21.

## IPMI (Intelligent Platform Management Interface)

An out-of-band management channel built into server-class motherboards, with its own processor and
network port that work even while the host is powered off or its operating system is dead. Its
Serial-over-LAN (SOL) feature relays the host's serial console over the network, giving true remote
console access independent of the running system. Most consumer mini-PCs lack IPMI, so a corpus
aimed at such hardware cannot assume it is available.

## IPSET

A named set of IP addresses or CIDR ranges in the Proxmox firewall, referenced in a rule with a
leading `+` (for example `-source +management`). The built-in `management` IPSET auto-allows its
members to reach SSH and the management ports, which is the safe way to whitelist your control
station before enabling the firewall.

## is_mountpoint

A Proxmox storage option (on `dir` and `btrfs` storages) that tells Proxmox the storage lives on a
separately mounted disk and to treat the storage as offline when that disk is not mounted. Essential
for an external USB disk: without it, writes land in the bare mount directory on the root disk when
the disk is absent, silently filling root. Set with `is_mountpoint 1` (or the target path).

## journald (persistent journal)

The systemd logging service. By default its logs are in memory and lost on reboot; setting
`Storage=persistent` (with a size cap) in `/etc/systemd/journald.conf` and creating
`/var/log/journal` makes them survive a reboot so you can investigate a crash afterward. Read it
with `journalctl` (for example `journalctl -p err -b` or `journalctl -u pve-cluster`).

## kexec

A Linux mechanism that boots a new kernel directly from the running one, skipping the firmware
(BIOS/UEFI) and the bootloader. Because it never re-runs the firmware, it lets a headless host
"reboot into an installer" with no change to the BIOS boot order, which is how guide 20 reinstalls
the host remotely. The same property is its danger: devices the firmware would normally
re-initialise (above all the network card) can be left unusable, and Secure Boot's kernel lockdown
disables the classic `kexec_load` call entirely, so `kexec` must be gated and rehearsed before use.

## KSM (Kernel Samepage Merging)

A kernel feature, managed by `ksmtuned`, that deduplicates identical memory pages across VMs to
reclaim RAM under pressure. It only activates above roughly 80% memory use and rarely fires on a
lightly loaded node; a security-sensitive guest can opt out with `allow-ksm=0`.

## KVM/QEMU VM

A full virtual machine: a guest with its own emulated hardware and kernel, run by QEMU on top of the
Linux KVM hypervisor. It is heavier than a container but fully isolated and able to run any
operating system. Each VM has a numeric VMID and a config file at
`/etc/pve/qemu-server/<vmid>.conf`. Managed with `qm`.

## local-btrfs

The default guest storage created by a btrfs-root install, of storage type `btrfs`, pointed at the
`/var/lib/pve/local-btrfs` subvolume. It carries all content types (ISOs, templates, backups, VM
images, and container rootdirs), so one storage does the job that `local` plus `local-lvm` do on an
LVM install. (On a btrfs install the plain `local` directory storage is created but disabled, and
there is no `local-lvm`.)

## Local DNS record

A name-to-address mapping that the DNS sinkhole answers for `*.home.arpa` names on the home network.
Adding a local DNS record makes a service reachable by a stable hostname from every device on the
network without editing individual hosts files. In this corpus local DNS records are created in the
sinkhole for the Proxmox host and each static-IP guest. Covered in
[01 -- DNS sinkhole](recipes/01-dns-sinkhole.md) and [10 -- Networking](10-networking.md).

## LXC container

A system container: a guest that shares the host's Linux kernel but runs its own isolated userspace
(its own processes, filesystem, and network). It is lighter and faster to start than a VM but must
run a Linux guest. Each container has a numeric VMID and a config file at
`/etc/pve/lxc/<vmid>.conf`. Managed with `pct`.

## MagicDNS

Tailscale's feature that gives each device on the tailnet a stable name like
`node.<tailnet>.ts.net`, resolvable from any other tailnet device. `tailscale serve` provisions a
real TLS certificate for that name automatically; `tailscale cert` can also write the certificate
and key to files.

## Management IP

The host's address on the home LAN: the IPv4 address you SSH to and that the hostname must resolve
to. It is simply the Proxmox host's LAN IP, not a loopback like 127.0.0.1.

## NAT bridge (masquerade)

An internal-only Linux bridge with no physical port (`bridge-ports none`) whose subnet the host
routes and SNATs (masquerades) out through the uplink. Used for an isolated dev lab: guests on it
reach the internet but are invisible to the home LAN, which never sees their traffic.

## nftables backend (opt-in)

The newer, Rust-based firewall backend for Proxmox VE (`proxmox-firewall`). In Proxmox VE 9 the
firewall is still iptables-based by default; the nftables backend is a technology preview that you
opt into by installing the package and setting `nftables: 1` in `host.fw`. It is not the default.

## notification matcher

In the Proxmox notification system, the rule that decides which events reach which targets. A
matcher can filter by severity (`match-severity`), by metadata field
(`match-field exact:type=vzdump`), or by time (`match-calendar`); a matcher with no rules matches
everything. There is no "drop" action, so you silence a class of events by ensuring no enabled
matcher selects them.

## the notification system

The Proxmox VE mechanism (introduced in 8.1, the forward-looking path in 9) that decides where
alerts go. It has two object kinds: targets (endpoints such as a mail relay, Gotify, or a webhook)
and matchers (rules selecting which events reach which targets). Configuration lives in
`/etc/pve/notifications.cfg`, with secrets in `/etc/pve/priv/notifications.cfg`. A fresh install
emails everything to the `root@pam` address through local sendmail.

## notification target

In the Proxmox notification system, a destination an event can be sent to: a local-MTA `sendmail`
target, a direct `smtp` relay, a `gotify` push server, or a generic `webhook` (which is how ntfy,
Discord, and similar are wired, since there is no dedicated ntfy type). Secrets for a target live in
`/etc/pve/priv/notifications.cfg`, separate from the public definition.

## occ

Nextcloud's command-line tool, invoked as `php occ ...` and run as the web-server user. It performs
essentially everything the Nextcloud web admin interface does: installing apps, resetting user
passwords, running filesystem scans, and triggering maintenance. It is the accessible, scriptable
way to manage a Nextcloud instance without the browser UI.

## OS template (vztmpl)

A compressed root-filesystem tarball (`.tar.zst`/`.tar.xz`) used as the base for a new LXC
container, managed with `pveam` and stored on a storage that has the `vztmpl` content type. This is
the container equivalent of a cloud image; it is not the same thing as a VM template.

## OVMF / UEFI

The UEFI firmware option for a VM (`bios: ovmf`, versus the default `seabios`). It requires a small
EFI variables disk (`efidisk0`, `efitype=4m`, optionally `pre-enrolled-keys=1`). Prefer it for
modern Linux guests and any PCIe passthrough.

## pct

The command-line tool that drives the full lifecycle of an LXC container: create, start, stop,
configure, snapshot, and destroy. It also provides the container access path (`pct enter` and
`pct exec`), one of the three superpowers.

## Pi-hole

A DNS sinkhole engine with a mature `pihole` CLI for managing block lists, allowlists, and query
logs. In this corpus it is one of the two engine choices in the DNS sinkhole recipe, alongside
AdGuard Home; both work with Unbound as the upstream recursive resolver.

## pmxcfs (/etc/pve)

The Proxmox Cluster File System: a small, database-backed FUSE filesystem mounted at `/etc/pve` that
holds all Proxmox configuration. It is provided by the `pve-cluster` service and exists even on a
single standalone node. It is the single source of truth for storage, guests, users, firewall, and
notification config, and it goes read-only if the node loses quorum. It is not an ordinary directory
and is not a general-purpose scratch disk.

## privilege separation (privsep)

A property of an API token. With `--privsep 1` (the recommended default) the token carries its own
ACLs and its effective rights are the intersection of the owning user's rights and the token's
rights, so a leaked token can only ever be less powerful than its owner. With `--privsep 0` the
token inherits the user's full rights, which is convenient but means a leak equals the user.

## Proxmox Backup Server (PBS)

A separate Proxmox product, paired with Proxmox VE 9 as PBS 4.x, that provides deduplicated,
incremental, verifiable, client-side-encrypted backups. Proxmox VE pushes backups to it as a `pbs:`
storage. In this corpus it is the primary backup method, with its datastore on an external disk so
the backups survive the host dying.

## Proxmox host / node

The single physical machine that runs Proxmox VE (the hypervisor). Also called "the node". It has no
accessible local console and is operated entirely over the network from the control station.

## Proxmox VE

Proxmox Virtual Environment: an open-source virtualization platform, built on Debian, that runs both
KVM/QEMU virtual machines and LXC containers on one host and exposes everything through a REST API
(and a web GUI this corpus does not use). This corpus targets version 9.x on Debian 13 "trixie".

## proxmox-backup-client

The command-line client that backs up a host's own files and directories to a Proxmox Backup Server
as `.pxar` archives, independent of Proxmox VE's guest backups. On this node it captures the host
configuration (`proxmox-backup-client backup pveconf.pxar:/etc/pve etc.pxar:/etc`), reading its
target and credentials from the `PBS_REPOSITORY`, `PBS_PASSWORD`, `PBS_FINGERPRINT`, and
`PBS_ENCRYPTION_PASSWORD` environment variables. It also restores those archives
(`proxmox-backup-client restore`).

## proxmox-backup-manager

The server-side administration command for Proxmox Backup Server: it creates and mounts datastores,
manages users, ACLs, and tokens, reads the certificate fingerprint, and schedules verify, prune,
garbage-collection, and sync jobs. Because the PBS web GUI is not accessible, this is how PBS is
operated in this corpus, alongside `proxmox-backup-client` and `pvesh`.

## proxmox-boot-tool

The Proxmox utility that manages the EFI System Partition(s): it copies the selected kernel and
initrd onto each managed ESP and configures the bootloader. On this btrfs-root UEFI host the
bootloader is GRUB, so the kernel command line lives in `/etc/default/grub` and you run
`proxmox-boot-tool refresh` after editing it. Current Proxmox docs also describe `update-grub` as a
valid GRUB apply path when the proxmox-boot-tool hook is present; this corpus uses `refresh`
directly because it names the ESP synchronization step.

## proxmoxer

A thin Python wrapper over the Proxmox REST API, installed with `pip install proxmoxer requests`. It
can talk to the API over HTTPS (preferably with an API token) or shell out locally to
`pvesh`/`qm`/`pct`, and is the right tool for bespoke Python automation that Ansible or Terraform
cannot express cleanly.

## prune job (PBS)

A scheduled Proxmox Backup Server task that applies a keep-\* retention policy (`keep-last`,
`keep-daily`, `keep-weekly`, `keep-monthly`, and so on) by marking older backup snapshots as
removable. Pruning frees no space by itself; garbage collection reclaims the space afterward.
Preview a policy before trusting it, and mark any irreplaceable snapshot as protected so pruning
skips it.

## pve-firewall

The default, iptables-based Proxmox firewall service. It compiles the plain-text `.fw` rule files
(datacenter, host, and per-guest) stored in pmxcfs into the live ruleset and applies it. The newer
nftables backend is a separate, opt-in technology preview; `pve-firewall` is what ships and runs by
default.

## pveam

The Proxmox VE Appliance Manager: the command-line tool that updates the OS-template catalog and
downloads container templates (`pveam update`, `pveam available`, `pveam download`). It manages the
`vztmpl` templates that `pct create` consumes.

## pvenode

The command-line tool for node-level settings and host health on a single Proxmox host: reading and
writing the node config (description, wake-on-LAN, ACME) and related per-node operations. It is the
`/nodes/<name>` corner of the API as a friendly CLI.

## pvesh

The command-line shell over the Proxmox REST API. Run as local root it talks to the API over a local
socket, needing no credentials or TLS, and can reach every API path as text. Because the web GUI is
just a client of the same API, `pvesh` can do anything the GUI can. It is the third of the three
superpowers, the universal text gateway to the host.

## pvesm

The Proxmox VE storage manager: the command-line front end to the storage model. It lists storage
status and volumes, and adds, changes, or removes storage definitions in `/etc/pve/storage.cfg`.

## pveum

The Proxmox VE user-management command-line tool: it manages users, groups, roles, ACLs, API tokens,
pools, authentication realms, and two-factor auth. Every `pveum` action is also reachable as a
`pvesh` call under `/access`.

## pxar archive

The Proxmox file archive format (`.pxar`) that `proxmox-backup-client` produces when backing up
directories such as `/etc/pve` and `/etc`. It stores file data and metadata in the deduplicated
chunk store like any other backup, and `--change-detection-mode=metadata` lets re-runs skip
unchanged files quickly. Restore it with
`proxmox-backup-client restore <snapshot> <archive>.pxar <target-dir>`, always into a staging
directory rather than over live files.

## qemu-guest-agent

A small agent installed inside a virtual machine that lets Proxmox communicate with the running
guest: graceful shutdown, filesystem-consistent snapshots and backups, and reporting the guest's IP
addresses. It is enabled per VM and installed inside the guest OS.

## qm

The command-line tool that drives the full lifecycle of a KVM/QEMU virtual machine: create, start,
stop, configure, snapshot, clone, and destroy. It also attaches to a VM's serial console with
`qm terminal`, one of the three superpowers.

## quorum

In a Proxmox cluster, the majority agreement that lets the cluster filesystem pmxcfs (`/etc/pve`)
accept writes; without it pmxcfs goes read-only to prevent split-brain. On a single node that was
never clustered there is no corosync configuration, so the node is quorate by default and `/etc/pve`
is normally writable. The symptom of lost quorum (an `/etc/pve` that is read-only even to root)
therefore appears on a standalone node only when stale cluster configuration is left over from a
past experiment; the immediate, non-destructive unblock is `pvecm expected 1`, which tells corosync
to expect a single vote.

## RDP (Remote Desktop)

Microsoft's Remote Desktop Protocol. On this node it is the accessible way to use a Windows guest's
desktop: you connect from the control station with the built-in client (`mstsc`) and run a Windows
screen reader such as NVDA inside the guest.

## realm (authentication domain)

Decides how a user proves identity; a full user id is always `name@realm`. The two that matter on a
single node are `pam` (a real Unix account on the host, used by `root@pam`) and `pve` (the Proxmox
built-in auth server, where users exist only inside Proxmox with no Unix account needed) -- the
right realm for dedicated admin and automation users. `ldap`, `ad`, and `openid` exist but are
overkill for one node.

## remote-viewer

The SPICE client from the `virt-viewer` package that opens a `console.vv` file to connect to a
guest's SPICE console. In this corpus it is used only for the attended install, where the guest's
own audio (Windows Narrator or `espeakup`) is the operator's console. Taught in
[08 -- Windows guests](08-windows-guests.md).

## resource pool

A named grouping of VMs, containers, and storage so a single ACL on `/pool/<name>` applies to all of
them at once. Created and populated with `pveum pool` subcommands; useful for granting a role over a
set of guests without listing each.

## the REST API

The single versioned HTTPS interface, served by `pveproxy` at `https://HOST:8006/api2/json/...`,
that exposes everything Proxmox can do. The web GUI is just a JavaScript client of this API; there
is no GUI-only capability. The same API is reachable as text through `pvesh` locally, or with `curl`
plus an API token from anywhere.

## reverse proxy

A server that terminates TLS and forwards requests to one or more backend services by hostname or
path. In this corpus a single Caddy LXC is the reverse proxy for internal web services, so
certificates and HTTPS are handled in one place rather than per service.

## role

A named set of privileges (the atoms such as `VM.PowerMgmt`, `Datastore.Audit`, `Sys.Console`).
Proxmox ships predefined roles (`Administrator`, `PVEAuditor`, `PVEVMAdmin`, `PVEVMUser`, and
others); prefer these before writing a custom role with `pveum role add`. A role grants nothing
until it is bound to a subject and a path by an ACL.

## Secure Boot

A UEFI feature that only lets the firmware run boot components signed by a trusted key. It has two
distinct consequences in this corpus. First, when Secure Boot is on, the running kernel enters
lockdown mode, which disables the classic `kexec_load` syscall, so the `kexec` reinstall route in
guide 20 cannot work -- it is the hard stop that makes the one-time UEFI USB boot the recommended
route on a Secure Boot host. Second, for booting installer media it is only a signing question:
media must be signed to boot with Secure Boot on, and the Proxmox VE installer has been signed since
8.1, so it boots without turning Secure Boot off.

## security group

A reusable, named bundle of firewall rules defined only in `cluster.fw` as `[GROUP <name>]` and
applied at any level with `GROUP <name>` in a `[RULES]` section. Define a rule set once (for example
a web-server allow) and attach it to several guests.

## send / receive

The block-level replication mechanism of both btrfs (`btrfs send` / `btrfs receive`) and ZFS
(`zfs send` / `zfs receive`): a read-only snapshot is serialized to a stream and reconstructed on
another filesystem or host, with incremental transfers of only the delta between two snapshots. The
basis for a cheap off-disk copy to an external disk. Not a substitute for Proxmox-aware per-guest
backups (Part F).

## serial console

A text console attached to a guest's virtual serial line, reached with `qm terminal` for a VM.
Configured before OS install, it makes even the installer and early boot reachable as plain text
over SSH, replacing the inaccessible graphical console. It is the first of the three superpowers.

## smartd (SMART monitoring)

The smartmontools daemon that watches disk and NVMe health via the drives' built-in SMART
self-reporting, runs scheduled self-tests, and emails root on problems. On this host the key NVMe
fields to watch are `Percentage Used`, `Available Spare` against its threshold, and
`Media and Data Integrity Errors`; its mail-to-root flows into the Proxmox notification system as a
`system-mail` event.

## snapshot

A point-in-time, copy-on-write capture of a guest's disk (and optionally its memory) that you can
roll back to. On btrfs and ZFS storage these are filesystem snapshots: instant to create and
initially sharing all blocks with the original. A snapshot on the same disk as the original is not a
backup; it dies with the disk.

## snippet

A small user-supplied configuration file (for example a cloud-init user-data YAML) stored on a
storage that has the `snippets` content type, referenced as `STORAGE:snippets/<file>`. Snippets let
you supply custom cloud-init logic via `--cicustom`. On this btrfs-root host, enable `snippets` on
`local-btrfs` before paths such as `local-btrfs:snippets/<file>.yaml` resolve.

## SPICE console

The graphical guest console type that, unlike noVNC, carries the guest's audio to the client. That
audio channel is what makes the by-ear attended install possible: the guest's own speech (Windows
Narrator or Debian `espeakup`) reaches the operator's speakers through the SPICE session. Used only
for that install-time exception; daily operation is over SSH or RDP. Taught in
[08 -- Windows guests](08-windows-guests.md).

## storage.cfg

The single cluster-wide file, `/etc/pve/storage.cfg`, that declares every configured storage: its
backend type, its content types, and its options. It lives on pmxcfs, so it is the source of truth
for storage. Guests reference volumes by a `STORAGE_ID:volume` identifier rather than by raw path.

## subvolume

An independently snapshottable and quota-able unit inside a btrfs filesystem that looks and behaves
like a directory. Proxmox uses one subvolume per container root filesystem and one for the
`local-btrfs` storage, which is what makes instant per-guest btrfs snapshots possible.

## swappiness

The `vm.swappiness` sysctl (0 to 100) that biases how readily the kernel swaps memory to disk. On a
RAM-rich virtualization host a low value such as 10 keeps the host from swapping out VM memory
prematurely; set it in `/etc/sysctl.d/` and never place swap on a ZFS zvol.

## sync job (PBS)

A scheduled Proxmox Backup Server task that copies snapshots from one datastore (or a remote PBS) to
another, preserving deduplication, to maintain a second directly-restorable copy. In this corpus it
feeds the independent copy on the Raspberry Pi; set `remove-vanished=false` so deleting a snapshot
on the primary does not delete the copy on the Raspberry Pi.

## tailnet

Your private Tailscale network: the mesh of devices that have joined your Tailscale account,
connected over WireGuard. Devices reach each other by their tailnet names regardless of where they
physically are, with no inbound ports opened on any router.

## Tailscale

A mesh VPN built on WireGuard that connects your devices into a private network without port
forwarding. In this corpus it carries SSH and admin access and the most sensitive services, kept off
the public tunnel so their traffic never transits a third party in the clear.

## tailscale serve / funnel

Two Tailscale commands that expose a local service over HTTPS. `tailscale serve` publishes it
privately, to your tailnet only -- the right tool for crown-jewel services that must not transit
Cloudflare. `tailscale funnel` publishes it to the entire public internet; this corpus routes public
traffic through the Cloudflare tunnel instead, so funnel is generally not used.

## Tailscale SSH

SSH access authorized by your tailnet's ACL policy rather than by the host's `authorized_keys`,
enabled with `tailscale up --ssh`. It checks the destination's SSH host key through the Tailscale
coordination server and runs alongside the host's own `sshd` (it does not replace it), so you can
stop exposing OpenSSH to the public internet and still reach the host over the tailnet.

## template / linked clone

A template is a virtual machine marked read-only to serve as a reusable base image; you do not run
it directly, you clone from it. A linked clone is a fast, thin copy of a template that shares the
template's base disk via copy-on-write and only stores its own changes. Because a linked clone
depends on the base, you must not delete a template that still has linked clones.

## TFA / TOTP (two-factor authentication)

A second login factor on top of a password. Proxmox supports TOTP (a time-based code),
WebAuthn/FIDO2 hardware keys, and one-time recovery keys. Honest caveat for this reader: enrolling a
new TOTP or WebAuthn factor is effectively GUI-driven, so the shell-only plan is to rely first on a
strong `root@pam` password plus scoped API tokens, and add TFA later (a known TOTP secret fed to
`oathtool` avoids needing to read a QR code).

## unattended-upgrades

The Debian mechanism for applying updates automatically. On a Proxmox node it is scoped to Debian
SECURITY updates only, with the Proxmox and virtualization packages blacklisted and automatic reboot
turned off, so a hypervisor is never upgraded or rebooted out from under you; Proxmox itself is
upgraded manually and deliberately.

## Unbound

A validating, recursive, caching DNS resolver. In the DNS sinkhole recipe it is placed behind the
sinkhole engine so DNS lookups recurse from the root servers (listening on `127.0.0.1` port `5335`)
instead of forwarding to a third-party upstream such as 8.8.8.8, giving full recursive resolution
with no third-party dependency.

## unprivileged container

An LXC container whose root user is mapped to an unprivileged user on the host, so that even root
inside the container has no real root power on the host. It is the default and recommended container
type in Proxmox VE 9; creating a privileged container instead now requires an extra privilege.

## UPID

The Unique Process Identifier of a Proxmox task. Every action `qm`, `pct`, `vzdump`, and the storage
layer take runs as a worker task stamped with a UPID, a colon-separated string that itself names the
node, the worker process, the task's start time, the task type (such as `vzdump` or `qmstart`), the
affected VMID, and the user. You list tasks with `pvenode task list` (add `--errors 1` for
failures), read a task's full output with `pvenode task log <UPID>`, and on a single node read the
on-disk logs directly under `/var/log/pve/tasks/` (which survive even when `/etc/pve` is
unavailable). Reading the failing task's log is how a one-line "backup failed" becomes the real
underlying error.

## verify job (PBS)

A scheduled Proxmox Backup Server task that re-reads stored chunks and checks them against their
recorded checksums to confirm backups are still intact and restorable. Because re-reading every
chunk from a USB HDD is slow, schedule it modestly (for example weekly) and let it skip
already-verified snapshots. A backup that fails verification is corrupt; a backup you have never
verified or test-restored is a guess.

## vfio-pci

The host kernel driver that "parks" a PCI device so it can be handed to a VM. Binding a device to
`vfio-pci` (by its `vendor:device` id in `/etc/modprobe.d`) stops the host's normal driver from
claiming it, which is what frees the device for PCI(e) passthrough. The flip side, and the danger,
is that a device bound to `vfio-pci` disappears from the host's own use, so it must never be a
device the host depends on (its only NIC, its boot controller). Covered in guide 21.

## VirtIO drivers (virtio-win)

The paravirtualized Windows drivers (disk `vioscsi`, network `NetKVM`, the balloon driver, and the
QEMU guest agent), shipped on the `virtio-win.iso`. Windows has no in-box virtio driver, so the ISO
is attached as a second CD during install and the guest-tools installer is run afterwards.

## virtio-scsi-single

The recommended SCSI controller for VMs in Proxmox VE 9. It gives each disk its own controller so a
per-disk `iothread` works, for the best throughput, and cloud images expect a virtio-scsi controller
to be present.

## VLAN-aware bridge

A Linux bridge configured with `bridge-vlan-aware yes` so it trunks 802.1Q VLANs; each guest NIC is
then placed on a VLAN with `tag=N`, transparently to the guest OS. Lets one wired uplink carry
several segmented networks.

## vmbr0 (Linux bridge)

The default Linux software bridge created by a standard Proxmox install. The host's single physical
NIC becomes a port on `vmbr0`, the host's management IP sits on the bridge, and guests attach to it,
placing them on the same network segment as the LAN. It is configured in `/etc/network/interfaces`.

## volume mount

A container mount point whose source is a Proxmox-managed storage volume (for example
`mp0: local-btrfs:110/vm-110-disk-1.raw,mp=/data,size=20G`). Unlike a bind mount, a volume mount is
storage-managed, so it can be snapshotted, quota'd, and included in backups.

## vTPM (tpmstate0)

A virtual Trusted Platform Module presented to a VM through a small `tpmstate0` state disk. Windows
11 requires a TPM 2.0, so a Windows 11 guest needs `tpmstate0` (version v2.0) alongside OVMF and
Secure Boot.

## vzdump

The built-in Proxmox tool that backs up both VMs and containers, writing one self-contained archive
per guest per run to a storage with the `backup` content type. In this corpus it is demoted to a
brief one-off tool, because Proxmox Backup Server is the primary backup method.

## WireGuard

The modern, fast VPN protocol Tailscale builds its encrypted mesh on. It runs over UDP and is
outbound-initiated, which is why a tailnet needs no inbound router ports; in this corpus it carries
SSH/admin traffic and crown-jewel service traffic end-to-end-private.

## WSL (Windows Subsystem for Linux)

A Linux environment (here a Debian distribution) running on the Windows control station. It is used
to run the Linux-only `proxmox-auto-install-assistant` when preparing the install ISO. This guide
assumes WSL2 Debian is already installed.

## ZFS

A mature, copy-on-write filesystem and volume manager with checksums, snapshots, compression, and
send/receive replication. On this node it is taught and used only on an external USB disk, never the
host root. Proxmox VE 9 ships OpenZFS 2.4 as of 9.2.

## zpool / dataset / zvol

A zpool is a ZFS storage pool built from one or more disks; on this node it is a single-disk pool on
an external USB disk. A dataset is a POSIX filesystem inside a pool that you mount and put files in.
A zvol is a block device inside a pool with no filesystem of its own, which something else (such as
a VM) formats. Proxmox stores VM disks as zvols and container roots as datasets.

## zpool scrub

The ZFS integrity check that reads every allocated block and verifies it against its checksum. On a
redundant pool it self-heals; on a single-disk pool it can only detect and report corruption, not
repair it, which is still valuable as an early-warning signal. Run with `zpool scrub <pool>`, check
with `zpool status` (or `zpool status -j` for clean JSON).
