# LXC Container Management via `pct` (Proxmox VE 8.x / 9.x)

Audience: blind screen-reader user, single PVE node, shell-only. The web GUI is inaccessible, so
everything below is a shell command or a named config-file edit. The primary access path into a
container is `pct enter <vmid>` / `pct exec <vmid> -- <cmd>`; no console GUI is ever needed.

Primary sources: Proxmox `pct.1`, `pveam.1`, `chapter-pct.html`, and the wiki pages "Linux
Container" and "Unprivileged LXC containers".

## 1. LXC vs VM - what they are and when to choose each

- LXC container: an OS-level (kernel-shared) container. It does NOT boot its own kernel - it shares
  the host's kernel and runs a Linux userland directly. Very low overhead, fast start/stop,
  near-zero RAM/CPU tax, instant boot. Managed with `pct`.
- VM (QEMU/KVM): full hardware virtualization with its own kernel and (optionally) its own OS -
  including non-Linux (Windows, BSD). Managed with `qm`. Stronger isolation, larger footprint.

Choose an LXC container when:

- The guest is Linux and you want maximum density/lowest overhead (many lightweight services: DNS,
  reverse proxy, web app, databases, Pi-hole, etc.).
- You want bind mounts to share host directories directly (cheap and fast).
- You want very fast boot and snapshot/clone.

Choose a VM when:

- You need a non-Linux OS, a different/custom kernel, kernel modules, or a custom kernel version.
- You need strong security isolation (untrusted workloads). LXC shares the host kernel, so
  kernel-level isolation is weaker than a VM.
- You want to run Docker/Kubernetes as the documented, supported path (Proxmox officially recommends
  running application-container engines like Docker inside a VM, not inside an LXC - see Gotchas).
- You need PCI/GPU passthrough with full device semantics, Secure Boot, TPM, etc.

Citation: pve.proxmox.com/wiki/Linux_Container; chapter-pct.html.

## 2. Container templates from the shell (`pveam`)

`pveam` = Proxmox VE Appliance Manager. Templates are downloaded to a storage that has the `vztmpl`
content type (default `local`, path `/var/lib/vz/template/cache/`).

```bash
pveam update # refresh the template catalog (do this first)
pveam available # list all available templates
pveam available --section system # only base OS images (system | mail | turnkeylinux)
pveam download local debian-12-standard_12.7-1_amd64.tar.zst # download to 'local'
pveam list local # list templates already present on a storage
pveam remove local:vztmpl/<file> # delete a downloaded template
```

- `pveam download <storage> <template>` - the template name is the second column from
  `pveam available`. Use the exact string.
- Downloaded files live at `/var/lib/vz/template/cache/`. You can also drop your own `.tar.gz` /
  `.tar.zst` / `.tar.xz` rootfs tarballs there and reference them directly.
- TurnKey Linux appliances appear in the `turnkeylinux` section.

Citation: pveam.1.html; chapter-pct.html.

## 3. The `pct` command surface

VMID is a unique integer 100 - 999999999. `pct help` and `pct help <cmd>` show full options.
Subcommands:

Lifecycle:

- `pct create <vmid> <ostemplate> [OPTIONS]` - create (or restore from backup).
- `pct start <vmid> [--debug] [--skiplock]`
- `pct shutdown <vmid> [--forceStop <0|1>] [--timeout <sec>]` - clean ACPI-style shutdown.
- `pct stop <vmid> [--skiplock]` - hard stop (pull the plug).
- `pct reboot <vmid> [--timeout <sec>]`
- `pct suspend <vmid>` / `pct resume <vmid>`
- `pct destroy <vmid> [--force] [--purge] [--destroy-unreferenced-disks]` - delete the container.
  `--purge` also removes it from backup jobs/HA/replication configs.

Inspect / list:

- `pct list` - list all containers (VMID, Status, Name).
- `pct status <vmid> [--verbose]`
- `pct config <vmid>` - print the effective config (the `.conf` file contents).
- `pct df <vmid>` - show filesystem usage of the container's mountpoints.
- `pct pending <vmid>` - show pending (not-yet-applied) config changes.
- `pct cpusets` / `pct listsnapshot <vmid>`.

Access (the core CLI workflow - no GUI console needed):

- `pct enter <vmid>` - open a root shell inside the container's namespace. The current PVE 9.2
  manual still lists `--keep-env` as defaulting to 1, but warns that the default is changing. Pass
  `--keep-env 0` or `--keep-env 1` explicitly.
- `pct exec <vmid> -- <command> [args...]` - run one command inside. The `--` separates pct options
  from the in-container command. Example: `pct exec 100 -- apt update`.
- `pct console <vmid> [--escape ^a]` - getty login session (still terminal, not GUI).
  `pct enter`/`pct exec` are usually preferable.

Config edits:

- `pct set <vmid> [OPTIONS]` - change config keys, e.g. `pct set 100 -memory 512`,
  `pct set 100 -cores 2`, `pct set 100 -net0 name=eth0,bridge=vmbr0,ip=dhcp`,
  `pct set 100 -mp0 /host/path,mp=/container/path`, `pct set 100 -onboot 1`. Use `-delete <key>` to
  remove a key: `pct set 100 -delete mp0`.

File transfer between host and container:

- `pct push <vmid> <host-file> <container-dest> [--user <u>] [--group <g>] [--perms <mode>]`
- `pct pull <vmid> <container-path> <host-dest> [--user] [--group] [--perms]`

Filesystem mount (host side, for repair while CT is stopped):

- `pct mount <vmid>` - mount the container's rootfs under `/var/lib/lxc/<vmid>/rootfs` on the host
  (CT should be stopped).
- `pct unmount <vmid>` - unmount it again.
- `pct fstrim <vmid> [--ignore-mountpoints]` - reclaim freed space on thin storage.

Clone / templatize:

- `pct clone <vmid> <newid> [--full] [--hostname <h>] [--storage <s>] [--snapname <s>] [--description] [--pool] [--bwlimit]`
- linked clone by default for templates; `--full` makes an independent full copy.
- `pct template <vmid>` - convert a (stopped) container into a template so it can be linked-cloned.

Snapshots (require snapshot-capable storage: ZFS, btrfs, or LVM-thin / qcow2):

- `pct snapshot <vmid> <snapname> [--description <d>]`
- `pct listsnapshot <vmid>`
- `pct rollback <vmid> <snapname> [--start]`
- `pct delsnapshot <vmid> <snapname> [--force]`

Resize disk:

- `pct resize <vmid> <disk> <size>` - grow a volume, e.g. `pct resize 100 rootfs +5G` or set
  absolute `pct resize 100 mp0 20G`. Shrinking is not supported.

Other:

- `pct rescan` - rescan storages and add unreferenced volumes to config.
- `pct move-volume <vmid> <volume> <target-storage>` (a.k.a. move disk).
- `pct remote-migrate` / `pct migrate` (cluster only - N/A on single node).
- `pct fsck <vmid>` - run filesystem check on a stopped CT's volume.
- `pct reboot`, `pct restart` are distinct from `pct stop`+`pct start`.

Citation: pct.1.html; pve-admin-guide.html; chapter-pct.html.

## 4. The container config file: `/etc/pve/lxc/<vmid>.conf`

This file IS the container. `pct config <vmid>` prints it; `pct set` edits it; you can also edit it
directly with a text editor (it lives on the cluster filesystem pmxcfs). Direct edits are fine when
the CT is stopped; some keys apply on next start.

Key options (one `key: value` per line):

- `arch: amd64` - CPU architecture (amd64 | arm64 | armhf | i386 | riscv32 | riscv64).
- `ostype: debian` - guest OS family (debian, ubuntu, alpine, archlinux, centos, fedora, opensuse,
  gentoo, nixos, unmanaged). Controls how PVE manages hostname/network/DNS inside the guest.
- `hostname: ct-web`
- `cores: 2` - number of CPU cores visible to the container.
- `cpulimit: 0.5` - fractional CPU-time cap (0 = unlimited). 0.5 = half a core.
- `cpuunits: 100` - relative CPU weight (cgroup v2 default 100; cgroup v1 default 1024).
- `memory: 512` - RAM cap in MB (maps to the cgroup memory limit).
- `swap: 512` - swap cap in MB.
- `rootfs: local-lvm:vm-100-disk-0,size=8G` - the root volume (storage:volume,size).
- `mp0: ...` / `mp1: ...` - additional mount points (volume or bind; see below).
- `net0: name=eth0,bridge=vmbr0,ip=dhcp` - network interface (net0..net9).
- `unprivileged: 1` - 1 = unprivileged (recommended default), 0 = privileged.
- `features: nesting=1,keyctl=1,fuse=1,mount=nfs;cifs` - advanced features (below).
- `onboot: 1` - start automatically when the host boots.
- `startup: order=2,up=30,down=30` - boot order / up-delay / shutdown-timeout.
- `tags: web,prod` - free-form labels.
- `description: ...` - multi-line note (each line prefixed `#` in the file).
- `lock: ...` - internal lock state (backup/snapshot/etc.); usually not set by hand.
- `lxc.<...>: <value>` - raw LXC config passthrough (see Raw options).

### Mount points (`rootfs`, `mp0`..`mp255`)

Two kinds:

1. Volume mount (a managed PVE disk on a storage):

```text
mp0: local-lvm:vm-100-disk-1,mp=/data,size=10G,backup=1
```

Options: `mp=` (path inside CT, required), `size=`, `backup=<0|1>`, `ro=<0|1>`, `acl=<0|1>`,
`quota=<0|1>`, `replicate=<0|1>`, `mountoptions=noatime;nodev`, `shared=<0|1>`.

1. Bind mount (share an existing host directory directly - no `size`):

```text
mp0: /mnt/bindmounts/shared,mp=/shared
```

The source is an absolute host path. PVE advice: reserve a dedicated host directory tree for bind
mounts (e.g. `/mnt/bindmounts/...`) that contains NO symlinks, to avoid escaping the intended
subtree. Bind mounts are NOT backed up by vzdump and are NOT snapshotted by `pct snapshot`.

`mp<N>` also accepts `idmap=type:container:disk:range-size;...` for per-mountpoint ID remapping on
unprivileged containers.

### Network (`net0`..`net9`)

```text
net0: name=eth0,bridge=vmbr0,ip=192.168.1.100/24,gw=192.168.1.1
net0: name=eth0,bridge=vmbr0,ip=dhcp
```

Keys: `name=` (in-guest iface name), `bridge=` (host bridge, e.g. vmbr0), `ip=` (CIDR or `dhcp` or
`manual`), `gw=`, `ip6=`, `gw6=`, `hwaddr=` (MAC), `tag=` (VLAN), `rate=` (Mbit/s shaping),
`firewall=<0|1>`, `mtu=`. Up to 10 interfaces. Set DNS with
`pct set <vmid> -nameserver 1.1.1.1 -searchdomain lan`.

### Privileged vs unprivileged

- `unprivileged: 1` is the recommended default. Root (uid 0) inside the container is mapped to an
  unprivileged high host uid (default uid 0 to 100000, 1 to 100001, ...), so a container breakout
  lands as a powerless host user.
- `unprivileged: 0` (privileged): in-container root is real host root (modulo
  AppArmor/seccomp/namespaces). The LXC team considers privileged containers inherently insecure;
  exploits there are NOT treated as CVEs. Use only for trusted workloads, and only when something
  genuinely needs it.
- The privileged/unprivileged choice is fixed at creation; to switch, back up and restore into a new
  container with the other setting (or recreate).

### Features

`features: nesting=1,keyctl=1,fuse=1,mknod=1,mount=nfs;cifs,force_rw_sys=1`

- `nesting=1` - allow nested containers; exposes a more complete procfs/sysfs. Required for running
  Docker/Podman or systemd-in-systemd cleanly inside the CT.
- `keyctl=1` - allow the `keyctl()` syscalls (needed by systemd-networkd and Docker in unprivileged
  CTs).
- `fuse=1` - allow FUSE filesystems inside the CT.
- `mknod=1` - allow creating device nodes (restricted set).
- `mount=nfs;cifs` - allow mounting these filesystem types from inside the CT.
- `force_rw_sys=1` - mount /sys read-write (rare; some workloads need it).

Set features via `pct set 100 -features nesting=1,keyctl=1`.

### Raw `lxc.*` options

Any key beginning `lxc.` is passed through verbatim to the underlying LXC config. Common uses:

- `lxc.apparmor.profile = unconfined` - disable AppArmor for the CT (NOT recommended; needed for
  some Docker-in-LXC setups).
- `lxc.cgroup2.devices.allow = c 10:200 rwm` - allow a device (e.g. /dev/net/tun).
- `lxc.mount.entry = ...` - raw mount entries.
- `lxc.idmap = ...` - custom UID/GID mapping (see next section). Note: keys that `pct` itself
  manages cannot all be overridden; PVE filters some.

Citation: pct.1.html (config section); chapter-pct.html.

## 5. Unprivileged containers and ID mapping (idmap)

Default mapping for an unprivileged CT: container uid/gid 0..65535 map to host 100000..165535. So
in-container root (0) = host 100000. A host directory bind-mounted in will show up owned by
`nobody`/`nogroup` (host 65534) inside the CT unless its host ownership falls in the 100000+ range.

Two ways to make a bind mount writable from an unprivileged CT:

A) Keep the default mapping, and on the HOST chown the shared directory to the mapped uid. For
in-container uid 1000 you chown host side to 101000:

```bash
chown -R 101000:101000 /mnt/bindmounts/shared
```

B) Custom idmap so a specific host uid/gid passes through unchanged (best when you want the SAME uid
inside and out, e.g. matching an NFS/SMB account). To expose host uid/gid 1005 unchanged inside the
CT, add to `/etc/pve/lxc/<vmid>.conf`:

```text
lxc.idmap = u 0 100000 1005
lxc.idmap = g 0 100000 1005
lxc.idmap = u 1005 1005 1
lxc.idmap = g 1005 1005 1
lxc.idmap = u 1006 101006 64530
lxc.idmap = g 1006 101006 64530
```

Read each line as: `<u|g> <guest_start_id> <host_start_id> <count>`. The three ranges map 0..1004 to
the high range, pass 1005 through 1:1, then map 1006..65535 back to the high range. You must also
authorize root to use that host id by adding to `/etc/subuid` and `/etc/subgid`:

```text
# /etc/subuid
root:1005:1
# /etc/subgid
root:1005:1
```

Then chown the data on the host to that id and start the CT:

```bash
chown -R 1005:1005 /mnt/bindmounts/shared
pct start <vmid>
```

Set the remapping BEFORE first start to avoid having to re-chown existing files.

Alternative architectural fix: instead of bind-mounting host dirs into an unprivileged CT, mount
NFS/CIFS INSIDE the container with a consistent service account uid/gid.

Citation: wiki/Unprivileged_LXC_containers; apalrd.net idmap tip; chapter-pct.html.

## 6. Bind mounts to share host directories - worked example

```bash
mkdir -p /mnt/bindmounts/media # dedicated, symlink-free host dir
pct set 110 -mp0 /mnt/bindmounts/media,mp=/media # add bind mount to CT 110
# (unprivileged) fix ownership so the CT user can write, e.g. default-map uid 1000:
chown -R 101000:101000 /mnt/bindmounts/media
pct exec 110 -- ls -la /media # verify from inside, no GUI needed
```

Read-only share: `pct set 110 -mp0 /mnt/bindmounts/media,mp=/media,ro=1`. Reminder: bind mounts are
not included in vzdump backups or in `pct snapshot` - back up that host directory separately.

## 7. Resource limits and cgroups

- CPU count: `cores` (visible CPUs). CPU time cap: `cpulimit` (e.g. 1.5 = 1.5 cores). Relative share
  under contention: `cpuunits`.
- Memory cap: `memory` (MB) to cgroup memory limit; `swap` (MB).
- Disk size: set at `rootfs`/`mp<N>` `size=`, change with `pct resize`.
- Disk I/O during clone/restore: `--bwlimit` (KiB/s).
- PVE 8/9 use cgroup v2 by default (unified hierarchy). Limits are enforced through the
  corresponding cgroup v2 controllers.
- Apply live: `pct set` updates most limits on a running CT immediately (memory/cores/cpulimit).
  Some keys only take effect on next start (`pct pending` shows what is queued).

Citation: chapter-pct.html (CPU/memory sections); pct.1.html.

## 8. Common gotchas

- Privileged vs unprivileged is decided at creation and cannot be toggled in place -
  recreate/restore to change it.
- Unprivileged bind-mount permissions: files appear as `nobody` until you align uid/gid via chown to
  the 100000+ range or a custom idmap (Section 5). This is the single most common LXC pain point.
- Snapshots need snapshot-capable storage (ZFS, btrfs, LVM-thin, qcow2). On plain `dir`/LVM-thick
  storage `pct snapshot` will fail.
- Bind mounts are excluded from vzdump backups and from container snapshots - protect that data
  separately.
- Docker-in-LXC: works but is officially discouraged; Proxmox recommends Docker inside a VM. If you
  insist on LXC: set `features: nesting=1,keyctl=1` (and often `fuse=1`). Recent runc (1.2+) writes
  `net.ipv4.ip_unprivileged_port_start=0` per network namespace, which fails in UNPRIVILEGED CTs on
  current kernels - so a PRIVILEGED CT is frequently required to make Docker work, and some setups
  also need `lxc.apparmor.profile = unconfined`. Each loosened feature erodes the isolation that
  justified using a container instead of a VM. The cgroup v2 + overlay2 combo sometimes forces the
  slow `vfs` storage driver.
- Mounting NFS/CIFS from inside a CT requires `features: mount=nfs;cifs` (and usually privileged or
  extra capabilities).
- `pct enter`/`pct exec` only work while the CT is running. To poke at a stopped CT's filesystem
  from the host, use `pct mount <vmid>` then `pct unmount <vmid>`.
- `pct destroy` does not by default remove the CT from backup jobs/HA - use `--purge`.
- The `pct enter --keep-env` default is version-sensitive; pass `--keep-env 0` for a clean
  environment or `--keep-env 1` if a script relies on inheriting the host environment.

Citation: wiki/Linux_Container; dev.to/mattercoder Docker-on-LXC analysis; forum threads on
nesting/keyctl; chapter-pct.html (privileged containers warning).

## 9. End-to-end example: create and use an unprivileged Debian CT (shell only)

```bash
pveam update
pveam available --section system
pveam download local debian-12-standard_12.7-1_amd64.tar.zst

pct create 110 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
 --hostname web \
 --cores 2 --memory 1024 --swap 512 \
 --rootfs local-lvm:8 \
 --net0 name=eth0,bridge=vmbr0,ip=dhcp \
 --unprivileged 1 \
 --features nesting=1 \
 --onboot 1 \
 --password # prompts for root password; or --ssh-public-keys <file>

pct start 110
pct status 110
pct exec 110 -- apt-get update
pct enter 110 # interactive root shell inside the container
# ... work inside, then exit ...
pct set 110 -mp0 /mnt/bindmounts/media,mp=/media
pct snapshot 110 before-upgrade
pct rollback 110 before-upgrade
pct shutdown 110
```

Citation: chapter-pct.html (create example); pct.1.html.

## Sources

- [pct(1)](https://pve.proxmox.com/pve-docs/pct.1.html)
- [pveam(1)](https://pve.proxmox.com/pve-docs/pveam.1.html)
- [Proxmox Container Toolkit](https://pve.proxmox.com/pve-docs/chapter-pct.html)
- [Proxmox VE Administration Guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.html)
- [Linux Container](https://pve.proxmox.com/wiki/Linux_Container)
- [Unprivileged LXC containers](https://pve.proxmox.com/wiki/Unprivileged_LXC_containers)
- [Proxmox Unprivilaged LXC Container Bind Mount UID/GID Mapping :: apalrd's adventures](https://www.apalrd.net/posts/2023/tip_idmap/)
- [Docker on Proxmox LXC: What Actually Works (and Why Unprivileged Doesn't)](https://dev.to/mattercoder/docker-on-proxmox-lxc-what-actually-works-and-why-unprivileged-doesnt-45km)
