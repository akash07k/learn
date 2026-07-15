# Storage

## What you'll be able to do

By the end of this guide you will understand the storage layer your guests sit on: the host btrfs
root and the one `local-btrfs` storage that backs everything, the honest limits of a single disk,
and how to read true disk usage when `df` lies. You will be able to add an external USB disk three
ways (as a directory, as btrfs, or as a ZFS pool), keep a removable disk healthy with
export-before-unplug, and resize a guest disk. You will also be able to read a guest disk's volume
id, know which guest owns it (and so what `qm destroy` will and will not delete), and pre-create a
volume with `pvesm alloc`. Backups themselves are Part F; this guide is about the storage layer they
live on.

## Before you start

Some of what follows is specific to Proxmox VE 9, so confirm your version first:

```bash
pveversion
```

You should see a `9.x` release. Note that btrfs integration is still a technology preview in PVE 9
(it has carried that label since PVE 7.0 and 9 did not promote it); ZFS, by contrast, is fully
supported. You do this work over SSH as root on the Proxmox host, the way guide 03 left it.

The storage model fits in one paragraph. Proxmox treats storage as a small set of named storages,
each of exactly one backend type, declared in a single file, `/etc/pve/storage.cfg`, on pmxcfs (the
`/etc/pve` filesystem). That makes the file the single source of truth for storage. You never edit
guest disk paths directly; you reference a volume by a `STORAGE_ID:volume` identifier (a volid) and
let the storage layer resolve the real path or block device. The `pvesm` command is the CLI front
end to this whole model: it lists status and volumes and adds, changes, or removes storage
definitions, writing `storage.cfg` for you so you do not hand-edit a pmxcfs file.

## What a btrfs-root install gives you

A btrfs-root install writes two storages to `/etc/pve/storage.cfg`. The usual `dir: local` (the
`/var/lib/vz` directory storage you get on an ext4/LVM install) is created but disabled, and a
single `btrfs: local-btrfs` storage is created active and carries every content type.

File `/etc/pve/storage.cfg` (the default on a btrfs-root install):

```text
dir: local
 path /var/lib/vz
 content iso,vztmpl,backup
 disable

btrfs: local-btrfs
 path /var/lib/pve/local-btrfs
 content iso,vztmpl,backup,images,rootdir
```

The important consequence: one btrfs storage does the job that `local` plus `local-lvm` do on an LVM
install. Because btrfs is file-level it can hold ISOs, container templates (`vztmpl`), backups, VM
images (`images`), and container rootdirs (`rootdir`) all in one place, so there is no `local-lvm`
on a btrfs install, and the plain `local` directory storage sits disabled.

Inspect the live state from the shell. None of these change anything:

```bash
pvesm status
pvesm list local-btrfs
cat /etc/pve/storage.cfg
btrfs subvolume list /
findmnt -t btrfs
```

`pvesm status` lists every storage with its type, status, total, used, and available, one storage
per line. On a default btrfs-root node you see `local` reported as disabled and `local-btrfs` as
active of type `btrfs`. `pvesm list local-btrfs` lists the volumes on that storage.
`cat /etc/pve/storage.cfg` shows the source of truth. `btrfs subvolume list /` shows the subvolumes,
including the `var/lib/pve/local-btrfs` storage subvolume and one subvolume per container rootfs.
`findmnt -t btrfs` confirms the btrfs mounts. Because `local-btrfs` is btrfs-backed, its total and
used figures come from btrfs's own accounting and share the one underlying filesystem with the host
root; there is no separate fixed-size pool the way LVM-thin carves one out, so root, guests, and
backups all compete for the one disk.

## The honest single-disk caveat

This is the most important point in the guide, so it comes early and plainly. On a single disk with
no RAID, btrfs uses the `single` profile for data. btrfs checksums all data and metadata, so a scrub
will detect bit-rot, silent corruption, or a failing flash cell. But with a single data copy there
is nothing to rebuild from, so a scrub cannot repair a bad data block; it can only tell you which
file is corrupt and return an error for it. You get an honest early warning, not self-healing.

Metadata is a little safer: on a single device btrfs keeps metadata in the `DUP` profile (two copies
on the same disk), so metadata corruption can often self-heal even on one disk. Your actual guest
data cannot. This is exactly why a scrub is still worth running on a single disk: metadata damage
may be repaired, and data damage is at least surfaced before it silently propagates into your
backups.

The conclusion is non-negotiable: because the disk is a single point of failure and data corruption
is detect-only, external backups are mandatory. Snapshots on the same disk are not backups; they die
with the disk. The same single-disk reality applies to a single-disk ZFS pool later in this guide,
where a `zpool scrub` likewise detects but cannot repair. (btrfs RAID5/6 is officially experimental
and dangerous; if you ever add disks for redundancy, use RAID1, not RAID5/6.)

## Compression with zstd

btrfs transparent compression is a mount option in `/etc/fstab`, set on the btrfs root entry and
taking effect on remount or reboot. The relevant option is `compress=zstd`. zstd gives a ratio
comparable to zlib but much faster, which is why it is the recommended algorithm.

Two facts shape how you use it. First, the mount option affects only newly written data; data
already on disk is not retroactively compressed. Second, there are two forms:

- `compress=zstd` makes a heuristic guess per file or extent and skips data it thinks is
  incompressible (early bailout), so already-compressed files such as media and archives are stored
  raw. This is the safe default for a general PVE host.
- `compress-force=zstd` tries every block and only falls back to uncompressed for blocks that grow.
  Use it when the heuristic is being too shy and you know your data is compressible; it costs more
  CPU.

The fstab entry uses the filesystem's UUID. To set the option without a terminal editor, edit
`/etc/fstab` the accessible, shell-only way (a here-doc, `tee`, or `sed -i`), as covered in the
"Editing files accessibly" section of guide 02
([02 -- The shell and the API](02-the-shell-and-the-api.md)); never assume vim or nano.

File `/etc/fstab` (the btrfs root entry, with compression added):

```text
UUID=<the-uuid> / btrfs defaults,compress=zstd 0 1
```

To compress data that is already on disk, rewrite it via defragment with a compression flag. The
algorithm given to `defrag` applies only to that one run; the persistent policy is still the mount
option:

```bash
btrfs filesystem defrag -r -czstd /path
```

`df` and `ls` show logical sizes and hide compression entirely, so to verify the real ratio install
and use `compsize` (the `compsize` package):

```bash
compsize /var/lib/pve/local-btrfs
```

`compsize` prints a `TOTAL` row with per-algorithm rows beneath. Reading its columns in prose:
`Type` is the compression algorithm (none, zstd, zlib, or lzo); `Perc` is disk usage as a percentage
of the uncompressed size, where lower means better compression; `Disk Usage` is what the data
actually costs on disk after compression; `Uncompressed` is what it would cost with no compression;
and `Referenced` is the apparent file sizes. This is the honest way to confirm compression is
working and worthwhile.

## Reading real usage (df lies)

Do not trust plain `df` on btrfs. btrfs allocates space in chunks (block groups) for data, metadata,
and system separately, and a chunk can be allocated but not yet full. `df` cannot see this
structure, so its "free" number is at best an estimate and at worst actively misleading: it can show
free space while writes fail, or show used space that a balance would reclaim.

Use btrfs's own tools instead:

```bash
btrfs filesystem usage /
btrfs filesystem df /
```

`btrfs filesystem usage /` is the best human view and shows the load-bearing numbers: the device
size (raw capacity), the device allocated (how much has been carved into chunks), the device
unallocated (raw space not yet assigned to any chunk), the free space estimated for new data, and
per-profile used-versus-allocated figures for Data and Metadata that reveal chunks that are
allocated but mostly empty. `btrfs filesystem df /` is a terser block-group summary of data,
metadata, system, and the global reserve.

The classic failure mode on a busy single-disk host is ENOSPC (out of space) even though `df` shows
free space, because data chunks ate all the unallocated space and metadata cannot grow into any.
`btrfs filesystem usage` is how you spot it (allocated much greater than used); the cure is a
filtered balance, in the maintenance section below.

## Snapshots and how PVE guest snapshots map to btrfs

A snapshot is a point-in-time, copy-on-write capture you can roll back to; on btrfs it is instant
and initially shares all blocks with the original. The native btrfs commands operate on a subvolume
path:

```bash
btrfs subvolume snapshot -r /some/path /a/new/path
btrfs subvolume snapshot /some/path /a/new/path
```

The `-r` form makes a read-only snapshot, which is the kind usable as a `btrfs send` source (see
Part F). Omitting `-r` makes a writable snapshot.

You rarely run those by hand for guests, because Proxmox does it for you. When you take a PVE
snapshot of a VM or container whose disk lives on btrfs storage (`qm snapshot <vmid> <name>` or
`pct snapshot <vmid> <name>`), Proxmox creates a read-only btrfs subvolume snapshot of the disk
subvolume, named with the original path followed by `@` and the snapshot name. So a snapshot named
`before-upgrade` of disk N appears as `...disk-N@before-upgrade`. This is fast and space-efficient,
and offline storage migration preserves these snapshots. The guest-facing snapshot commands
(`qm`/`pct snapshot`, `listsnapshot`, `rollback`, `delsnapshot`) are covered in guides
[05 -- Containers with LXC and pct](05-containers-with-lxc-and-pct.md) and
[06 -- Virtual machines with qm](06-virtual-machines-with-qm.md), so reach for those for the guest
workflow.

One btrfs-specific gotcha lives with the container workflow: a sized container volume on btrfs is a
raw ext4 image, which Proxmox formats with ext4 Multiple Mount Protection, so the container's first
start after a `pct rollback` stalls about 40 seconds. Guide
[05 -- Containers with LXC and pct](05-containers-with-lxc-and-pct.md) explains why and how to
remove the feature if you rely on fast rollbacks.

One thing bears repeating from the single-disk caveat: a snapshot on the same disk as the original
is not a backup. It dies with the disk.

## Scrub and balance -- the maintenance routine

A scrub reads every allocated block and verifies it against its stored checksum, catching data
checksum errors, metadata errors, superblock errors, and disk read errors. On this single disk it
can repair the DUP metadata but can only report data corruption, which is precisely the early honest
signal a single-NVMe host otherwise lacks. A scrub is not an fsck; it validates checksums, it does
not rebuild the tree.

```bash
btrfs scrub start /
btrfs scrub status /
```

Balance rewrites and consolidates block groups. On a single disk you do not need it for redundancy,
but the filtered form is genuinely useful to reclaim allocated-but-mostly-empty chunks and to cure
the ENOSPC-with-free-space failure mode. Run it only as needed (when `btrfs filesystem usage` shows
allocated much greater than used), not on a fixed aggressive schedule, and avoid a full unfiltered
balance on a busy host:

```bash
btrfs balance start -dusage=10 /
```

The kernel ships a systemd scrub timer per mount, with the mount path systemd-escaped (`-` stands
for the root mount `/`). Enable it for the root filesystem and confirm it is scheduled:

```bash
systemctl enable --now btrfs-scrub@-.timer
systemctl list-timers
```

If you prefer a turnkey Debian-native option, the `btrfsmaintenance` package automates scrub (and a
light balance and defrag) via `/etc/default/btrfsmaintenance`; install it and enable its timers
instead.

Recommended cadence for this single-NVMe host:

- Scrub monthly. This is the high-value job: it surfaces corruption you cannot otherwise see.
- Check `btrfs filesystem usage /` regularly (monthly, or whenever the pool feels full). Never trust
  `df`.
- Balance with `-dusage` only as needed, when usage shows allocated much greater than used or you
  hit ENOSPC.
- Keep external backups always. Snapshots on the same disk are not backups.

## The btrfs cache=none footgun

btrfs honors the `O_DIRECT` flag, so a VM disk on btrfs storage must not use disk cache mode `none`.
Doing so can produce checksum errors. This is a real, btrfs-specific footgun, set per VM disk. Use
`writeback` or `writethrough` instead -- the Proxmox default cache mode is `none`, which is exactly
the unsafe one here, so you must set this explicitly:

```bash
qm set <vmid> --scsi0 local-btrfs:<size>,cache=writeback
```

You can also set it by editing the disk line in `/etc/pve/qemu-server/<vmid>.conf`, but `qm set`
validates the change. The full `qm` disk workflow is in guide
[06 -- Virtual machines with qm](06-virtual-machines-with-qm.md).

## Identify an external disk safely

Never trust `/dev/sdX` for an external disk. Kernel `sdX` names are assigned in probe order and are
not stable: unplug and replug the disk, add a second USB device, or reboot, and `sdb` can become
`sdc`. Use stable identifiers instead. Use `/dev/disk/by-id/` (derived from the disk's model and
serial, or its WWN) for creating, partitioning, and formatting, and the partition UUID (from
`blkid`) for mounting.

```bash
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,UUID,MODEL,SERIAL
ls -l /dev/disk/by-id/
blkid
```

Safety callout: `mkfs` and `zpool create` ERASE the target disk. There is no local console to
recover from on this headless host, so confirm the by-id path points at the disk you mean (match the
model and serial) before you run any format or pool-create command below. If several identical
enclosures are attached, double-check the serial maps to the right physical disk first.

Use an explicit confirmation variable before the destructive command. This makes the target audible
twice, keeps `/dev/sdX` out of the command entirely, and gives you one last Ctrl-C point:

```bash
TARGET_DISK=/dev/disk/by-id/usb-<MODEL>_<SERIAL>
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,UUID,MODEL,SERIAL "$TARGET_DISK"
printf 'About to erase %s. Type ERASE to continue: ' "$TARGET_DISK"
read CONFIRM
[ "$CONFIRM" = ERASE ] || { echo 'Aborted.'; exit 1; }
```

Run the `mkfs` or `zpool create` command only after that guard passes, and use `"$TARGET_DISK"` as
the device argument.

## Add a USB disk as a directory storage

Format the disk on its by-id path (this erases it; run the confirmation guard above first), make a
mount point, and note the new filesystem's UUID:

```bash
mkfs.ext4 "$TARGET_DISK"
mkdir -p /mnt/usb-backup
blkid "$TARGET_DISK"
```

(You can use `mkfs.btrfs` here instead if you want a btrfs directory; the registration step is the
same `dir` type either way.)

Mount it persistently by UUID in `/etc/fstab`, with `nofail` and a device timeout. Edit `/etc/fstab`
the accessible, shell-only way from guide
[02 -- The shell and the API](02-the-shell-and-the-api.md), not a terminal editor.

File `/etc/fstab` (the USB directory mount line):

```text
UUID=<the-uuid> /mnt/usb-backup ext4 defaults,nofail,x-systemd.device-timeout=10 0 2
```

`nofail` is essential on a headless host: without it, an absent USB disk halts boot into an
emergency shell, which you cannot reach. `x-systemd.device-timeout=10` caps how long boot waits for
the device. After editing, reload and mount:

```bash
systemctl daemon-reload
mount /mnt/usb-backup
```

A systemd `.mount` unit is the explicit alternative to an fstab line. The unit's filename must match
the mount path systemd-escaped, so `/mnt/usb-backup` becomes the unit file
`mnt-usb\x2dbackup.mount`. Write it the accessible, shell-only way (a here-doc or `tee`, never a
terminal editor) as covered in guide [02 -- The shell and the API](02-the-shell-and-the-api.md).

File `/etc/systemd/system/mnt-usb\x2dbackup.mount`:

```text
[Unit]
Description=USB backup disk

[Mount]
What=/dev/disk/by-uuid/<the-uuid>
Where=/mnt/usb-backup
Type=ext4
Options=defaults,nofail

[Install]
WantedBy=multi-user.target
```

`nofail` carries the same meaning here as in fstab. One difference to know:
`x-systemd.device-timeout` is an fstab option (systemd generates the device-wait timeout from it);
in a hand-written `.mount` unit there is no `Options=x-systemd.device-timeout` equivalent, so you
rely on `nofail` to keep an absent disk from blocking boot. Then reload and enable it:

```bash
systemctl daemon-reload
systemctl enable --now 'mnt-usb\x2dbackup.mount'
```

Register it as Proxmox storage with `pvesm`, which writes `storage.cfg` for you. `is_mountpoint 1`
is the key safety flag: if the disk is not mounted, Proxmox marks the storage offline instead of
writing into the bare mount directory on the root disk:

```bash
pvesm add dir usb-backup --path /mnt/usb-backup --content backup --is_mountpoint 1 --prune-backups keep-daily=7,keep-weekly=4
```

For a general-purpose store, add more content types (for example
`--content backup,iso,vztmpl,images,rootdir`).

## Add a USB disk as a btrfs storage

If you format the USB disk as btrfs instead, you gain native snapshots and clones for guest volumes
on the external disk, and it becomes a natural `btrfs send`/`receive` target (Part F). Format on the
by-id path (this erases it; run the confirmation guard above first), make a mount point, and note
the UUID:

```bash
mkfs.btrfs "$TARGET_DISK"
mkdir -p /mnt/usb-btrfs
blkid "$TARGET_DISK"
```

Mount it persistently with `nofail`, the same accessible fstab edit as above.

File `/etc/fstab` (the USB btrfs mount line):

```text
UUID=<the-uuid> /mnt/usb-btrfs btrfs defaults,nofail 0 0
```

The final `0` is the fsck-pass field, and it is `0` here (not the `2` the ext4 directory line uses)
on purpose: btrfs has its own consistency mechanism and is not checked by the boot-time `fsck` pass
ordering, so a `0` pass for btrfs is correct, not a typo. (The btrfs root entry earlier in this
guide uses pass `1`, which is the installer's default; both `0` and `1` are fine for btrfs, since
its boot-time fsck pass is effectively a no-op either way.)

Then reload, mount, and register the btrfs backend with `is_mountpoint 1`:

```bash
systemctl daemon-reload
mount /mnt/usb-btrfs
pvesm add btrfs usb-btrfs --path /mnt/usb-btrfs --content images,rootdir,backup,iso,vztmpl --is_mountpoint 1
```

## Add a USB disk as a ZFS pool (end to end)

ZFS manages its own mounting (no fstab needed) and gives you checksums, snapshots, send/receive, and
compression, which is exactly why it is worth learning on a spare USB disk. As with the directory
and btrfs methods, identify and confirm the disk first: list the stable ids and match the serial of
the disk you mean against the device you are about to hand to `zpool create`, exactly as in
"Identify an external disk safely" above.

```bash
ls -l /dev/disk/by-id/
lsblk -o NAME,SIZE,MODEL,SERIAL
```

Then create the pool on that stable by-id device. This erases the disk, so run the confirmation
guard above first:

```bash
zpool create -f -o ashift=12 -O compression=zstd -O atime=off -m /mnt/usbzfs usbpool "$TARGET_DISK"
```

Note that `zpool create -f` forces creation past the safety warning that would otherwise stop you
when the target still has an existing partition table. That warning is normally your seatbelt, so
with `-f` present, confirming the by-id path against the serial just above is your last line of
defence against formatting the wrong disk.

Reading each flag:

- `-o ashift=12` sets 4 KiB (2^12) sectors. This is a per-vdev, create-time-only property; you
  cannot change it later. 12 is the safe default for essentially every modern disk (even 512e disks
  that report 512-byte sectors). Using ashift=9 on a real 4K disk causes severe write amplification,
  so always pin 12.
- `-O compression=zstd` and `-O atime=off` (capital `-O`) set dataset properties as pool-wide
  defaults: inline zstd compression, and no access-time updates (which cuts write churn on a USB
  disk). Child datasets and zvols inherit these.
- `-m /mnt/usbzfs` sets the pool mountpoint to something explicit rather than the default `/usbpool`
  at root, which is cleaner for a removable disk.
- `-f` forces past minor warnings such as an existing partition table. Make sure it is the right
  disk first; `zpool create` is destructive.

Inside a pool live two kinds of object. A dataset is a POSIX filesystem you mount and put files in
(`zfs create usbpool/mydata`). A zvol is a block device with no filesystem of its own, which
something else formats (`zfs create -V 10G usbpool/myvol`). The `zfspool` plugin maps guest disks
across both transparently: a VM disk becomes a zvol in `raw` format (for example
`usbpool/vm-100-disk-0`), and an LXC container rootfs becomes a dataset (subvolume) (for example
`usbpool/subvol-101-disk-0`). So the same storage uses zvols for VMs and datasets for containers.

Register the pool (or a child dataset of it) as a `zfspool` storage. `--sparse 1` enables thin
provisioning so a VM disk consumes space only as written:

```bash
zfs create usbpool/guests
pvesm add zfspool usbpool-guests --pool usbpool/guests --content images,rootdir --sparse 1
```

A `zfspool` storage holds only `images` and `rootdir`; it cannot hold `backup`, `iso`, or `vztmpl`.
For those, create a dataset and point a `dir` storage at its mountpoint:

```bash
zfs create usbpool/backup
pvesm add dir usbpool-backup --path /mnt/usbzfs/backup --content backup,iso,vztmpl --prune-backups keep-last=3
```

Snapshots and clones are instant and near-free. PVE's own guest snapshots use these under the hood
when a guest's disk lives on a `zfspool` storage:

```bash
zfs snapshot usbpool/mydata@before-change
zfs clone usbpool/mydata@before-change usbpool/mydata-clone
```

A few more dataset commands round out day-to-day use. `zfs list` shows datasets and snapshots with
their space; `zfs get` and `zfs set` read and change properties such as `compression`, `quota`, or
`mountpoint`; `zfs rollback` returns a dataset to an earlier snapshot; and `zfs destroy` removes a
dataset or a snapshot. Both `rollback` and `destroy` are irreversible -- `rollback` discards every
change made since that snapshot, and `destroy` deletes the data outright -- so confirm the target
name before you run them:

```bash
zfs list -t all
zfs get compression usbpool/mydata
zfs set quota=20G usbpool/mydata
zfs rollback usbpool/mydata@before-change
zfs destroy usbpool/mydata@before-change
```

The replication story is `zfs send`/`receive`, which serializes a snapshot to a stream and
reconstructs it elsewhere, with incremental transfer of only the delta between two snapshots:

```bash
zfs snapshot usbpool/mydata@s1
zfs send usbpool/mydata@s1 | zfs receive otherpool/mydata
zfs snapshot usbpool/mydata@s2
zfs send -i @s1 usbpool/mydata@s2 | zfs receive otherpool/mydata
```

Scrub the pool to verify integrity, and read its status as JSON, which parses cleanly with a screen
reader and avoids wide column-aligned tables:

```bash
zpool scrub usbpool
zpool status -j | jq
```

The single-disk reality from the btrfs caveat applies identically here: on a pool with no redundancy
a scrub can detect checksum errors but cannot repair them, because there is no second copy to
rebuild from. `zpool status` reports the bad file under "errors:" and you restore it from another
backup. Scrubbing is still worth it as an early warning that the disk is going bad (rising checksum,
read, or write counters), so check `zpool status` after every reconnect.

## Cap the ZFS ARC (important on a btrfs-root host)

ARC is ZFS's in-RAM read cache. Proxmox documents an installer-written ARC cap (10% of RAM, clamped
to 16 GiB) in `/etc/modprobe.d/zfs.conf`, and current installers also account for additional ZFS
storage created during installation even when root is not ZFS. But this guide adds ZFS later by hand
for a USB pool, so do not assume the cap exists or is the value you want. Check it yourself; if the
file is absent, says `zfs_arc_max=0`, or sets a cap too high for your VM workload, write a modest
cap manually.

Write the cap to `/etc/modprobe.d/zfs.conf` the accessible, shell-only way from guide
[02 -- The shell and the API](02-the-shell-and-the-api.md). The value is in bytes; the example is 4
GiB (4294967296 bytes):

File `/etc/modprobe.d/zfs.conf`:

```text
options zfs zfs_arc_max=4294967296
```

Then rebuild the early-boot image and reboot so the module loads with the parameter:

```bash
update-initramfs -u -k all
reboot
```

A few details. The value is in bytes, and `0` means "use the default". If your target `zfs_arc_max`
is below `zfs_arc_min` (default 1/32 of RAM), you must also lower `zfs_arc_min` to at most
`zfs_arc_max - 1`, or the setting is ignored. To test a value for the current boot only (lost on
reboot, no rebuild needed), write the byte count to the runtime parameter first:

```bash
echo 4294967296 > /sys/module/zfs/parameters/zfs_arc_max
```

## Living with a removable USB disk

The workflow that keeps a removable ZFS disk healthy is: always export before unplugging.
`zpool export` flushes writes, unmounts, and releases the disk, which avoids leaving the pool in a
suspended state:

```bash
sync
zpool export usbpool
```

Re-attach the disk and import by stable id, then verify it is ONLINE:

```bash
zpool import -d /dev/disk/by-id usbpool
zpool status usbpool
```

For an on-demand pool, keep it out of the boot import cache so boot never tries to import an absent
disk and stall:

```bash
zpool set cachefile=none usbpool
```

The USB gotchas, as a short list:

- Unstable `sdX` names. USB bridges re-enumerate, so always create and import by `/dev/disk/by-id`.
  A pool bound to `sdX` can come up DEGRADED or FAULTED purely because the device came back as a
  different name.
- UAS and power-management drops. USB enclosures and the UAS layer can suspend, reset, or drop the
  disk on autosuspend or under load; ZFS then sees I/O errors and may fault the disk or suspend the
  pool. Prefer a quality powered enclosure, and consider disabling USB autosuspend and disk standby
  while attached.
- A suspended pool. If the disk vanishes mid-write, the pool can hang in a suspended state; recovery
  often needs `zpool clear usbpool` after reconnect, sometimes a reboot. Exporting before unplug
  avoids this.
- Lying caches. Some cheap USB-SATA bridges ignore cache-flush commands, undermining crash
  consistency. Use a known-good enclosure; do not trust no-name bridges for data you care about.

For a removable directory or btrfs disk the rules are simpler but just as important: always use
`nofail` in fstab and `is_mountpoint 1` on the storage, so an absent disk leaves the storage merely
inactive (guests on it fail to start, which is expected) instead of halting boot or writing phantom
data into root. Never set `shared 1` (`--shared 1`) on a local USB disk; `shared` declares the
content is identical on all nodes, which is wrong on a single node and breaks migration logic on a
cluster. And remember `pvesm remove` deletes only the config stanza; the data on the disk stays
until you delete the files or wipe the disk.

## Resizing a guest disk (grow only)

Disks grow only; shrinking is not supported. For a VM disk, `+` adds to the current size and no sign
sets an absolute size:

```bash
qm disk resize <vmid> <disk> +5G
```

For a container, resize the `rootfs` (or an `mp0` through `mp255` mount point):

```bash
pct resize <vmid> rootfs +5G
```

The difference matters: after growing a VM disk you must extend the filesystem inside the VM guest
afterward, whereas for a container Proxmox resizes and grows the filesystem in one step. The full
guest workflow is in guides [05 -- Containers with LXC and pct](05-containers-with-lxc-and-pct.md)
and [06 -- Virtual machines with qm](06-virtual-machines-with-qm.md).

## Volume ids, ownership, and formats

You reference every guest disk by a volume id (a volid), and the volid encodes two things: where the
disk lives and which guest owns it. Reading one tells you what `qm destroy` will and will not
delete.

On this node's file-based `local-btrfs`, a guest volume looks like this:

```text
local-btrfs:9100/vm-9100-disk-0.raw
```

That is `STORAGE:VMID/vm-VMID-<name>.<format>`: the `9100/` path segment and the `vm-9100-` prefix
both name VM 9100 as the owner, and the file is a raw image inside a per-disk btrfs subvolume. A
block storage (for example a ZFS pool you add on a USB disk) writes volids the other way, with no
path segment and no extension, as in `usbpool:vm-9100-disk-0`. Either way, the VMID in the name is
the owner.

Ownership is not cosmetic. When you run `qm destroy 9100` (or `pct destroy`), Proxmox frees the
volumes owned by 9100 -- the ones whose name carries `9100`. A volume that is attached to 9100 but
named for a different VMID is left alone. This is the whole mechanism behind the
persistent-data-disk pattern in [06 -- Virtual machines with qm](06-virtual-machines-with-qm.md): a
disk survives a VM's deletion only when its name carries a different owner id, not because you
detached it and not because you created it by hand.

You can pre-create a volume from the shell with `pvesm alloc`, which is how you hand a data disk a
chosen owner before attaching it. The `<vmid>` argument sets the owner, and on a file storage the
name must follow `vm-<vmid>-<name>.<format>`:

```bash
# a 100 GiB raw volume owned by VM 9999 on local-btrfs
pvesm alloc local-btrfs 9999 vm-9999-data.raw 100G --format raw
# -> local-btrfs:9999/vm-9999-data.raw
```

That volume now exists on the storage but is attached to nothing. Note the distinction: unattached
is not the same as unowned. Every image volume has an owner VMID -- `pvesm alloc` requires one -- so
there is no such thing as an ownerless disk; you can only leave one unattached. The owner id can
even be a VMID with no VM behind it, which is how you park a data disk that no VM's `destroy` will
reclaim until you attach it. `pvesm list local-btrfs` shows unattached volumes alongside the rest.

Pass an empty name (`''`) to let Proxmox pick the next `vm-<vmid>-disk-N` for you. Delete a volume
-- which really destroys its data -- with `pvesm free <volid>`.

Two notes on format. First, btrfs stores VM images as raw files inside subvolumes and snapshots at
the subvolume level, so raw is the right choice here; qcow2 is offered on file-based storage but
buys you nothing on btrfs, and block storages (LVM, ZFS, Ceph) require raw regardless. Second,
preallocation is a per-storage property (`off`, `metadata`, `falloc`, `full`; the default `metadata`
behaves like `off` for raw images), set with `pvesm set local-btrfs --preallocation <mode>`. On a
single copy-on-write btrfs disk it is rarely worth changing.

## Storage capability at a glance (readable lists)

These are the per-backend capabilities as a definition list, not a grid. Each backend lists its
level, snapshot support, thin/sparse, shared-capable, and content types.

dir (Directory):

- Level: file.
- Snapshots: qcow2 images only.
- Thin/sparse: yes (qcow2 grows on demand).
- Shared: no (local path).
- Content: images, rootdir, vztmpl, iso, backup, snippets.

btrfs:

- Level: file.
- Snapshots: yes (native btrfs subvolume snapshots).
- Thin/sparse: yes.
- Shared: no.
- Content: images, rootdir, vztmpl, iso, backup, snippets.

zfspool:

- Level: file and block (zvols for images, datasets for rootdir).
- Snapshots: yes (native ZFS snapshots).
- Thin/sparse: yes (with `sparse`).
- Shared: no (local pool).
- Content: images, rootdir.

lvmthin (LVM-thin, for contrast):

- Level: block.
- Snapshots: yes (native thin snapshots).
- Thin/sparse: yes.
- Shared: no.
- Content: images, rootdir.

One informational note on PVE 9: thick LVM gained snapshots in 9 via qcow2 "volume-chain" snapshots,
but that is a technology preview and not for production. For this single-node USB setup it is mostly
informational; prefer btrfs or zfspool on the USB disk for real snapshot support today.

## Verify it worked

Confirm the storage layer from the shell. Each command is text-only and reads cleanly.

The default storage is active:

```bash
pvesm status
```

`local-btrfs` should be active. Any USB storage shows active when its disk is mounted and inactive
when the disk is absent, which is the expected, safe behaviour with `nofail` plus `is_mountpoint 1`.

Real btrfs usage returns numbers (not the `df` estimate):

```bash
btrfs filesystem usage /
```

You should see device size, allocated, unallocated, and free-estimated figures.

Compression shows a ratio:

```bash
compsize /var/lib/pve/local-btrfs
```

The `TOTAL` row's `Perc` column shows disk usage as a percentage of uncompressed; below 100 means
compression is saving space.

For a USB ZFS pool, the pool is healthy and visible to Proxmox:

```bash
zpool status usbpool
pvesm scan zfs
```

`zpool status usbpool` should report the pool ONLINE, and `pvesm scan zfs` should list the pool.

Any USB mount is present when attached:

```bash
findmnt /mnt/usb-backup
```

`findmnt` prints the mount line when the disk is mounted, and nothing when it is absent.

## Sources

- `research/round2-pve9/06-pve9-btrfs-deep.md` - the technology-preview status; the default
  btrfs-root `storage.cfg` (disabled `dir: local` plus active `btrfs: local-btrfs`) and
  `pvesm status` behaviour; the single-disk `single`-data / `DUP`-metadata detect-not-repair caveat
  and the backups-are-mandatory conclusion; `compress=zstd` versus `compress-force`,
  retro-compression with `btrfs filesystem defrag -r -czstd`, and `compsize` column meanings; the
  "df lies" chunk-allocation explanation with `btrfs filesystem usage /` and `btrfs filesystem df /`
  and the ENOSPC-with-free-space failure; native `btrfs subvolume snapshot [-r]` and how a PVE guest
  snapshot becomes a `...disk-N@<name>` read-only subvolume; the monthly-scrub routine
  (`btrfs scrub start`/`status`, `btrfs balance start -dusage=10 /`, the `btrfs-scrub@-.timer` and
  `btrfsmaintenance` options) and recommended cadence; and the btrfs `cache=none` O_DIRECT footgun
  with `qm set ... cache=writeback`.
- `research/round2-pve9/08-pve9-storage-model-and-pvesm.md` - the one-paragraph storage model (named
  storages, one backend type each, declared in `/etc/pve/storage.cfg` on pmxcfs, `STORAGE_ID:volume`
  volids); the `pvesm` command surface and `is_mountpoint`/`sparse`/`shared`/`prune-backups`
  options; content types and which backends carry them; identifying an external disk with
  `lsblk`/`blkid`/`ls -l /dev/disk/by-id/`; the three USB-add methods (`dir` with the `nofail` +
  `x-systemd.device-timeout` fstab line and the systemd `.mount` alternative, `btrfs`, and
  `zfspool`) all with `is_mountpoint 1`; the capability lists per backend and the PVE 9 thick-LVM
  volume-chain snapshot tech preview; the removable-disk gotchas (never `shared 1`, `pvesm remove`
  keeps data); and grow-only `qm disk resize` / `pct resize`.
- `research/round2-pve9/07-pve9-zfs-on-external-disk.md` - by-id (never `sdX`) for USB pools;
  `zpool create -f -o ashift=12 -O compression=zstd -O atime=off -m /mnt/usbzfs` with each flag
  explained and ashift create-time-only; datasets versus zvols and the `zfspool` plugin mapping (VM
  disks to zvols, CT rootfs to datasets); registering `zfspool` with `--sparse 1` and the separate
  `dir`-on-a-dataset store for backup/iso/vztmpl; `zfs snapshot`/`clone` and `zfs send`/`receive`
  incremental; `zpool scrub` + `zpool status -j | jq` and the single-disk detect-not-repair reality;
  the check-for-an-ARC-cap point and the `/etc/modprobe.d/zfs.conf` `zfs_arc_max` fix with
  `update-initramfs -u -k all`, the `zfs_arc_min` interaction, and the runtime `/sys` test; and
  export-before-unplug, `zpool import -d /dev/disk/by-id`, `cachefile=none`, and the USB gotchas
  (UAS/power drops, suspended pool needing `zpool clear`, lying caches).
- `GLOSSARY.md` and `CONTEXT.md` - the canonical definitions of btrfs, btrfs balance, btrfs scrub,
  ashift, disk by-id, is_mountpoint, local-btrfs, send / receive, snapshot, storage.cfg, subvolume,
  content type, pvesm, ZFS, zpool / dataset / zvol, zpool scrub, ARC, and volume mount reused here.
- Proxmox VE documentation:
  [the Storage chapter](https://pve.proxmox.com/pve-docs/chapter-pvesm.html),
  [pvesm.1](https://pve.proxmox.com/pve-docs/pvesm.1.html), the
  [BTRFS wiki](https://pve.proxmox.com/wiki/BTRFS), and the
  [ZFS on Linux wiki](https://pve.proxmox.com/wiki/ZFS_on_Linux).
- Upstream documentation: the btrfs docs for
  [Scrub](https://btrfs.readthedocs.io/en/latest/Scrub.html),
  [Compression](https://btrfs.readthedocs.io/en/latest/Compression.html),
  [Balance](https://btrfs.readthedocs.io/en/latest/Balance.html), and
  [filesystem usage](https://btrfs.readthedocs.io/en/latest/btrfs-filesystem.html); the
  [compsize tool](https://github.com/kilobyte/compsize); and the
  [OpenZFS documentation](https://openzfs.github.io/openzfs-docs/).

---

Previous: [08 -- Windows guests](08-windows-guests.md) | Next: [10 -- Networking](10-networking.md)
