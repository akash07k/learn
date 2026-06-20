# BTRFS on Proxmox VE 9 (deep dive)

Target: latest PVE 9.x (9.1/9.2 era, mid-2026) on Debian 13 "trixie". Scope: BTRFS as the **host
root filesystem** on a single node, single 1TB NVMe, no RAID, shell-only operation for a
screen-reader user.

Bottom line up front: BTRFS works fine as a single-disk PVE root and gives you native snapshots +
checksums + transparent compression with no ZFS ARC RAM tax. But it is still officially a
**technology preview** in PVE 9, and on a **single disk** its self-healing is neutered (it can
_detect_ bit-rot but cannot _repair_ it, because there is no second copy). That single-disk caveat
is the most important honest point in this whole document.

---

## 1. Technology-preview status: the honest reality in PVE 9

The PVE docs and wiki still label BTRFS integration a "technology preview" in PVE 9 (it has carried
this label since PVE 7.0 in 2021, and PVE 9 did **not** promote it). In the storage capability table
BTRFS is marked stability `TP5` ("Technology Preview, best-effort support"). ZFS, by contrast, is
fully supported.

What "technology preview" means in practice here:

- It is shipped, installable from the official ISO, and the PVE `btrfs` storage plugin is a real,
  maintained plugin. It is not abandonware.
- Proxmox does not promise the same level of support/QA as ZFS or LVM-thin. Fewer people run it, so
  you are more likely to hit an under-tested edge.
- Notably, scanning the PVE **9.0 and 9.1 roadmap/release notes turns up no BTRFS-specific changelog
  entries** - no installer rework, no plugin overhaul. (Some community posts loosely credit "btrfs
  installation improvements" to 9.1, but that is not reflected in the official roadmap text; treat
  it as unconfirmed.) Translation: BTRFS in PVE 9 is essentially BTRFS as it was in PVE 8, riding a
  newer kernel.
- The big PVE 9.x storage headline feature, **"Snapshots as volume-chains"** (a new TP that brings
  snapshot support to LVM-thick / Directory / NFS / CIFS via qcow2 chains), explicitly does **not**
  involve BTRFS - BTRFS already had native snapshots and is not part of that work.

Kernel: PVE 9.0 ships kernel 6.14, PVE 9.1 ships 6.17, and current PVE 9.2 ships kernel 7.0. Newer
kernels generally mean a more mature, better-fixed btrfs (btrfs is in active upstream development,
so a newer kernel is a real benefit for this filesystem specifically).

The single most important caveat is **single-disk redundancy**, covered in section 9. Read it.

Citations: [BTRFS](https://pve.proxmox.com/wiki/BTRFS) ,
[Proxmox VE Storage](https://pve.proxmox.com/pve-docs/chapter-pvesm.html) ,
[Roadmap](https://pve.proxmox.com/wiki/Roadmap)

---

## 2. What a BTRFS-root install lays out

When you pick BTRFS for the root filesystem in the PVE installer, on a single disk you choose RAID
level **`single`** (the only sensible choice for one NVMe; RAID0/RAID1/RAID10 need 2-4 disks). The
installer:

- Partitions the NVMe (EFI system partition, plus the main btrfs partition).
- Creates a single btrfs filesystem that holds the root.
- Creates an **additional subvolume** mounted at `/var/lib/pve/local-btrfs`, which becomes the PVE
  storage for guests.

You can see the subvolumes after install with:

```bash
btrfs subvolume list /
```

This lists subvolume ID, generation, top level, and path - you will see the
`var/lib/pve/local-btrfs` subvolume among them.

Installer-time options worth knowing (set in the installer's advanced disk options):

- `compress` - enable transparent compression on the btrfs subvolume at install time. Accepts `on`
  (= `zlib`), `zlib`, `lzo`, `zstd`. **Defaults to `off`.** Recommend `zstd`.
- `hdsize` - total disk size to use, letting you leave free space unpartitioned (e.g. for a swap
  partition; btrfs swapfiles are fiddly, so a dedicated swap partition is cleaner).

Citations: [BTRFS](https://pve.proxmox.com/wiki/BTRFS) ,
[pve-docs/pve-installation.adoc at master · proxmox/pve-docs](https://github.com/proxmox/pve-docs/blob/master/pve-installation.adoc)
,
[pve-docs/local-btrfs.adoc at master · proxmox/pve-docs](https://github.com/proxmox/pve-docs/blob/master/local-btrfs.adoc)

---

## 3. Default storages created (and what `pvesm status` shows)

A BTRFS-root install writes this to `/etc/pve/storage.cfg`:

```text
dir: local
 path /var/lib/vz
 content iso,vztmpl,backup
 disable

btrfs: local-btrfs
 path /var/lib/pve/local-btrfs
 content iso,vztmpl,backup,images,rootdir
```

Key points:

- The usual `dir: local` (the `/var/lib/vz` directory storage you get on an ext4/LVM install) **is
  created but `disable`d**. So on a BTRFS root, `local` is present-but-off by default.
- A new storage of **type `btrfs`** named `local-btrfs` is created and pointed at the
  `/var/lib/pve/local-btrfs` subvolume. This one storage carries **all** content types: ISOs,
  container templates (`vztmpl`), backups, VM images (`images`), and container rootdirs (`rootdir`).
  So one btrfs storage does the job that `local` + `local-lvm` do on an LVM install.

`pvesm status` lists every configured storage with Type, Status (active/disabled/inactive), Total,
Used, Available, and a usage %. On a default BTRFS-root single node you would see `local` reported
as **disabled** and `local-btrfs` as **active** of type `btrfs`. Run it to confirm before doing
anything:

```bash
pvesm status
```

Because `local-btrfs` is btrfs-backed, the Total/Used figures it reports come from btrfs's own
accounting and share the single underlying filesystem with the host root - there is no separate
fixed-size pool the way LVM-thin carves one out. Everything (root, guests, backups) competes for the
one ~1TB pool, so watch free space (see section 8 on why `df` is misleading).

Citations:
[pve-docs/local-btrfs.adoc at master · proxmox/pve-docs](https://github.com/proxmox/pve-docs/blob/master/local-btrfs.adoc)
, [pvesm(1)](https://pve.proxmox.com/pve-docs/pvesm.1.html)

---

## 4. The PVE `btrfs` storage plugin

### Type and options (`/etc/pve/storage.cfg`)

```text
btrfs: <storage-id>
 path <abs-path-to-btrfs-mountpoint-or-subvol>
 content <comma-list>
 is_mountpoint <path> # recommended if path is not the fs root
 nodes <node-list> # optional
 disable # optional
```

- `path` (required): absolute path into a btrfs filesystem.
- `is_mountpoint`: tells PVE the storage lives on a separate mount and to wait for it before using
  the storage. Use this when the btrfs is an extra disk mounted somewhere, e.g.:

```text
btrfs: data2
path /mnt/data2/pve-storage
content rootdir,images
is_mountpoint /mnt/data2
```

- `content`: any of `images` (VM disks), `rootdir` (CT root), `vztmpl`, `iso`, `backup`, `snippets`.

Add an existing btrfs to PVE from the shell:

```bash
pvesm add btrfs my-storage --path /my-storage
```

### How VM and CT disks are stored - subvolumes vs raw files

The btrfs plugin behaves like the **Directory** plugin but is snapshot-aware:

- **VM disks** are stored as **raw-format image files placed inside a btrfs subvolume**. Only the
  **`raw`** format is supported on btrfs storage - **no qcow2, no vmdk**. (You do not need qcow2 for
  snapshots here because btrfs provides snapshots at the filesystem layer; that is the whole point.)
- **Container (CT) rootfs** is stored as a **btrfs subvolume** directly (so the container's
  filesystem is a real subvolume, enabling instant snapshots of it).

### Capability matrix - how btrfs differs from ext4/LVM/ZFS

From the PVE "Available storage types" table:

- type `btrfs`, level **file**, shared **no**, snapshots **yes**, stability **TP5**.

How that compares:

- **dir (ext4 directory)**: file-level, snapshots only via qcow2 image format. btrfs gives you
  native snapshots without qcow2.
- **lvmthin**: block-level, snapshots yes, but no checksums/compression and not a normal filesystem
  you can browse.
- **zfspool**: block/file, snapshots yes, checksums+compression like btrfs - the mature alternative
- but costs ARC RAM and is heavier.

So the btrfs row's headline win over a plain directory storage is **native snapshots + data
checksums + transparent compression**, while staying a browsable filesystem. The trade vs ZFS is
maturity/support, and vs lvmthin is that you keep a real filesystem.

### Important plugin gotcha: cache mode and O_DIRECT

The docs warn: **btrfs honors the `O_DIRECT` flag, so VMs on btrfs storage should NOT use disk cache
mode `none`.** Doing so can produce **checksum errors**. Use a caching mode such as `writeback` (or
the default) instead. This is a real, btrfs-specific footgun - set it per VM disk. Configure it
shell-side with e.g. `qm set <vmid> --scsi0 local-btrfs:<size>,cache=writeback` or by editing the
disk line in `/etc/pve/qemu-server/<vmid>.conf`.

Citations: [Proxmox VE Storage](https://pve.proxmox.com/pve-docs/chapter-pvesm.html) ,
[pvesm(1)](https://pve.proxmox.com/pve-docs/pvesm.1.html)

---

## 5. Subvolumes: create / list / delete

```bash
btrfs subvolume create /some/path # make a new subvolume
btrfs subvolume list / # list all subvolumes under a mount
btrfs subvolume delete /some/path # delete (no need to empty it first)
```

A subvolume looks like a directory but is an independent snapshottable/quota-able unit. PVE creates
one per container rootfs and one for the `local-btrfs` storage. You generally let PVE manage guest
subvolumes via `pct`/`qm`; the raw `btrfs subvolume` commands are for host-level work (e.g. carving
a dedicated subvolume for backups on an external disk).

Citation: [BTRFS](https://pve.proxmox.com/wiki/BTRFS)

---

## 6. Snapshots - and how PVE guest snapshots map to btrfs

### Native btrfs snapshots

```bash
btrfs subvolume snapshot -r /some/path /a/new/path # read-only snapshot (COW clone)
btrfs subvolume snapshot /some/path /a/new/path # writable snapshot (omit -r)
```

Snapshots are copy-on-write: instantly created, initially share all blocks with the origin, and only
diverge as either side is modified. Read-only (`-r`) snapshots are the ones usable as a `btrfs send`
source (section 7).

### How PVE guest snapshots map onto btrfs

When you take a PVE snapshot of a VM/CT that lives on btrfs storage (`qm snapshot <vmid> <name>` or
`pct snapshot <vmid> <name>`):

- PVE creates a **read-only btrfs subvolume snapshot** of the disk subvolume.
- The snapshot's path is the original subvolume/raw-file path followed by `@` and the snapshot name.
  So a snapshot named `before-upgrade` of a disk appears as `...disk-0@before-upgrade`.
- This is fast and space-efficient (COW), unlike qcow2 internal snapshots on a directory store.
- Offline storage migration **preserves snapshots** on btrfs (a plus over some backends).

List/manage guest snapshots with `qm listsnapshot <vmid>` / `pct listsnapshot <vmid>`, `qm rollback`
/ `pct rollback`, and `qm delsnapshot` / `pct delsnapshot`. All shell-friendly, no GUI needed.

Citations: [Host System Administration](https://pve.proxmox.com/pve-docs/chapter-sysadmin.html)
(BTRFS section) ,
[Proxmox VE Administration Guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.html) (7.16.2
Snapshots) , [BTRFS](https://pve.proxmox.com/wiki/BTRFS)

---

## 7. Transparent compression (zstd)

### Enabling it

Compression is a **mount option**, set in `/etc/fstab` on the root/btrfs entry, then takes effect on
remount/reboot:

```text
UUID=<uuid> / btrfs defaults,compress=zstd 0 1
```

Algorithms: `zstd` (recommended - ratio comparable to zlib but much faster), `zlib` (slower,
slightly better ratio, levels 1-9), `lzo` (fast, weaker ratio, no levels). You can pin a level, e.g.
`compress=zstd:3` (zstd default level is 3; range -15..15, negatives are faster/worse).

### `compress` vs `compress-force`

- `compress=zstd`: btrfs makes a **heuristic guess per file/extent** and **skips data it thinks is
  incompressible** (early-bailout). Already-compressed files (media, archives) get stored raw.
- `compress-force=zstd`: btrfs **tries every block**, only falling back to uncompressed for blocks
  that grow. Use this when the heuristic is being too shy and you know your data is compressible;
  costs more CPU. For a general PVE host, plain `compress=zstd` is the safe default.

### Caveat: existing data is not retroactively compressed

Changing the mount option only affects **newly written** data. To compress data that is already on
disk, rewrite it via defragment with a compression flag:

```bash
btrfs filesystem defrag -r -czstd /path
```

Note the compression algorithm given to `defrag` applies only to that defrag run; the persistent
policy is still the mount option. (Also: `fallocate()`d files and `nodatasum` files are excluded
from compression; direct-IO reads fall back to buffered.)

### Checking what compression actually achieved - `compsize`

`df`/`ls` show _logical_ sizes and hide compression. Install and use `compsize` (package `compsize`
/ `btrfs-compsize`) to see the real ratio:

```text
compsize /var/lib/pve/local-btrfs
```

Output columns:

- **Type** - the compression algorithm (none / zstd / zlib / lzo).
- **Perc** - disk-usage as a percentage of uncompressed (lower is better compression).
- **Disk Usage** - what the data actually costs on disk (post-compression).
- **Uncompressed** - what it would cost with no compression.
- **Referenced** - apparent file sizes.

A `TOTAL` row summarizes, with per-algorithm rows beneath. This is the honest way to verify
compression is working and worthwhile.

Citations:
[Compression - BTRFS documentation](https://btrfs.readthedocs.io/en/latest/Compression.html) ,
[GitHub - kilobyte/compsize: btrfs: find compression type/ratio on a file or set of files](https://github.com/kilobyte/compsize)
, [BTRFS](https://pve.proxmox.com/wiki/BTRFS)

---

## 8. Filesystem usage reporting - the "df lies" gotcha

**Do not trust plain `df` on btrfs.** btrfs allocates space in _chunks_ (block groups) for data,
metadata, and system, each potentially under a different RAID profile, and a chunk can be _allocated
but not yet full_. `df` cannot see this structure, so its "free" number is at best an estimate and
at worst actively misleading (it can show free space while writes fail with ENOSPC, or show used
space that a balance would reclaim).

Use btrfs's own tools instead:

```bash
btrfs filesystem usage / # best human view: per-device + per-profile breakdown
btrfs filesystem df / # terse block-group summary (data/metadata/system/global-reserve)
```

`btrfs filesystem usage` shows the load-bearing numbers:

- **Device size** - raw capacity.
- **Device allocated** - how much has been carved into chunks.
- **Device unallocated** - raw space not yet assigned to any chunk.
- **Free (estimated)** - usable space remaining (accounting for profile/redundancy).
- **Used** vs allocated per Data/Metadata/System - reveals chunks that are allocated but mostly
  empty (candidates for a balance, section 9).

A classic failure mode on a busy single-disk PVE host: **metadata exhaustion / ENOSPC even though
`df` shows free space**, because data chunks ate all the unallocated space and metadata cannot grow.
`btrfs filesystem usage` is how you spot this; `balance` (next section) is how you fix it.

Citations: [btrfs-filesystem(8)](https://btrfs.readthedocs.io/en/latest/btrfs-filesystem.html) ,
[BTRFS](https://pve.proxmox.com/wiki/BTRFS)

---

## 9. Single-disk caveats (read this honestly)

This is the crux for a single 1TB NVMe with no RAID.

**Detection without repair.** btrfs checksums all data and metadata, so a scrub (section 10) _will
detect_ bit-rot, silent corruption, or a failing flash cell. But with `single` data profile there is
**no second copy**, so btrfs **cannot repair** the bad block - it can only tell you a file is
corrupt and return an error for it. You get an honest early warning, not self-healing. (Contrast: a
2-disk RAID1 btrfs _would_ repair from the good mirror during scrub.)

**Metadata is still safer than data, partly.** On a single device, btrfs by default uses `DUP`
profile for **metadata** (two copies of metadata on the same disk) while **data** is `single`. So
metadata corruption can often self-heal even on one disk, but your actual VM/CT data cannot. This is
why a scrub is still worth running on a single disk: metadata damage may be repaired, and data
damage is at least surfaced before it silently propagates into backups.

**No redundancy = backups are mandatory.** Because the disk itself is a single point of failure and
corruption is detect-only, **external backups are non-negotiable**. Use Proxmox Backup Server or
`vzdump`, and/or `btrfs send`/`receive` to an external disk (section 11). Snapshots on the same disk
are NOT backups - they die with the disk.

**RAID5/6 is irrelevant and dangerous here anyway.** Even if you later add disks, btrfs RAID5/6 is
officially "experimental and dangerous" - do not use it. For redundancy go RAID1.

**Free-space discipline.** A single shared pool (root + guests + backups + snapshots) plus btrfs's
chunk allocation means you must actively monitor with `btrfs filesystem usage` and run periodic
balance to avoid ENOSPC surprises.

### Balance - when/why on a single disk

```bash
btrfs balance start -v -dusage=10 / # rewrite data chunks under 10% full, reclaim them
```

Balance relocates/consolidates block groups. On a **single disk you do NOT need it for
redundancy/profile reasons**, but the `-dusage` filtered form is genuinely useful to **reclaim
allocated-but-mostly-empty chunks** and cure/prevent **ENOSPC even when `df` shows free space**. Run
it occasionally (or when `btrfs filesystem usage` shows allocated >> used), starting with a low
`-dusage` and raising it if needed. Avoid a full unfiltered balance on a busy host - it is IO heavy
and unnecessary here.

Citations: [Scrub - BTRFS documentation](https://btrfs.readthedocs.io/en/latest/Scrub.html) ,
[Balance - BTRFS documentation](https://btrfs.readthedocs.io/en/latest/Balance.html) ,
[BTRFS](https://pve.proxmox.com/wiki/BTRFS)

---

## 10. Scrub - and why it matters most on a single disk

Scrub reads every allocated block and verifies it against its stored checksum, catching data
checksum errors, superblock errors, metadata header errors, and disk read errors. On a redundant fs
it auto-repairs from the good copy; on single-disk **data** it can only **report** (and may repair
**DUP metadata**). It is **not** an fsck - it validates checksums, it does not rebuild the tree.

Commands:

```bash
btrfs scrub start / # start a scrub of the fs containing /
btrfs scrub status / # progress + errors found
btrfs scrub cancel /
btrfs scrub resume /
```

Why it matters on _this_ box: a single NVMe with no mirror is exactly where silent corruption would
otherwise go unnoticed until it ends up in every backup. A monthly scrub gives you an **early honest
signal** ("file X is corrupt, restore it from backup now") instead of discovering rot months later.
Expect a scrub to use up to ~80% of device bandwidth; on Linux 5.14+ you can throttle per device via
`/sys/fs/btrfs/<FSID>/devinfo/<DEVID>/scrub_speed_max`.

Citation: [Scrub - BTRFS documentation](https://btrfs.readthedocs.io/en/latest/Scrub.html)

---

## 11. send / receive - for backups/replication to an external disk

`btrfs send` serializes a **read-only** snapshot into a stream; `btrfs receive` reconstructs it on
another btrfs (external USB/eSATA disk, or piped over ssh to another host). Snapshots **must be
read-only** to be a send source.

Full send, then incremental:

```bash
# prepare read-only snapshots first
btrfs subvolume snapshot -r /var/lib/pve/local-btrfs /var/lib/pve/local-btrfs/.snap/base

# full backup to external btrfs mounted at /mnt/backup
btrfs send /var/lib/pve/local-btrfs/.snap/base | btrfs receive /mnt/backup

# later, incremental: only the delta since 'base'
btrfs subvolume snapshot -r /var/lib/pve/local-btrfs /var/lib/pve/local-btrfs/.snap/v2
btrfs send -p /var/lib/pve/local-btrfs/.snap/base /var/lib/pve/local-btrfs/.snap/v2 \
 | btrfs receive /mnt/backup
```

Useful flags: `-p <parent>` (incremental), `-f <file>` (to a file instead of stdout),
`--proto 2 --compressed-data` (send already-compressed extents without decompressing). Over the
network: `btrfs send ... | ssh host btrfs receive /mnt/backup`.

Caveat for PVE specifically: this is a **block/subvolume-level** backup of the btrfs itself, which
is a great cheap offsite copy of the whole storage, but it is **not** the same as PVE-aware
per-guest backups. For restorable, per-VM/CT backups prefer **Proxmox Backup Server** or `vzdump`;
use `btrfs send`/`receive` as an additional whole-filesystem replication safety net to a second
physical disk. Since there is only one disk in the host, the receive target **must** be an external
disk for it to count as a real backup.

Citation: [btrfs-send(8)](https://btrfs.readthedocs.io/en/latest/btrfs-send.html)

---

## 12. Quotas / qgroups (mention + perf caveat)

btrfs **qgroups** track per-subvolume usage (referenced vs exclusive space) and can enforce limits
hierarchically. Enable with `btrfs quota enable /`, then manage via `btrfs qgroup ...`.

**Performance caveat - important with snapshots:** qgroup accounting is global; every reference
change forces btrfs to recount trees referring to an extent, which **slows transaction commits and
can cause large latency spikes, and it gets worse as snapshot count grows.** Since PVE guest
snapshots create many subvolumes, enabling full qgroups on a PVE host can hurt. If you need quotas,
newer btrfs offers **simple quotas (squotas)** - same API/hierarchy but cheaper accounting (extents
charged to the first allocating subvolume, no expensive back-reference resolution). For a typical
single-node home/lab PVE host, **leave qgroups off** unless you have a concrete need.

Citation: [Quota groups - BTRFS documentation](https://btrfs.readthedocs.io/en/latest/Qgroups.html)

---

## 13. Recommended maintenance routine (single disk, shell-only)

The kernel ships systemd units for scrub. On Debian/PVE the `btrfsmaintenance` package (or the
upstream `btrfs-scrub@.timer` template) automates it. Pick one of these:

Option A - enable the kernel/systemd scrub timer for the root mount (mount-path escaped):

```bash
systemctl enable --now btrfs-scrub@-.timer # '-' == the root mount '/'
systemctl list-timers | grep btrfs # verify it is scheduled
```

Option B - install `btrfsmaintenance` (Debian package) and configure `/etc/default/btrfsmaintenance`
(`BTRFS_SCRUB_PERIOD=monthly`, `BTRFS_BALANCE_PERIOD=...`, `BTRFS_BALANCE_DUSAGE=10`), then enable
its timers. This is the turnkey Debian-native way and also schedules a light balance and defrag.

Option C - roll your own systemd timer if you want exact control. Create
`/etc/systemd/system/btrfs-scrub.service`:

```ini
[Unit]
Description=monthly btrfs scrub of /

[Service]
Type=oneshot
ExecStart=/usr/bin/btrfs scrub start -B /
```

and `/etc/systemd/system/btrfs-scrub.timer`:

```ini
[Unit]
Description=run btrfs scrub monthly

[Timer]
OnCalendar=monthly
Persistent=true
RandomizedDelaySec=1h

[Install]
WantedBy=timers.target
```

then `systemctl enable --now btrfs-scrub.timer`. (`scrub start -B` runs in the foreground so the
oneshot service waits for completion and its exit status reflects errors.)

Recommended cadence for this single-NVMe box:

- **Scrub: monthly.** This is the high-value job - it surfaces corruption you cannot otherwise see.
- **Check `btrfs filesystem usage /` regularly** (e.g. monthly, or whenever the pool feels full);
  never trust `df`.
- **Balance with `-dusage` only as needed**, when usage shows allocated >> used or you hit ENOSPC.
  Not on a fixed aggressive schedule.
- **External backups always** (PBS/`vzdump` for guests; optional `btrfs send`/`receive` to an
  external disk for whole-fs replication). Snapshots on the same disk are not backups.
- **Compression: `compress=zstd`** at install or in fstab; verify with `compsize`.
- **Per-VM disk cache: not `none`** (use `writeback`/default) to avoid O_DIRECT checksum errors.

Citations: [Scrub - BTRFS documentation](https://btrfs.readthedocs.io/en/latest/Scrub.html) ,
[BTRFS](https://pve.proxmox.com/wiki/BTRFS)

---

## 14. Example end-to-end `storage.cfg` (single-node BTRFS root)

Default after a BTRFS-root install (what you actually get):

```text
dir: local
 path /var/lib/vz
 content iso,vztmpl,backup
 disable

btrfs: local-btrfs
 path /var/lib/pve/local-btrfs
 content iso,vztmpl,backup,images,rootdir
```

If you add an external USB/eSATA btrfs disk as a backup/replication target (mounted via `/etc/fstab`
at `/mnt/backup`):

```text
btrfs: backup-btrfs
 path /mnt/backup/pve
 content backup,images,rootdir
 is_mountpoint /mnt/backup
```

---

## Sources

- Proxmox VE Storage chapter (pvesm), incl. BTRFS backend & capability table:
  [Proxmox VE Storage](https://pve.proxmox.com/pve-docs/chapter-pvesm.html)
- pvesm(1) manpage (BTRFS backend, O_DIRECT/cache warning, raw-in-subvolume):
  [pvesm(1)](https://pve.proxmox.com/pve-docs/pvesm.1.html)
- PVE BTRFS wiki page (install, subvolumes, snapshots, compression, default storage.cfg):
  [BTRFS](https://pve.proxmox.com/wiki/BTRFS)
- PVE local-btrfs admin doc (default storages, mkfs, fstab, subvol/snapshot commands):
  [pve-docs/local-btrfs.adoc at master · proxmox/pve-docs](https://github.com/proxmox/pve-docs/blob/master/local-btrfs.adoc)
- PVE installation doc (installer `compress`/`hdsize` options):
  [pve-docs/pve-installation.adoc at master · proxmox/pve-docs](https://github.com/proxmox/pve-docs/blob/master/pve-installation.adoc)
- PVE Roadmap / 9.0 & 9.1 release notes (no btrfs-specific changes; volume-chain TP excludes btrfs):
  [Roadmap](https://pve.proxmox.com/wiki/Roadmap)
- upstream btrfs docs - Scrub:
  [Scrub - BTRFS documentation](https://btrfs.readthedocs.io/en/latest/Scrub.html)
- upstream btrfs docs - Compression:
  [Compression - BTRFS documentation](https://btrfs.readthedocs.io/en/latest/Compression.html)
- upstream btrfs docs - Balance:
  [Balance - BTRFS documentation](https://btrfs.readthedocs.io/en/latest/Balance.html)
- upstream btrfs docs - filesystem usage/df:
  [btrfs-filesystem(8)](https://btrfs.readthedocs.io/en/latest/btrfs-filesystem.html)
- upstream btrfs docs - Qgroups (perf caveat, squotas):
  [Quota groups - BTRFS documentation](https://btrfs.readthedocs.io/en/latest/Qgroups.html)
- upstream btrfs docs - send/receive:
  [btrfs-send(8)](https://btrfs.readthedocs.io/en/latest/btrfs-send.html)
- compsize tool (compression ratio reporting):
  [GitHub - kilobyte/compsize: btrfs: find compression type/ratio on a file or set of files](https://github.com/kilobyte/compsize)
