# PVE 9 Backup and Restore with vzdump (to an external USB disk)

Target: latest Proxmox VE 9.x (Debian 13 "trixie"), mid-2026. Reader is a blind, screen-reader,
shell-only operator on a single node: host root on BTRFS, no RAID, a single internal NVMe, so
backups go to an EXTERNAL USB DISK (and/or a Proxmox Backup Server). Accessibility backbone is the
serial console plus `pct enter` and `pvesh`; everything below is CLI-only.

All facts are stated as true in PVE 9 unless a "Delta from PVE 8" note says otherwise. Citations are
inline and collected at the end.

## The one-paragraph model

`vzdump` is the single tool that backs up both VMs (QEMU) and containers (LXC). A backup is one
self-contained archive file per guest per run, written to a storage that has the `backup` content
type (or to a raw directory via `--dumpdir`). You can run `vzdump` by hand for ad-hoc backups, but
the normal pattern is a _backup job_ defined in `/etc/pve/jobs.cfg` and fired on a schedule by the
`pvescheduler` daemon. Restore is a separate per-type command: `qmrestore` for VMs, `pct restore`
for containers. There is no GUI dependency anywhere in this; the whole lifecycle is CLI- and
config-file-driven, which suits a screen-reader, shell-only operator.

## vzdump: the core command

Usage: `vzdump <vmid> [OPTIONS]`, or with `--all` / `--pool` / `--exclude` for bulk runs. Minimal
example, one guest, compressed, to a named storage:

```bash
vzdump 101 --storage usbbackup --mode snapshot --compress zstd
```

The options that matter for this guide (all confirmed in the PVE 9 `vzdump(1)` manpage and admin
guide):

- `--mode <snapshot | stop | suspend>` (default `snapshot`) - see modes below.
- `--compress <0 | 1 | gzip | lzo | zstd>` (default `0` = none) - use `zstd`.
- `--zstd <N>` (default `1`) - number of zstd threads; `0` means "all cores".
- `--storage <id>` - write the archive into a configured storage (preferred).
- `--dumpdir <path>` - write straight into a directory path instead of a storage. Mutually exclusive
  with `--storage`; bypasses the storage layer entirely.
- `--notes-template <string>` - generate a `.notes` sidecar; supports `{{cluster}}`,
  `{{guestname}}`, `{{node}}`, `{{vmid}}` (double curly braces).
- `--exclude-path <glob>` - repeatable; skip files/dirs in CONTAINER backups.
- `--protected <bool>` - mark the resulting backup protected (never auto-pruned).
- `--fleecing [enabled=]<1|0>[,storage=<id>]` - backup fleecing, VM only (below).
- `--all` / `--exclude <list>` / `--pool <name>` - bulk selection (below).
- `--prune-backups <retention>` - per-run retention override (below).
- `--remove <0|1>` (default `1`) - after a successful run, prune per the policy.
- `--bwlimit <KiB/s>` - throttle I/O (useful so a USB backup doesn't starve the box).
- `--notification-mode <auto | legacy-sendmail | notification-system>` - see below.
- `--stdexcludes <0|1>` (default `1`) - keep the built-in temp/log excludes for CTs.

Defaults can be set host-wide in `/etc/vzdump.conf` (colon-separated `key: value`, `#` comments), so
you don't repeat them on every job. Example:

```text
# /etc/vzdump.conf
mode: snapshot
compress: zstd
storage: usbbackup
prune-backups: keep-last=3,keep-daily=7,keep-weekly=4,keep-monthly=6
notification-mode: notification-system
```

## Backup modes and what each means on a BTRFS store

The mode controls guest consistency vs. downtime; it is about how the guest's _live_ data is
quiesced, and is largely independent of what filesystem the backup _target_ is (your USB disk). The
relevant nuance for you is the CONTAINER side, because your host root is BTRFS and CT volumes may
live on BTRFS subvolumes.

VMs (QEMU):

- `snapshot` (default) - lowest downtime. A live backup: QEMU copies data blocks while the VM keeps
  running, with a small theoretical inconsistency risk that the live mechanism mitigates. This is
  the mode you want for a home VM.
- `suspend` - kept for compatibility; suspends the VM, then does a snapshot-style backup. Rarely
  needed now.
- `stop` - highest consistency: orderly shutdown, background QEMU process backs up, then the VM
  restarts. Use only when you need a guaranteed-clean image.

Containers (LXC):

- `snapshot` - the container is briefly suspended for consistency, a temporary storage snapshot of
  its volumes is taken, and the snapshot content is archived while the CT runs again. This requires
  the underlying storage to support snapshots. BTRFS, ZFS, and LVM-thin do; a plain `dir` storage
  does NOT. Delta/gotcha: on PVE 9 with a BTRFS-backed CT this works because BTRFS subvolume
  snapshots are available; if a CT's rootfs is on a non-snapshot storage, vzdump silently falls back
  to `suspend` mode for that CT.
- `suspend` - uses rsync: first pass copies live, then the CT is suspended for a short second rsync
  pass of changed files, minimizing downtime. Works anywhere.
- `stop` - stops the CT for the whole backup; maximum consistency, real downtime.

For a single-node home box: `snapshot` for both VMs and CTs is the right default.

## Backup fleecing (the PVE 8.2+/9 feature - recommend it)

Delta from PVE 8: backup fleecing was introduced in PVE 8.2 and is a standard PVE 9 feature. Problem
it solves: in `snapshot` mode, when the guest writes to a block that has not yet been copied to the
backup target, the backup must copy that old block out FIRST (copy-before-write) before the guest
write can proceed. If the backup target is slow - exactly your case, an external USB disk - the
guest write stalls waiting on the slow target, so an I/O-heavy guest can hang or crawl during the
backup window.

Fleecing fixes this by inserting a fast LOCAL cache image (the "fleecing image"). The old block is
copied into the fleecing image (fast, local), the guest write proceeds immediately, and the slow
target is fed from the fleecing image in the background. As blocks finish, the fleecing image is
discarded to keep its size down. Net effect: the slow USB/network target no longer dictates guest
I/O latency.

Enable per run:

```bash
vzdump 101 --fleecing enabled=1,storage=local-btrfs --compress zstd --storage usbbackup
```

Requirements and notes:

- VM only (no effect for containers).
- The fleecing storage should be FAST LOCAL storage with thin-provisioning and discard support:
  LVM-thin, RBD, ZFS (with `sparse 1`), or many file-based storages. On this single NVMe BTRFS host,
  use the active `local-btrfs` storage as the fleecing target; the plain `local` storage is disabled
  on the corpus target.
- Costs temporary local space proportional to churn during the backup; that space is reclaimed
  after.
- Recommendation: turn fleecing ON for VM backups to the USB disk. It is the single biggest win for
  keeping guests responsive while backing up to slow external media.

## Where backups live: the `backup` content type on the USB disk

A storage must declare `content backup` before vzdump will write to it. For your external USB disk,
the practical pattern is a `dir` (or `btrfs`) storage rooted at the USB mountpoint:

```text
# /etc/pve/storage.cfg (stanza for the external USB disk)
dir: usbbackup
 path /mnt/usbbackup
 content backup
 prune-backups keep-last=3,keep-daily=7,keep-weekly=4,keep-monthly=6
 is_mount 1
```

`is_mount 1` is the critical safety flag for removable media: if the USB disk is NOT mounted at
`/mnt/usbbackup`, PVE treats the storage as unavailable and the job fails gracefully instead of
silently writing backups into the host root filesystem (which would fill your NVMe). The host-level
mount in `/etc/fstab` should additionally use `nofail` (and ideally `x-systemd.device-timeout=...`)
so the box still boots if the USB disk is absent. Together: `nofail` keeps the host booting;
`is_mount 1` keeps vzdump from backing up to the wrong place.

File layout under `<storage>/dump/` (the `dump/` subdir is where vzdump puts files):

- `vzdump-qemu-<vmid>-<YYYY_MM_DD>-<HH_MM_SS>.vma.zst` - a VM backup (VMA container format,
  zstd-compressed). Other suffixes: `.vma.gz`, `.vma.lzo`, `.vma` (none).
- `vzdump-lxc-<vmid>-<YYYY_MM_DD>-<HH_MM_SS>.tar.zst` - a container backup (tar, zstd). Other
  suffixes: `.tar.gz` / `.tgz`, `.tar.lzo`, `.tar`.
- `<same basename>.log` - the per-backup task log.
- `<same basename>.notes` - the rendered notes (from `--notes-template`).
- Protected backups also get a `.protected` marker so prune skips them.

(Note: `.vma.zst`/`.tar.zst` are the file-based-storage formats. A Proxmox Backup Server target
stores chunked, deduplicated data instead and is addressed by its own `pbs:` storage - out of scope
for the file naming above but a valid second target.)

## Scheduled backups from the shell: /etc/pve/jobs.cfg

Scheduled jobs are NOT cron. They live in `/etc/pve/jobs.cfg` (on the pmxcfs cluster filesystem) and
are executed by the `pvescheduler` daemon. Each backup job is a `vzdump:` stanza. Field syntax
mirrors the CLI options (note `enabled`, `all`, `schedule`, `notes-template`, `notification-mode`,
`repeat-missed`, `fleecing`).

A complete, realistic single-node stanza (nightly, all guests, to USB, with fleecing and the new
notification system):

```text
vzdump: nightly-usb
	schedule 02:30
	all 1
	enabled 1
	storage usbbackup
	mode snapshot
	compress zstd
  fleecing enabled=1,storage=local-btrfs
	notes-template {{node}}-{{guestname}}-{{vmid}}
	prune-backups keep-last=3,keep-daily=7,keep-weekly=4,keep-monthly=6
	notification-mode notification-system
	repeat-missed 1
	exclude 900,901
```

Field notes:

- Stanza header is `vzdump: <job-id>` (the job-id is auto-generated like `backup-07cdf241-8b56` when
  created via API/GUI, but you may name it yourself when hand-editing).
- `all 1` backs up every guest on the node; pair with `exclude <vmid-list>` to skip some.
  Alternatively use `vmid <list>` for an explicit set, or `pool <name>` to back up exactly the
  guests in a resource pool.
- `node <name>` restricts the job to one node (harmless on a single node; can omit).
- `repeat-missed 1` makes pvescheduler run a job that was missed (e.g. the host was off at 02:30) as
  soon as it next can - valuable for a home box that isn't 24/7.
- You can create/manage jobs without editing the file by hand via the API, e.g.
  `pvesh create /cluster/backup --schedule "02:30" --storage usbbackup --all 1 ...`, but direct
  editing of `/etc/pve/jobs.cfg` is fully supported and is the most screen-reader-friendly path.
  After editing, `pvescheduler` picks it up; no restart needed (you may
  `systemctl reload-or-restart pvescheduler` if impatient).

Run a defined job immediately for testing:

```bash
# list jobs and ids
cat /etc/pve/jobs.cfg
# trigger one job now (uses the job's own settings, incl. job-id notes)
vzdump --all 1 --storage usbbackup --mode snapshot --compress zstd
```

(There is no single "run job X now" subcommand that's universally stable across versions; the
dependable approach is to re-issue an equivalent `vzdump` line, or run the backup from `pvesh`/GUI
"Run now". The scheduled execution itself is what `pvescheduler` owns.)

## Schedule syntax (systemd calendar events) and how to validate it

The `schedule` field uses systemd OnCalendar / calendar-event syntax (a PVE-flavored subset).
Examples that are valid in PVE 9:

- `02:30` - daily at 02:30.
- `*-*-* 02:30:00` - same, fully written out.
- `mon..fri 21:00` - weekdays at 21:00.
- `sat 03:00` - Saturdays at 03:00.
- `*/15` - every 15 minutes.
- `sun *-*-1..7 04:00` - the first Sunday of each month at 04:00 (day-of-month 1..7 AND weekday
  Sunday).
- `mon..fri 8..17,22:0/15` - every 15 min during business hours plus 22:00.

ALWAYS validate before trusting a schedule. systemd ships the validator:

```bash
systemd-analyze calendar "sun *-*-1..7 04:00"
systemd-analyze calendar --iterations 5 "mon..fri 21:00"
```

It prints the normalized form and the next N elapse times, so you can confirm the job will fire when
you expect. This is the accessible, deterministic way to check a schedule without watching a clock.

## Retention / prune

Retention is expressed as `keep-*` knobs, set either on the storage (applies to all backups there),
in the job's `prune-backups`, or per `vzdump` run with `--prune-backups`. The job/run value
overrides the storage value. Knobs:

- `keep-last=<N>` - the N most recent backups, regardless of age.
- `keep-hourly=<N>` - newest backup in each of the last N hours.
- `keep-daily=<N>` - newest in each of the last N days.
- `keep-weekly=<N>` - newest per week (weeks are Monday..Sunday).
- `keep-monthly=<N>` - newest per month.
- `keep-yearly=<N>` - newest per year.
- `keep-all=1` - keep everything (the default if nothing else is set; mutually exclusive with the
  other keep-\* options).

Important semantics: the buckets are independent and do NOT overlap-subtract in an intuitive way -
each `keep-*` selects within its own time window from the backups not already kept by a "finer"
window. Protected backups are exempt from pruning and do not count toward the keep counts.

Pruning happens automatically after a successful job (because `--remove` defaults to `1`). To SEE
what a policy would delete without deleting anything - do this before trusting a new retention
setting:

```bash
pvesm prune-backups usbbackup --dry-run \
 --prune-backups keep-last=3,keep-daily=7,keep-weekly=4,keep-monthly=6
```

`--dry-run` lists each backup as `keep` or `remove`. Drop `--dry-run` to actually prune on demand
(outside the job).

## Restore

Restore is per-guest-type and writes a (possibly new) guest from an archive file. You address the
archive by its storage volid (`usbbackup:backup/vzdump-...`) or by an absolute path.

VMs - `qmrestore <archive> <vmid> [OPTIONS]`:

- `qmrestore usbbackup:backup/vzdump-qemu-101-2026_06_01-02_30_00.vma.zst 201 --storage local-btrfs`
  restores into a NEW VMID 201 (pick an unused id to avoid clobbering the original) and allocates
  disks on the active btrfs storage.
- `--force` - overwrite an existing VM with that id (destructive; use deliberately).
- `--storage <id>` - where to allocate the restored disks (for this target, `local-btrfs` on the
  NVMe-backed btrfs storage).
- `--unique` - assign fresh random MAC(s), so the restored copy doesn't collide on the network with
  the original. Use this when restoring a clone for testing.
- `--start` - start the VM right after a successful restore.
- `--bwlimit <KiB/s>` - throttle restore I/O.
- `--live-restore` - start the VM immediately and restore in the background. PBS ONLY; it does not
  work with `.vma.zst` files on a directory/USB storage. So for your USB-disk workflow, live-restore
  is unavailable - plan for a normal restore.

Containers - `pct restore <vmid> <archive> [OPTIONS]`:

- `pct restore 201 usbbackup:backup/vzdump-lxc-105-2026_06_01-02_30_00.tar.zst --storage local-btrfs`
  restores into NEW CTID 201 on local storage.
- `--force` - overwrite an existing container with that id.
- `--storage <id>` - target storage for the rootfs/volumes.
- `--unique` - assign a unique random MAC.
- `--start` - start the CT after restore.
- `--rootfs <volume>` - override the root volume spec.
- `--ignore-unpack-errors` - continue past extraction errors (last-resort recovery).
- `--password` - set the root password inside the restored CT.

Test-restore tip (accessible, non-destructive): restore to a fresh, unused VMID/CTID on
`local-btrfs` with `--unique`, boot it, confirm it works, then destroy it. This proves the backup is
actually restorable without touching the live guest.

## Notification integration (PVE 9 - replaces --mailto)

Delta from PVE 8: vzdump no longer sends mail directly; it routes through the cluster NOTIFICATION
SYSTEM (targets + matchers, configured in `/etc/pve/notifications.cfg`). The old `--mailto` and
`--mailnotification` parameters are DEPRECATED. The behavior is selected by `--notification-mode`
(or the job's `notification-mode` field):

- `notification-system` - always use the new notification system; `mailto` / `mailnotification` are
  ignored. This is the recommended setting going forward.
- `legacy-sendmail` - old behavior: honor `mailto` / `mailnotification` and send via the local
  `sendmail`, bypassing the notification system.
- `auto` (default) - if a `mailto` address is set, behave like `legacy-sendmail`; if not, use the
  notification system.

How a job notifies on failure: in `notification-system` mode, when a backup job finishes, vzdump
emits a notification event carrying metadata (job id, type `vzdump`, severity - `info` on success,
`error`/`warning` on failure). The notification system's MATCHERS decide which TARGET receives it.
The built-in default matcher routes such events to the default target, which on a fresh install is
the `mail-to-root` target (mail to the root account's configured address). For a failure-only home
setup, add a matcher that fires on `severity error/warning` (or on `type vzdump`) to your chosen
target (e.g. an SMTP target or a Gowebhook/ntfy target), so you only get pinged when a backup
actually fails. Practically: set `notification-mode notification-system` in the job, then configure
one SMTP (or webhook) target and a matcher in `/etc/pve/notifications.cfg`; do NOT rely on
`--mailto` anymore.

## Configuration disaster recovery (back up the host, not just guests)

vzdump backs up GUESTS, not the HOST. If the NVMe dies, restoring guests requires a working PVE host
first, and rebuilding the host by hand is painful. So additionally snapshot the host's critical
config to the USB disk on the same schedule. The high-value paths:

- `/etc/pve` - the entire cluster filesystem: guest configs (`qemu-server/`, `lxc/`), `storage.cfg`,
  `jobs.cfg`, `notifications.cfg`, users, etc. THIS is the crown jewel; with it plus the guest
  backups you can reconstruct everything.
- `/etc/network/interfaces` (+ `/etc/network/interfaces.d/`) - your bridges/VLANs.
- `/etc/hosts`, `/etc/hostname`, `/etc/resolv.conf` - node identity/DNS.
- `/etc/fstab` and any `systemd` mount units - so the USB mount/`is_mount` comes back.
- `/etc/apt/` (sources, including the PVE 9 repo config) and `/etc/ssh/` if you want to preserve
  host keys.

A simple, scriptable nightly config tarball to the USB disk (note `/etc/pve` is a FUSE mount, so
copy from it while pmxcfs is running):

```bash
ts=$(date +%F-%H%M)
tar czf /mnt/usbbackup/pve-config-$ts.tar.gz \
 /etc/pve /etc/network/interfaces /etc/network/interfaces.d \
 /etc/hostname /etc/hosts /etc/resolv.conf /etc/fstab \
 /etc/apt /etc/ssh 2>/dev/null
```

You can drive this from a `vzdump` hook script, or a tiny systemd timer, or simply a second small
job; the key is that it lands on the SAME external disk as the guest backups so a single USB disk is
a complete recovery kit. Keep a few generations and prune by hand or with
`find ... -mtime +N -delete`.

## A sensible single-node home strategy

1. One `dir`/`btrfs` storage `usbbackup` on the external USB disk, `content backup`, `is_mount 1`;
   host `fstab` entry uses `nofail`.
2. Nightly `vzdump: nightly-usb` job at ~02:30: `all 1`, `mode snapshot`, `compress zstd`,
   `fleecing enabled=1,storage=local-btrfs` (VMs), `repeat-missed 1`.
3. Retention `keep-last=3,keep-daily=7,keep-weekly=4,keep-monthly=6` on the job (or storage);
   validate with `pvesm prune-backups usbbackup --dry-run` before trusting.
4. `notification-mode notification-system`; one SMTP/webhook target + a matcher that alerts you on
   failure (severity error/warning). No `--mailto`.
5. A parallel nightly CONFIG tarball (`/etc/pve` + network + fstab + apt) to the same USB disk for
   host disaster recovery.
6. Mark any irreplaceable backup `--protected` so prune never eats it.
7. Periodic TEST RESTORE: monthly, `qmrestore`/`pct restore` to a throwaway VMID/CTID with
   `--unique`, boot, verify, destroy. A backup you've never restored is a guess.
8. Offsite/offline copy: rotate a SECOND USB disk (or `rsync`/copy the newest archives to a remote
   box or a second PBS) so a single failure/theft/ransomware event can't take both copies. The 3-2-1
   rule still applies at home.
9. USB-absent safety: because of `is_mount 1` + `nofail`, if you forget to plug the disk in, the job
   FAILS LOUDLY (and the host still boots) instead of silently writing to the NVMe and filling root

- exactly the behavior you want.

## Key deltas from PVE 8 (quick reference)

- Backup FLEECING (`--fleecing`) - new in 8.2, standard in 9; strongly recommended for VM backups to
  a slow USB/remote target to avoid guest I/O stalls.
- NOTIFICATION SYSTEM - vzdump routes through targets/matchers; `--mailto` / `--mailnotification`
  are DEPRECATED; use `--notification-mode notification-system`.
- `maxfiles` is deprecated in favor of `prune-backups` keep-\* retention (this predates 9 but is the
  only supported retention model now).
- Everything else (modes, zstd, jobs.cfg + pvescheduler, qmrestore/pct restore, live-restore being
  PBS-only) is unchanged in substance from late PVE 8.

## Citations

- Proxmox VE Admin Guide / Backup and Restore (chapter vzdump):
  [Backup and Restore](https://pve.proxmox.com/pve-docs/chapter-vzdump.html)
- vzdump(1) manpage: [vzdump(1)](https://pve.proxmox.com/pve-docs/vzdump.1.html)
- qmrestore(1) manpage: [qmrestore(1)](https://pve.proxmox.com/pve-docs/qmrestore.1.html)
- pct(1) manpage (pct restore): [pct(1)](https://pve.proxmox.com/pve-docs/pct.1.html)
- pvescheduler(8) manpage: [pvescheduler(8)](https://pve.proxmox.com/pve-docs/pvescheduler.8.html)
- Backup and Restore wiki: [Backup and Restore](https://pve.proxmox.com/wiki/Backup_and_Restore)
- Notifications wiki / docs: [Notifications](https://pve.proxmox.com/wiki/Notifications) and
  [Notifications](https://pve.proxmox.com/pve-docs/chapter-notifications.html)
- PVE 8.2 release (fleecing introduced):
  [Proxmox Virtual Environment 8.2 with Import Wizard released](https://www.proxmox.com/en/about/press-releases/proxmox-virtual-environment-8-2)
  and [Roadmap](https://pve.proxmox.com/wiki/Roadmap)
- Context7: /websites/pve_proxmox_pve-docs (vzdump options, calendar events, jobs.cfg,
  prune-backups, notification-mode).
