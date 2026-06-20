# Backups with Proxmox Backup Server

## What you'll be able to do

By the end of this guide you will be able to stand up [Proxmox Backup Server (PBS)](GLOSSARY.md) as
a VM on this node, put its [datastore](GLOSSARY.md) on a dedicated external USB HDD, point Proxmox
VE at it, encrypt the backups, schedule guest and host-config backups, and keep the store healthy
with verify, prune, and garbage collection. This is written now to be implemented later: the backup
hardware (the external USB HDD) is provisioned in a future step, so treat this as the plan you run
once that disk is connected. The commands are ready to use then; where a step needs the running PBS
or the mounted datastore, it is phrased as a "when the disk is in place, confirm it like this" check
rather than something to run today.

## Why PBS, and the one honest catch

Plain `vzdump` writes a full, self-contained archive every single run. PBS instead runs a
content-addressed, deduplicated [datastore](GLOSSARY.md), which buys three things that matter on a
single node. First, [deduplication](GLOSSARY.md) plus incremental backups: data is split into chunks
and hashed, so after the first full backup only the changed chunks are written. Subsequent backups
are fast and small while still restorable as a full point-in-time snapshot. Second, server-side
[verification](GLOSSARY.md): every chunk has a checksum, and a verify job re-reads stored data on a
schedule so you find bit-rot before a restore, not during one. Third, client-side
[encryption](GLOSSARY.md): the data is encrypted with a key you hold before it ever leaves the
client, so the server only stores ciphertext (and still deduplicates it).

The architecture here is the one recorded in
[docs/adr/0002](../docs/adr/0002-backup-architecture.md): PBS runs as a VM on this node, and its
datastore lives on a dedicated external USB HDD. PBS is amd64-only (there is no official arm64
build), and this node is the only amd64 machine on hand, which is precisely why PBS runs as a VM
here rather than on the Raspberry Pi.

The honest catch: a backup that lives on the same machine, or worse the same disk, as the thing it
protects is not a real backup. If the node dies, an on-node-only datastore dies with it. Two
defenses follow from that, and this guide depends on both. The datastore must sit on a separate
physical disk (the external USB HDD, never the internal NVMe), and a genuine second copy must live
on a separate machine (the Raspberry Pi, which is guide 18). This guide builds the first leg; the
off-box copy is guide 18's job.

## Installing PBS accessibly (apt, with the ISO console mode noted)

The current PBS ISO is not graphical-only: it offers graphical, console, and terminal UI serial
console installer entries. For this corpus, though, the most predictable accessible path is still to
install PBS as ordinary packages on top of a Debian 13 ("trixie") base with apt, because the Debian
installer has a known text/speech route and every PBS setup step after boot can stay in a normal
shell. Here PBS lives in a VM on this node; building that VM (and giving it a serial console) is
guides [06 -- Virtual machines with qm](06-virtual-machines-with-qm.md) and
[07 -- Cloud-init templates](07-cloud-init-templates.md). The steps below are what you run inside
that PBS VM once it has a Debian 13 base; the focus here is the PBS software itself.

For the non-interactive editing convention used for every config file below (here-doc, `tee`, or a
drop-in, never assuming vim or nano), see the "Editing files accessibly" section of guide
[02 -- The shell and the API](02-the-shell-and-the-api.md).

First add the Proxmox archive keyring and verify it before trusting anything from the repo:

```bash
wget https://enterprise.proxmox.com/debian/proxmox-archive-keyring-trixie.gpg \
  -O /usr/share/keyrings/proxmox-archive-keyring.gpg

sha256sum /usr/share/keyrings/proxmox-archive-keyring.gpg
# expect exactly:
# 136673be77aba35dcce385b28737689ad64fd785a797e57897589aed08db6e45
```

The sha256sum must equal `136673be77aba35dcce385b28737689ad64fd785a797e57897589aed08db6e45`. If it
does not match, stop: do not run `apt update` against an unverified keyring. Only when it matches do
you continue.

Then add the no-subscription PBS repository in the Debian 13 deb822 format. Write
`/etc/apt/sources.list.d/pbs-no-subscription.sources`:

```text
Types: deb
URIs: http://download.proxmox.com/debian/pbs
Suites: trixie
Components: pbs-no-subscription
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
```

If a `pbs-enterprise` repo file exists without a subscription, disable it or `apt update` will error
on a 401. Now update and install:

```bash
apt update
apt full-upgrade -y
apt install proxmox-backup-server
```

The service comes up on `https://<ip>:8007`. You do not need that web GUI; the
`proxmox-backup-manager` CLI covers everything in this guide. The first time you log in (to set
anything up), use `root@pam` with the VM's root password; from there you create the dedicated backup
user below.

### Verify it worked

```bash
proxmox-backup-manager version
```

When PBS is installed, this reports a PBS 4.x version line (for example
`proxmox-backup-server 4.x`). A "command not found" means the package did not install.

## The datastore on the external USB HDD

A datastore is a directory on a filesystem PBS controls. It must go on the external USB HDD, never
the internal NVMe. Identifying and preparing that USB disk (finding it by stable ID, partitioning,
creating the filesystem or ZFS pool, and the removable-media `is_mountpoint` safety mindset) is
taught in guide [09 -- Storage](09-storage.md); do that first. What follows is only the PBS-specific
datastore step layered on top.

On the filesystem choice, be honest about the trade-off. ext4 or xfs is the simplest
officially-recommended chunk-store filesystem and the safe default. ADR-0002 chose ZFS on the USB
HDD instead, for its checksums and scrub (consistent with the ZFS practice in this corpus); ZFS is
supported, at the cost of copy-on-write overhead on the chunk store. Avoid BTRFS for the datastore
filesystem. Present both to yourself honestly and pick per the ADR; see guide 09 for the disk
preparation either way.

If the disk is already mounted (say at `/mnt/datastore/store1`), create a plain datastore against
that path:

```bash
proxmox-backup-manager datastore create store1 /mnt/datastore/store1
```

PBS can also format a whole disk and register the datastore in one step. Both of these commands
erase the entire target disk. Confirm the device against the stable-ID check in guide 09 before
running either -- `sdX` here is a placeholder, not a literal. For ext4:

```bash
proxmox-backup-manager disk fs create store1 --disk sdX \
  --filesystem ext4 --add-datastore true
```

For the ADR's ZFS choice, the disk helper creates the pool and adds the datastore:

```bash
proxmox-backup-manager disk zpool create store1 --devices sdX \
  --raidlevel single --add-datastore true
```

Because the USB HDD is removable, the more disciplined option is a removable datastore. PBS 4 tracks
the partition by UUID and mounts and unmounts it on demand (it does not add `/etc/fstab` entries). A
removable device with only one datastore can mount automatically when PBS detects it; still keep the
explicit mount and unmount commands in your notes because they are the accessible way to prove state
from the shell. Create it against the backing partition's UUID, then mount it around use:

```bash
# create on a prepared partition identified by its UUID
proxmox-backup-manager datastore create usbstore /mnt/datastore/usbstore \
  --backing-device <PARTITION-UUID>

# when the drive is plugged in:
proxmox-backup-manager datastore mount usbstore
# ... run backups or a sync ...
proxmox-backup-manager datastore unmount usbstore   # waits for running tasks
```

New in PBS 4.0, a sync job can be configured to run automatically when the removable datastore is
mounted, so plugging the drive in triggers the copy. The actual sync-job flags are
`--run-on-mount true`; if you want PBS to detach the drive after the copy finishes, also set
`--unmount-on-done true`:

```bash
proxmox-backup-manager sync-job update <job-id> \
  --run-on-mount true --unmount-on-done true
```

This removable discipline is the PBS-side echo of guide 09's rule for the USB target: the store must
fail loudly when the disk is absent, never silently fill the internal NVMe. A removable datastore
that is simply not mounted is unavailable, so backups to it fail cleanly instead of landing
somewhere wrong. Scheduled verify, prune, and garbage-collection jobs are skipped while the
removable datastore is absent; sync jobs start and fail with an error so a missed off-box copy is
visible instead of silently ignored.

### Verify it worked

```bash
proxmox-backup-manager datastore list
proxmox-backup-manager datastore show store1
```

When the disk is in place and the datastore is created, `datastore list` includes your store name,
and `datastore show store1` prints its path and properties.

## A backup user and an access token on PBS

PBS has its own user database and its own `@pbs` realm, entirely separate from Proxmox VE's
`pveum`/`@pam`/`@pve` identities. Create a dedicated, least-privilege user for backups rather than
reusing `root@pam`. The why behind least privilege, using a token instead of a password, and
privilege separation is taught in guide
[13 -- Users, permissions, and API tokens](13-users-permissions-and-api-tokens.md); this guide does
not re-teach it and only shows the PBS-side commands.

```bash
proxmox-backup-manager user create backup@pbs
proxmox-backup-manager user list

# grant only the backup role on this datastore's path
proxmox-backup-manager acl update /datastore/store1 DatastoreBackup --auth-id backup@pbs
```

Do not paste a PBS password on the command line. Current PBS CLI docs show `user create --password`
as a value-taking option, not a prompt. For this unattended identity, create the user without a
password and use the API token below as the actual credential PVE stores. Keep `root@pam` as the
break-glass administrative login for PBS itself.

The `DatastoreBackup` role can create backups and read its own; it is not full admin. The wider
roles (`DatastoreAdmin`, `DatastorePowerUser`, `DatastoreReader`, `DatastoreAudit`) are deliberately
not used here.

For an unattended client like the PVE node, prefer an API token over a password. Generate one (the
secret is shown once, so capture it), then grant the same narrow role to the token's auth-id:

```bash
proxmox-backup-manager user generate-token backup@pbs pve-node
# prints tokenid backup@pbs!pve-node and a secret (shown ONCE) -- store it now

proxmox-backup-manager acl update /datastore/store1 DatastoreBackup \
  --auth-id 'backup@pbs!pve-node'
```

### Verify it worked

```bash
proxmox-backup-manager acl list
```

This lists the ACL entries; you should see `/datastore/store1` granted the `DatastoreBackup` role
for `backup@pbs` (and for the `backup@pbs!pve-node` token if you created it).

## Connecting Proxmox VE to PBS

Because this PBS is self-signed, PVE has to be told the server's certificate
[fingerprint](GLOSSARY.md), and the fingerprint must match or the client refuses to connect. Read it
on the PBS host:

```bash
proxmox-backup-manager cert info | grep Fingerprint
# Fingerprint (sha256): 64:d3:ff:3a:50:38:53:5a:9b:f7:50:...:ab:fe
```

Copy that colon-separated string. On the PVE node, add the `pbs:` storage. With `--password` given
no value, `pvesm` prompts for the secret instead of taking it on the command line:

```bash
pvesm add pbs pbs-store1 \
  --server 192.168.1.50 \
  --datastore store1 \
  --username 'backup@pbs!pve-node' \
  --fingerprint 64:d3:ff:3a:...:ab:fe \
  --password \
  --content backup
```

That writes a `pbs:` stanza into `/etc/pve/storage.cfg`. The resulting stanza looks like this (you
can also hand-edit it directly, per guide 02's editing section):

```text
pbs: pbs-store1
        server 192.168.1.50
        datastore store1
        username backup@pbs!pve-node
        fingerprint 64:d3:ff:3a:50:38:53:5a:9b:f7:50:...:ab:fe
        content backup
        prune-backups keep-daily=7,keep-weekly=4,keep-monthly=6
        encryption-key autogen
```

The secret is not stored in clear in `storage.cfg`. PVE keeps the password or token secret under
`/etc/pve/priv/storage/pbs-store1.pw`, and the encryption key (the next section) under
`/etc/pve/priv/storage/pbs-store1.enc`. That secret-at-rest split, secret out of the config file and
into a root-only `priv/` path, is the same pattern guide
[13 -- Users, permissions, and API tokens](13-users-permissions-and-api-tokens.md) describes. If you
ever regenerate the PBS certificate, update the `fingerprint` here (and any `PBS_FINGERPRINT`) or
the connection breaks.

### Verify it worked

```bash
pvesm status
```

When PBS is reachable and the fingerprint matches, the `pbs-store1` storage appears in the list and
is marked active.

## Client-side encryption (and guarding the key)

The non-negotiable rule, up front: if you lose the encryption key you lose every encrypted backup
that depends on it. There is no vendor recovery unless you deliberately set up and keep a PBS master
key for key recovery. So create the key and a printable paper backup before the first encrypted
backup, and store both the key and the paperkey off the PBS server and off the node entirely.

```bash
# create a key and a printable / QR paper backup
proxmox-backup-client key create /root/store1.key --hint 'home pbs store1'
proxmox-backup-client key paperkey /root/store1.key \
  --output-format text > /root/store1-paperkey.txt
```

`key create` uses the default scrypt KDF, which prompts you to set a key password; the resulting key
is password-protected. Pass `--kdf none` instead if you want an unprotected key (no password
prompt), at the cost of anyone with the key file being able to read the backups.

Move `store1.key` and `store1-paperkey.txt` somewhere other than this node and other than the PBS
server: a password manager, an encrypted USB kept off-site, or literally printed paper in a drawer.
For PVE-side guest backups, the key is the one referenced by the storage as
`/etc/pve/priv/storage/pbs-store1.enc` (the `encryption-key autogen` line above generates it);
export and back that up the same way. For host-config backups with `proxmox-backup-client`, the key
is referenced by `--keyfile` or the `PBS_ENCRYPTION_PASSWORD` variable in the next sections.
Wherever the key appears, the same rule holds: a copy lives off the server and off the node, or the
backups are one disk failure from unreadable.

## Scheduling guest backups to PBS

This is the point people get wrong, so state it plainly: PBS does not schedule guest backups. PBS
schedules its own maintenance (verify, prune, garbage collection, sync). The guest backups
themselves are scheduled on the PVE side by the `pvescheduler` daemon, as a `vzdump:` job in
`/etc/pve/jobs.cfg` that happens to point at the `pbs:` storage. The `schedule` field uses systemd
calendar-event syntax (for example `02:30` for daily at 02:30, or `mon..fri 21:00` for weekdays);
always validate an expression before trusting it with `systemd-analyze calendar "02:30"` (add
`--iterations 5` to print the next few firing times). This is the accessible, deterministic way to
confirm a job will fire when you expect, with no clock-watching.

Write (or hand-edit, per guide 02) a stanza in `/etc/pve/jobs.cfg`. A realistic single-node job,
nightly, all guests, to the PBS storage:

```text
vzdump: nightly-pbs
        schedule 02:30
        all 1
        enabled 1
        storage pbs-store1
        mode snapshot
        fleecing enabled=1,storage=local-btrfs
        notes-template {{node}}-{{guestname}}-{{vmid}}
        notification-mode notification-system
        repeat-missed 1
        prune-backups keep-daily=7,keep-weekly=4,keep-monthly=6
```

A few of those fields earn their place here. The `fleecing enabled=1,storage=local-btrfs` setting
turns on [backup fleecing](GLOSSARY.md) for VMs: the USB-backed PBS target is slow, and fleecing
inserts a fast local cache image so a guest that writes during the backup window does not stall
waiting on the slow target. It is VM-only and costs a little temporary local space that is reclaimed
afterward; turn it on. Use `local-btrfs` here because the plain `local` storage is disabled on this
btrfs-root host. The `notification-mode notification-system` setting routes the job result through
PVE's notification system rather than the deprecated `--mailto`; pair it with guide 15's
failure-only matcher so you are pinged only when a backup actually fails. `repeat-missed 1` makes
`pvescheduler` run a job that was missed because the box was off, which suits a home node that is
not always on. The `prune-backups` keep-\* policy sets retention.

A note on PBS's own notifications: PBS does have its own notification system for its server-side
jobs. But on this single node the actionable alerts are the PVE backup-job results, so configure
those through guide 15 and treat PBS's own notifications as secondary. The first backup of each
guest is full; every backup after that is incremental, thanks to dedup and the dirty-bitmap.

### Verify it worked

Trigger one run by hand (this uses the same settings, writing to the PBS storage):

```bash
vzdump --all 1 --storage pbs-store1 --mode snapshot \
  --fleecing enabled=1,storage=local-btrfs
```

When the disk is in place and the run finishes, confirm a snapshot exists. With the repository and
credentials set in the environment (see the next section for the variables), on the PBS or PVE host:

```bash
proxmox-backup-client snapshot list
# e.g. vm/100/2026-06-11T02:30:01Z  (and ct/<vmid>/... for containers)
```

The job's task log should also show success, and you should see a `vm/<vmid>/...` (or
`ct/<vmid>/...`) snapshot line.

## Backing up the host config with proxmox-backup-client

`vzdump` and the guest job above back up guests, not the PVE host itself. The host's `/etc/pve`,
network config, and package selection are in no guest backup. Capture them as
[pxar archives](GLOSSARY.md) with [proxmox-backup-client](GLOSSARY.md) run on the PVE node. This is
the one piece that you schedule yourself with a systemd timer or cron; PBS will not schedule it.

The client reads its target and credentials from environment variables. The repository format is
`[[user@]server[:port]:]datastore`, for example `backup@pbs!pve-node@192.168.1.50:store1`. A
shell-history hygiene warning applies, the same one as guide 15: do not paste secrets inline on the
command line where they land in your shell history and `ps` output. Put them in a root-only env file
(`chmod 600`, sourced by a root-only script) or a token file, not in an interactive command:

```bash
# in a root-only file such as /usr/local/sbin/host-backup.sh (chmod 600), not typed inline
export PBS_REPOSITORY='backup@pbs!pve-node@192.168.1.50:store1'
export PBS_PASSWORD='...'                       # the token secret
export PBS_FINGERPRINT='64:d3:ff:3a:...:ab:fe'  # trust the self-signed cert
export PBS_ENCRYPTION_PASSWORD='...'            # if the key is password-protected

proxmox-backup-client backup \
  pveconf.pxar:/etc/pve \
  etc.pxar:/etc \
  --change-detection-mode=metadata \
  --keyfile /root/store1.key
```

`PBS_ENCRYPTION_PASSWORD` is the passphrase that unlocks the `--keyfile`; with the default scrypt
KDF the key is password-protected, so you must set this (only a `--kdf none` key needs no password).
Using a different or unreadable key produces backups you cannot restore, and that failure stays
silent until restore day.

`--change-detection-mode=metadata` lets re-runs skip files whose metadata is unchanged, so repeat
host backups are fast. The high-value host paths to make sure you capture (from guide 15's
disaster-recovery list) are `/etc/pve` (the crown jewel: guest configs, `storage.cfg`, `jobs.cfg`,
notifications, users), `/etc/network/interfaces` (your bridges and VLANs), `/etc/fstab` (so the USB
mount and `is_mountpoint` come back), `/etc/apt` (the PVE 9 repo config), and `/etc/ssh` (host
keys). Schedule this from a systemd timer or cron on the PVE node; remember PBS does not do it for
you.

### Verify it worked

```bash
proxmox-backup-client snapshot list
# host/<pve-hostname>/2026-06-11T03:00:01Z
```

When the disk is in place and the client backup has run, the list shows a `host/<pve-hostname>/...`
snapshot, and that snapshot contains `pveconf.pxar` (and `etc.pxar`).

## Keeping backups healthy: verify, prune, garbage-collect

These three named tasks run on the PBS server with `proxmox-backup-manager`, and PBS does schedule
these (unlike the guest backups). They use the same systemd calendar-event syntax as the backup job
above; validate any expression with `systemd-analyze calendar`.

[Verify](GLOSSARY.md) re-reads stored chunks and checks them against their recorded checksums, so
corruption is found before a restore. Because re-reading every chunk from a USB HDD is slow,
schedule it modestly:

```bash
proxmox-backup-manager verify-job create verify-store1 \
  --store store1 --schedule daily --ignore-verified true --outdated-after 30
proxmox-backup-manager verify store1     # manual, one-off
```

[Prune](GLOSSARY.md) applies the keep-\* retention policy. The crucial point: prune frees no space;
it only marks snapshots as removable. Mark anything irreplaceable as protected so prune skips it.

```bash
proxmox-backup-manager prune-job create prune-store1 \
  --store store1 --schedule daily \
  --keep-daily 7 --keep-weekly 4 --keep-monthly 6
```

The retention knobs in that policy, as a definition list rather than a grid:

- `keep-last=N` -- the N most recent backups regardless of age.
- `keep-daily=N` -- the newest backup in each of the last N days.
- `keep-weekly=N` -- the newest per week.
- `keep-monthly=N` -- the newest per month.
- `keep-yearly=N` -- the newest per year.

[Garbage collection](GLOSSARY.md) is what actually reclaims disk space, deleting chunks no surviving
snapshot references, after a grace window:

```bash
proxmox-backup-manager datastore update store1 --gc-schedule 'Tue 04:27'
proxmox-backup-manager garbage-collection start store1   # manual, one-off
```

The order is the whole model: prune first (it marks snapshots removable), garbage collection second
(it reclaims the freed chunks). Prune marks, GC reclaims; running prune alone frees nothing, so if
the datastore fills, you run GC, not just more pruning. A fine home cadence is daily prune,
daily-or-weekly verify, and a weekly GC.

### Verify it worked

```bash
proxmox-backup-manager garbage-collection status store1
```

When the disk is in place, this reports the last GC run, the chunks examined, and the space
reclaimed, confirming the maintenance cycle is functioning.

## vzdump as a one-off tool

`vzdump` still has a place as an ad-hoc, full-archive tool when you want a quick self-contained
backup without PBS in the loop:

```bash
vzdump 101 --storage local-btrfs --mode snapshot --compress zstd --protected
```

`--protected` marks the resulting archive so prune never auto-removes it, useful for a keep-forever
snapshot before a risky change. Restoring such an archive uses `qmrestore` (VMs) or `pct restore`
(containers), which are taught in guide 18; this guide does not re-teach restore. One restore caveat
worth repeating: `--live-restore` (start the guest immediately and stream blocks on demand) is
PBS-only and does not work from a `.vma.zst` or `.tar.zst` file. The PBS VM itself, since it cannot
back itself up into its own datastore, is handled with a one-off `vzdump` or simply rebuilt from
config, as ADR-0002 notes. For the full restore lifecycle see guide 18, the only guide that teaches
`qmrestore` and `pct restore`.

## Sources

- `research/round2-pve9/16-pbs-latest.md` -- grounded the PBS 4 apt install and the
  `136673be77aba35dcce385b28737689ad64fd785a797e57897589aed08db6e45` keyring hash, the
  `pbs-no-subscription` deb822 `.sources` repo, datastore creation (plain,
  `disk fs create --add-datastore`, ZFS `disk zpool create`, and the removable `--backing-device`
  UUID + `datastore mount`/`unmount` with sync-on-mount), the `@pbs` realm with `DatastoreBackup`
  role and `user generate-token`, the `cert info | grep Fingerprint` read, the `pbs:` storage stanza
  and `/etc/pve/priv/storage/<id>.pw` and `.enc` secret split, the `key create`/`key paperkey` and
  lose-key-lose-backups rule, the
  `PBS_REPOSITORY`/`PBS_PASSWORD`/`PBS_FINGERPRINT`/`PBS_ENCRYPTION_PASSWORD` env vars and
  host-config `proxmox-backup-client backup ... --change-detection-mode=metadata`, and the
  verify/prune/GC commands and the prune-then-GC model.
- `research/round2-pve9/15-pve9-backup-and-restore.md` -- grounded the one-off `vzdump` paragraph
  (modes, `--storage`, `--fleecing enabled=1,storage=local-btrfs`, `--protected`, `--live-restore`
  being PBS-only), the `vzdump:` job stanza in `/etc/pve/jobs.cfg` fired by `pvescheduler`, the
  `schedule` calendar syntax and `repeat-missed 1`, the `notification-mode notification-system`
  routing, and the high-value host-config path list.
- [docs/adr/0002 -- Backup architecture](../docs/adr/0002-backup-architecture.md) -- the accepted
  decision this guide implements: PBS as a VM on the node (amd64-only), datastore on a dedicated
  external USB HDD (ZFS), first backup full and the rest incremental, and the CLI-only operation
  because the PBS GUI is inaccessible.
- `GLOSSARY.md` -- the reused definitions of [Proxmox Backup Server (PBS)](GLOSSARY.md),
  [datastore](GLOSSARY.md), [deduplication](GLOSSARY.md), [proxmox-backup-client](GLOSSARY.md),
  [proxmox-backup-manager](GLOSSARY.md), [verify job (PBS)](GLOSSARY.md),
  [prune job (PBS)](GLOSSARY.md), [garbage collection (GC)](GLOSSARY.md),
  [fingerprint (PBS TLS fingerprint)](GLOSSARY.md), [backup fleecing](GLOSSARY.md),
  [pxar archive](GLOSSARY.md), and [vzdump](GLOSSARY.md).
- [PBS admin guide: installation](https://pbs.proxmox.com/docs/installation.html) -- the keyring,
  deb822 `.sources`, and apt install.
- [PBS admin guide: storage and datastores](https://pbs.proxmox.com/docs/storage.html) -- datastore
  creation, removable datastores, and the `gc-schedule` property.
- [PBS admin guide: maintenance](https://pbs.proxmox.com/docs/maintenance.html) -- verify, prune,
  and garbage collection.
- [PBS admin guide: encryption and backup client](https://pbs.proxmox.com/docs/backup-client.html)
  -- pxar archives, the `PBS_*` env vars, encryption keys, and `--change-detection-mode`.
- [proxmox-backup-client(1)](https://pbs.proxmox.com/docs/proxmox-backup-client/man1.html) --
  `key create`, `key paperkey`, `backup`, and `snapshot list`.
- [proxmox-backup-manager(1)](https://pbs.proxmox.com/docs/proxmox-backup-manager/man1.html) --
  datastore, user, acl, verify-job, prune-job, and garbage-collection.
- [PVE wiki: Storage: Proxmox Backup Server](https://pve.proxmox.com/wiki/Storage:_Proxmox_Backup_Server)
  -- the `pbs:` storage stanza, `pvesm add pbs`, and the fingerprint.

---

Previous: [16 -- Automation and the ecosystem](16-automation-and-the-ecosystem.md) | Next:
[18 -- The independent copy and restore](18-the-independent-copy-and-restore.md)
