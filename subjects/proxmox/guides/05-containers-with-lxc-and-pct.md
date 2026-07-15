# Containers with LXC and pct

## What you'll be able to do

By the end of this guide you will have stood up your first real guest: an unprivileged Debian 13 LXC
container, created, entered, snapshotted, and cloned entirely from the shell. You will know where
its config file lives and how to edit it safely, the difference between a bind mount and a volume
mount, the idmap fix that makes a shared host directory writable from inside an unprivileged
container, and the Proxmox VE 9 behaviour changes that affect all of this. A container is the
fastest path to a running, accessible guest, which is why it comes before virtual machines.

## Before you start

Some of what follows is specific to Proxmox VE 9, so confirm your version first:

```bash
pveversion
```

You should see a `9.x` release. Two version facts shape this whole guide. First, Proxmox VE 9 (on
Debian 13 "trixie") runs a pure cgroup v2 hierarchy with no cgroup v1 fallback, so a very old
container userspace that only understands cgroup v1 (CentOS 6, Ubuntu 16.04, and the like) will not
boot. Any current Debian, Ubuntu, or Alpine guest is cgroup v2 native and works out of the box, so
this is not a concern for the templates this guide uses. Second, an unprivileged container is the
default and the recommendation in Proxmox VE 9; creating a privileged container now needs an extra
privilege, covered in the deltas section near the end.

You do this work over SSH as root on the Proxmox host, the way guide 03 left it: repositories clean
and the host fully upgraded.

## Get an OS template with pveam

A container starts from an OS template (vztmpl): a compressed root-filesystem tarball that
`pct create` unpacks into the new container's root. You manage templates with `pveam`, the Proxmox
VE Appliance Manager. It is pure command line and reads cleanly with a screen reader.

Refresh the catalog first, then list the base operating-system templates:

```bash
pveam update
pveam available --section system
```

`pveam update` downloads the current list of available templates; run it before `available` or the
list may be stale. `pveam available --section system` prints just the base OS templates (Debian,
Ubuntu, Alpine, and so on), one per line. The three practical choices for home services are Debian
13 "trixie" (`debian-13-standard_*_amd64.tar.zst`), Ubuntu 24.04 LTS (`ubuntu-24.04-standard`), and
Alpine (`alpine-3.x-default_*`, the smallest footprint, though it is musl and BusyBox rather than
glibc, so a few glibc-expecting scripts differ). This guide uses Debian 13.

Download the Debian 13 template to the active `local-btrfs` storage. The filename ends in a
point-release version; copy the exact name from the `available` output (the `*` below stands in for
that version):

```bash
pveam download local-btrfs debian-13-standard_*_amd64.tar.zst
pveam list local-btrfs
```

`pveam list local-btrfs` shows the templates already downloaded to `local-btrfs`. Downloaded
templates land on a storage that carries the `vztmpl` content type; on this btrfs-root node that is
the active `local-btrfs` storage (the plain `local` directory storage is disabled here, per guide
[09 -- Storage](09-storage.md)), on disk under `/var/lib/pve/local-btrfs/template/cache/`. You then
reference a template in `pct create` by its storage volid, `local-btrfs:vztmpl/<file>`.

## Create an unprivileged container

Now create the container. The command below is a complete, unprivileged Debian 13 container on btrfs
storage. It is written across several lines for readability; the trailing backslash continues each
line. The `110` is the VMID, the numeric id this guest is known by from now on.

```bash
pct create 110 local-btrfs:vztmpl/debian-13-standard_13.x-1_amd64.tar.zst \
 --hostname web \
 --unprivileged 1 \
 --cores 2 --memory 2048 --swap 512 \
 --rootfs local-btrfs:8 \
 --net0 name=eth0,bridge=vmbr0,ip=192.168.1.110/24,gw=192.168.1.1 \
 --features nesting=1 \
 --onboot 1 \
 --ssh-public-keys /root/web.pub
```

Reading the options in turn:

- `--unprivileged 1` makes this an unprivileged container, where the container's root user is mapped
  to a harmless high uid on the host. This is the default and the right choice for home services.
- `--cores 2 --memory 2048 --swap 512` give it two CPU cores, 2048 MB of RAM, and 512 MB of swap.
  Memory and swap are in MB.
- `--rootfs local-btrfs:8` allocates an 8 GiB root volume on the active `local-btrfs` storage, the
  btrfs storage created by the btrfs-root install (the storage model is covered in guide
  [09 -- Storage](09-storage.md); note the plain `local` directory storage is disabled on this node
  and in any case carries no `rootdir` content type, so it cannot hold a container rootfs). Because
  you asked for a fixed size, Proxmox stores this as a raw ext4 image (a `disk.raw` file) inside a
  btrfs subvolume wrapper: the raw file enforces the 8 GiB cap, and the wrapping subvolume is what
  keeps the snapshots later in this guide cheap and native. (A hard size cap on a bare btrfs
  subvolume would need subvolume quotas, which Proxmox avoids because they interfere with
  `btrfs send`, so it reaches for a raw file instead.) Proxmox expands the shorthand into a concrete
  volid, so `pct config` later shows it as `rootfs: local-btrfs:110/vm-110-disk-0.raw,size=8G`
  rather than the `local-btrfs:8` you typed.
- `--net0 name=eth0,bridge=vmbr0,ip=192.168.1.110/24,gw=192.168.1.1` attaches an interface named
  `eth0` inside the container to the host bridge `vmbr0` and gives it a static LAN address and
  gateway. A fixed address is this corpus's default, so a service is always reachable at the same
  place; guide [10 -- Networking](10-networking.md) covers the address plan and the DHCP
  alternative.
- `--features nesting=1` enables nesting, needed for some workloads (and for Docker-in-a-container,
  noted later).
- `--onboot 1` auto-starts the container when the host boots.
- `--ssh-public-keys /root/web.pub` injects the public key in that file into the container's root
  `authorized_keys`, so the container comes up SSH-reachable with no password. Prefer this over
  `--password` (which prompts for a root password): key-based access is the goal state from
  guide 04. Put your control-station public key at `/root/web.pub` on the host first (copy it over
  with `scp`, or write it with a here-doc); `pct create` fails if that file is absent.

If you would rather let your router hand out the address by DHCP (reasonable for a throwaway, but a
service other machines point at wants a fixed address), use `ip=dhcp` instead:

```bash
 --net0 name=eth0,bridge=vmbr0,ip=dhcp
```

To put the interface on a VLAN, append a tag:

```bash
 --net0 name=eth0,bridge=vmbr0,ip=192.168.1.110/24,gw=192.168.1.1,tag=20
```

One safety note carries over from guide 02. The key you inject with `--ssh-public-keys` lands in the
container's `authorized_keys`, which shares the lockout caveat guide 02 raised for the host: keep an
independent copy of your public key in `~/.ssh/authorized_keys2` so you are not locked out if the
primary key file is ever unavailable, and remember that `pct enter` (below) is always there as a
fallback door regardless.

One optional tuning step fits here, right after creation. Because that rootfs is a raw ext4 image
(see above), its first start after any future `pct rollback` stalls about 40 seconds on an ext4
Multiple Mount Protection check. Now, while the container is freshly created and stopped, is the
cleanest moment to strip that feature if you expect to lean on fast snapshot rollbacks; the ext4 MMP
note under "Snapshots, clones, and templates" below has the why and the exact commands.

## Get inside and verify

Start the container, then step into it:

```bash
pct start 110
pct enter 110
```

`pct enter 110` opens a clean interactive root shell inside the container. It is a normal PTY that
your screen reader reads like any SSH session, with no escape-key dance to leave it; exit with
`exit` or Ctrl-D. To run a single command without entering, use `pct exec` with the `--` separator:

```bash
pct exec 110 -- systemctl status
```

Be explicit about environment inheritance: pass `--keep-env 0` when you want a clean environment,
and `--keep-env 1` if you need the host's environment variables inherited. Guide 04 covers the
access verbs in full (`pct enter`, `pct exec`, `pct console`, the escape keys, and the
version-sensitive `--keep-env` default), so reach for it rather than re-reading the detail here.

## The container config file

`pct` is a thin front end over a single plain-text config file. Every container has one, named by
its VMID.

The file is:

```text
/etc/pve/lxc/<vmid>.conf
```

It lives on pmxcfs (the `/etc/pve` filesystem), is an INI-style text file, and is safe to edit two
ways: with `pct set <vmid> --opt val` (which validates the change), or by hand followed by
`pct reboot <vmid>` to apply. `pct config <vmid>` prints the effective config.

The key options, as a readable list:

- `cores`: number of CPU cores visible to the container. Omit to allow all host cores.
- `cpulimit`: a hard ceiling in fractional cores (`0.5` is half a core, `2` is two cores; `0` is no
  limit).
- `cpuunits`: the scheduler weight, the relative share under contention. Under cgroup v2 the default
  is `100` (it was `1024` under the old cgroup v1).
- `memory`: the RAM limit in MB (default 512).
- `swap`: additional swap in MB.
- `rootfs`: the root volume, for example `local-btrfs:110/vm-110-disk-0.raw,size=8G`.
- `net0` through `net9`: network interfaces.
- `features`: a comma list such as `nesting=1,keyctl=1`.
- `onboot`: `1` to auto-start the container when the host boots.
- `startup`: boot order and delay, format `order=<n>,up=<sec>,down=<sec>`, for example
  `order=2,up=30`.
- `protection`: `1` blocks an accidental destroy or disk-remove.

A full example config follows. This is what `/etc/pve/lxc/110.conf` might look like once it has a
data volume mount, a media bind mount, and a custom idmap (both explained in the next two sections):

File `/etc/pve/lxc/110.conf`:

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
rootfs: local-btrfs:110/vm-110-disk-0.raw,size=8G
mp0: local-btrfs:110/vm-110-disk-1.raw,mp=/var/lib/data,size=20G,backup=1
mp1: /srv/media,mp=/media,ro=1
net0: name=eth0,bridge=vmbr0,ip=192.168.1.110/24,gw=192.168.1.1,tag=20,firewall=1
features: nesting=1,keyctl=1
description: Home web service

lxc.idmap: u 0 100000 1005
lxc.idmap: g 0 100000 1005
lxc.idmap: u 1005 1005 1
lxc.idmap: g 1005 1005 1
lxc.idmap: u 1006 101006 64530
lxc.idmap: g 1006 101006 64530
```

Snapshots are recorded as extra `[snapname]` sections appended to this same file. Those sections are
written by `pct snapshot`; never hand-edit them.

## Storage for data -- volume mounts vs bind mounts

Beyond the root filesystem, a container can have extra mount points, `mp0` through `mp255`. There
are two kinds, and one rule tells them apart: if the source is an absolute host path, it is a bind
mount; if the source is a storage volid, it is a volume mount.

A volume mount is a Proxmox-managed volume allocated on a storage. It can be snapshotted, quota'd,
and included in backups. The mount-point line gives a storage volid, a mount path inside the
container, a size, and optionally backup inclusion:

```text
mp0: local-btrfs:110/vm-110-disk-1.raw,mp=/var/lib/data,size=20G,backup=1
```

The mount path (`/var/lib/data` here) is yours to choose; it is just where the volume appears inside
the container.

A bind mount instead shares an existing host directory into the container. Its source is an absolute
host path, and you typically set it read-only with `ro=1`:

```text
mp1: /srv/media,mp=/media,ro=1
```

The bind mount trade-off matters: because a bind mount is not a Proxmox-managed volume, it is not
snapshotted, not quota'd, and excluded from `vzdump` backups by default. Use a volume mount for data
you want snapshotted and backed up; use a bind mount to share existing host files (a media library,
for instance) that are managed and backed up separately. Bind mounts on an unprivileged container
also need the permission fix in the next section.

## The unprivileged permission fix (idmap)

This is the one part of unprivileged containers that surprises everyone, so it is worth
understanding before you hit it.

An unprivileged container does not run with real host root. By default its uids and gids `0` through
`65535` map to host `100000` through `165535`. So container root (uid 0) is host uid 100000, and
container uid 1000 is host uid 101000. That mapping is what makes the container safe: even root
inside it has no real power on the host.

The mapping also explains a common confusion. A host directory owned by `root:root` (host uid 0)
shows up inside the container as `nobody:nogroup` and is unwritable, because host uid 0 is outside
the container's mapped range (100000 and up). The fix is to line up ownership across the mapping.
There are two ways.

### Option A: chown the host directory

Chown the host directory to the mapped uid. If a service runs as uid 1000 inside the container, that
is host uid 101000. So set the host directory's owner to that:

```bash
chown -R 101000:101000 /srv/host-share
```

This needs no config changes. The only oddity is that the host then shows the directory owned by a
high uid (101000) rather than a friendly name.

### Option B: a custom lxc.idmap

A custom `lxc.idmap` punches a 1:1 hole so a real host uid lines up unchanged inside the container.
This is the better choice when host and container must share a plain host uid such as 1005. It takes
three edits.

First, in the container config, replace the implicit full-range map with a split map. The example
below maps host 1005 to container 1005. This is one of the rare cases where you hand-edit a pmxcfs
file directly (`pct set` has no option for `lxc.idmap`), rather than letting a CLI tool write it;
append these lines the accessible way from guide 02's "Editing files accessibly" (a here-doc or
`tee -a`, then read back with `cat`), not a terminal editor. Make all three edits below with the
container stopped (run `pct stop 110` first if it is running); you apply them together at the end of
step 3 with a single `pct start 110`.

File `/etc/pve/lxc/110.conf`:

```ini
lxc.idmap: u 0 100000 1005
lxc.idmap: g 0 100000 1005
lxc.idmap: u 1005 1005 1
lxc.idmap: g 1005 1005 1
lxc.idmap: u 1006 101006 64530
lxc.idmap: g 1006 101006 64530
```

Read the `u` lines as the mapping: container uids 0 through 1004 map to host 100000 through 101004;
container uid 1005 maps to host 1005 (the 1:1 hole); container uids 1006 through 65535 map to host
101006 through 165535. The three ranges together cover the full 0 through 65535 with no gaps and no
overlaps, which is required. The `g` lines do the same for groups.

Second, allow root to delegate that single host id. These lines are in addition to the default
`root:100000:65536` lines already present in each file, so append one line to each (no editor
needed) and hear what was written:

```bash
echo 'root:1005:1' | tee -a /etc/subuid
echo 'root:1005:1' | tee -a /etc/subgid
```

`tee -a` echoes back exactly the line it appended, which is the screen-reader confirmation that the
edit landed. Because `tee -a` only ever appends, re-running this step (for example after a
reinstall) adds a second identical `root:1005:1` line to each file. Read back what is there and make
sure each id appears exactly once:

```bash
grep 1005 /etc/subuid /etc/subgid
```

You want one `root:1005:1` line per file; if a re-run left a duplicate, delete the extra so each id
is delegated once.

Third, set ownership on the host directory to the real id and start the container:

```bash
chown -R 1005:1005 /srv/host-share
pct start 110
```

Inside the container the files now show as `1005:1005` and are writable, and on the host they remain
plainly owned by `1005:1005`.

There is also a per-mount `idmap=` shorthand you can add to an `mp[n]` line (for example
`idmap=u:1005:1005:1;g:1005:1005:1`) that shifts a single mount without rewriting the whole
container map, which is handy for a one-off share.

## Snapshots, clones, and templates

Because the container's root volume (and any volume mounts) sit on btrfs storage as subvolumes,
snapshots are fast, native btrfs subvolume snapshots. A snapshot is a point-in-time, copy-on-write
capture you can roll back to. Take one before a risky change:

```bash
pct snapshot 110 before-upgrade --description "pre apt upgrade"
pct listsnapshot 110
pct rollback 110 before-upgrade
pct delsnapshot 110 before-upgrade
```

`pct snapshot` creates the snapshot, `pct listsnapshot` lists them, `pct rollback` reverts the
container to one, and `pct delsnapshot` removes one. Snapshots only cover Proxmox-managed volumes
(the root volume and any volume mounts); a bind mount is not a Proxmox volume, so it is not
snapshotted. The snapshot metadata is recorded as `[snapname]` sections in `/etc/pve/lxc/110.conf`;
never hand-edit those.

### The 40-second stall after a rollback (ext4 MMP)

A container's first `pct start` after a `pct rollback` can stall for roughly 40 seconds before the
rootfs mounts, then be instant on every later start. This is deliberate Proxmox behaviour, not a
fault: it formats a container's raw ext4 root filesystem with the `mmp` feature (ext4 Multiple Mount
Protection), which stops the same image being mounted twice at once and corrupting it. On mount, MMP
waits about twice its update interval whenever the on-disk MMP block looks like it might still be
active, and a rollback restores an older image whose MMP block looks exactly that way, so the next
mount runs the full wait. On this btrfs storage a sized container rootfs is a raw ext4 image
(`vm-110-disk-0.raw`, wrapped in a btrfs subvolume so snapshots stay cheap), so it carries MMP and
this delay. If you rely on fast rollbacks, strip the feature while the container is stopped:

```bash
pct stop 110
LOOP=$(losetup -Pf --show "$(pvesm path local-btrfs:110/vm-110-disk-0.raw)")
tune2fs -O ^mmp "$LOOP"                  # remove Multiple Mount Protection
e2fsck -fy "$LOOP"                       # clear the stale MMP state it left behind
tune2fs -l "$LOOP" | grep -i features   # confirm mmp is no longer listed
losetup -d "$LOOP"
```

That is a one-time change and it survives future rollbacks. The cost is losing double-mount
protection: low risk on this single node with no shared storage and no HA, but keep MMP if container
images ever live on storage shared between nodes. Enabling MMP is intentional in Proxmox VE 9 with
no per-container toggle, so stripping it after creation is one way to get fast rollbacks. The other
is to avoid the ext4 layer entirely: create the rootfs unsized with `--rootfs local-btrfs:0`, which
allocates a bare btrfs subvolume (`subvol-110-disk-0`) instead of a raw ext4 image, so there is no
ext4 and no MMP at all. The trade-off is that an unsized subvolume has no hard capacity cap, so a
runaway container can grow into the whole btrfs pool, whereas the sized raw ext4 image (the default)
caps it. Pick the size cap if isolation matters, the unsized subvolume if fast rollbacks and the
simplest snapshot path matter more.

Note that a snapshot on the same disk as the original is not a backup; it dies with the disk.
Backups are a later guide.

### Clone a container or make a template

To copy a container, clone it:

```bash
pct clone 110 111 --hostname web2
```

That makes container 111 a copy of 110. To turn a container into a reusable read-only base for fast
linked clones, mark it a template:

```bash
pct template 110
```

A template is not run directly; you clone from it, and a linked clone is a thin copy that shares the
template's base via copy-on-write. Because a linked clone depends on the base, do not delete a
template that still has linked clones.

## A note on Docker in a container

If you want to run Docker or Podman, Proxmox's standing recommendation is to run them inside a
virtual machine, not an LXC container, for full isolation. If you do run Docker in a container
anyway, use an unprivileged container with `features: nesting=1,keyctl=1` (keyctl is required for
Docker's use of the kernel keyring), adding `fuse=1` if you use fuse-overlayfs. Proxmox VE 9.1 also
adds native OCI application containers as a Proxmox-blessed alternative to bolting Docker inside a
system container for simple single-image apps. This is a pointer, not a recipe; building the VM
itself is covered in guide 06, and the Docker-Compose-in-a-VM deployment pattern (Pattern C) is in
the recipes -- see guide [19 -- Applied recipes overview](19-recipes-overview.md) and recipe
[04 -- Paperless-ngx](recipes/04-paperless-ngx.md).

## PVE 9 deltas to know

Three Proxmox VE 9 changes affect container work, so run `pveversion` first and confirm you are on
9.x before relying on either behaviour:

- `--keep-env` on `pct enter` and `pct exec` is version-sensitive. The current Proxmox VE 9.2 manual
  still lists the default as on (1), while warning that the default is changing. Scripts should pass
  `--keep-env 0` or `--keep-env 1` explicitly instead of relying on the default.
- cgroup v2 only. The default `cpuunits` is now `100` (it was `1024` under cgroup v1), and a very
  old cgroup-v1-only container userspace will not boot.
- Creating a privileged container (`--unprivileged 0`) now requires the `Sys.Modify` privilege on
  `/`. Unprivileged is the default and the recommendation anyway, so most readers never hit this.

## Verify it worked

Confirm the container from the shell. First, it is running:

```bash
pct list
```

You should see a row for `110` with status `running`.

Next, confirm it is really Debian 13:

```bash
pct exec 110 -- cat /etc/os-release
```

The output should name Debian 13 (a `VERSION` line mentioning 13 / "trixie" and `ID=debian`).

Confirm it is unprivileged:

```bash
pct config 110
```

The effective config should include `unprivileged: 1`.

Finally, confirm key-based access works. If you injected your key at creation and the container has
a DHCP or static address, SSH straight in:

```bash
ssh root@192.168.1.110
```

That should log you in with no password prompt, using the injected key. If SSH is not reachable yet,
`pct enter 110` is the always-available fallback door into the container.

## Sources

- `research/round2-pve9/10-pve9-lxc-pct.md` - the `pveam` workflow (`update`,
  `available --section system`, `download local-btrfs`, `list local-btrfs`) and the `vztmpl` content
  type on the active btrfs storage; the complete `pct create` for an unprivileged Debian 13
  container on btrfs, with the static-IP and VLAN-tag variants; the `/etc/pve/lxc/<vmid>.conf`
  option reference and full example `110.conf`; the volume-mount-versus-bind-mount distinguishing
  rule and caveats; the default `0..65535` to `100000..165535` idmap, the Option A chown fix and the
  Option B `lxc.idmap` worked example with the matching `/etc/subuid` and `/etc/subgid` lines and
  the per-mount `idmap=` shorthand; native btrfs snapshots (`pct snapshot`, `listsnapshot`,
  `rollback`, `delsnapshot`) covering only Proxmox-managed volumes; `pct clone` and `pct template`;
  the Docker-in-LXC guidance; and the PVE 9 deltas (`--keep-env` default warning, cgroup v2 only
  with `cpuunits` default 100, and `Sys.Modify` for privileged containers).
- `GLOSSARY.md` and `CONTEXT.md` - the canonical definitions of LXC container, `pct`, `pveam`, OS
  template (vztmpl), unprivileged container, bind mount, volume mount, idmap, subvolume, snapshot,
  template / linked clone, `local-btrfs`, and pmxcfs reused here.
- Proxmox VE documentation: [pct.1](https://pve.proxmox.com/pve-docs/pct.1.html),
  [the Container chapter](https://pve.proxmox.com/pve-docs/chapter-pct.html),
  [pct.conf.5](https://pve.proxmox.com/pve-docs/pct.conf.5.html), and the
  [Unprivileged LXC containers wiki](https://pve.proxmox.com/wiki/Unprivileged_LXC_containers).

---

Previous: [04 -- Talking to guests without a GUI](04-talking-to-guests-without-a-gui.md) | Next:
[06 -- Virtual machines with qm](06-virtual-machines-with-qm.md)
