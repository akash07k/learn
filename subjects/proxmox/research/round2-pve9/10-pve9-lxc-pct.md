# PVE 9: LXC Containers via `pct` (shell-only, screen-reader path)

Target: Proxmox VE 9.x (9.0 GA Aug 2025, point releases through mid-2026), based on Debian 13
"trixie". Components moved during the 9.x series: 9.0 shipped kernel 6.14 and LXC 6.0.4, 9.1 made
kernel 6.17 the default, and 9.2 ships kernel 7.0 and LXC 7.0. Single node, host root on BTRFS, no
GUI. Everything below is doable from a serial console / SSH shell.

This file emphasizes the access path that matters for a blind operator: `pct enter`, `pct exec`, and
`pct console` give full keyboard, screen-reader-friendly access to every container without ever
touching the web GUI or noVNC.

## TL;DR deltas from PVE 8

- **`pct enter` / `pct exec` `--keep-env` is version-sensitive.** The current Proxmox VE 9.2 manual
  still lists `--keep-env` with default 1 (the host environment is preserved), while warning that
  the default is changing. Scripts should pass `--keep-env 0` for a clean environment or
  `--keep-env 1` for inherited variables instead of relying on the implicit default.
- **cgroup v2 only (unified hierarchy).** PVE 9 / Debian 13 run pure cgroup v2; the hybrid cgroup v1
  fallback that older PVE offered is gone. Very old container userspaces (CentOS 6, Ubuntu 16.04 and
  similar) that only understand cgroup v1 will not boot. Any modern Debian/ Ubuntu/Alpine guest is
  fine. `cpuunits` default is 100 under cgroup v2 (it was 1024 under v1).
- **Privileged-container creation now gated by a privilege.** Creating a _privileged_ CT (i.e.
  `unprivileged 0`) requires the `Sys.Modify` privilege on `/` in PVE 9. Unprivileged is the default
  and the recommendation.
- **AppArmor 4** and a newer LXC (6.0.x). Behavior is mostly compatible; nesting/keyctl/fuse feature
  flags work as before.
- **PVE 9.1 adds OCI-image-based LXC deployment** (pull an OCI/Docker image and run it as an
  application container). Useful to know it exists, but the classic system-container `pct` workflow
  in this document is unchanged and remains the primary path.
- GlusterFS storage support was dropped in 9 (irrelevant to a BTRFS single node, noted for
  completeness).

## Templates: `pveam` (Proxmox VE Appliance Manager)

`pveam` manages the OS template catalog and downloads. Pure CLI, screen-reader clean.

```bash
pveam update # refresh the catalog (do this first)
pveam available # list everything available
pveam available --section system # just the base OS templates (debian/ubuntu/alpine/...)
pveam available --section turnkey # TurnKey appliances
pveam list local-btrfs # show templates already downloaded to active storage
pveam download local-btrfs debian-13-standard_13.x-1_amd64.tar.zst
pveam remove local-btrfs:vztmpl/<file> # delete a downloaded template
```

Downloaded templates live on a storage that has the `vztmpl` content type. On a default install that
uses the classic LVM layout that is the `local` storage, on disk at `/var/lib/vz/template/cache/`.
On this btrfs-root target, the active template store is `local-btrfs`, on disk at
`/var/lib/pve/local-btrfs/template/cache/`; the plain `local` storage is disabled. You reference a
template in `pct create` either by storage volid (`local-btrfs:vztmpl/<file>`) or by absolute path.

### Which Debian 13 / Ubuntu / Alpine templates exist (mid-2026)

- **Debian 13 "trixie"**: `debian-13-standard_*_amd64.tar.zst` is published in the official
  `pveam available --section system` catalog on PVE 9. (At the very first 9.0 GA there was a short
  window where the official Debian 13 appliance had not yet been built and people built their own
  with `dab`/the `dab-pve-appliances` repo; by the point releases the official `debian-13-standard`
  template is in the catalog.) Also still present: `debian-12-standard`, `debian-11-standard`.
- **Ubuntu**: `ubuntu-24.04-standard` (Noble, LTS) and `ubuntu-22.04-standard` (Jammy);
  `ubuntu-25.04-standard` interim where built. Pick the LTS (24.04) for home services.
- **Alpine**: `alpine-3.x-default_*_amd64.tar.xz` (rolling minor; e.g. alpine-3.21 / 3.22). Alpine
  is the smallest footprint and is excellent for single-purpose home services; note it is
  musl/BusyBox, so a few scripts expecting glibc differ.

Templates are compressed `.tar.zst` (newer) or `.tar.xz` / `.tar.gz` (older); `pct create` handles
all of them.

## Creating a container with `pct create`

Minimal unprivileged Debian 13 CT on BTRFS storage `local-btrfs` (rootfs auto-allocated as a
subvolume on BTRFS):

```bash
pct create 110 local-btrfs:vztmpl/debian-13-standard_13.x-1_amd64.tar.zst \
 --hostname web \
 --unprivileged 1 \
 --cores 2 --memory 2048 --swap 512 \
 --rootfs local-btrfs:8 \
 --net0 name=eth0,bridge=vmbr0,ip=dhcp \
 --features nesting=1 \
 --onboot 1 \
 --password # prompts for root pw; or use --ssh-public-keys <file>
```

Notes:

- `--rootfs local-btrfs:8` means "allocate an 8 GiB root volume on storage `local-btrfs`". On a
  BTRFS storage this becomes a BTRFS subvolume (so it supports cheap snapshots, see below).
- `--unprivileged 1` is the default and the right choice for home services.
- Static IP instead of DHCP: `--net0 name=eth0,bridge=vmbr0,ip=192.168.1.110/24,gw=192.168.1.1`.
- Add a VLAN tag: append `,tag=20` to the `net0` string.

## The container config file: `/etc/pve/lxc/<vmid>.conf`

`pct` is a thin front-end over this file. It lives in the cluster filesystem (`pmxcfs`), is a plain
INI-ish text file, and is fully editable by hand (then `pct start`/`pct reboot` to apply).
`pct config <vmid>` prints the effective config; `pct set <vmid> --opt val` edits it safely.

### Key options (PVE 9)

- `arch`: amd64 (default) | arm64 | armhf | i386 | riscv32 | riscv64.
- `ostype`: debian | ubuntu | alpine | archlinux | centos | fedora | opensuse | nixos | devuan |
  gentoo | unmanaged. Controls which init/network tweaks PVE applies inside the guest.
- `hostname`: the CT hostname.
- `cores`: number of CPU cores visible to the CT (cgroup cpuset). Omit = all host cores.
- `cpulimit`: hard ceiling as fractional cores (`0.5` = half a core, `2` = two cores). `0` = no
  limit.
- `cpuunits`: scheduler weight (relative share under contention). cgroup v2 default **100** (range
  roughly 1 - 10000). This replaced the v1 default of 1024.
- `memory`: RAM limit in **MB** (default 512).
- `swap`: additional swap in MB. With cgroup v2 this is enforced via `memory.swap.max`.
- `rootfs`: the root volume, e.g. `rootfs: local-btrfs:subvol-110-disk-0,size=8G` on BTRFS.
- `mp0..mp255`: additional mount points (volume or bind - see below).
- `net0..net9`: network interfaces (see below).
- `unprivileged`: `1` (default, recommended) | `0` (privileged, needs `Sys.Modify` in PVE 9).
- `features`: comma list - `nesting`, `keyctl`, `fuse`, `mknod`, `mount=<fstypes>`, `force_rw_sys`
  (see below).
- `onboot`: `1` to auto-start the CT when the host boots.
- `startup`: boot order/delay, format `order=<n>,up=<sec>,down=<sec>` - e.g.
  `startup: order=2,up=30` (start after order-1 guests, then wait 30 s before the next).
- `console`, `cmode` (tty|console|shell), `tty` (number of ttys): console behavior.
- `protection`: `1` blocks accidental destroy/disk-remove.
- `tags`, `description`: metadata.

### `net[n]` format

```text
net0: name=eth0,bridge=vmbr0,hwaddr=BC:24:11:..,ip=dhcp,type=veth
```

Common keys: `name=` (interface name inside CT), `bridge=` (host bridge, e.g. vmbr0), `ip=dhcp` or
`ip=192.168.1.110/24` + `gw=192.168.1.1`, `ip6=auto|dhcp|<cidr>`, `tag=<vlan>`, `rate=<MB/s>`
(shaping), `mtu=<n>`, `firewall=1`.

### `mp[n]` format - volume mounts vs bind mounts

```text
# Volume mount (Proxmox-managed; allocated on a storage; supports snapshot/backup/quota):
mp0: local-btrfs:subvol-110-disk-1,mp=/data,size=20G,backup=1

# Bind mount (share an existing HOST directory; NOT storage-managed):
mp0: /srv/host-share,mp=/data
```

Distinguishing rule: if the volume field is an **absolute host path** it's a _bind mount_; if it is
a **storage volid** it's a _volume mount_. Bind-mount caveats (PVE 9, unchanged):

- Not snapshotted, not quota'd, and **excluded from `vzdump` backups** by default.
- Source path must not traverse symlinks; use a directory reserved for the purpose.
- Permissions are the pain point on unprivileged CTs - see the next section. Useful `mp` flags:
  `ro=1` (read-only), `backup=1` (include volume mounts in backups), `acl=1`,
  `mountoptions=noatime`, `shared=1`, and `idmap=` for per-mount uid/gid shifting.

## A full example `/etc/pve/lxc/110.conf`

```ini
arch: amd64
ostype: debian
hostname: web
cores: 2
cpulimit: 2
cpuunits: 100
memory: 2048
swap: 512
unprivileged: 1
onboot: 1
startup: order=2,up=30
rootfs: local-btrfs:subvol-110-disk-0,size=8G
mp0: local-btrfs:subvol-110-disk-1,mp=/var/lib/data,size=20G,backup=1
mp1: /srv/media,mp=/media,ro=1
net0: name=eth0,bridge=vmbr0,ip=192.168.1.110/24,gw=192.168.1.1,tag=20,firewall=1
features: nesting=1,keyctl=1
description: Home web service

# Custom idmap so host UID/GID 1005 lines up inside the CT (for the bind mount above).
# These raw lxc.* lines are passed straight through to LXC:
lxc.idmap: u 0 100000 1005
lxc.idmap: g 0 100000 1005
lxc.idmap: u 1005 1005 1
lxc.idmap: g 1005 1005 1
lxc.idmap: u 1006 101006 64530
lxc.idmap: g 1006 101006 64530
```

Snapshots are recorded as extra `[snapname]` sections appended to this same file.

## Unprivileged containers + idmap (the bind-mount permission fix)

Default mapping for an unprivileged CT: container UID/GID `0..65535` map to host `100000..165535`.
So container root (0) is host UID 100000; container UID 1000 is host 101000. This is why a host
directory owned by `root:root` (host UID 0) shows up inside the CT as `nobody:nogroup` and is
unwritable - host UID 0 is outside the CT's mapped range.

Two ways to make a host bind-mount writable by the container:

**Option A - chown the host dir to the mapped UID.** If a service runs as UID 1000 inside the CT,
that is host UID 101000. So on the host: `chown -R 101000:101000 /srv/host-share`. Simple, no config
changes, but the host sees "weird" high UIDs.

**Option B - custom idmap so a real host UID lines up 1:1** (best when host and CT must share a
plain host UID such as 1005). Three edits:

1. In `/etc/pve/lxc/<vmid>.conf`, replace the implicit full-range map with a split map that punches
   a 1:1 hole for the shared id (example maps host 1005 to CT 1005):

```text
lxc.idmap: u 0 100000 1005
lxc.idmap: g 0 100000 1005
lxc.idmap: u 1005 1005 1
lxc.idmap: g 1005 1005 1
lxc.idmap: u 1006 101006 64530
lxc.idmap: g 1006 101006 64530
```

Meaning: CT uids 0 - 1004 to host 100000 - 101004; CT uid 1005 to host 1005 (the hole); CT uids
1006 - 65535 to host 101006 - 165535. (The g lines do the same for groups.) The three ranges must
together cover the full 0 - 65535 with no gaps/overlaps.

1. Allow root to delegate that single host id, in `/etc/subuid` and `/etc/subgid`:

```text
# /etc/subuid
root:1005:1
# /etc/subgid
root:1005:1
```

(These are _in addition to_ the default `root:100000:65536` lines already present.)

1. Set ownership on the host directory to the real id and start the CT:

```bash
chown -R 1005:1005 /srv/host-share
pct start <vmid>
```

Inside the CT the files now show as 1005:1005 and are writable, and on the host they are still
plainly owned by 1005:1005.

There is also a per-mount `idmap=` shorthand on `mp[n]` (e.g. `idmap=u:1005:1005:1;g:1005:1005:1`)
that shifts a single mount without rewriting the whole container map - handy for one-off shares.

## Access paths - no GUI required (the screen-reader backbone)

These three commands are why LXC is fully accessible to a shell-only / screen-reader operator. All
run over plain SSH or the host serial console and produce normal terminal output:

```bash
pct enter 110 --keep-env 0 # interactive root shell INSIDE the CT, clean environment
pct enter 110 --keep-env 1 # inherit the host environment explicitly
pct exec 110 -- systemctl status nginx # run one command; note the '--' separator
pct exec 110 --keep-env 1 -- env # run with host env preserved
pct console 110 # attach to the CT's tty/console (cmode tty); escape: Ctrl-a then q
pct console 110 --escape '^b' # change the escape prefix if Ctrl-a clashes with your tmux/screen
```

Guidance for a screen reader:

- Prefer **`pct enter`** for an interactive session - it is a clean PTY, behaves like a normal
  shell, and your screen reader reads it like any SSH session. No noVNC, no graphical console.
- Use **`pct exec -- <cmd>`** for scripting/automation; remember the `--` so flags after it go to
  the in-CT command, not to `pct`.
- **`pct console`** attaches to the literal container console (good for watching boot / fixing a
  broken network); exit with the escape sequence (default `Ctrl-a` then `q`). `pct enter` is usually
  nicer for day-to-day work because there is no escape-key dance.
- PVE-9 gotcha: the `--keep-env` default is not a stable contract. If a script relies on host vars
  (`HTTP_PROXY`, etc.), use `pct exec <ctid> --keep-env 1`; if you want isolation, use
  `--keep-env 0`.

Other routinely useful `pct` subcommands (all CLI, all accessible):

```bash
pct list # all CTs on the node, with status
pct config 110 # effective config
pct set 110 --memory 4096 # live-edit a setting
pct start 110 ; pct stop 110 ; pct reboot 110 ; pct shutdown 110
pct df 110 # disk usage
pct push 110 ./file /root/file ; pct pull 110 /root/file ./file
pct clone 110 111 --hostname web2
pct resize 110 rootfs +4G # grow the root volume
pct fstrim 110 # reclaim freed space
pct mount 110 / pct unmount 110 # mount CT rootfs on host for offline repair
pct template 110 # turn a CT into a template for linked clones
```

## Snapshots on BTRFS

Because the CT rootfs (and any volume mounts) sit on a BTRFS storage as subvolumes, snapshots are
fast, native BTRFS subvolume snapshots:

```bash
pct snapshot 110 before-upgrade --description "pre apt upgrade"
pct listsnapshot 110
pct rollback 110 before-upgrade
pct delsnapshot 110 before-upgrade
```

Caveats: snapshots only cover Proxmox-managed volumes (rootfs + volume `mp`s). **Bind mounts are not
snapshotted** (they are not Proxmox volumes). The snapshot metadata is stored as extra sections in
`/etc/pve/lxc/110.conf`. BTRFS storage must be configured as a Proxmox `btrfs` storage type (not
just a directory storage on a btrfs filesystem) for snapshot support to engage.

## cgroup v2 resource limits (PVE 9 / Debian 13)

PVE 9 is unified cgroup v2 exclusively. The `pct`/config knobs map onto v2 controllers:

- `cores` to the cpuset controller (which CPUs are visible).
- `cpulimit` to `cpu.max` (bandwidth ceiling).
- `cpuunits` to `cpu.weight` (relative share; default 100).
- `memory` to `memory.max`; `swap` to `memory.swap.max`.

Implication: container userspaces that only support cgroup v1 (very old distros) will not run on
PVE 9. All current Debian 13/12, Ubuntu 24.04/22.04, and Alpine 3.x guests are cgroup-v2 native and
work out of the box. Edit limits live with `pct set 110 --cores N --memory M --cpulimit X` - no host
reboot needed.

## Docker inside LXC on the PVE 9 kernel - reality

It is _technically possible_ and works on current PVE 9 kernels, including the 7.0 line in 9.2, but
Proxmox's standing recommendation is unchanged: **for Docker/Podman, run them inside a QEMU VM, not
an LXC**, when you want maximum isolation and the ability to live-migrate. Docker-in-LXC is a
convenience trade-off.

If you do run Docker in an LXC on PVE 9:

- Set `features: nesting=1,keyctl=1` (keyctl is required for Docker's use of the kernel keyring;
  nesting is required for the nested procfs/sysfs and the container-in-container model). `fuse=1` if
  you use fuse-overlayfs.
- **Unprivileged + nesting + keyctl** is the recommended posture and works for most stacks (overlay2
  storage driver on a modern kernel). Some images that need extra syscalls/devices may still fail;
  that's when people fall back to a **privileged** CT (which on PVE 9 now requires the `Sys.Modify`
  privilege to create) or to the Docker-in-a-VM approach.
- AppArmor 4 in PVE 9 is stricter; if a container workload trips AppArmor you may need a tuned
  profile. For a single-node home lab the pragmatic split is: lightweight always-on home services as
  native LXCs (no Docker), and any Docker-compose stack inside one dedicated VM (or one
  nesting-enabled LXC if you accept the caveats).
- New in PVE 9.1: native **OCI image** support for application containers via the GUI/`pct`, which
  is a Proxmox-blessed alternative to bolting Docker inside a system container for simple
  single-image apps.

## Accessibility summary

Every operation above is a terminal command with plain text output. `pct enter` gives a normal
interactive shell inside any container, `pct exec -- cmd` runs single commands, and `pct console`
attaches to the raw console for boot/repair - none require the web GUI or a graphical console, so
LXC management is fully screen-reader friendly. The only PVE-9 behavioral change to internalize is
`--keep-env` being version-sensitive; pass `--keep-env 0` or `--keep-env 1` explicitly.

## Citations

- pct(1) manual - [pct(1)](https://pve.proxmox.com/pve-docs/pct.1.html) (subcommands, `--keep-env`
  default warning, features, create options)
- Proxmox Container Toolkit chapter -
  [Proxmox Container Toolkit](https://pve.proxmox.com/pve-docs/chapter-pct.html)
  (unprivileged/idmap, bind vs volume mounts, features, pveam, Docker-in-LXC guidance)
- pct.conf(5) - [pct.conf(5)](https://pve.proxmox.com/pve-docs/pct.conf.5.html) (config file option
  reference)
- Unprivileged LXC containers wiki -
  [Unprivileged LXC containers](https://pve.proxmox.com/wiki/Unprivileged_LXC_containers) (lxc.idmap
  worked example, /etc/subuid, /etc/subgid, chown fix)
- Proxmox VE 9.x release / Roadmap - [Roadmap](https://pve.proxmox.com/wiki/Roadmap) and
  [Proxmox Virtual Environment 9.0 with Debian 13 released](https://www.proxmox.com/en/about/company-details/press-releases/proxmox-virtual-environment-9-0)
  (Debian 13 base, PVE 9.0/9.1/9.2 kernel progression, LXC 6.0.x to 7.0, cgroup v2, privileged-CT
  privilege)
- Upgrade from 8 to 9 - [Upgrade from 8 to 9](https://pve.proxmox.com/wiki/Upgrade_from_8_to_9)
  (cgroup v2, Sys.Modify for privileged CTs, GlusterFS dropped)
- PVE 9.1 OCI LXC -
  [Proxmox ve 9 1 released with oci based lxc deployment (linuxiac.com)](https://linuxiac.com/proxmox-ve-9-1-released-with-oci-based-lxc-deployment/)
- Debian 13 LXC template availability -
  [Debian 13 LXC Template](https://forum.proxmox.com/threads/debian-13-lxc-template.169469/)
