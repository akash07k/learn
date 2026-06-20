# Host root filesystem: btrfs (single-disk), with ZFS taught on external media

Status: accepted

The Proxmox host is a single-disk machine (one 1 TB NVMe, no RAID, 24 GB RAM). We install the host
root on **btrfs** to get data checksums (bit-rot detection on a single non-redundant SSD) and
transparent zstd compression, while staying far simpler and lighter than ZFS. The guide corpus
teaches **both btrfs and ZFS** in depth; ZFS is exercised hands-on on an external USB disk rather
than on the host root, so the operator gains full ZFS competence without committing live services to
it.

## Considered options

- **ext4 + LVM-thin** (the Proxmox installer default): rejected. Fully supported and simplest, but
  no checksums and no compression - unattractive on a single disk with no redundancy. Demoted to a
  brief mention in the storage guide.
- **btrfs root** (chosen): checksums, compression, cheap snapshots, simpler than ZFS. Trade-off:
  Proxmox classifies btrfs as a "technology preview", and it needs the occasional `btrfs scrub`.
  Accepted knowingly.
- **ZFS root**: rejected for the host to avoid ARC RAM pressure and ZFS's larger concept surface on
  the operator's daily machine. Still taught fully (on external media) and documented as the path to
  take if the host is rebuilt or a second disk is added.

## Consequences

- There is no `local-lvm` storage; guest disks live as btrfs subvolumes. Guides will flag this where
  common tutorials assume `ext4 + local-lvm`.
- The answer.toml automated install sets `disk-setup.filesystem = "btrfs"`.
