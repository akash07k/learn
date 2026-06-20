# Proxmox VE Storage Management on a Single Non-RAID Node

Audience: blind screen-reader user, shell-only, single PVE node on a personal PC, NO RAID. Single
disk or simple independent disks. ZFS single-vdev pools allowed but explained with their
no-redundancy caveat. Target: PVE 8.x (Debian 12); notes on 9.x where relevant.

All instructions are shell commands or named config-file edits. No GUI.

---

## 1. The PVE storage model (mental model)

Proxmox separates the **storage backend** (where bytes physically live) from the **guest volumes**
(virtual disks for VMs and rootfs for containers). You define each backend once in a single
cluster-wide config file, then guests reference a backend by its **storage ID** plus a volume name,
e.g. `local-lvm:vm-100-disk-0`.

Two physical storage levels:

- **File-level** (dir, nfs, cifs, btrfs, zfs-as-dir): stores guest disks as image _files_ (raw,
  qcow2, vmdk) inside a directory tree. Also holds ISOs, container templates, backups, snippets.
- **Block-level** (lvm, lvmthin, zfspool, iscsi, rbd): hands each guest a raw block device (an LV or
  a zvol). Faster, less overhead, but cannot directly hold ISOs/backups/templates (no filesystem to
  drop files into).

Key consequence for a single-PC user: your install gives you exactly two storages out of the box
(`local` = file-level dir, `local-lvm` = block-level lvmthin), and that split (files vs guest disks)
is the thing to understand first.

Sources: [Proxmox VE Storage](https://pve.proxmox.com/pve-docs/chapter-pvesm.html)

---

## 2. The config file: /etc/pve/storage.cfg

There is ONE storage config for the whole node (it lives in the pmxcfs cluster filesystem
`/etc/pve`, so it is automatically consistent; even on a single node it sits there). Edit it
directly or, preferably, use the `pvesm` CLI which validates.

Format: stanzas, one per storage. First line is `<type>: <storage-id>`, followed by indented option
lines.

Example of a full single-node `/etc/pve/storage.cfg` after install plus a couple of hand-added
storages:

```text
dir: local
	path /var/lib/vz
	content iso,vztmpl,backup

lvmthin: local-lvm
	thinpool data
	vgname pve
	content rootdir,images

dir: backup-disk
	path /mnt/backup
	content backup,iso,vztmpl
	is_mountpoint 1

zfspool: tank
	pool tank
	content images,rootdir
	sparse 1
```

### Common stanza options

- `content <list>` - comma list of allowed content types (see section 3).
- `path <dir>` - mount/base path (dir, and the dir part of nfs/cifs).
- `nodes <list>` - restrict storage to named nodes (irrelevant on one node; leave unset = available
  everywhere).
- `disable` - set to make PVE ignore the storage without deleting the stanza.
- `shared` - declares the storage as shared cluster storage. **Leave this off on a single local
  node**; setting it on local disk lies to PVE.
- `is_mountpoint 1` - tells PVE "this path is an externally mounted disk; treat the storage as
  offline if nothing is mounted there." Use this for any extra disk you mount via fstab so PVE never
  writes into the bare mountpoint when the disk is missing.
- `preallocation <off|metadata|falloc|full>` - for raw/qcow2 (default metadata).
- `format <raw|qcow2|vmdk>` - default image format for file storages.
- `content-dirs` - override default subdirectory names for a dir storage.
- `prune-backups`, `max-protected-backups` - backup retention (see backup topic).

Sources: [Proxmox VE Storage](https://pve.proxmox.com/pve-docs/chapter-pvesm.html)

---

## 3. Content types

Each storage advertises which content types it may hold. The six that matter:

- `images` - VM disk images (e.g. `vm-100-disk-0`). Block or file storage.
- `rootdir` - container root filesystems (e.g. `subvol-101-disk-0` or a raw image). Block or file
  storage.
- `vztmpl` - LXC container template tarballs (file storage only).
- `iso` - ISO installer images for VMs (file storage only).
- `backup` - vzdump backup archives `vzdump-*.{vma,tar}.{zst,gz,lzo}` (file only).
- `snippets` - hook scripts, cloud-init custom configs (file only).

Plus `import` (for ESXi/OVA import staging) in recent versions.

Rule of thumb: block storages (lvmthin, zfspool, lvm) can ONLY carry `images` and `rootdir`.
Everything else (iso, vztmpl, backup, snippets) needs a file-level storage. That is why `local`
(dir) keeps your ISOs/templates/backups and `local-lvm` keeps the actual VM/CT disks.

Set content types from the shell:

```bash
pvesm set local --content iso,vztmpl,backup,snippets
pvesm set local-lvm --content rootdir,images
```

Sources: [Proxmox VE Storage](https://pve.proxmox.com/pve-docs/chapter-pvesm.html)

---

## 4. The `pvesm` CLI (your primary storage tool)

`pvesm` = Proxmox VE Storage Manager. Core subcommands:

```bash
pvesm status # overview: every storage, type, enabled, total/used/avail %
pvesm status --content images # filter to storages allowing a content type

pvesm list <STORAGE_ID> # list volumes on a storage
pvesm list local-lvm --vmid 100 # only volumes owned by VM 100

pvesm add <TYPE> <ID> <options> # create a storage (writes storage.cfg)
pvesm set <ID> <options> # modify an existing storage
pvesm remove <ID> # delete the storage.cfg stanza (does NOT erase data)

pvesm alloc <ID> <VMID> <name> <size> [--format raw|qcow2]
 # manually create a guest volume
pvesm alloc local-lvm 100 '' 32G # '' = auto-name (vm-100-disk-N)
pvesm free <volume-id> # delete a volume, e.g. pvesm free local-lvm:vm-100-disk-0

pvesm scan <type> ... # discover backends to import (see below)
pvesm path <volume-id> # print the real filesystem/device path of a volume
pvesm extractconfig <volume> # pull guest config out of a backup volume
```

### `pvesm scan` variants (discovery before `add`)

```bash
pvesm scan lvm # list existing volume groups
pvesm scan lvmthin <VG> # list thin pools in a VG, e.g. pvesm scan lvmthin pve
pvesm scan zfs # list importable ZFS pools
pvesm scan nfs <server> # list NFS exports on a server
pvesm scan cifs <server> # list CIFS/SMB shares
```

`add` examples:

```bash
pvesm add dir mydir --path /mnt/data --content images,iso,backup
pvesm add lvm myvg --vgname vmdata --content images,rootdir
pvesm add lvmthin mythin --vgname vmdata --thinpool thinpool --content images,rootdir
pvesm add zfspool tank --pool tank --content images,rootdir --sparse 1
pvesm add nfs nas --server 192.168.1.10 --export /export/pve --content backup,iso
```

Important: `pvesm remove <ID>` only removes the _config entry_. The underlying VG, ZFS pool, or
directory contents stay on disk. To reclaim space you must also destroy the LVs/pool/files manually.

Sources: [Proxmox VE Storage](https://pve.proxmox.com/pve-docs/chapter-pvesm.html) ,
[Proxmox VE Administration Guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.html)

---

## 5. The two install-time storages: `local` and `local-lvm`

A standard ext4/LVM Proxmox install carves the boot disk into an LVM volume group named `pve` with
three logical volumes: `root` (the PVE OS, mounted at `/`), `swap`, and `data` (an LVM-thin pool).

- **`local`** (type `dir`, path `/var/lib/vz`) - a directory ON the root LV. Default content
  `iso,vztmpl,backup`. This is where ISOs, container templates, and backups go.
- **`local-lvm`** (type `lvmthin`, vgname `pve`, thinpool `data`) - the thin pool. Default content
  `images,rootdir`. This is where VM disks and container rootfs go.

Inspect them:

```bash
pvesm status # see both, with sizes
cat /etc/pve/storage.cfg # see their stanzas
vgs # the 'pve' volume group
lvs # root, swap, data, plus any vm-*-disk-* thin LVs
lvs -a -o +seg_monitor # include hidden thin metadata volumes
df -h /var/lib/vz # how full 'local' (the root LV) is
```

Modify them like any other storage, e.g. to also allow snippets on `local`:

```bash
pvesm set local --content iso,vztmpl,backup,snippets
```

If you do NOT want the OS disk split between `local` and `local-lvm` (a common single-disk wish -
"give me one big pool"), that is decided at install time via the installer's
`hdsize`/`maxroot`/`maxvz` advanced options. Post-install you can delete the `data` thin pool and
grow `root` to reclaim it (advanced, destroys `local-lvm`):

```bash
lvremove pve/data # destroys local-lvm (back up guests first!)
lvextend -l +100%FREE pve/root # grow root LV into freed space
resize2fs /dev/pve/root # grow the ext4 filesystem
pvesm remove local-lvm # drop the now-empty storage entry
```

Sources: [Host System Administration](https://pve.proxmox.com/pve-docs/chapter-sysadmin.html) ,
[Proxmox VE Storage](https://pve.proxmox.com/pve-docs/chapter-pvesm.html)

---

## 6. LVM and LVM-thin from the shell

### Plain LVM (thick)

Use case: a second whole disk you want to dedicate to VM disks, no thin features.

```bash
wipefs -a /dev/sdb # clear old signatures (DESTROYS data on sdb)
sgdisk -N 1 /dev/sdb # one GPT partition spanning the disk
pvcreate /dev/sdb1 # mark it an LVM physical volume
vgcreate vmdata /dev/sdb1 # create volume group 'vmdata'
pvesm add lvm myvg --vgname vmdata --content images,rootdir
```

Plain LVM gives each guest a raw LV. It is robust but: NO thin provisioning, and snapshots are
limited (historically none for guest disks; PVE 9 adds volume-chain snapshots on LVM - see section
8).

### LVM-thin (the snapshot-capable one)

Thin provisioning means volumes only consume space as data is written, and you get real, fast
copy-on-write snapshots - which is why PVE uses lvmthin for `local-lvm`.

Create a thin pool on a fresh disk:

```bash
wipefs -a /dev/sdb
sgdisk -N 1 /dev/sdb
pvcreate /dev/sdb1
vgcreate vmdata /dev/sdb1
lvcreate -L 80G -T -n thinpool vmdata # -T = thin pool, named 'thinpool'
# (alternative two-step form:)
# lvcreate -L 80G -n thinpool vmdata
# lvconvert --type thin-pool vmdata/thinpool
pvesm add lvmthin mythin --vgname vmdata --thinpool thinpool --content images,rootdir
```

Inspect / verify thin pools:

```bash
pvesm scan lvmthin vmdata # confirm PVE sees the pool
lvs -o +data_percent,metadata_percent # watch pool fullness (CRITICAL - see gotcha)
```

GOTCHA - **never let a thin pool fill to 100%.** Because it overcommits, writes fail and guests can
corrupt when the pool (data OR metadata) hits 100%. Monitor `data_percent` and `metadata_percent`.
Keep headroom. Metadata exhaustion is separate from data exhaustion and just as fatal.

### Resizing LVM

```bash
# Grow a guest VM disk (preferred - does LV + notifies QEMU):
qm disk resize 100 scsi0 +10G

# Grow the thin pool itself if the VG has free extents:
lvextend -L +50G vmdata/thinpool

# Grow a plain LV and its filesystem (for a dir-on-LVM storage):
lvextend -L +20G /dev/vmdata/mylv
resize2fs /dev/vmdata/mylv
```

Sources: [Proxmox VE Storage](https://pve.proxmox.com/pve-docs/chapter-pvesm.html) ,
[pve-docs/local-lvm.adoc at master · proxmox/pve-docs](https://github.com/proxmox/pve-docs/blob/master/local-lvm.adoc)
,
[pve-docs/pve-storage-lvmthin.adoc at master · proxmox/pve-docs](https://github.com/proxmox/pve-docs/blob/master/pve-storage-lvmthin.adoc)

---

## 7. ZFS on a single disk

ZFS is allowed here as a **single-vdev pool** (one disk = one vdev). You get checksumming,
compression, snapshots, clones, and `zfs send`/`receive`. You do NOT get redundancy: a single-disk
pool cannot self-heal - if the one disk dies or a block goes bad with no second copy, that data is
lost. ZFS still _detects_ the corruption (that is its value even on one disk), but cannot repair it.
Treat a single-disk ZFS pool as needing real backups, not as protection.

### Create a single-disk pool

```bash
ls -l /dev/disk/by-id/ # ALWAYS use stable by-id names, not /dev/sdb
zpool create -f -o ashift=12 tank /dev/disk/by-id/ata-...-XXXX
```

- `ashift=12` = 4K sectors; correct for virtually all modern SSD/HDD. Set it at creation - it cannot
  be changed later.
- Use `by-id` so the pool still imports if the kernel reshuffles `sdX` letters.

### Datasets, compression, properties

```bash
zfs create tank/vmstore # a dataset (for the storage)
zfs set compression=lz4 tank # enable lz4 (cheap, almost always a win)
# (zstd is also available: zfs set compression=zstd tank)
zfs set atime=off tank # small perf win, less write churn
zfs get all tank | head # inspect properties
zfs list # datasets + space
zpool status # pool/vdev health (run periodically)
zpool list # capacity/fragmentation
```

### Add the pool as PVE storage

```bash
pvesm add zfspool tank --pool tank --content images,rootdir --sparse 1
```

`sparse 1` makes zvols thin-provisioned. With `zfspool`, VM disks become **zvols**
(`tank/vm-100-disk-0`) and container rootfs become **datasets** (`tank/subvol-101-disk-0`).

### Snapshots

```bash
# PVE-managed guest snapshot (preferred - captures disk + config):
qm snapshot 100 before-update
qm listsnapshot 100
qm rollback 100 before-update

# Native ZFS snapshot of a dataset (manual):
zfs snapshot tank/vmstore@2026-06-10
zfs list -t snapshot
zfs rollback tank/vmstore@2026-06-10
```

### ARC memory tuning (important on a PC with limited RAM)

ZFS's ARC read cache will, by default, try to grow large. On PVE 8.1+ new installs cap ARC at 10% of
RAM (max 16 GiB), written to `/etc/modprobe.d/zfs.conf`. On older installs or to be safe on a
low-RAM PC, set an explicit cap so ARC does not starve your VMs.

Edit `/etc/modprobe.d/zfs.conf` (create it if absent), values in BYTES:

```text
# Example: cap ARC between 2 GiB and 8 GiB
options zfs zfs_arc_min=2147483648
options zfs zfs_arc_max=8589934592
```

Apply (rebuild initramfs, then reboot):

```bash
update-initramfs -u -k all
reboot
```

Temporary change for the running session (no reboot, resets on boot):

```bash
echo "$((4 * 1024*1024*1024))" > /sys/module/zfs/parameters/zfs_arc_max
```

Check current ARC usage:

```bash
arcstat 1 # live ARC stats
cat /proc/spl/kstat/zfs/arcstats | grep -E '^(size|c_max|c_min)'
```

Rule of thumb for a small box: pick how much RAM you need for VMs + OS, give ZFS the rest, cap
`zfs_arc_max` to that, set `zfs_arc_min` to ~1/3 of max so ARC can shrink under VM pressure but not
collapse entirely.

When ZFS helps even without RAID: end-to-end checksums (silent-corruption detection), transparent
compression (often 1.3-2x effective capacity for free), instant snapshots/clones, and
`zfs send | zfs receive` for efficient backups to an external/USB disk. Costs: RAM hunger (ARC) and
more CPU than ext4/LVM.

Sources: [Host System Administration](https://pve.proxmox.com/pve-docs/chapter-sysadmin.html) ,
[ARC and L2ARC Sizing on Proxmox](https://klarasystems.com/articles/arc-and-l2arc-sizing-for-proxmox/)
, [Proxmox Support Forum](https://forum.proxmox.com/) (ARC sizing threads)

---

## 8. Capability matrix (which storage does what)

Level = file or block. "Shared" matters only for clusters - on this single node treat every local
backend as not-shared (do NOT set `shared 1` on local disk).

| Storage | Level | Snapshots           | Thin prov.   | Holds VM imgs | Holds CT rootfs | Holds iso/tmpl/backup |
| ------- | ----- | ------------------- | ------------ | ------------- | --------------- | --------------------- |
| dir     | file  | yes (qcow2 only)    | qcow2 only   | yes           | yes             | yes                   |
| lvm     | block | no\* (yes in PVE 9) | no           | yes           | yes             | no                    |
| lvmthin | block | yes (CoW)           | yes          | yes           | yes             | no                    |
| zfspool | both  | yes (native)        | yes (sparse) | yes           | yes             | no                    |
| btrfs   | file  | yes (native)        | yes          | yes           | yes             | yes                   |
| nfs     | file  | yes (qcow2 only)    | qcow2 only   | yes           | yes             | yes                   |
| cifs    | file  | yes (qcow2 only)    | qcow2 only   | yes           | yes             | yes                   |

\* Plain LVM had no guest-disk snapshots historically; PVE 9 adds volume-chain snapshots on LVM. On
PVE 8.x, if you want snapshots on block storage, use lvmthin or zfspool.

Image formats by storage:

- dir / nfs / cifs: raw, qcow2, vmdk (snapshots require qcow2).
- lvm / lvmthin: raw only (snapshots come from the LVM layer, not the format).
- zfspool: raw (as zvol) for VMs, subvol (dataset) for containers.
- btrfs: raw, and subvol for containers.

Volume naming:

- VM disks: `vm-<VMID>-disk-<N>` (or `.qcow2`/`.raw` on file storage).
- Container rootfs: `subvol-<VMID>-disk-<N>` (zfs/btrfs) or a raw image file.
- Clonable template base: `base-<VMID>-disk-<N>`.

Practical pick for THIS setup (single PC, no RAID):

- Simplest / lowest RAM: keep the default ext4+**lvmthin** (`local` + `local-lvm`). Snapshots work,
  low overhead, no tuning. Recommended default.
- Want checksums + compression + send/recv backups, have spare RAM: **ZFS single-disk** pool. Cap
  ARC. Remember: no redundancy, still need backups.
- Extra plain disk just for backups/ISOs: **dir** storage (section 9).

Sources: [Proxmox VE Storage](https://pve.proxmox.com/pve-docs/chapter-pvesm.html) ,
[pvesm(1)](https://pve.proxmox.com/pve-docs/pvesm.1.html)

---

## 9. Directory storage on an extra disk (format + fstab + add)

Goal: take a second disk, make a filesystem, mount it persistently, and register it as a `dir`
storage (e.g. for backups, ISOs, templates).

```bash
# 1. Identify the disk (confirm it is the right empty one!)
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,MODEL
ls -l /dev/disk/by-id/

# 2. Wipe and partition (DESTROYS everything on /dev/sdb)
wipefs -a /dev/sdb
sgdisk -N 1 /dev/sdb # single GPT partition; or use parted

# 3. Make a filesystem
mkfs.ext4 -L pvedata /dev/sdb1

# 4. Get its UUID (mount by UUID, never by /dev/sdX which can change)
blkid /dev/sdb1

# 5. Create the mountpoint and add to /etc/fstab
mkdir -p /mnt/pvedata
# append a line to /etc/fstab, e.g.:
# UUID=xxxx-xxxx /mnt/pvedata ext4 defaults,nofail 0 2
# 'nofail' = node still boots if the disk is absent.
mount -a # mount now; also validates the fstab line
findmnt /mnt/pvedata # confirm it mounted

# 6. Register as PVE storage. is_mountpoint 1 stops PVE writing into the bare
# mountpoint when the disk is missing.
pvesm add dir pvedata --path /mnt/pvedata --content backup,iso,vztmpl,images \
 --is_mountpoint 1
```

PVE auto-creates the subdirectory layout under the path:

- `images/<VMID>/` - VM disk image files
- `template/iso/` - ISO images
- `template/cache/` - container template tarballs
- `dump/` - vzdump backups
- `snippets/` - snippets
- `import/` - import staging

Sources: [Proxmox VE Storage](https://pve.proxmox.com/pve-docs/chapter-pvesm.html)

---

## 10. Disk identification and prep (shell toolbox)

```bash
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,MODEL,SERIAL # tree of disks/parts
ls -l /dev/disk/by-id/ # stable per-disk names (USE THESE)
blkid # UUIDs + filesystem types of partitions
fdisk -l /dev/sdb # partition table dump
parted /dev/sdb print # GPT-aware table view
smartctl -a /dev/sdb # SMART health (from smartmontools)
```

Preparing / wiping a disk (all DESTRUCTIVE - triple-check the device):

```bash
wipefs -a /dev/sdb # remove all filesystem/partition signatures
sgdisk --zap-all /dev/sdb # nuke GPT + MBR structures entirely
sgdisk -N 1 /dev/sdb # create one partition spanning the whole disk
parted -s /dev/sdb mklabel gpt # alternative: fresh GPT label
```

PVE also exposes disk info via API/CLI:

```bash
pvesm status # storage view
lsblk; cat /proc/mounts # what is mounted where
```

GOTCHA: device letters `/dev/sda`, `/dev/sdb` are NOT stable across reboots or when USB disks are
plugged/unplugged. Always identify disks by `/dev/disk/by-id/` and mount filesystems by `UUID=`.
This is the single most common cause of a home node failing to boot or a ZFS pool failing to import.

Sources: [Host System Administration](https://pve.proxmox.com/pve-docs/chapter-sysadmin.html) ,
[pve-docs/local-lvm.adoc at master · proxmox/pve-docs](https://github.com/proxmox/pve-docs/blob/master/local-lvm.adoc)

---

## 11. Resizing guest disks (VM and CT)

```bash
# VM disk - grow only (shrinking is NOT supported):
qm disk resize 100 scsi0 +10G # add 10G to scsi0 of VM 100
# then inside the guest, grow the partition + filesystem
# (e.g. growpart /dev/sda 1 ; resize2fs /dev/sda1)

# Container mountpoint:
pct resize 101 rootfs +5G # grow CT 101 rootfs by 5G
# For containers PVE usually grows the in-guest filesystem automatically.
```

Underlying-storage resize (covered in sections 6 and 7): `lvextend`+`resize2fs` for LVM/dir, or just
grow the zvol via `qm disk resize` for ZFS. Shrinking guest disks is unsupported across the board -
plan sizes up front, or migrate data.

Sources: [qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html) ,
[pct(1)](https://pve.proxmox.com/pve-docs/pct.1.html)

---

## 12. Managing ISO and template storage

ISOs and container templates live on file storages with the right content type (`iso`, `vztmpl`).
Default home is `local` (`/var/lib/vz`), paths `/var/lib/vz/template/iso/` and
`/var/lib/vz/template/cache/`.

```bash
# Download an ISO straight to a storage (recent PVE):
pvesm download-url local iso https://example.com/debian.iso
# Or just copy a file in:
cp debian-12.iso /var/lib/vz/template/iso/

# Container templates (LXC):
pveam update # refresh the template catalog
pveam available # list downloadable templates
pveam available --section system | grep debian
pveam download local debian-12-standard_12.7-1_amd64.tar.zst # downloads to 'local'

# See what is stored:
pvesm list local # ISOs, templates, backups on 'local'
pvesm list local --content iso
```

To keep ISOs/templates off the OS disk, point them at an extra dir storage created in section 9
(give it `iso,vztmpl` content) and download there instead.

Sources: [Proxmox VE Storage](https://pve.proxmox.com/pve-docs/chapter-pvesm.html)

---

## 13. Optional network storage (NFS / CIFS) for backups & ISOs

For a home node, NFS/CIFS to a NAS is the natural place for backups and a shared ISO library (keeps
them off the single local disk, which has no redundancy).

```bash
# Discover exports/shares first:
pvesm scan nfs 192.168.1.10
pvesm scan cifs 192.168.1.10

# NFS:
pvesm add nfs nas-backup --server 192.168.1.10 --export /export/pve \
 --content backup,iso,vztmpl --options vers=4.2

# CIFS/SMB (Windows or Samba share); store credentials safely:
pvesm add cifs nas-backup --server 192.168.1.10 --share backups \
 --username pve --password '<secret>' --content backup,iso,vztmpl
```

PVE stores CIFS credentials in `/etc/pve/priv/storage/<ID>.pw`. Both NFS and CIFS can hold VM images
too, and PVE emulates snapshots/clones via qcow2 on them - but for a single home node, prefer
network storage for **backups, ISOs and templates**, and keep running VM disks on fast local
storage. Use the `is_mountpoint`/`nofail` mindset: if the NAS is down, the storage shows offline
rather than breaking the node.

Sources: [Proxmox VE Storage](https://pve.proxmox.com/pve-docs/chapter-pvesm.html)

---

## 14. Single-disk / no-RAID best practices (summary)

- Default install (ext4 + lvmthin) is the lowest-effort, lowest-RAM choice and gives you snapshots
  via `local-lvm`. Recommended unless you specifically want ZFS features.
- A single disk = single point of failure regardless of filesystem. **Backups are your redundancy.**
  Schedule vzdump to a second disk or NAS (NFS/CIFS).
- If using ZFS single-disk: set `ashift=12`, enable `compression=lz4`, cap `zfs_arc_max` for your
  RAM, identify the disk by `by-id`, and run `zpool status` periodically (and `zpool scrub tank`
  monthly to detect - though not repair - rot).
- Monitor thin-pool fullness (`lvs -o +data_percent,metadata_percent`) - a full thin pool corrupts
  guests.
- Always mount extra disks by `UUID=` with `nofail`, and register the dir storage with
  `is_mountpoint 1`.
- Do NOT set `shared 1` on any local storage.
- Keep `local` (OS disk) lean: push ISOs, templates, and backups to a separate disk or NAS so a full
  root LV does not wedge the node.

---

## 15. Gaps / things to verify on the real box

- Exact PVE 9 LVM snapshot semantics (volume-chain snapshots) - confirm on the installed version
  with `pveversion` before relying on LVM snapshots.
- `pvesm download-url` availability varies by version; `pveam`/`cp` always work.
- btrfs is "technology preview" in PVE - mentioned for completeness but not recommended over
  lvmthin/ZFS for a primary store on a single disk.
- Whether the user's install actually used the ext4+LVM layout vs a ZFS-on-root install
  (`zfspool: local-zfs` with `rpool/data`) changes which default storages exist - check
  `cat /etc/pve/storage.cfg` and `pvesm status` on the node.

```text

```
