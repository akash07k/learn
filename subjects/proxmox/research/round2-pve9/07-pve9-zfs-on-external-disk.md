# PVE 9: ZFS on an External USB Disk (single-disk pool, learning + backup target)

Target: latest Proxmox VE 9.x (Debian 13 "trixie"), mid-2026. Single node, host root = BTRFS. ZFS is
used here ONLY on an EXTERNAL USB disk - never the host root. No RAID (single-disk zpool only). All
steps are shell-only (serial console / pct enter / pvesh friendly). Where PVE 9 differs from PVE 8,
it is flagged as a DELTA.

This whole topic carries one structural caveat you must internalise up front: a single-disk pool
with no redundancy can DETECT corruption (via checksums) but CANNOT self-heal it. ZFS still buys you
checksumming, snapshots, send/receive, and compression - which is exactly why it is worth learning
on a spare USB disk - but it is not a substitute for having a second copy of important data.

## 1. ZFS version shipped in PVE 9 and notable features

Current PVE 9.2 ships OpenZFS 2.4 on the kernel 7.0 line. Earlier PVE 9 point releases shipped
OpenZFS 2.3: PVE 9.0 listed ZFS 2.3.3 with kernel 6.14, and PVE 9.1 listed ZFS 2.3.4 with kernel
6.17. DELTA from PVE 8: PVE 8 shipped OpenZFS 2.2.x.

Notable OpenZFS features in the PVE 9 line, with the current PVE 9.2 baseline in mind:

- RAIDZ Expansion arrived with OpenZFS 2.3. It lets you add a disk to an existing RAIDZ vdev. Not
  relevant to a single-disk pool with no RAIDZ, but it is the headline 2.3 storage-layout feature.
- Fast Dedup also arrived with OpenZFS 2.3. It makes dedup cheaper than older ZFS dedup designs, but
  the guidance for this learning/backup USB pool is unchanged: do NOT enable dedup. It is still
  RAM-hungry and rarely worth it here. Use compression instead.
- JSON output is available for useful commands such as `zpool status -j`, `zpool list -j`, and
  `zfs list -j`. This is genuinely useful for a screen-reader user: JSON parses cleanly and avoids
  wide column-aligned ASCII tables. Pipe through `jq` for readable, linear output.
- OpenZFS 2.4 adds current-generation features such as default user/group/project quotas, uncached
  IO fallback, special-vdev support for ZVOL writes through `special_small_blocks`, all-pool scrub
  and trim helpers, targeted time-range scrub options, and the `arcstat`/`arc_summary` rename to
  `zarcstat`/`zarcsummary`. Most of these are advanced or not useful on a single USB disk, but the
  rename matters when reading PVE 9.2 system reports and shell output.

DELTA worth calling out for accessibility: prefer `zpool status -j | jq` and `zfs list -j | jq` in
PVE 9 over the default tabular output.

## 2. Why /dev/disk/by-id matters (doubly so for removable USB)

ALWAYS create and import USB pools using stable `/dev/disk/by-id/` paths, never `/dev/sdX`. Kernel
`sdX` names are assigned in probe order and are NOT stable: unplug/replug the USB disk, plug in a
second USB device, or reboot, and `sdb` can become `sdc`. A pool created against `/dev/sdb` can come
up DEGRADED/FAULTED or fail to import after such a change. `by-id` names are derived from the disk's
model+serial (or WWN) and stay constant across reboots and re-plugs.

Find the stable id for your USB disk:

```bash
ls -l /dev/disk/by-id/ | grep -v part # list whole-disk ids
# or, cleaner, the PVE helper:
lsblk -o NAME,SIZE,MODEL,SERIAL,WWN
ls /dev/disk/by-id/ | grep -i usb # USB bridges often show usb-... ids
```

Prefer an id that encodes the serial, e.g. `/dev/disk/by-id/ata-...-<serial>` or
`/dev/disk/by-id/usb-<model>_<serial>-0:0` or a `wwn-0x...` id. USB-SATA bridges sometimes hide the
real ATA serial and present a generic `usb-...` id; if several identical enclosures exist, double
check the serial maps to the right physical disk before creating the pool.

USB-specific extra reason: USB bridges can also disappear and re-enumerate on power-management
events (see section 13). A pool bound to `by-id` survives the device coming back as a different
`sdX`; a pool bound to `sdX` may not.

## 3. Creating a single-disk zpool on the USB disk (ashift=12)

```bash
# Identify the disk's stable id first (section 2), then:
zpool create -f -o ashift=12 \
 -O compression=zstd -O atime=off \
 -m /mnt/usbzfs \
 usbpool /dev/disk/by-id/<your-usb-disk-id>
```

Notes on each part:

- `-o ashift=12` sets 4 KiB (2^12) sectors. This is a per-vdev, CREATE-TIME-ONLY property - you
  cannot change it later. 12 is the safe default for virtually all modern disks (even 512e disks
  that lie about being 512-byte). Using ashift=9 on a real 4K disk causes severe write
  amplification, so always pin 12. Some very new disks are physically 8 KiB (ashift=13); only use 13
  if you confirm it.
- `-O compression=zstd` and `-O atime=off` are dataset-level properties set as pool-wide defaults at
  create time (capital `-O`). See sections 6-7.
- `-m /mnt/usbzfs` sets the pool's mountpoint. For a removable/secondary pool it is cleaner to mount
  somewhere explicit like `/mnt/usbzfs` rather than the default `/usbpool` at root. (You can also
  set `-m none` if you only want child datasets/zvols and no top-level mounted filesystem.)
- `-f` forces creation past minor warnings (e.g. an existing partition table). Make sure you have
  the RIGHT disk first - `zpool create` is destructive.
- Pool naming rules (PVE docs): start with a letter; alphanumerics plus `- _ . : space`; must NOT
  begin with `mirror`, `raidz`, `draid`, or `spare`, and must not be named `log`.

Single-disk = a single top-level vdev with one disk, no mirror/raidz. ZFS will still checksum
everything; it just has no redundant copy to repair from.

Optional defence-in-depth on a single disk: `zfs set copies=2 usbpool/<dataset>` keeps two copies of
each block on the same disk, so ZFS can self-heal isolated bad sectors (NOT a whole-disk failure).
It doubles space usage for that dataset. Reasonable for a small, important dataset; not for bulk
backup data. PVE docs explicitly note `copies` is "not a replacement for disk redundancy."

## 4. Datasets vs zvols - and which PVE uses for guest disks

Two storage object types live inside a pool:

- Dataset (a.k.a. ZFS filesystem) - a POSIX filesystem you mount and put files in. Created with
  `zfs create usbpool/mydata`. Has properties like recordsize, compression, atime, quota. This is
  what you use for file storage, vzdump dumps, PBS datastore, manual data.
- Zvol (ZFS volume) - a block device exported at `/dev/zvol/usbpool/<name>`, with no filesystem of
  its own; something else (a VM, mkfs) puts a filesystem on it. Created with
  `zfs create -V 10G usbpool/myvol`. Has `volblocksize` (the block analogue of recordsize) instead
  of recordsize.

How the PVE `zfspool` storage plugin maps guest disks (important):

- VM disks (qemu) to ZVOLS, format `raw`. Each VM disk is its own zvol, e.g.
  `usbpool/vm-100-disk-0`. The zvol's block size comes from the storage's `blocksize` property (the
  plugin's `blocksize` maps to ZFS volblocksize).
- LXC container rootfs to DATASETS (subvolumes), format `subvol`, e.g. `usbpool/subvol-101-disk-0`.
  Containers get a real ZFS filesystem with quota.

So the same `zfspool` storage transparently uses zvols for VMs and datasets for containers. Child
objects inherit properties (compression, etc.) from the parent dataset, so set sane defaults on the
pool/parent once.

## 5. The PVE ZFS storage plugin (type `zfspool` in storage.cfg)

The plugin type is `zfspool`. It accesses a local ZFS pool or a dataset within one. Configure it in
`/etc/pve/storage.cfg`. Properties:

- `pool` - the ZFS pool or dataset to allocate within (e.g. `usbpool` or `usbpool/guests`).
- `content` - `images` (VM disks) and/or `rootdir` (LXC rootfs). The zfspool plugin supports only
  those two content types for guest storage. It does NOT serve `backup`/`vztmpl`/`iso` - for those
  you use a `dir` storage pointed at a dataset's mountpoint, or a PBS datastore (section 12).
- `sparse` - enable ZFS thin provisioning. A sparse zvol has no upfront reservation, so it only
  consumes space as data is written. Recommended on a learning/secondary pool; without it each VM
  disk reserves its full size.
- `blocksize` - sets the ZFS volblocksize for newly created zvols (VM disks). Default 16k in recent
  ZFS. Leave default unless you have a reason.
- `mountpoint` - where the pool/dataset is mounted; defaults to `/<pool>`. Changing it here does not
  change the dataset's own `mountpoint` property.

Add the storage from the shell (no GUI) with `pvesm`:

```bash
pvesm add zfspool usbpool-guests \
 --pool usbpool/guests --content images,rootdir --sparse 1
pvesm status # confirm it is active
pvesm zfsscan # list zpools visible to PVE
```

### Example /etc/pve/storage.cfg entries

```text
# Guest disks (VM zvols + LXC subvol datasets) on the USB ZFS pool
zfspool: usbpool-guests
 pool usbpool/guests
 content images,rootdir
 sparse
 # blocksize 16k # optional; default is fine

# A plain directory storage on a ZFS dataset, for vzdump backups / ISOs / templates
# (zfspool itself cannot hold 'backup'; point a dir storage at a dataset mountpoint)
dir: usbpool-backup
 path /mnt/usbzfs/backup
 content backup,iso,vztmpl
 prune-backups keep-last=3
```

For the `dir` backup storage to work, first create and mount the dataset:
`zfs create usbpool/backup` (it mounts under the pool mountpoint, e.g. `/mnt/usbzfs/backup`), then
point `path` at that exact directory.

## 6. Compression (lz4 / zstd)

Compression is on inline; it saves space and often improves throughput (less data to/from the slow
USB disk). Two main choices:

- `lz4` - very fast, low CPU, modest ratio. The long-standing safe default; it has early-abort so
  incompressible data costs almost nothing.
- `zstd` - better ratio at slightly more CPU; levels `zstd-1`..`zstd-19` (`zstd` alone is level 3).
  `zstd` is a good default for a backup-oriented USB pool where ratio matters more than raw speed.

```bash
zfs set compression=zstd usbpool # pool-wide default (inherited)
zfs set compression=lz4 usbpool/faststuff # override per-dataset
zfs get compressratio usbpool # see achieved ratio
```

Compression only affects data written AFTER the change; existing data is not recompressed until
rewritten. PVE's own docs use `compression=lz4` in examples; `zstd` is the modern stronger choice.
(`compression=on` currently means lz4.)

## 7. atime, recordsize basics

- `atime` - updates the access timestamp on every read, causing extra writes. Turn it off on a USB
  pool to cut write churn (and spin-ups): `atime=off`. If you ever need mtime/ctime but not full
  atime, `relatime=on` is a middle ground, but `atime=off` is the usual choice here.
- `recordsize` (datasets) - the MAX logical block size, default 128K. ZFS uses variable-size records
  up to this. Defaults are fine for general files and for vzdump/PBS targets. Tune only with reason:
  large sequential/media to 1M can improve throughput and ratio; databases with fixed page size to
  match it (e.g. 16K). It applies to NEW writes only.
- `volblocksize` (zvols / VM disks) - the fixed block size, set at zvol creation via the plugin's
  `blocksize`. Default 16k. Cannot be changed after creation.

```bash
zfs set atime=off usbpool
zfs set recordsize=1M usbpool/media # example: large media dataset
```

## 8. Snapshots and clones

Snapshots are instant, read-only, near-free (copy-on-write; cost grows only as data diverges). Great
for the learning playground and for cheap restore points.

```bash
zfs snapshot usbpool/mydata@before-change # one dataset
zfs snapshot -r usbpool@nightly # recursive over all children
zfs list -t snapshot # list snapshots
zfs rollback usbpool/mydata@before-change # revert (destroys newer snaps)
# Read files from a snapshot without rollback: <mountpoint>/.zfs/snapshot/<name>/
zfs destroy usbpool/mydata@before-change # remove a snapshot
```

Clones are writable, instant copies derived from a snapshot (share blocks until written):

```bash
zfs clone usbpool/mydata@snap usbpool/mydata-clone
zfs promote usbpool/mydata-clone # detach clone from its origin snapshot
```

Note: PVE's own guest-snapshot feature uses these ZFS snapshots under the hood when a guest's disk
lives on a `zfspool` storage (snapshots are fast and free there), which is another reason to keep
test VMs/CTs on the USB ZFS pool.

## 9. zfs send / receive - the key reason to use ZFS for backup/replication

`zfs send` serialises a snapshot to a stream; `zfs receive` reconstructs it. This is block-level,
checksummed, and supports INCREMENTAL transfer (only the deltas between two snapshots) - the core
reason to use ZFS as a backup/ replication mechanism to another disk or host.

Local replication to a second pool/disk:

```bash
zfs snapshot usbpool/mydata@s1
zfs send usbpool/mydata@s1 | zfs receive otherpool/mydata # full, first time
# later, after more snapshots:
zfs snapshot usbpool/mydata@s2
zfs send -i @s1 usbpool/mydata@s2 | zfs receive otherpool/mydata # incremental delta
```

To another host over SSH:

```bash
zfs send -i @s1 usbpool/mydata@s2 | ssh backuphost zfs receive backuppool/mydata
```

Useful flags: `-R` (replicate a dataset and all its children/snaps/properties), `-w` (raw send -
preserves compression/encryption without re-processing), `-I` (send an entire range of intermediate
snapshots), and on receive `-F` (force, roll target back to match) and `-u` (do not auto-mount the
received dataset - handy for a removable target). Always keep at least one common snapshot on both
sides; incrementals need a shared base.

Accessibility/automation note: this is fully scriptable and serial-console friendly. PVE's built-in
"Storage Replication" (`pvesr`) is essentially scheduled `zfs send/receive` between ZFS storages,
but it is aimed at clusters; on a single node you typically just script send/receive to the USB pool
or to a remote host yourself (cron/systemd timer).

## 10. Scrub + status - and the single-disk reality

A scrub reads every allocated block and verifies its checksum.

```bash
zpool scrub usbpool # start a scrub (runs in background)
zpool status usbpool # progress, errors, vdev health
zpool status -j usbpool | jq # JSON output (PVE 9 / ZFS 2.4) - screen-reader friendly
zpool scrub -s usbpool # stop an in-progress scrub
zpool list # capacity / health summary
```

CRITICAL single-disk caveat, stated explicitly: on a pool with NO redundancy (single disk, no
mirror/raidz), a scrub can DETECT checksum errors but CANNOT repair them - there is no second copy
to rebuild the block from. `zpool status` will report the bad file under "errors:" and you must
restore that file from another backup. (Exception: if you set `copies=2` on a dataset, ZFS can
self-heal isolated block errors for that dataset, but still not a whole-disk failure.)

So scrubbing a single USB disk is still worth doing: it tells you early that the disk is going bad
(rising CKSUM/READ/WRITE counters), letting you replace it and re-send your data before total loss.
Treat detection - not repair - as the value.

Scheduling: Debian/PVE installs a ZFS scrub systemd timer (`zfs-scrub-weekly@.timer` /
`zfs-scrub-monthly@.timer`) and a monthly scrub is the common cadence. Enable for the USB pool,
e.g.: `systemctl enable --now zfs-scrub-monthly@usbpool.timer`. Note the timer only scrubs while the
pool is imported - a removable disk that is usually unplugged will be skipped, so for an on-demand
USB disk, run `zpool scrub usbpool` by hand when it is attached. Also check `zpool status` after
every reconnect.

## 11. ARC memory tuning on PVE 9

ARC (Adaptive Replacement Cache) is ZFS's in-RAM read cache. If it is not capped, upstream OpenZFS
can grow ARC to a large share of free RAM. It releases memory under pressure, but the release is not
always fast enough for latency-sensitive VM workloads, so PVE documents an installer-written cap.

DELTA / IMPORTANT - the actual PVE default: contrary to some forum chatter claiming PVE 9 raised the
ARC cap to roughly 90% of RAM, the official Proxmox docs and the PVE wiki for current 9.x still
state that ZFS uses 10% of host memory, clamped to a maximum of 16 GiB, for ARC by default, and that
this value is written to `/etc/modprobe.d/zfs.conf` during installation. This 10%/16-GiB cap was
introduced in PVE 8.1 and carries into PVE 9 per the docs. PVE 8.4 also fixed installer handling so
ARC limits are set for additional ZFS storage even when root is not ZFS.

Relevance to THIS setup: your host root is BTRFS, and this topic adds ZFS later by hand for a USB
pool. Do not assume either outcome. Check whether `/etc/modprobe.d/zfs.conf` already exists and
whether it contains a suitable `zfs_arc_max` value. If the file is absent, says `zfs_arc_max=0`, or
sets a cap too high for your VM workload, add your own modest cap so the USB pool's cache does not
eat RAM you would rather give to guests.

Set a permanent cap (example: 4 GiB = 4294967296 bytes):

```bash
# Create/edit the modprobe config:
# /etc/modprobe.d/zfs.conf
# options zfs zfs_arc_max=4294967296
echo "options zfs zfs_arc_max=4294967296" > /etc/modprobe.d/zfs.conf
update-initramfs -u -k all # required so the value is applied early at boot
reboot
```

Key details:

- Value is in BYTES. 0 means "use the default".
- If your target `zfs_arc_max` is below `zfs_arc_min` (default 1/32 of RAM), you must also lower
  `zfs_arc_min` to at most `zfs_arc_max - 1`, or the setting is ignored.
- `update-initramfs -u -k all` is needed especially when root is ZFS; with a BTRFS root it is less
  critical but still the documented, reliable way to make the module load with the parameter - run
  it.
- Temporary change for the current boot (no reboot, lost on reboot):
  `echo 4294967296 > /sys/module/zfs/parameters/zfs_arc_max`. Good for testing a value before
  committing it to modprobe.
- Check current ARC size/limit: `zarcsummary`, `zarcstat`, or
  `cat /proc/spl/kstat/zfs/arcstats | grep -E '^(size|c_max)'`.

## 12. Using the ZFS USB disk as a vzdump / PBS backup target

Two ways to back up onto the USB ZFS pool:

A) vzdump to a directory on a ZFS dataset (simplest)

- The `zfspool` plugin does NOT accept `backup` content. So create a dataset and expose it as a
  `dir` storage with `content backup`:

```bash
zfs create usbpool/backup # mounts at <poolmount>/backup
pvesm add dir usbpool-backup \
--path /mnt/usbzfs/backup \
--content backup,iso,vztmpl \
--prune-backups keep-last=3
vzdump 100 --storage usbpool-backup --mode snapshot --compress zstd
```

- Let ZFS do the compression (`compression=zstd` on the dataset) OR vzdump's `--compress`, not
  heavily both; double compression wastes CPU for little gain. A reasonable choice: ZFS zstd on the
  dataset + vzdump `--compress 0`.

B) Proxmox Backup Server (PBS) datastore on a ZFS dataset (better: dedup + incremental + verify)

- Install proxmox-backup-server (or point at an existing PBS). Create the datastore on a dataset
  mountpoint:

```bash
zfs create usbpool/pbs
proxmox-backup-manager datastore create usbstore /mnt/usbzfs/pbs
```

- PBS gives you deduplicated, incremental, client-side-encrypted, verifiable backups - a much
  stronger backup story than raw vzdump, and it pairs well with a ZFS dataset (checksums + snapshots
  of the datastore itself).
- For a REMOVABLE PBS target, see the "removable datastore" feature (PBS 3.4+/with PVE 9) which is
  designed for disks that are exported and physically rotated; otherwise just ensure the pool is
  imported before any scheduled backup/verify/GC job runs.

In BOTH cases: because the target is a single disk with no redundancy, this USB pool should be ONE
copy in a 3-2-1 strategy, not your only copy.

## 13. USB-specific ZFS gotchas (read before trusting this in production)

OpenZFS works on USB disks but USB adds failure modes ZFS was not designed around. Be explicit with
yourself about these:

- Unstable device names - covered in section 2. USB bridges re-enumerate; ALWAYS use
  `/dev/disk/by-id`. A pool can import DEGRADED/FAULTED purely because the device came back as a
  different `sdX`. Re-import by id if needed (section 14).
- Power management / spin-down - USB enclosures and the USB Attached SCSI (UAS) layer can suspend,
  reset, or drop the disk on autosuspend or under load. ZFS then sees I/O errors and may FAULT the
  disk or suspend the pool. Mitigations: disable USB autosuspend (kernel `usbcore.autosuspend=-1` or
  per-device), disable disk APM/standby (`hdparm -B 255 -S 0 /dev/sdX` while attached), and prefer a
  quality powered enclosure. Some cheap UAS bridges are flaky under ZFS; a `usb-storage.quirks=...`
  blacklist of UAS for that bridge sometimes helps.
- "Hung" / suspended pool - if the disk vanishes mid-write, the pool can enter a suspended state and
  processes touching it hang in D-state. Recovery often needs `zpool clear usbpool` after reconnect,
  sometimes a reboot. Always `export` before unplug (section 14) to avoid this.
- Performance - USB (even USB 3 / 10 Gbps) has higher latency, no NCQ depth like SATA/SAS, and the
  bridge can bottleneck. Expect sync writes, scrubs, and send/receive to be slow. Avoid
  `sync=always`; avoid dedup; keep recordsize generous for bulk data. This is fine for a learning
  pool and an offline backup target, NOT for running latency-sensitive VMs.
- Cheap-flash / lying caches - some USB-SATA and flash bridges ignore cache-flush (FLUSH) commands,
  which undermines ZFS's crash-consistency guarantees on power loss. Use a known-good enclosure; do
  not trust no-name USB sticks for anything you care about.
- No redundancy = no self-heal - restated because it is the big one: single disk detects but cannot
  repair. Keep another copy.

## 14. Import / export for a REMOVABLE USB disk

This is the workflow that keeps a removable ZFS disk healthy.

Cleanly remove the disk (ALWAYS export before physically unplugging):

```bash
sync
zpool export usbpool # flushes, unmounts, releases the disk
# now it is safe to physically unplug
```

Re-attach the disk and import by stable id:

```bash
zpool import # scan and list importable pools (no action)
zpool import -d /dev/disk/by-id usbpool # import by id (preferred)
# alternate explicit mountpoint / no-mount variants:
zpool import -d /dev/disk/by-id -R /mnt/usbzfs usbpool # altroot
zpool status usbpool # verify ONLINE, check error counters
```

What happens on unplug WITHOUT export: the pool is left "active"/imported in the cachefile; on
reconnect it may auto-import fine, OR come up FAULTED/UNAVAIL if the device name moved, and any
in-flight writes are lost. If it comes back wrong: `zpool clear usbpool` (clear transient errors
after reconnect) and re-`import` by id. Hence: export first, every time.

cachefile considerations for a REMOVABLE pool - by default a pool is recorded in
`/etc/zfs/zpool.cache` and `zfs-import-cache.service` tries to import it at every boot. For a disk
that is usually absent, that produces boot-time noise/timeouts. Two clean options:

```bash
# Option A: keep the pool OUT of the cachefile so boot never tries to import it;
# you import on demand by hand when the disk is attached:
zpool set cachefile=none usbpool
# Option B (recommended for on-demand removable): set cachefile=none AND rely on
# `zpool import -d /dev/disk/by-id usbpool` manually (or a small udev/systemd
# rule) only when present.
```

Mounting at boot vs on-demand:

- On-demand (recommended for a removable USB disk): `cachefile=none`, no boot import; run
  `zpool import -d /dev/disk/by-id usbpool` after you plug it in. Add it to PVE as storage only
  while present, or accept the storage showing inactive when the disk is gone (PVE marks a missing
  `zfspool`/`dir` storage as not active, which is harmless).
- At boot (only if the disk is permanently attached): leave it in the cachefile (default) so
  `zfs-import-cache.service` imports it early; or use `zfs-import-scan.service` which scans
  `/dev/disk/by-id`. For a permanently attached secondary disk this is fine.

Always import by id (`-d /dev/disk/by-id`) on a USB pool so ZFS records stable paths and does not
fall back to `/dev/sdX`.

## Citations

- Proxmox VE Roadmap release history (PVE 9.0/9.1/9.2 kernel and ZFS baselines):
  [Roadmap](https://pve.proxmox.com/wiki/Roadmap)
- Proxmox VE docs - System Administration, ZFS on Linux chapter (zpool create ashift,
  compression=lz4, ARC limit via /etc/modprobe.d/zfs.conf zfs_arc_max, update-initramfs -u -k all,
  by-id guidance, pool naming, copies caveat):
  [Host System Administration](https://pve.proxmox.com/pve-docs/chapter-sysadmin.html)
- Proxmox VE docs - pvesm / Storage, ZFS Pool Backend (zfspool type: pool, blocksize, sparse,
  mountpoint; content images,rootdir; zvols for VMs and subvol datasets for CTs; example
  storage.cfg): [Proxmox VE Storage](https://pve.proxmox.com/pve-docs/chapter-pvesm.html)
- Proxmox VE docs - pve-admin-guide, "Limit ZFS Memory Usage" (zfs_arc_max permanent vs /sys
  runtime, zfs_arc_min interaction, >256 GiB note, update-initramfs):
  [Proxmox VE Administration Guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.html)
- Proxmox VE wiki - ZFS on Linux (10% / 16 GiB ARC default for new installs, zfs.conf,
  update-initramfs, ashift, by-id): [ZFS on Linux](https://pve.proxmox.com/wiki/ZFS_on_Linux)
- OpenZFS 2.4.0 release (current PVE 9.2 ZFS line; includes the `zarcstat`/`zarcsummary` rename,
  uncached IO fallback, time-range scrubs, and special-vdev/zvol improvements):
  [Release zfs-2.4.0 · openzfs/zfs](https://github.com/openzfs/zfs/releases/tag/zfs-2.4.0)
- OpenZFS docs (man pages for zpool-create, zpool-scrub, zpool-import, zpool-export, zfs-send,
  zfs-receive, zfs properties):
  [OpenZFS Documentation - OpenZFS documentation](https://openzfs.github.io/openzfs-docs/)
- OpenZFS issues documenting USB device-name instability / FAULTED-on-reboot (why by-id matters;
  UAS/power-management gotchas):
  [zfs changes back to /dev/sdx device names upon reboot · Issue #2944 · openzfs/zfs](https://github.com/openzfs/zfs/issues/2944)
  ,
  [zpool replace fails when new dev name is same device - replugged external USB drive using /dev/sdX names cannot be detached/reattached · Issue #7866 · openzfs/zfs](https://github.com/openzfs/zfs/issues/7866)
- Proxmox forum discussion on PVE 9 / ARC behaviour (source of the "~90%" claim that the official
  docs do NOT corroborate - flagged as unofficial):
  [Proxmox problem with memory limits in ARC (ZFS)](https://forum.proxmox.com/threads/proxmox-problem-with-memory-limits-in-arc-zfs.147127/)
