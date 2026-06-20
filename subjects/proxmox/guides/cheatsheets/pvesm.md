# Cheatsheet: pvesm (storage)

`pvesm` is the Proxmox storage manager: the CLI front end to the whole storage model. Reach for it
whenever you need to see how full your storages are, list the volumes on one, scan the host for
backends, or add, change, and remove a storage definition. The named storages it manages all live in
one file, `/etc/pve/storage.cfg` on pmxcfs; you never hand-edit that file, because `pvesm` writes it
for you. Every line below is plain text you run as root on the Proxmox host over SSH, with no web
GUI anywhere. For the why and the worked builds, see the full guide
[09 -- Storage](../09-storage.md).

`<id>` is the storage id you choose (for example `usb-backup`); a volume is referenced as
`STORAGE_ID:volume`.

## Inspect (read-only)

- `pvesm status` -- every storage with its type, status, total, used, and available, one storage per
  line.
- `pvesm list <storage>` -- the volumes on one storage (for example `pvesm list local-btrfs`).
- `pvesm scan lvm` -- scan the host for LVM volume groups.
- `pvesm scan zfs` -- scan the host for ZFS pools (use after creating a pool to confirm Proxmox sees
  it).
- `cat /etc/pve/storage.cfg` -- the source of truth behind all of the above; read it, do not edit it
  by hand.

## Manage storages (these edit storage.cfg)

`pvesm add`, `set`, and `remove` all rewrite `/etc/pve/storage.cfg` for you. The first argument to
`add` is the backend type; the second is the id you choose.

- `pvesm add dir <id> --path /mnt/usb-backup --content backup --is_mountpoint 1 --prune-backups keep-daily=7,keep-weekly=4`
  -- a directory storage on a mounted disk. `--is_mountpoint 1` is the safety flag: if the disk is
  not mounted, the storage goes offline instead of writing into the bare mount directory on the root
  disk. `--prune-backups keep-daily=7,keep-weekly=4` sets the backup retention schedule for that
  storage.
- `pvesm add btrfs <id> --path /mnt/usb-btrfs --content images,rootdir,backup,iso,vztmpl --is_mountpoint 1`
  -- a btrfs storage on a mounted btrfs disk, with native snapshots.
- `pvesm add zfspool <id> --pool usbpool/guests --content images,rootdir --sparse 1` -- a ZFS pool
  (or a child dataset) as guest storage; `--sparse 1` is thin provisioning. A `zfspool` holds only
  `images` and `rootdir`.
- `pvesm set <id> --content backup,iso,vztmpl,images,rootdir` -- change a property of an existing
  storage (here, widen its content types).
- `pvesm remove <id>` -- delete the storage definition only. This removes the stanza from
  `storage.cfg`; it does NOT delete the data on the disk, which stays until you delete the files or
  wipe the disk.

Never set `--shared 1` on a local USB disk: `shared` declares the content is identical on all nodes,
which is wrong on a single node and breaks migration logic.

## Content (ISOs and templates)

- `pvesm download-iso <storage> <volume-name> --url <url>` -- download an installer ISO straight
  onto an `iso`-capable storage; add `--checksum <hash> --checksum-algorithm sha256` to verify the
  download. This is the form guides 06 and 08 use.

The guide does not use `pvesm alloc` or `pvesm free`, so they are omitted here; VM and container
disks are allocated for you by `qm`/`pct` and by the storage plugin.

## Content types and the btrfs default

A storage carries one or more content types: `images` (VM disks), `rootdir` (container rootfs),
`iso` (installer images), `vztmpl` (container templates), and `backup` (vzdump archives). Which a
backend can hold varies; on a btrfs-root install the default is `local-btrfs` with all types and
there is no `local-lvm`. See [09 -- Storage](../09-storage.md) for the capability lists and the
default `storage.cfg`.

## Full treatment

This card is a reminder, not a lesson. For the why and worked examples, see:

- [09 -- Storage](../09-storage.md) -- the storage model, reading real disk usage (`df` lies), the
  three USB-add methods (`dir`, `btrfs`, `zfspool`), content-type capabilities per backend, and
  grow-only resizing.

---

Back to the [cheatsheets index](README.md). Browse all the [guides](../README.md).
