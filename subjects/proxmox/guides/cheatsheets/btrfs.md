# Cheatsheet: btrfs (the host root filesystem)

btrfs is THIS node's root filesystem: a single-disk btrfs install, with one `local-btrfs` storage
backing everything (ISOs, templates, backups, VM images, container rootdirs), no `local-lvm`, and no
RAID. Reach for the `btrfs` tool when you want to inspect true disk usage, scrub for integrity, take
a filesystem-level snapshot, or send/receive a subvolume off-box. Every line below is plain text you
run as root over SSH; there is no web GUI step. The mount you operate on is almost always the root,
`/`. This card is btrfs as the root and default storage here; the optional secondary ZFS pool on an
external disk has its own card ([zfs.md](zfs.md)). For the why and worked examples, see
[09 -- Storage](../09-storage.md).

## Inspect

The mount path is `/` on this node. None of these change anything.

- `btrfs filesystem usage /` -- the honest free-space view; accounts for chunk allocation and
  per-profile Data/Metadata used-versus-allocated. Trust this, not `df` (plain `df` misreports free
  space on btrfs).
- `btrfs filesystem df /` -- a terser block-group summary (data, metadata, system, global reserve).
- `btrfs device stats /` -- per-device error counters; any nonzero value means a failing disk,
  investigate it.
- `btrfs subvolume list /` -- every subvolume, including the `var/lib/pve/local-btrfs` storage
  subvolume and one per container rootfs.

## Maintenance

- `btrfs scrub start /` -- read every allocated block and verify it against its checksum; run it on
  a schedule (monthly here). On this single disk it repairs DUP metadata but can only report data
  corruption, not fix it.
- `btrfs scrub status /` -- progress and result of the running or last scrub.
- `btrfs balance start -dusage=10 /` -- the filtered form; rewrites and reclaims
  allocated-but-mostly-empty data chunks. Run only as needed (when `usage` shows allocated much
  greater than used, or on ENOSPC-with-free-space); avoid a full unfiltered `btrfs balance start /`
  on a busy host, it is heavy.
- `btrfs filesystem defrag -r -czstd /path` -- defragment recursively and rewrite with zstd
  compression; this is also how you retro-compress data already on disk (the mount option only
  affects new writes).

btrfs has NO native alert when a scrub finds errors; you must wire the monitoring yourself (see
[15 -- Monitoring, maintenance, and notifications](../15-monitoring-maintenance-and-notifications.md)).
The kernel ships a per-mount scrub timer you can enable:
`systemctl enable --now btrfs-scrub@-.timer` (the `-` is the systemd-escaped root mount `/`).

## Snapshots and replication

These are filesystem-level snapshots on a subvolume path, distinct from the guest-level `qm`/`pct`
snapshots (Proxmox creates these btrfs subvolume snapshots under the hood when a guest disk lives on
btrfs storage).

- `btrfs subvolume snapshot /some/path /a/new/path` -- a writable snapshot, instant and initially
  sharing all blocks.
- `btrfs subvolume snapshot -r /some/path /a/new/path` -- the read-only form; this is the kind
  usable as a `btrfs send` source.
- `btrfs subvolume delete /a/path` -- DESTRUCTIVE: removes a subvolume or snapshot for good.
- `btrfs send /a/readonly-snapshot | btrfs receive /target/path` -- the off-box replication
  primitive; serialize a read-only snapshot and reconstruct it elsewhere. A snapshot on the same
  disk as the original is not a backup (it dies with the disk), so send it off-box.

## Full treatment

This card is a reminder, not a lesson. For the why and worked examples, see:

- [09 -- Storage](../09-storage.md) -- the `local-btrfs` storage, reading real usage when `df` lies,
  the scrub-and-balance routine and cadence, native snapshots and how PVE guest snapshots map to
  btrfs subvolumes, and send/receive.
- [01 -- Unattended install](../01-install-proxmox-unattended.md) -- why the root is btrfs on a
  single disk with no RAID (the technology-preview note and the single-device profile).
- [03 -- Repositories, updates, and the host](../03-repositories-updates-and-the-host.md) -- the
  btrfs-root boot consequence (GRUB, not systemd-boot).

---

Back to the [cheatsheets index](README.md). Browse all the [guides](../README.md).
