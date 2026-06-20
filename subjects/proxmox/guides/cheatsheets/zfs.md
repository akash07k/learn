# Cheatsheet: zfs (the optional secondary pool)

ZFS here is an OPTIONAL secondary pool on extra disks (a spare USB or extra SATA disk), NOT this
node's root. The root is btrfs ([btrfs.md](btrfs.md)); reach for ZFS only when you add a separate
data or guest pool and want its checksums, snapshots, send/receive, and inline compression. Every
line below is plain text you run as root over SSH; there is no web GUI step. For the why and worked
end-to-end examples, see [09 -- Storage](../09-storage.md).

DESTRUCTIVE-on-the-wrong-disk warning, read this first: `zpool create` ERASES the target disk, and
`-f` forces past the safety warning that would otherwise stop you. There is no local console to
recover from on this headless host. ALWAYS identify the disk by its stable `/dev/disk/by-id/...`
name (match the model and serial), NEVER `/dev/sdX` (which renumbers on replug or reboot).
Confirming the by-id path against the serial is your last line of defence once `-f` is present.

## Pools

Identify the disk first; these only read, they change nothing. List the stable ids and match the
serial of the disk you mean before any create.

- `ls -l /dev/disk/by-id/` -- the stable by-id names (model plus serial, or WWN); this is the path
  you hand to `zpool create`, never `/dev/sdX`.
- `lsblk -o NAME,SIZE,MODEL,SERIAL` -- confirm which physical disk a by-id path is.
- `zpool create -f -o ashift=12 -O compression=zstd -O atime=off -m /mnt/usbzfs usbpool /dev/disk/by-id/usb-<MODEL>_<SERIAL>`
  -- create the pool on the confirmed by-id device. DESTRUCTIVE: this erases the disk.
  `-o ashift=12` pins 4 KiB sectors and is create-time-only (cannot change later);
  `-O compression=zstd` and `-O atime=off` (capital `-O`) set pool-wide dataset defaults; `-m` sets
  the mountpoint; `-f` forces past the existing-partition-table warning, so be sure of the disk.
- `zpool status usbpool` -- health and scrub state; the pool should read ONLINE, and any nonzero
  checksum, read, or write counter (or a file listed under "errors:") means trouble. Check it after
  every reconnect.
- `zpool status -j | jq` -- the same status as JSON, which reads cleanly with a screen reader and
  avoids wide column-aligned tables.
- `zpool import -d /dev/disk/by-id usbpool` -- import the pool by stable id (after re-attaching the
  disk, or moving it from another system).
- `zpool export usbpool` -- flush writes, unmount, and release the disk; do this BEFORE you unplug a
  removable pool (run `sync` first) to avoid leaving it suspended.
- `zpool clear usbpool` -- clear transient error counters AFTER you have dealt with the cause; also
  the recovery step when a vanished disk left the pool suspended.
- `zpool set cachefile=none usbpool` -- a property example: keep an on-demand pool out of the boot
  import cache so boot never stalls on an absent disk.

## Datasets

The pool name is `usbpool` in these examples; substitute your own.

- `zfs create usbpool/mydata` -- a child dataset (a POSIX filesystem you mount and put files in).
- `zfs list` -- datasets and their space usage.
- `zfs set compression=zstd usbpool/mydata` -- set a dataset property (e.g. `compression`,
  `atime=off`); children inherit it.
- `zfs get compression usbpool/mydata` -- read one property's effective value (and where it was
  inherited from).

## Maintenance

- `zpool scrub usbpool` -- read every block and verify it against its checksum; schedule it (monthly
  here). On a single-disk pool with no redundancy a scrub DETECTS checksum errors but cannot repair
  them (no second copy to rebuild from), so it is an early warning, not self-healing.
- ARC (ZFS's in-RAM read cache) can grow large if no cap is active. Because this workflow adds ZFS
  later by hand on a btrfs-root host, check `/etc/modprobe.d/zfs.conf` and
  `/sys/module/zfs/parameters/zfs_arc_max`; if the cap is absent, `0`, or too high, set
  `zfs_arc_max` yourself -- see [09 -- Storage](../09-storage.md) and
  [14 -- Best practices and hardening](../14-best-practices-and-hardening.md).

## Snapshots and replication

A snapshot on the same disk as the original is not a backup (it dies with the disk);
`zfs send`/`receive` is how you copy it off-box or onto a secondary pool.

- `zfs snapshot usbpool/mydata@before-change` -- an instant, near-free point-in-time snapshot.
- `zfs rollback usbpool/mydata@before-change` -- DESTRUCTIVE: revert the dataset to the snapshot,
  discarding everything written since.
- `zfs clone usbpool/mydata@before-change usbpool/mydata-clone` -- a writable clone from a snapshot.
- `zfs destroy usbpool/mydata@before-change` -- DESTRUCTIVE: remove a snapshot for good.
- `zfs destroy -r usbpool/mydata` -- DESTRUCTIVE: remove a dataset and its children/snapshots
  recursively; recursive removal needs `-r`.
- `zfs send usbpool/mydata@s1 | zfs receive otherpool/mydata` -- the off-box/secondary replication
  primitive: serialize a snapshot to a stream and reconstruct it elsewhere.
- `zfs send -i @s1 usbpool/mydata@s2 | zfs receive otherpool/mydata` -- incremental send: transfer
  only the delta between two snapshots.

## Full treatment

This card is a reminder, not a lesson. For the why and worked examples, see:

- [09 -- Storage](../09-storage.md) -- adding a USB disk as a ZFS pool end to end, datasets versus
  zvols and the `zfspool` plugin mapping, scrub and the single-disk detect-not-repair reality,
  snapshots and send/receive, the ARC cap, and export-before-unplug for a removable pool.
- [btrfs.md](btrfs.md) -- the host root filesystem and default storage (ZFS here is the secondary
  pool, not the root).

---

Back to the [cheatsheets index](README.md). Browse all the [guides](../README.md).
