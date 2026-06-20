# Backup architecture: PBS VM on the node, Raspberry Pi as the independent copy

Status: accepted

Backups use Proxmox Backup Server (incremental + deduplicated, so only changed chunks are written
after the first full backup). The **primary** PBS runs as a VM on the Proxmox node (PBS is
amd64-only and the node is the only amd64 machine), with its datastore on a dedicated external USB
HDD formatted as ZFS (checksums + scrub for backup integrity, and it doubles as the operator's ZFS
hands-on environment per ADR 0001). The **independent off-box copy** lives on the Raspberry Pi 4B (8
GB) - a separate machine and disk, so node death cannot destroy both copies. An optional third leg
is a second external USB HDD rotated off-site, giving a real 3-2-1.

## Pi secondary mechanism

- Preferred: a community arm64 PBS build (e.g. `wofferl/proxmox-backup-arm64`, current for PBS 4.x /
  Debian 13) on the Pi, fed by a scheduled PBS sync-job - a real, directly-restorable second PBS
  with dedup preserved. The unsupported community component is confined to this secondary role (low
  blast radius).
- All-supported alternative: `zfs send` / rsync the datastore to a ZFS-on-USB disk on the Pi
  (official software only; the Pi copy is "cold" - attach it under a PBS to restore from it).

## Considered and rejected

- **vzdump full backups as the primary method**: rejected - no incrementals or dedup, so every run
  rewrites everything (wasteful in space and I/O). Kept only as a brief one-off/ad-hoc tool.
- **PBS on the Raspberry Pi as the primary store**: rejected - no official ARM64 PBS build, and the
  Pi 4B + USB HDD is too slow for the frequently-used hot store (USB IOPS and SHA-256 chunk hashing
  are the bottlenecks).
- **PBS on the Windows control station**: rejected - PBS does not run natively on Windows; running
  it in a VM/WSL there ties backups to the operator's daily, not-always-on, and sole
  screen-reader-accessible machine.

## Consequences

- The PBS web GUI is inaccessible, so PBS is driven entirely via `proxmox-backup-manager` /
  `proxmox-backup-client` and `pvesh`.
- The first backup of each guest is full; every backup after that is incremental.
- The PBS VM itself is backed up with a one-off vzdump (or simply rebuilt from config).
