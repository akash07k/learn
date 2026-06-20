# PVE 9 Storage Model and the pvesm CLI

Target: latest Proxmox VE 9.x (Debian 13 "trixie"), mid-2026. Reader is a blind, screen-reader,
shell-only operator on a single node: host root on BTRFS, no RAID, external USB disks for extra
storage and backups. Accessibility backbone is the serial console plus `pct enter` and `pvesh`;
everything below is CLI-only.

All facts are stated as true in PVE 9 unless a "Delta from PVE 8" note says otherwise. Citations are
inline and collected at the end.

## The storage model in one paragraph

Proxmox treats storage as a small set of named "storages", each of one backend type, declared in a
single cluster-wide file, `/etc/pve/storage.cfg`. That file lives on the `pmxcfs` (the cluster
filesystem mounted at `/etc/pve`), so it is the same on every node and is the single source of
truth. You never edit guest disk paths directly; you reference volumes by a `STORAGE_ID:volume`
volume identifier (volid) and let the storage layer resolve the real path or block device. The
`pvesm` ("PVE storage manager") command is the CLI front end to this whole model.

## /etc/pve/storage.cfg structure

The file is a series of stanzas. Each stanza begins with `type: STORAGE_ID` on column 0, followed by
tab-indented `option value` lines. Example with several of the options this guide cares about:

```text
dir: local
 path /var/lib/vz
 content iso,vztmpl,backup
 disable

btrfs: local-btrfs
 path /var/lib/pve/local-btrfs
 content iso,vztmpl,backup,images,rootdir

dir: usb-backup
 path /mnt/usb-backup
 content backup
 is_mountpoint 1
 prune-backups keep-daily=7,keep-weekly=4,keep-monthly=6
 nodes pve

zfspool: usb-zfs
 pool tank/vmdata
 content images,rootdir
 sparse
```

### Common options (work across most backends)

- `type` - the backend, given as the stanza prefix (`dir`, `btrfs`, `zfspool`, `lvm`, `lvmthin`,
  `nfs`, `cifs`, `pbs`, etc.). Not a separate line; it is the word before the colon.
- `content` - comma-separated list of allowed content types (see next section). This is the gate
  that decides what a storage may hold.
- `path` - absolute filesystem path; used by file-level backends (`dir`, `btrfs`, and the
  auto-created mount path for `nfs`/`cifs`).
- `is_mountpoint` - "Assume the given path is an externally managed mountpoint and consider the
  storage offline if it is not mounted. Using a boolean (yes/no) value serves as a shortcut to using
  the target path in this field." This is the key safety flag for USB disks: if the disk is not
  mounted, Proxmox marks the storage offline instead of writing into the empty mount directory on
  the root disk. Accepts `1`/`yes` or the literal target path.
- `sparse` - (zfspool) create thin/sparse zvols that only consume space as written.
- `nodes` - restrict the storage to a list of node names. On a single node this is optional but
  harmless (e.g. `nodes pve`).
- `disable` - present (no value) to administratively switch the storage off without deleting its
  config.
- `prune-backups` - retention policy for the `backup` content type:
  `keep-all=<1|0>,keep-last=<N>,keep-hourly=<N>,keep-daily=<N>,keep-weekly=<N>,keep-monthly=<N>,keep-yearly=<N>`.
  Shorter intervals are processed first, `keep-last` first of all.
- `content-dirs` - override the default per-content subdirectory layout for file-level storages,
  e.g. `content-dirs backup=custom/backup/dir`.
- `format` - default image format for new volumes (`raw`, `qcow2`, `subvol`, `vmdk` depending on
  backend).
- `preallocation` - `off | metadata | falloc | full` for new raw/qcow2 images (default `metadata`).
- `shared` - declares the storage holds identical content on all nodes. **Do not set this on a local
  USB disk** (see gotchas).
- `max-protected-backups` - cap on protected backups per guest (`-1` = unlimited).

## Content types and which backends carry them

The content types are:

- `images` - VM disk images (block/zvol/qcow2/raw).
- `rootdir` - container root filesystems (CT volumes / subvols).
- `vztmpl` - container templates (the `.tar.zst` / `.tar.gz` LXC templates).
- `iso` - ISO installation images for VMs.
- `backup` - vzdump backup archives (`.vma`, `.tar`, and PBS chunks).
- `snippets` - hook scripts, cloud-init user-data, custom config snippets.
- `import` - (PVE 8.2+) import source, e.g. OVF/ESXi import staging.

Which backend can hold which content:

- `dir`, `nfs`, `cifs`, `btrfs` - file-level, can hold **all** types:
  `images, rootdir, vztmpl, iso, backup, snippets` (and `import`).
- `zfspool`, `lvm`, `lvmthin` - block/volume-level, hold **only** `images, rootdir`.
- `pbs` (Proxmox Backup Server) - `backup` only.
- `iscsi` - `images` only.

Practical consequence for this single-node setup: ISOs, container templates, and snippets can only
live on a file-level store (your `local-btrfs`, a `dir` on a USB disk, or NFS/CIFS). A `zfspool` or
`lvmthin` cannot hold ISOs or templates.

## The pvesm command surface

`pvesm` is the storage CLI. Full subcommand list:

- `pvesm status` - status of all storages (type, total/used/avail, active flag). Add
  `--content <type>` to filter, `--storage <id>` to narrow.
- `pvesm list <STORAGE_ID>` - list volumes/content on one storage. Filters: `--content <type>`,
  `--vmid <id>`.
- `pvesm add <TYPE> <STORAGE_ID> [OPTIONS]` - create a new storage stanza.
- `pvesm set <STORAGE_ID> [OPTIONS]` - modify options on an existing storage.
- `pvesm remove <STORAGE_ID>` - delete the storage **config only** (does not erase data on disk).
- `pvesm alloc <STORAGE_ID> <VMID> <name> <size>` - allocate a new disk image/volume. `size` like
  `4G`; `name` can be empty string for auto-naming.
- `pvesm free <VOLUME_ID>` - delete a volume. **Destroys data.**
- `pvesm path <VOLUME_ID>` - resolve a volid to its real filesystem path or block device (useful for
  shell inspection of where a guest disk actually lives).
- `pvesm prune-backups <STORAGE_ID> [--prune-backups <spec>] [--vmid <id>] [--dry-run 1]` - apply
  (or preview) a retention policy on backups.
- `pvesm export <VOLUME_ID> <format> <filename> [--snapshot ...] [--with-snapshots 1]` and
  `pvesm import <VOLUME_ID> <format> <filename> ...` - move a volume's data (and optionally its
  snapshot chain) to/from a stream or file. Marked "used internally" (the engine behind storage
  migration) but runnable directly.
- `pvesm extractconfig <volume>` - pull the guest config out of a vzdump archive.
- `pvesm apiinfo` - print storage API version/age.

Scan subcommands (discover what is available before adding it):

- `pvesm scan lvm` - list local LVM volume groups.
- `pvesm scan lvmthin <vgname>` - list thin pools in a volume group.
- `pvesm scan zfs` - list importable/local ZFS pools.
- `pvesm scan btrfs` - scan local btrfs filesystems. (Aliases for several scans also exist:
  `lvmscan`, `lvmthinscan`, `zfsscan`, `nfsscan`, `cifsscan`, `iscsiscan`.)
- `pvesm scan nfs <server>` - list NFS exports on a server.
- `pvesm scan cifs <server> [--username <u>] [--password]` - list CIFS shares.
- `pvesm scan pbs <server> <username> --password <pw>` - list PBS datastores.
- `pvesm scan iscsi <portal>` - list iSCSI targets.

## What a BTRFS install creates by default, and how to inspect it

On a host installed with root on BTRFS, the Proxmox installer creates a single local storage backed
by the root btrfs filesystem, typically:

```text
dir: local
 path /var/lib/vz
 content iso,vztmpl,backup
 disable
 disable

btrfs: local-btrfs
 path /var/lib/pve/local-btrfs
 content iso,vztmpl,backup,images,rootdir
```

In practice the installer presents one `local-btrfs` (type `btrfs`) store that can hold everything,
because btrfs is file-level and supports `images` and `rootdir` as subvolumes. Note there is **no**
`local-lvm`/`lvmthin` store on a BTRFS install (that pair only appears on the default ext4/LVM
install). Delta from PVE 8: btrfs as a first-class storage backend was already present in 8.x as a
technology preview; in PVE 9 it remains the backend used for BTRFS root installs.

Inspect it from the shell:

```bash
pvesm status
pvesm list local-btrfs
cat /etc/pve/storage.cfg
btrfs filesystem show
btrfs subvolume list /
findmnt -t btrfs
```

`pvesm status` confirms it is `active`; `btrfs subvolume list /` shows the per-guest subvolumes that
`rootdir`/`images` content created.

## Adding an external USB disk as storage - three ways

First, identify the disk safely. Never trust `/dev/sdX` (it reorders across reboots and across USB
hotplug). Use stable identifiers:

```bash
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,UUID,MODEL,SERIAL
blkid
ls -l /dev/disk/by-id/
ls -l /dev/disk/by-uuid/
```

Pick the device from `/dev/disk/by-id/` (stable, includes model+serial) for partitioning/formatting,
and the partition **UUID** (from `blkid`) for mounting.

### Way 1: as a Directory store (ext4 or btrfs), mounted by UUID

Format (this erases the disk - confirm the by-id path first):

```bash
# create one partition spanning the disk (optional; you can mkfs the whole disk)
sgdisk -n1:0:0 /dev/disk/by-id/usb-<MODEL>_<SERIAL>
# ext4:
mkfs.ext4 /dev/disk/by-id/usb-<MODEL>_<SERIAL>-part1
# or btrfs:
mkfs.btrfs /dev/disk/by-id/usb-<MODEL>_<SERIAL>-part1

mkdir -p /mnt/usb-backup
blkid /dev/disk/by-id/usb-<MODEL>_<SERIAL>-part1 # note the UUID
```

Mount it persistently. Two supported approaches:

Option A - /etc/fstab by UUID with `nofail`:

```bash
UUID=<the-uuid> /mnt/usb-backup ext4 defaults,nofail,x-systemd.device-timeout=10 0 2
systemctl daemon-reload
mount /mnt/usb-backup
```

`nofail` is essential: without it, an absent USB disk drops boot into an emergency shell.
`x-systemd.device-timeout` caps how long boot waits for the device.

Option B - a systemd `.mount` unit (more explicit, easy to add `nofail`). The unit name must match
the mount path: `/mnt/usb-backup` becomes `mnt-usb\x2dbackup.mount` (systemd-escaped). Minimal unit:

```ini
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

Then `systemctl daemon-reload && systemctl enable --now mnt-usb\x2dbackup.mount`.

Register it as Proxmox storage, with `is_mountpoint 1` so Proxmox refuses to write when the disk is
absent:

```bash
pvesm add dir usb-backup --path /mnt/usb-backup --content backup --is_mountpoint 1 \
 --prune-backups keep-daily=7,keep-weekly=4 --shared 0
```

(For a general-purpose store add more content types, e.g.
`--content backup,iso,vztmpl,images,rootdir`.)

### Way 2: as a btrfs store

If you formatted the USB disk btrfs and mounted it (fstab/systemd as above, with `nofail`), register
the btrfs backend instead of `dir`. btrfs gives you snapshots and clones for guest volumes:

```bash
mkfs.btrfs /dev/disk/by-id/usb-<MODEL>_<SERIAL>-part1
mkdir -p /mnt/usb-btrfs
# fstab: UUID=<uuid> /mnt/usb-btrfs btrfs defaults,nofail 0 0
pvesm add btrfs usb-btrfs --path /mnt/usb-btrfs --content images,rootdir,backup,iso,vztmpl \
 --is_mountpoint 1 --shared 0
```

### Way 3: as a zfspool

ZFS manages its own mounting (no fstab needed), and Proxmox auto-imports the pool. Create the pool
on the stable by-id device, then add the zfspool storage:

```bash
zpool create -o ashift=12 tank /dev/disk/by-id/usb-<MODEL>_<SERIAL>
# optional child dataset for guests:
zfs create tank/vmdata
pvesm add zfspool usb-zfs --pool tank/vmdata --content images,rootdir --sparse 1
```

ZFS pools survive reboots via the zpool cache; for a removable disk you may prefer to leave it as a
manually-imported pool and not rely on auto-import. Inspect with `zpool status`, `zfs list`,
`pvesm scan zfs`.

## PVE 9 storage capability matrix (readable lists)

For each backend: storage level, snapshot support, thin/sparse, shared-capable, and the content
types it can hold.

### dir (Directory)

- Level: file
- Snapshots: qcow2 images only (and, in PVE 9, via volume-chain snapshots - see the LVM-thick note;
  volume-chain snapshots are coming to dir/NFS/CIFS too)
- Thin/sparse: yes (qcow2 grows on demand)
- Shared: no (local path)
- Content: images, rootdir, vztmpl, iso, backup, snippets

### btrfs

- Level: file
- Snapshots: yes (native btrfs subvolume snapshots)
- Thin/sparse: yes
- Shared: no
- Content: images, rootdir, vztmpl, iso, backup, snippets

### zfspool

- Level: file and block (zvols for images, datasets for rootdir)
- Snapshots: yes (native ZFS snapshots)
- Thin/sparse: yes (with `sparse`)
- Shared: no (local pool)
- Content: images, rootdir

### lvm (thick LVM)

- Level: block
- Snapshots: **yes in PVE 9** via qcow2-on-LVM volume-chain snapshots (tech preview; requires
  `snapshot-as-volume-chain 1` and qcow2-format disks). Delta from PVE 8: thick LVM previously had
  effectively no usable Proxmox snapshots.
- Thin/sparse: no (volumes are fully allocated)
- Shared: possible (e.g. LVM on shared iSCSI LUN); not for a local USB disk
- Content: images, rootdir

### lvmthin (LVM-thin)

- Level: block
- Snapshots: yes (native thin snapshots)
- Thin/sparse: yes
- Shared: no
- Content: images, rootdir

### nfs

- Level: file
- Snapshots: qcow2 images only
- Thin/sparse: yes (qcow2)
- Shared: yes
- Content: images, rootdir, vztmpl, iso, backup, snippets

### cifs (SMB)

- Level: file
- Snapshots: qcow2 images only
- Thin/sparse: yes (qcow2)
- Shared: yes
- Content: images, rootdir, vztmpl, iso, backup, snippets

## PVE 9 delta: thick-LVM snapshots (qcow2 volume chains)

This is the headline PVE 9 storage change. Thick LVM and other "dumb" block stores historically
could not snapshot well (native LVM snapshots carry heavy I/O cost and can deadlock when the
snapshot fills). PVE 9 introduces **snapshots as volume chains**: each VM disk and each snapshot is
a qcow2 image placed on a full-sized thick LVM logical volume, with the previous image set as the
qcow2 backing file. Creating a snapshot allocates a new thick LV, lays a new qcow2 on it, points it
at the prior image, and reroutes guest I/O to the new top image.

Enable it per-storage and use qcow2-format disks:

```bash
pvesm add lvm lvmthick --content images --vgname lvm --snapshot-as-volume-chain 1
qm set <VMID> --scsi1 lvmthick:2,format=qcow2
```

Status: technology preview in PVE 9, not for production. The same volume-chain mechanism is expected
to graduate and extend to Directory, NFS, and CIFS storages, giving vendor-agnostic snapshots on any
block-capable storage (including SAN iSCSI/FC). For this guide's single-node USB setup it is mostly
informational - prefer btrfs or zfspool on the USB disk for real snapshot support today.

## ISO and container-template locations

- ISOs live under a file-level storage's `template/iso/` directory; with the default layout that is
  `/var/lib/vz/template/iso/` for `local`, or `<path>/template/iso/` for any `dir`/`btrfs` store
  that has `iso` content.
- Container templates live under `template/cache/`, e.g. `/var/lib/pve/local-btrfs/template/cache/`
  on this btrfs-root target or `/var/lib/vz/template/cache/` on the classic `dir: local` layout
  (content type `vztmpl`).
- Download templates from the CLI with `pveam`: `pveam update`, `pveam available`, then
  `pveam download <storage> <template>` (storage must allow `vztmpl`).
- You can drop an ISO straight into the `template/iso/` directory and it appears in
  `pvesm list <storage> --content iso`.

## Resizing guest disks (grow only)

VM disk (qcow2/raw/zvol/LVM volume):

```bash
qm disk resize <vmid> <disk> <size>
# e.g. add 5 GiB:
qm disk resize 100 scsi0 +5G
# e.g. set absolute size:
qm disk resize 100 virtio0 100G
```

`+` adds to current size; no sign means absolute. "Shrinking disk size is not supported." After
growing, extend the filesystem inside the guest.

Container mountpoint / rootfs:

```bash
pct resize <vmid> <volume> <size>
# e.g.:
pct resize 100 rootfs +5G
pct resize 100 mp0 +10G
```

Same grow-only rule and `+`/absolute semantics; volume is `rootfs` or `mp0`..`mp255`. For
containers, PVE resizes and grows the filesystem in one step for supported filesystems.

## Removable-disk gotchas

- **Always set `is_mountpoint 1`** on a `dir`/`btrfs` store that lives on a removable/external disk.
  Without it, if the disk is not mounted Proxmox writes into the bare mount directory on your root
  (BTRFS) disk, silently filling root and creating a "phantom" copy that vanishes when the disk
  reappears.
- **Always use `nofail`** in fstab (or in the systemd `.mount` `Options=`). Without it, an absent
  USB disk halts boot into an emergency shell - catastrophic for a headless, screen-reader,
  single-node host. Pair with `x-systemd.device-timeout=10` so boot does not hang waiting.
- **Never set `shared 1` (`--shared 1`) on a local USB disk.** `shared` tells Proxmox the content is
  identical on all nodes; on a single node it is wrong and on a cluster it would cause guests to
  assume their disks exist on other nodes, breaking migration and HA logic.
- **If the USB is absent at boot:** with `nofail` + `is_mountpoint 1`, the host boots normally, the
  storage shows as inactive/offline in `pvesm status`, and any guest whose disks live there fails to
  start (expected) rather than corrupting data. Reconnect the disk, `mount /mnt/usb-...` (or
  `systemctl start` the mount unit), and the storage returns to `active`.
- **Identify by `/dev/disk/by-id` and UUID, never `/dev/sdX`.** USB enumeration order is not stable;
  `sdb` today may be `sdc` after a reboot or replug.
- `pvesm remove` only deletes the config stanza; the data on the USB disk stays. To reclaim space
  you must delete files/volumes (`pvesm free`, or remove the backup/iso files) - or wipe the disk.

## Verification / inspection cheat sheet

```bash
pvesm status # all storages, active flag, usage
pvesm status --content backup # only backup-capable stores
pvesm list usb-backup # volumes/backups on the USB store
pvesm path local-btrfs:vm-100-disk-0 # real path/device of a guest disk
cat /etc/pve/storage.cfg # the source of truth
findmnt /mnt/usb-backup # confirm the mount is present
lsblk -o NAME,SIZE,FSTYPE,UUID,MOUNTPOINT,SERIAL
```

## Citations

- Proxmox VE Storage chapter (pvesm):
  [Proxmox VE Storage](https://pve.proxmox.com/pve-docs/chapter-pvesm.html)
- Proxmox VE Administration Guide (storage, content types, options):
  [Proxmox VE Administration Guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.html)
- pvesm(1) man page (subcommands, is_mountpoint, prune-backups):
  [pvesm(1)](https://pve.proxmox.com/pve-docs/pvesm.1.html)
- qm(1) man page (qm disk resize): [qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html)
- pct(1) man page (pct resize): [pct(1)](https://pve.proxmox.com/pve-docs/pct.1.html)
- PVE 9.0 LVM snapshots (volume chains), config flag and walkthrough:
  [PVE 9.0 - Snapshots for LVM - Michael Ablassmeier](https://abbbi.github.io/pve9/)
- Blockbridge: Inside Proxmox VE 9 SAN Snapshot Support (qcow2-on-thick-LVM):
  [Inside Proxmox VE 9 SAN Snapshot Support](https://kb.blockbridge.com/technote/proxmox-qcow-snapshots-on-lvm/index.html)
- Proxmox wiki, Storage and Storage:\_Directory: [Storage](https://pve.proxmox.com/wiki/Storage) ,
  [Storage: Directory](https://pve.proxmox.com/wiki/Storage:_Directory)
- USB/external disk mounting practice (by-id/UUID, nofail, is_mountpoint):
  [How To Add External USB Storage To Proxmox](https://ostechnix.com/add-external-usb-storage-to-proxmox/)
  ,
  [Mounting USB Drive for backups](https://forum.proxmox.com/threads/mounting-usb-drive-for-backups.138029/)
