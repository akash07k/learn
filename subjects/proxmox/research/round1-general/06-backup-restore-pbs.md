# Topic 06: Backup, Restore, and Proxmox Backup Server (PBS)

Audience: blind screen-reader user, single PVE 8.x node (Debian 12) home lab, shell-only (no web
GUI). PVE 9.x notes flagged inline. Every action below is a shell command or a named config-file
edit.

---

## 1. Concepts and where backups live

Two storage flavors hold backups in PVE:

- **File-level storage** (a `dir`, NFS, or CIFS storage with the `backup` content type enabled).
  Backups are stored as plain files. Every vzdump backup is a FULL backup here - no incremental, no
  dedup.
- **Proxmox Backup Server (PBS) storage** (`pbs` type in `storage.cfg`). Backups are stored as
  de-duplicated, incremental chunks plus metadata. This is the big win covered in section 7.

A storage can only receive backups if its `content` line includes `backup`. Check/enable from the
shell:

```bash
# List storages and their content types
pvesm status
cat /etc/pve/storage.cfg

# The default 'local' dir storage usually already allows backups:
# dir: local
# path /var/lib/vz
# content iso,vztmpl,backup
# Default backup target directory on 'local' is /var/lib/vz/dump/
```

### Backup file naming (file-level storage)

Files land in the storage's `dump/` subdirectory (e.g. `/var/lib/vz/dump/`):

- VM image: `vzdump-qemu-<VMID>-YYYY_MM_DD-HH_MM_SS.vma.zst`
- Container: `vzdump-lxc-<VMID>-YYYY_MM_DD-HH_MM_SS.tar.zst`
- Log file: same basename `+ .log`
- Notes file: same basename `+ .notes` (free-text description)
- Protected mark: `+ .protected` marker may exist for protected backups

Compression suffix varies: `.zst` (zstd), `.lzo` (lzo), `.gz` (gzip), or none. For VMs the container
is a `.vma` (Proxmox's VM archive); for CTs it is a `.tar` (a tarball of the root filesystem). The
guest's config is embedded inside the archive (under `./etc/vzdump/` in the tar, or the VMA header
for VMs), so a restore recreates the config automatically.

---

## 2. vzdump CLI - the core backup command

`vzdump` backs up VMs (qemu) and containers (lxc). Same command for both; PVE detects guest type by
VMID.

### Backup modes (`--mode`)

- `snapshot` (default): no/near-zero downtime. Uses storage/qemu snapshot or LXC snapshot. For VMs
  uses live backup. For CTs requires a snapshot-capable backing store (LVM-thin, ZFS, Ceph, or a
  temporary file snapshot) - otherwise falls back behavior differs; `suspend` is the safe
  alternative if snapshot isn't possible.
- `suspend`: container/VM is paused (suspended) during backup, then resumed. Short freeze;
  consistent. For CTs it does a rsync-then-suspend-then-rsync.
- `stop`: guest is fully shut down for the backup, then restarted. Most consistent, longest
  downtime. Best for guests that can't be snapshotted.

### Compression (`--compress`)

- `zstd` (recommended, default `--zstd 1` thread tuning, multithreaded, fast + good ratio)
- `lzo` (very fast, weaker ratio)
- `gzip` (slow, classic; can use `pigz` for multithreaded gzip via `--pigz N`)
- `0` = no compression, `1` = legacy gzip

### Common single-VM examples

```bash
# Snapshot backup of VM 101 to a named storage, zstd compression
vzdump 101 --storage local --mode snapshot --compress zstd

# Container 777, stop mode, to a custom directory (no storage object)
vzdump 777 --dumpdir /mnt/backup --mode stop --compress zstd

# Snapshot to a dump dir (PVE doc example)
vzdump 777 --dumpdir /mnt/backup --mode snapshot

# Exclude paths inside a CT backup (shell globs; repeatable)
vzdump 777 --exclude-path /tmp/ --exclude-path '/var/foo*'

# Mark backup as protected (excluded from prune/retention)
vzdump 101 --storage local --protected 1

# Add a notes description using template variables
vzdump 101 --storage local \
 --notes-template 'Backup of {{guestname}} ({{vmid}}) on {{node}}'

# Limit backup I/O bandwidth to 50 MiB/s (50000 KiB/s)
vzdump 101 --storage local --bwlimit 50000
```

### Multi-VM / bulk backups

```bash
# Back up ALL guests on this node
vzdump --all --storage local --mode snapshot --compress zstd

# All guests EXCEPT some (implies --all)
vzdump --all --exclude 100,101 --storage local

# A space/comma list of specific VMIDs
vzdump 100 101 105 --storage local
vzdump --pool mypool --storage local # all guests in a resource pool
```

### `--storage` vs `--dumpdir`

- `--storage <id>`: writes to a PVE storage object (recommended; respects the storage's
  prune-backups retention, shows up in `pvesm list`, integrates with PBS). Mutually exclusive with
  `--dumpdir`.
- `--dumpdir <path>`: writes plain files to an arbitrary directory. Not tracked as a storage; you
  manage retention yourself.

### Notes template variables (`--notes-template`)

- `{{guestname}}` - the guest's configured name
- `{{vmid}}` - numeric VM/CT ID
- `{{node}}` - hostname that created the backup
- `{{cluster}}` - cluster name (single node: usually empty/host name)

### Email notification (`--mailto`)

```bash
vzdump --all --storage local --mailto admin@example.com --mailnotification failure
```

GOTCHA / version note: `--mailto` and `--mailnotification` are **deprecated** in favor of the
notification system (notification targets + matchers). On PVE 8.x they still work. The new system is
configured in `/etc/pve/notifications.cfg` (targets like sendmail/gotify/smtp, and matchers). For a
simple home lab, `--mailto` is fine and simplest. Requires a working MTA / postfix on the host.

### Other useful options

- `--remove 1` (default): after backup, prune old backups per `--prune-backups`.
- `--prune-backups keep-last=3,keep-daily=7` : retention for THIS run, overrides storage config (see
  section 4).
- `--stdexcludes 1` (default): auto-exclude temp files/logs for CT backups.
- `--mode` + `--bwlimit` + `--ionice` for I/O shaping.
- `--fleecing enabled=1,storage=<id>` (VM only, PVE 8.2+): "backup fleecing" buffers writes to a
  fleecing image so backup I/O does not slow the guest; useful for slow backup targets.
- `--script <hookscript>`: run a hook script at phases (job-start, backup-start, backup-end,
  log-end, etc.). Good for app-quiescing or pre/post tasks.

### Restoring the config / inspecting an archive

```bash
# Print the guest config stored inside a backup archive
pvesm extractconfig local:backup/vzdump-qemu-101-2026_06_10-02_00_01.vma.zst

# List backups known to a storage
pvesm list local --content backup
```

---

## 3. Scheduled backups from the shell

Scheduled (periodic) backup jobs are NOT cron-by-default anymore. They live in `/etc/pve/jobs.cfg`
and are executed by the **pvescheduler** systemd daemon. The legacy `/etc/cron.d/vzdump` mechanism
still works if you create it, but the modern, supported path is `jobs.cfg`.

### The pvescheduler daemon

```bash
systemctl status pvescheduler
journalctl -u pvescheduler # see when jobs fired
```

pvescheduler reads `/etc/pve/jobs.cfg`, evaluates each job's `schedule` against systemd **calendar
event** syntax, and runs due jobs. `/etc/pve` is the cluster filesystem (pmxcfs); editing the file
there is the supported way.

### /etc/pve/jobs.cfg format

Each job is a stanza. The header is `vzdump: <job-id>` and indented `key value` lines follow.
Example file:

```text
vzdump: backup-nightly
	schedule mon..fri 02:00
	storage local
	mode snapshot
	compress zstd
	mailto admin@example.com
	mailnotification failure
	all 1
	notes-template {{guestname}}
	prune-backups keep-daily=7,keep-weekly=4,keep-monthly=3
	enabled 1

vzdump: backup-weekly-vms
	schedule sat 03:30
	storage pbs-store
	mode snapshot
	vmid 100,101,105
	notes-template Weekly {{guestname}} on {{node}}
	enabled 1
```

Key fields:

- `schedule` - systemd calendar event (see below). Required.
- `storage` - target storage id (or use `dumpdir`).
- `mode` - snapshot|suspend|stop.
- `compress` - zstd|lzo|gzip|0.
- `all 1` - back up all guests; or `vmid 100,101` for a list; or `pool <name>`.
- `exclude <vmids>` - with `all 1`.
- `mailto` / `mailnotification` - email (deprecated but works).
- `notes-template` - same `{{...}}` variables as the CLI.
- `prune-backups` - per-job retention (overrides storage setting).
- `enabled 1|0` - toggle without deleting.
- `node <name>` - restrict to one node (irrelevant on single node, can omit).

You can edit `/etc/pve/jobs.cfg` directly with a text editor:

```bash
nano /etc/pve/jobs.cfg # or vi; pvescheduler picks up changes automatically
```

You can also create jobs via the API/CLI without hand-editing:

```bash
pvesh create /cluster/backup --id backup-nightly \
 --schedule 'mon..fri 02:00' --storage local --mode snapshot \
 --compress zstd --all 1 --mailto admin@example.com \
 --prune-backups 'keep-daily=7,keep-weekly=4'
pvesh get /cluster/backup # list jobs
pvesh delete /cluster/backup/backup-nightly
```

### systemd calendar event (schedule) syntax

Format: `[weekdays] [year-month-day] [hour:minute[:second]]`. Examples:

- `02:00` - every day at 02:00
- `daily` - 00:00 every day
- `weekly` - Monday 00:00
- `sat 02:00` - every Saturday at 02:00
- `mon..fri 22:00` - Mon through Fri at 22:00
- `*-*-* 03:30:00` - daily at 03:30
- `mon,wed,fri 21:00` - those three days at 21:00
- `*-*-01 04:00` - first day of every month at 04:00
- `00/6:00` - every 6 hours (00:00, 06:00, 12:00, 18:00)
- `2026-12-25 00:00` - one specific date

Validate any expression with:

```bash
systemd-analyze calendar 'mon..fri 02:00'
systemd-analyze calendar 'sat *-*-* 03:30:00' --iterations 3
```

### Legacy cron path (optional)

Old setups put a file at `/etc/cron.d/vzdump`. You can still drive vzdump from cron if you prefer,
but you lose the pvescheduler integration and the GUI/API listing. Example `/etc/cron.d/myvzdump`:

```text
0 2 * * 1-5 root vzdump --all --storage local --mode snapshot --compress zstd --mailto admin@example.com --quiet 1
```

Recommendation: use `/etc/pve/jobs.cfg` (pvescheduler), not cron.

---

## 4. Retention and pruning (`prune-backups`)

`prune-backups` decides which backups to KEEP after a run (or when running a manual prune). Set it
on the storage (applies to all jobs targeting it) or per job/per vzdump invocation (overrides
storage).

Keep options (all optional, combine freely):

- `keep-last=N` - the N most recent backups
- `keep-hourly=N`
- `keep-daily=N`
- `keep-weekly=N`
- `keep-monthly=N`
- `keep-yearly=N`
- `keep-all=1` - keep everything (default; disables pruning)

Pruning works by "thinning": it keeps the newest backup in each time bucket. A backup can satisfy
multiple keep rules. `keep-all=1` overrides all others.

### Storage-level retention (storage.cfg)

```text
dir: local
	path /var/lib/vz
	content iso,vztmpl,backup
	prune-backups keep-daily=7,keep-weekly=4,keep-monthly=6
```

### Per-job example (jobs.cfg)

```text
	prune-backups keep-last=3,keep-daily=13,keep-yearly=9
```

### Per-vzdump-run example

```bash
vzdump 777 --prune-backups keep-last=3,keep-daily=13,keep-yearly=9
```

### Manual prune / dry-run on a storage

```bash
# Show what WOULD be removed for a storage (dry run)
pvesm prune-backups local --dry-run \
 --prune-backups keep-daily=7,keep-weekly=4

# Actually prune
pvesm prune-backups local --prune-backups keep-daily=7,keep-weekly=4
```

GOTCHA: backups marked **protected** (`--protected 1` or `.protected` marker) are NEVER pruned and
do not count toward keep limits.

---

## 5. Restore - VMs (`qmrestore`)

`qmrestore <archive> <vmid> [OPTIONS]` restores a VM from a vzdump VMA archive or from a PBS backup.

```bash
# Restore to the ORIGINAL id (must not be running; use --force to overwrite)
qmrestore /var/lib/vz/dump/vzdump-qemu-101-2026_06_10-02_00_01.vma.zst 101

# Restore to a NEW VMID (clone-style; original untouched)
qmrestore /var/lib/vz/dump/vzdump-qemu-101-2026_06_10-02_00_01.vma.zst 150

# Overwrite an existing VM
qmrestore <archive> 101 --force

# Put restored disks on a specific storage, give fresh MAC, start after restore
qmrestore <archive> 150 --storage local-lvm --unique --start

# From a storage volume id instead of a path
qmrestore local:backup/vzdump-qemu-101-2026_06_10-02_00_01.vma.zst 150
```

Key options:

- `--force` - overwrite existing VM with that id.
- `--storage <id>` - default storage for restored disks.
- `--unique` - assign a new random MAC (avoids collisions when restoring to a new id while the
  original still exists).
- `--start 1` - start the VM after a successful restore.
- `--bwlimit <KiB/s>` - throttle restore I/O.
- `--live-restore` - **PBS only**: boot the VM immediately and stream/restore blocks in the
  background, so the guest is usable in seconds. Great for fast recovery; if the restore fails
  midway the VM is discarded.

---

## 6. Restore - Containers (`pct restore`)

`pct restore <vmid> <archive> [OPTIONS]` creates (or recreates) a CT from a vzdump tar archive or a
PBS backup.

```bash
# Restore CT to original id from a file
pct restore 777 /mnt/backup/vzdump-lxc-777.tar

# Restore to a NEW id, placing rootfs on a chosen storage with a size
pct restore 800 local:backup/vzdump-lxc-777-2026_06_10-02_00_01.tar.zst \
 --storage local-lvm --rootfs local-lvm:8

# Overwrite an existing CT
pct restore 777 <archive> --force

# Restore unprivileged, ignore mountpoint restore, set hostname
pct restore 800 <archive> --unprivileged 1 --hostname web01
```

Key options:

- `--force` - overwrite existing CT.
- `--storage <id>` - default storage for the rootfs/mountpoints.
- `--rootfs <storage:size>` - explicit rootfs placement/size.
- `--unprivileged 0|1` - privileged vs unprivileged on restore.
- `--ignore-unpack-errors 1` - continue past tar extraction errors.
- `--bwlimit <KiB/s>` - throttle.

There is NO `--live-restore` for containers (VM-only feature).

---

## 7. Proxmox Backup Server (PBS) - intro for a single home node

### Why PBS beats plain vzdump

Plain vzdump on file storage = always a FULL backup, compressed, no dedup. PBS:

- **Incremental** after the first backup: only changed chunks are sent (dirty bitmap for VMs).
  Backups are fast and small.
- **Deduplication**: identical data chunks stored once across ALL guests and all snapshots. Backing
  up 5 similar Debian CTs costs roughly one Debian's worth.
- **Built-in verification** (checksums) to detect bit-rot, and **garbage collection** to reclaim
  space from unreferenced chunks.
- **Client-side encryption** option (AES-GCM) - safe to push offsite.
- **`--live-restore`** for VMs (instant boot).
- File-level restore browser from the shell helper / mount.

Tradeoff: PBS is a separate service/host. For a home lab it is worth it once you have more than a
couple of guests.

### Where to run PBS on a single-node home lab

- **Best**: a separate physical box (old PC, NUC, mini server) with its own disks. Survives the loss
  of the PVE host. Recommended.
- **Acceptable**: a VM or LXC _on the same PVE node_, with the datastore on a SEPARATE physical disk
  (ideally also copied offsite). Convenient but does NOT protect against the host's total failure
  unless the datastore disk + an offsite copy survive.
- **Avoid**: installing PBS on the PVE host root disk pointed at the same disk - no real protection.

### Installing PBS

Option A - on top of an existing Debian 12/13 (no GUI install ISO):

```bash
# Add the no-subscription PBS repo (Debian 12 'bookworm'; use 'trixie' on 13)
wget https://enterprise.proxmox.com/debian/proxmox-release-bookworm.gpg \
 -O /etc/apt/trusted.gpg.d/proxmox-release-bookworm.gpg
echo "deb http://download.proxmox.com/debian/pbs bookworm pbs-no-subscription" \
 > /etc/apt/sources.list.d/pbs.list
apt update
apt install proxmox-backup-server
# Web admin (you won't use it) is on https://<pbs-ip>:8007
```

Option B - boot the dedicated **Proxmox Backup Server ISO** installer (graphical installer; a
sighted helper or accessible-install method may be needed once, after which everything is
shell/SSH).

Version note: PBS 3.x pairs with PVE 8.x (Debian 12). PBS 4.x / Debian 13 ("trixie") aligns with PVE
9.x. Match the repo codename to the OS.

### Create a datastore (on PBS host)

```bash
# Create a datastore named 'home' backed by a directory on a data disk
proxmox-backup-manager datastore create home /mnt/datastore/home

# List datastores
proxmox-backup-manager datastore list

# (Optional) schedule GC and prune on the datastore at creation
proxmox-backup-manager datastore create home /mnt/datastore/home \
 --gc-schedule 'sun 03:00' --prune-schedule 'daily' \
 --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --verify-new true
```

### Create a user/API token and get the fingerprint (on PBS host)

```bash
# Create a dedicated user and token for PVE to authenticate as
proxmox-backup-manager user create pve-backup@pbs
proxmox-backup-manager user generate-token pve-backup@pbs pve-node
# Capture the token secret once, then grant datastore access to the user and token.
proxmox-backup-manager acl update /datastore/home DatastoreBackup \
 --auth-id pve-backup@pbs
proxmox-backup-manager acl update /datastore/home DatastoreBackup \
 --auth-id 'pve-backup@pbs!pve-node'

# Show the TLS fingerprint PVE needs to trust the server
proxmox-backup-manager cert info | grep -i fingerprint
# or:
proxmox-backup-client login ... then check; the fingerprint is the SHA-256 of the cert
```

The fingerprint is the SHA-256 of the PBS server certificate; you paste it into the PVE storage
config so PVE can verify the (self-signed) cert.

### Add PBS as a PVE storage (on the PVE host) - /etc/pve/storage.cfg

Append a `pbs:` stanza to `/etc/pve/storage.cfg`:

```text
pbs: pbs-store
	server 192.168.1.50
	datastore home
	content backup
  username pve-backup@pbs!pve-node
  password <TOKEN-SECRET>
	fingerprint 09:54:ef:..snip..:88:af:47:fe:4c:3b:cf:8b:26:88:0b:4e:3c:b2
	prune-backups keep-daily=7,keep-weekly=4,keep-monthly=6
	encryption-key autogen
```

Notes:

- `server` = PBS host/IP; `datastore` = the datastore name created above.
- `username` = the PBS API token id, `user@pbs!tokenid`.
- `password` = the token secret shown once by `user generate-token`; do not use an inline user
  password for automation.
- `fingerprint` = the SHA-256 cert fingerprint from the PBS host.
- `encryption-key autogen` enables client-side encryption; PVE generates and stores the key under
  `/etc/pve/priv/storage/<id>.enc`. BACK THAT KEY UP - lose it and encrypted backups are
  unrecoverable.

You can also add it via CLI instead of editing by hand:

```bash
pvesm add pbs pbs-store --server 192.168.1.50 --datastore home \
 --username 'pve-backup@pbs!pve-node' --password \
 --fingerprint 09:54:ef:...:b2 \
 --prune-backups keep-daily=7,keep-weekly=4,keep-monthly=6
pvesm status # verify the pbs storage is online
```

Once added, `vzdump --storage pbs-store ...` and the jobs.cfg `storage pbs-store` just work;
restores with `qmrestore`/`pct restore` accept the PBS volume id and support `--live-restore` for
VMs.

### Backing up the PVE HOST itself / arbitrary files with proxmox-backup-client

`proxmox-backup-client` runs on ANY machine (including the PVE host) to back up files/directories
directly into a PBS datastore - independent of vzdump. This is how you protect the host's `/etc`,
scripts, etc.

```bash
# Point the client at the repo (auth-id@server:datastore). Set once per shell:
export PBS_REPOSITORY='pve-backup@pbs!pve-node@192.168.1.50:home'
export PBS_PASSWORD='<TOKEN-SECRET>' # token secret from user generate-token
# Optional: trust the self-signed cert
export PBS_FINGERPRINT='09:54:ef:...:b2'

# Back up the PVE config + system config as a pxar archive
proxmox-backup-client backup \
 pveconf.pxar:/etc/pve \
 etc.pxar:/etc \
 --repository pve-backup@pbs@192.168.1.50:home

# Back up the whole root filesystem (mount points skipped by default)
proxmox-backup-client backup root.pxar:/ \
 --repository pve-backup@pbs@192.168.1.50:home

# List snapshots
proxmox-backup-client snapshot list

# Restore a single archive to a directory
proxmox-backup-client restore host/<hostname>/2026-06-10T02:00:00Z \
 etc.pxar /restore/etc

# Mount a pxar archive to browse/copy individual files (FUSE)
proxmox-backup-client mount host/<hostname>/2026-06-10T02:00:00Z \
 etc.pxar /mnt/restore
# ... copy what you need, then:
umount /mnt/restore
```

Archive source spec syntax: `name.TYPE:/path` where TYPE is `pxar` (a directory tree), `img` (a
block device/image), `conf`, or `log`.

Client-side encryption:

```bash
# Generate an encryption key once and protect it
proxmox-backup-client key create /root/pbs-encryption.key
# Use it for backups
proxmox-backup-client backup etc.pxar:/etc --keyfile /root/pbs-encryption.key
```

GOTCHA: store the encryption key (and its paper/QR backup, `key paperkey`) OFFLINE. Without it,
encrypted snapshots cannot be restored.

### Verification (integrity) and garbage collection (on PBS host)

```bash
# Verify all (re-checks chunk checksums; detects bit-rot)
proxmox-backup-manager verify home

# Verify with tuned threads, force re-verify
proxmox-backup-manager verify home --read-threads 1 --verify-threads 4 \
 --ignore-verified false

# Garbage collection: reclaim space from unreferenced chunks
proxmox-backup-manager garbage-collection start home
proxmox-backup-manager garbage-collection status home

# Schedule GC / verify / prune as jobs
proxmox-backup-manager prune-job create daily-prune --schedule daily \
 --store home --keep-daily 7 --keep-weekly 4 --keep-monthly 6
proxmox-backup-manager verify-job create weekly-verify --schedule 'sun 04:00' \
 --store home
```

IMPORTANT ordering: pruning REMOVES snapshots (references); GC then frees the now-unreferenced
chunks. Run prune first, GC after. GC uses a 24h+ safety window (access-time based), so
freshly-unreferenced chunks are not deleted immediately.

### Pruning a backup group from the client

```bash
proxmox-backup-client prune vm/101 --keep-daily 7 --keep-weekly 4 --dry-run
proxmox-backup-client prune vm/101 --keep-daily 7 --keep-weekly 4
```

---

## 8. File-level restore from the shell

Three ways to pull individual files out of a backup without a full restore:

1. **PBS-backed backups** - use the file-restore tooling. From the PVE host:

```bash
# List a backup snapshot's contents (drives/partitions for VMs, fs for CTs)
proxmox-file-restore list <pbs-snapshot> --repository <repo>
# Extract a path to a local directory
proxmox-file-restore extract <pbs-snapshot> /path/in/guest \
--target /restore/here --repository <repo>
```

For VM backups this transparently spins up a tiny isolated helper VM to safely read the (untrusted)
guest filesystem, then exposes its files. For CTs it reads the pxar directly. (The GUI exposes this
as a browser; the same capability is available via `proxmox-file-restore` on the CLI.)

1. **CT vzdump tar (file storage)** - it's just a tarball; extract directly:

```bash
mkdir /restore/ct && tar -C /restore/ct \
--zstd -xf /var/lib/vz/dump/vzdump-lxc-777-2026_06_10.tar.zst ./path/wanted
```

1. **VM vma archive** - not directly browsable. Restore to a throwaway VMID
   (`qmrestore <archive> 999`), boot or mount its disk, copy files, then destroy the temp VM. Or
   `proxmox-backup-client mount` if the backup is on PBS.

2. **`proxmox-backup-client mount`** (PBS host/file backups) - FUSE-mount a pxar archive and `cp`
   what you need (shown in section 7).

---

## 9. Configuration / disaster-recovery backup of the host

vzdump backs up GUESTS, not the PVE host OS. For bare-metal disaster recovery you must separately
capture the host's config so you can rebuild the node and re-import guests.

What to save (small, back up daily):

- `/etc/pve` - ALL VM/CT configs, storage.cfg, jobs.cfg, users, datacenter.cfg. This is the pmxcfs
  (a FUSE db); copy its contents, do not rely on raw block.
- `/etc/network/interfaces` (and `/etc/network/`) - network/bridge config.
- `/etc/hosts`, `/etc/hostname`, `/etc/resolv.conf`.
- `/etc/passwd`, `/etc/shadow`, `/etc/ssh/` - local users, host keys.
- `/etc/apt/`, `/etc/cron*`, `/etc/systemd/` customizations.
- `/var/lib/pve-cluster/` (the pmxcfs SQLite db, `config.db`) - for a full cluster-state restore on
  a fresh install.

Simple shell approaches:

```bash
# Quick dated tarball of the critical config to a backup mount
tar czf /mnt/backup/pveconf-$(hostname)-$(date +%F).tar.gz \
 /etc/pve /etc/network/interfaces /etc/hostname /etc/hosts \
 /etc/ssh /var/lib/pve-cluster/config.db

# Or push it into PBS (deduped, versioned, can go offsite/encrypted):
proxmox-backup-client backup \
 pveconf.pxar:/etc/pve etc.pxar:/etc clusterdb.pxar:/var/lib/pve-cluster \
 --repository pve-backup@pbs@192.168.1.50:home
```

Automate it as a tiny cron/systemd-timer or a vzdump `--script` hook so a config snapshot rides
along with the nightly guest backup.

Recovery sketch: reinstall PVE (same version), then restore `/etc/network/interfaces` and reboot
networking, then restore `/etc/pve` contents (storage.cfg, guest configs), then re-add PBS storage,
`qmrestore` / `pct restore` each guest from PBS.

---

## 10. Recommended home-lab backup strategy (3-2-1)

3-2-1 = 3 copies of data, on 2 different media, 1 offsite.

Practical single-node plan:

1. **Primary (on-site, fast):** PBS datastore on a SEPARATE disk (or a dedicated PBS box). Nightly
   incremental backups of all guests via a `jobs.cfg` vzdump job to `storage pbs-store`. Dedup +
   incremental keeps it cheap.

- Schedule: `mon..fri 02:00` (or daily). Retention e.g. `keep-daily=7,keep-weekly=4,keep-monthly=6`.

1. **Second copy (different medium):** weekly `vzdump --storage local` (full, compressed) OR a PBS
   **sync job** to a second datastore on an external USB disk. Protects against a corrupt primary
   datastore.
2. **Offsite:** PBS **remote sync** (pull) to a friend's/relative's PBS or a VPS, OR rotate an
   encrypted external USB disk offsite, OR `proxmox-backup-client` with client-side encryption
   pushing to cloud storage. Encryption matters offsite.
3. **Config DR:** daily tarball / pxar of `/etc/pve`, `/etc`, network config, `config.db`
   (section 9) included in the same job.

Frequency guidance:

- Guests with changing data (databases, file servers): daily, snapshot mode.
- Static appliances: weekly is fine.
- Critical guests: also keep a `--protected 1` "known-good" snapshot that prune won't touch.

Verification & hygiene:

- Enable `--verify-new true` on the datastore (or a weekly verify job) so bit-rot is caught.
- Schedule GC weekly (`sun 03:00`) and prune daily.
- Periodically TEST a restore (`qmrestore <archive> 999`, boot, destroy). An untested backup is a
  hope, not a backup.

---

## 11. Gotchas summary

- A storage only accepts backups if `content` includes `backup`.
- vzdump `snapshot` mode needs snapshot-capable storage for CTs; otherwise use `suspend`/`stop`.
- `--mailto`/`--mailnotification` are deprecated (still work on 8.x); the new notification system
  lives in `/etc/pve/notifications.cfg`.
- `--live-restore` is PBS + VM only (no CT).
- Protected backups are never pruned and don't count toward keep limits.
- PBS prune removes references; GC frees space - run prune first, GC after; GC has a ~24h safety
  window so space isn't freed instantly.
- BACK UP the PBS client-side encryption key offline - no key, no restore.
- Match repo codename to OS: bookworm/PBS3 for PVE8; trixie/PBS4 for PVE9.
- vzdump does NOT back up the host OS - capture `/etc/pve`, `/etc`, network, and `config.db`
  separately for true disaster recovery.

---

## Citations

- PVE Backup and Restore (vzdump):
  [Backup and Restore](https://pve.proxmox.com/pve-docs/chapter-vzdump.html)
- vzdump(1) man page: [vzdump(1)](https://pve.proxmox.com/pve-docs/vzdump.1.html)
- PVE admin guide (qmrestore, pct restore, jobs.cfg, prune-backups):
  [Proxmox VE Administration Guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.html)
- PVE PBS storage plugin (storage.cfg pbs stanza):
  [pve-docs/pve-storage-pbs.adoc at master · proxmox/pve-docs](https://github.com/proxmox/pve-docs/blob/master/pve-storage-pbs.adoc)
- PBS docs - backup client: [Backup Client Usage](https://pbs.proxmox.com/docs/backup-client.html)
- PBS docs - command syntax (datastore/prune/verify/GC):
  [Command Syntax](https://pbs.proxmox.com/docs/command-syntax.html)
- PBS docs - proxmox-backup-client man:
  [proxmox-backup-client](https://pbs.proxmox.com/docs/proxmox-backup-client/man1.html)
- PBS docs - maintenance (verify/GC):
  [Maintenance Tasks](https://pbs.proxmox.com/docs/maintenance.html)
- PBS docs - installation: [Installation](https://pbs.proxmox.com/docs/installation.html)
- PVE package repositories:
  [Package Repositories](https://pve.proxmox.com/wiki/Package_Repositories)
- systemd calendar events: `man systemd.time`; validate via `systemd-analyze calendar`
