# Proxmox Backup Server (PBS 4) for a single-node, CLI-only home user

Target: latest Proxmox Backup Server that pairs with PVE 9 / Debian 13 "trixie", i.e. **PBS 4.x**
(4.0 released July 2025; 4.1, 4.2 followed; current docs build "Proxmox Backup 4.2.1-1"). Reader is
a blind, screen-reader, shell-only user on a single PVE node with a BTRFS host root, backing up to
an external USB disk or a separate cheap box. Everything below is CLI. The PBS web GUI on :8007
exists but is graphical and not required.

## Version pairing (PBS 4 with PVE 9 / Debian 13)

- PBS 4.0 is built on **Debian 13 "trixie"**, kernel **6.14.8-2**, **ZFS 2.3.3** - the same base
  generation as **PVE 9.0**. Current PBS 4.2 is still the same Debian 13/PBS 4 major line, but has
  moved to kernel **7.0** and **ZFS 2.4.1**.
- Treat the PBS 4 line as the natural match for the current PVE 9 line and Debian 13 generation. Old
  PBS 4.0 launch notes that mention PVE 9.0 should not be read as excluding later PVE 9.x clients;
  in mid-2026 the practical pairing is current PVE 9.2 with current PBS 4.2.
- Cross-version is best-effort: you _can_ back up PVE 8 to PBS 4 or PVE 9 to PBS 3, but two-or-more
  releases apart is "best-effort only". Keep them on the same major.
- PBS 3.4 gets security/critical fixes only until **August 2026**, so plan to be on PBS 4 by then.

## What PBS gives you over plain vzdump

vzdump (the built-in `vzdump`/`.vma`/`.tar` backups to a `dir`/`nfs` storage) writes a **full,
self-contained archive every run**. PBS instead runs a content-addressed, chunked, deduplicated
datastore. Concretely PBS adds:

- **Client-side deduplication** - data is split into chunks, hashed, and only _new_ chunks are
  uploaded/stored. Identical blocks across VMs, across snapshots, and across time are stored once.
  Huge space win for many similar guests.
- **Incremental "dirty-bitmap" backups for VMs** - for running QEMU VMs, PVE+PBS use a _dirty
  bitmap_ so that after the first backup only changed disk blocks are read and sent. Subsequent
  backups are fast and small while still being restorable as a full point-in-time snapshot. vzdump
  always re-reads the whole disk.
- **Incremental file backups** - `proxmox-backup-client` supports
  `--change-detection-mode=metadata`, which skips re-reading files whose metadata is unchanged, so
  host/CT _file_ backups are also fast on repeat runs.
- **Verification** - every chunk has a checksum; `verify` jobs re-read and validate stored data on a
  schedule, so you find bit-rot _before_ a restore. vzdump has no equivalent integrity check.
- **Encryption** - AES-256-GCM, **client-side**, with a key you control. The server only ever sees
  encrypted chunks (and even dedups them).
- **Live-restore** - for VMs, PVE can start the guest immediately and stream blocks on demand from
  PBS, so a large VM is usable in seconds rather than after a full copy. (This is a PVE-side feature
  when restoring from a `pbs:` storage.)
- **Retention via prune + garbage collection** - `keep-daily/weekly/monthly/...` retention is
  applied by _prune_ (which only removes the snapshot index), then _garbage collection_ (GC)
  actually frees the now-unreferenced chunks. Because of dedup, deleting old snapshots frees only
  the chunks nothing else still needs.
- **Namespaces, sync jobs, tape** - one datastore can hold many isolated namespaces; `sync-job` can
  pull a datastore to a second PBS for off-site copies.

For a one-node homelab the killer features are dedup + incremental + verify + encryption. If you
have only one or two guests and a big disk, vzdump is simpler; once you keep history or have several
guests, PBS pays for itself quickly in space and restore confidence.

## The honest single-node tradeoff (read this first)

**Do not run PBS as a datastore that lives on the same physical disks as the thing it backs up.** If
the node (or its pool) dies, the backups die with it, which defeats the purpose. On a single PVE
node you have three sane options, best first:

1. **Separate cheap box** (mini-PC, an old PC, or even an SBC) running PBS on Debian 13. PVE pushes
   backups to it over the LAN. Survives the PVE node dying. This is the recommended home setup.
2. **Removable USB datastore** that you physically **unplug and store offline** (ideally rotate two
   drives, one off-site). PBS 4 has first-class _removable datastores_: it mounts/unmounts on demand
   and can auto-run a sync on mount. This gives you the 3-2-1 "offline copy" leg cheaply.
3. **PBS in a VM/CT on the same node, datastore on a USB disk** - acceptable only if that USB disk
   is removable/rotated. PBS-as-a-guest-on-the-node alone (with the datastore on the node's own
   pool) is the _risky_ configuration to avoid.

A pragmatic home pattern: PBS on a small separate box for fast nightly backups, _plus_ a removable
USB datastore that you sync to weekly and carry off-site. Even a single separate box is a big step
up from vzdump-to-a-second-folder.

Note: PBS cannot _schedule client backups itself_. The server schedules GC, prune, verify, sync and
tape jobs. **Host/CT file backups via `proxmox-backup-client` must be triggered from the client**
(cron or a systemd timer). PVE guest backups are scheduled on the PVE side as usual.

## Installing PBS accessibly (apt on Debian 13, not the ISO)

The current PBS ISO is not graphical-only: it offers graphical, console, and terminal UI serial
console installer entries. For this corpus, install PBS **on top of a normal Debian 13 ("trixie")
netinst** instead - the Debian installer has a known text/speech path, and the rest of the setup is
ordinary shell work - then add the PBS repo and `apt install`. (Or run PBS inside a VM/CT, but the
host package install is the same apt steps below.)

### 1. Add the Proxmox archive keyring

```bash
wget https://enterprise.proxmox.com/debian/proxmox-archive-keyring-trixie.gpg \
 -O /usr/share/keyrings/proxmox-archive-keyring.gpg

# verify it
sha256sum /usr/share/keyrings/proxmox-archive-keyring.gpg
# expect: 136673be77aba35dcce385b28737689ad64fd785a797e57897589aed08db6e45
```

### 2. Add the PBS repository (Deb822 `.sources` format - new in this generation)

No-subscription (free) repo - file `/etc/apt/sources.list.d/proxmox.sources`:

```text
Types: deb
URIs: http://download.proxmox.com/debian/pbs
Suites: trixie
Components: pbs-no-subscription
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
```

(Enterprise repo, if you have a subscription, is `pbs-enterprise` at
`https://enterprise.proxmox.com/debian/pbs` in `/etc/apt/sources.list.d/pbs-enterprise.sources`. If
you use the no-subscription repo, disable the enterprise one or apt will warn.)

### 3. Install

```bash
apt update
apt full-upgrade -y
apt install proxmox-backup-server
```

The service comes up on `https://<ip>:8007`. You **do not** need that GUI; the
`proxmox-backup-manager` CLI covers everything below.

### Client-only install (e.g. on the PVE node or another Debian box)

To run `proxmox-backup-client` somewhere without the full server, add the **pbs-client** repo
instead and install just the client:

```bash
# /etc/apt/sources.list.d/pbs-client.sources
Types: deb
URIs: http://download.proxmox.com/debian/pbs-client
Suites: trixie
Components: main
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
```

```bash
apt update && apt install proxmox-backup-client
```

(On a PVE 9 node `proxmox-backup-client` is already available, so you usually don't need this.)

## Creating a datastore (on the external / separate disk)

A datastore is just a directory on a filesystem PBS controls. Put it on the external/separate disk,
not the OS disk.

### Plain datastore at an existing path

```bash
# disk already mounted at /backup/disk1 (ext4 or xfs recommended)
proxmox-backup-manager datastore create store1 /backup/disk1/store1
proxmox-backup-manager datastore list
proxmox-backup-manager datastore show store1
```

### Let PBS format a whole disk and add the datastore in one step

```bash
proxmox-backup-manager disk fs create store1 --disk sdX \
 --filesystem ext4 --add-datastore true
# creates ext4 on sdX, mounts at /mnt/datastore/store1, registers datastore store1
```

(For ZFS instead:
`proxmox-backup-manager disk zpool create mypool --devices sdX --raidlevel single --add-datastore`.)

### Removable USB datastore (the offline-copy option)

PBS 4 manages removable datastores itself (it tracks the partition by UUID and mounts/unmounts on
demand - it does _not_ add `/etc/fstab` entries). Devices with only one datastore on them mount
automatically when detected; explicit mount/unmount commands remain useful shell proof of state.
Create the datastore against a backing partition, then mount/unmount it around use:

```bash
# create on a prepared ext4/xfs partition identified by its UUID
proxmox-backup-manager datastore create usbstore /mnt/datastore/usbstore \
 --backing-device <PARTITION-UUID>

# when the drive is plugged in:
proxmox-backup-manager datastore mount usbstore
# ... run backups / sync ...
proxmox-backup-manager datastore unmount usbstore # waits for running tasks
```

If a removable datastore is offline and unmount got stuck, clear its state with:

```bash
proxmox-backup-manager datastore update usbstore --maintenance-mode offline
```

New in PBS 4.0: a `sync-job` can be configured to **run automatically when the removable datastore
is mounted**, so plugging the USB drive in triggers the copy. The concrete flags are
`--run-on-mount true` and, if the drive should detach after the copy, `--unmount-on-done true`:

```bash
proxmox-backup-manager sync-job update <job-id> \
 --run-on-mount true --unmount-on-done true
```

If the removable datastore is not mounted when scheduled jobs fire, PBS skips verify, prune, and
garbage-collection jobs. Sync jobs start and fail with a datastore-not-mounted error so a missed
copy is visible. If you rely on `--unmount-on-done`, consider the datastore `gc-on-unmount` option
so garbage collection has a natural window before PBS detaches the device.

## Users and ACLs

PBS has its own `@pbs` realm. Create a dedicated, least-privilege user for PVE and for host backups
rather than using `root@pam`.

```bash
proxmox-backup-manager user create backup@pbs
proxmox-backup-manager user list

# grant a role on a datastore path
proxmox-backup-manager acl update /datastore/store1 DatastoreBackup --auth-id backup@pbs
# DatastoreAdmin = full; DatastoreBackup = create backups + read own;
# DatastorePowerUser, DatastoreReader, DatastoreAudit are narrower roles.
proxmox-backup-manager acl list
```

For unattended clients, prefer an **API token** over a password:

```bash
proxmox-backup-manager user generate-token backup@pbs pve-node
# prints tokenid backup@pbs!pve-node and a secret (shown once) - store it
proxmox-backup-manager acl update /datastore/store1 DatastoreBackup \
 --auth-id 'backup@pbs!pve-node'
```

## The `proxmox-backup-manager` surface (what you'll actually use)

- `datastore` - create / list / show / update / remove / mount / unmount.
- `user`, `acl` - identities and permissions (above); also `user generate-token`.
- `verify-job` / `verify` - scheduled and manual integrity verification.
- `prune-job` - scheduled retention (deletes snapshot indexes per keep-rules).
- `garbage-collection` (alias context: `datastore update --gc-schedule`) - schedule and
  `garbage-collection start <store>` to run the chunk sweep manually.
- `cert` - `cert info` (read the server fingerprint), cert update.
- `sync-job` - pull from a remote PBS (off-site / second box).
- `disk` - `disk fs create`, `disk zpool create`, list disks.
- `subscription`, `network`, `dns`, `node`, `task` - host/service admin.

## Getting the datastore (server) fingerprint

PVE needs the PBS server certificate's SHA-256 fingerprint to trust a self-signed PBS. On the PBS
host:

```bash
proxmox-backup-manager cert info | grep Fingerprint
# Fingerprint (sha256): 64:d3:ff:3a:50:38:53:5a:9b:f7:50:...:ab:fe
```

Copy that colon-separated string into the PVE storage config below.

## Adding PBS to PVE 9 as storage

### Via `pvesm` (CLI)

```bash
# discover datastores on the server (optional sanity check)
pvesm scan pbs <server> backup@pbs --password

# add it (will prompt for the password since --password has no value)
pvesm add pbs pbs-store1 \
 --server 192.168.1.50 \
 --datastore store1 \
 --username 'backup@pbs' \
 --fingerprint 64:d3:ff:3a:...:ab:fe \
 --password \
 --content backup
```

### Via `/etc/pve/storage.cfg` (the `pbs:` stanza)

```text
pbs: pbs-store1
 server 192.168.1.50
 datastore store1
 username backup@pbs
 fingerprint 64:d3:ff:3a:50:38:53:5a:9b:f7:50:...:ab:fe
 content backup
 namespace home
 prune-backups keep-daily=7,keep-weekly=4,keep-monthly=6
 encryption-key autogen
```

Properties: `server`, `port` (default 8007), `datastore`, `username` (user@realm or
`user@realm!token`), `password`, `fingerprint`, `content backup`, `namespace` (optional, isolates
this PVE's backups inside the datastore), `encryption-key`, `prune-backups`. The secret is **not**
stored in `storage.cfg` in clear - PVE keeps it under `/etc/pve/priv/storage/<STORAGE-ID>.pw`, and
an encryption key under `/etc/pve/priv/storage/<STORAGE-ID>.enc`.

### Client-side encryption from the PVE side

```bash
# generate and store an encryption key for this storage
pvesm set pbs-store1 --encryption-key autogen
# (or feed your own key file). Back this key up off the node - see below.
```

With `encryption-key` set, PVE encrypts guest backups before upload; PBS only stores ciphertext (and
still dedups it).

## Backing up the PVE host's own CONFIG with proxmox-backup-client

vzdump backs up _guests_, not the **host**. The host's `/etc/pve`, `/etc`, network, and package
selection are not in any guest backup. Use `proxmox-backup-client` on the PVE node to capture them
as `.pxar` archives.

```bash
# point the client at the datastore + auth (put in root's env / a script)
export PBS_REPOSITORY='backup@pbs!pve-node@192.168.1.50:store1'
export PBS_PASSWORD='...' # or use a token secret
export PBS_FINGERPRINT='64:d3:ff:3a:...:ab:fe' # trust self-signed cert
export PBS_ENCRYPTION_PASSWORD='...' # if the key is password-protected

# back up the host config as named pxar archives (run as root)
proxmox-backup-client backup \
 pveconf.pxar:/etc/pve \
 etc.pxar:/etc \
 --change-detection-mode=metadata \
 --keyfile /root/.config/proxmox-backup/encryption-key.json
```

Repository format: `[[username@]server[:port]:]datastore`, e.g.
`backup@pbs!pve-node@192.168.1.50:store1` when using the API token created above. Quote token auth
IDs in shell commands because `!` is special in many shells. Archive spec is
`name.pxar:/source/path`.

List and restore:

```bash
proxmox-backup-client snapshot list
# e.g. host/<pve-hostname>/2026-06-10T02:00:01Z

# restore /etc/pve into a staging dir (NEVER restore straight over a live /etc/pve)
proxmox-backup-client restore \
 host/<pve-hostname>/2026-06-10T02:00:01Z \
 pveconf.pxar /root/restore-pveconf/

# single-file/dir extraction is also possible; review then copy back what you need
```

Schedule this from the PVE node with a systemd timer or cron (remember: PBS won't schedule client
backups for you), e.g. a nightly `/usr/local/sbin/host-backup.sh` that exports the env vars and runs
the command above.

## Verify, prune, and garbage-collection scheduling

Run these **on the PBS server** (`proxmox-backup-manager`). They are server-side scheduled jobs
(calendar-event syntax, e.g. `daily`, `Tue 04:27`, `mon..fri 10:30`).

```bash
# Verification: re-check stored chunks, skip recently-verified ones
proxmox-backup-manager verify-job create verify-store1 \
 --store store1 --schedule daily --ignore-verified true --outdated-after 30
proxmox-backup-manager verify store1 # manual, one-off

# Prune: apply retention (removes snapshot indexes only)
proxmox-backup-manager prune-job create prune-store1 \
 --store store1 --schedule 'daily' \
 --keep-daily 7 --keep-weekly 4 --keep-monthly 6

# Garbage collection: free chunks no snapshot references anymore
proxmox-backup-manager datastore update store1 --gc-schedule 'Tue 04:27'
proxmox-backup-manager garbage-collection start store1 # manual, one-off
proxmox-backup-manager datastore update store1 --delete gc-schedule # disable
```

Order matters conceptually: prune marks snapshots gone, GC later reclaims space. Schedule prune
before GC. Verify can run any time; nightly verify of recent backups plus a weekly full GC is a fine
home cadence.

## Encryption key management - keep the key OFF the server

Client-side encryption is only as safe as your key custody, and **if you lose the key you lose every
encrypted backup** - there is no recovery.

```bash
# create a key (default location ~/.config/proxmox-backup/encryption-key.json)
proxmox-backup-client key create
proxmox-backup-client key create /root/store1.key --hint 'home pbs store1'

# make a printable / QR paper backup to store physically off-site
proxmox-backup-client key paperkey /root/store1.key \
 --output-format text > /root/store1-paperkey.txt
```

Rules of thumb:

- Store the key (and a `paperkey` printout) **somewhere other than the PBS server and other than the
  PVE node** - a password manager, an encrypted USB kept off-site, or literally printed paper in a
  drawer.
- Use a password-protected key (`--kdf scrypt`, the default) and remember the password; record both
  the key file and its password separately.
- For PVE storage encryption, the key lives at `/etc/pve/priv/storage/<STORAGE-ID>.enc` - export and
  back it up the same way.
- `encryption-key autogen` in `storage.cfg` is convenient but still produces a key you must copy off
  the node.

## Recommended home strategy (concrete)

1. Run **PBS 4 on a separate cheap box** (mini-PC/old PC) installed via Debian 13 netinst + apt
   (accessible), datastore `store1` on its own disk.
2. Create a least-privilege `backup@pbs` user + an API **token** for the PVE node;
   `acl update /datastore/store1 DatastoreBackup`.
3. On PVE 9, add `pbs: pbs-store1` to `storage.cfg` (server, datastore, token username, fingerprint,
   `content backup`, a `namespace`, `encryption-key autogen`,
   `prune-backups keep-daily=7,keep-weekly=4,keep-monthly=6`). Schedule nightly guest backups to it
   on the PVE side.
4. Add a **systemd timer on the PVE node** running
   `proxmox-backup-client backup pveconf.pxar:/etc/pve etc.pxar:/etc` so the _host_ config is
   captured too.
5. On PBS: `verify-job` daily, `prune-job` daily, `--gc-schedule` weekly.
6. Add a **removable USB datastore** + a `sync-job` that runs on mount; rotate two USB drives and
   keep one off-site. That is your offline 3-2-1 leg.
7. **Export the encryption key + paperkey off both machines** and test a restore of one guest and of
   `pveconf.pxar` before you rely on any of it.

## PBS 4 deltas vs PBS 3 (flag these)

- **Base OS bump**: Debian 12 to **Debian 13 "trixie"**. PBS 4.0 launched with kernel 6.14 and **ZFS
  2.3.3**; current PBS 4.2 uses kernel 7.0 and **ZFS 2.4.1**. This matches the PVE 9 / Debian 13
  generation.
- **APT repos moved to Deb822 `.sources` format** (server no-subscription component is now
  `pbs-no-subscription`; the client-only repo uses component `main`). The keyring is
  `proxmox-archive-keyring-trixie.gpg`. Old single-line `.list` entries are gone.
- **Removable datastores are first-class**: a device with one datastore can auto-mount when
  detected, and sync jobs can auto-run when the medium is mounted via `--run-on-mount true` (new in
  4.0) - directly useful for the offline-USB pattern.
- **S3-compatible object store as a datastore backend** - introduced as native support in 4.0;
  current 4.2 docs and release notes describe S3-backed datastores as supported, with 4.1 adding S3
  rate limiting and 4.2 adding request stats/notifications. It is useful as an off-site leg, but do
  not make any single S3 provider or datastore your only independent copy.
- **4.1**: user-based traffic control (bandwidth limits per user), configurable verify-job
  parallelism. **4.2**: move backup groups/namespaces within a datastore for reorganizing without
  re-uploading.
- Upgrade path PBS 3 to 4 is an in-place dist-upgrade (see the official "Upgrade from 3 to 4" wiki);
  PBS 3.4 is supported only until **August 2026**.

## Gotchas

- **PBS does not schedule client/host backups.** Only GC, prune, sync, verify and tape are
  server-scheduled. `proxmox-backup-client` runs must be cron/timer-driven on the client. (Confirmed
  in the PBS proxy `schedule_tasks()` source.)
- **Same-node backups are not a backup.** A datastore on the PVE node's own pool dies with the node.
  Separate box or removable/offline disk - be explicit about this.
- **Lose the encryption key = lose the backups.** No vendor recovery. Keep key + paperkey off both
  machines.
- **Prune frees nothing by itself** - space only returns after GC. If a datastore fills up, run
  `garbage-collection start store1`, not just prune.
- **Fingerprint must match.** If you regenerate the PBS cert, update `fingerprint` in `storage.cfg`
  / `PBS_FINGERPRINT` or clients refuse to connect.
- **Don't restore `pveconf.pxar` directly over a live `/etc/pve`.** Restore to a staging dir and
  copy back the specific files.
- **BTRFS host root note**: PBS itself prefers **ext4 or xfs** for the _datastore_ filesystem. The
  reader's PVE _host root_ being BTRFS is irrelevant to PBS; just don't put the datastore on a BTRFS
  subvolume if you can use ext4/xfs/ZFS instead.
- **Disable the enterprise repo** if unsubscribed, or `apt update` errors on a 401.

## Citations

- PBS 4 install on Debian (keyring, `.sources`, apt):
  [Installation](https://pbs.proxmox.com/docs/installation.html)
- Backup storage, datastores, removable datastores, GC schedule:
  [Backup Storage](https://pbs.proxmox.com/docs/storage.html)
- Maintenance (verify, GC start, GC schedule):
  [Maintenance Tasks](https://pbs.proxmox.com/docs/maintenance.html) ; GitHub
  [proxmox-backup/docs/maintenance.rst at master · proxmox/proxmox-backup](https://github.com/proxmox/proxmox-backup/blob/master/docs/maintenance.rst)
- backup-client (pxar archives, env vars, encryption keys, restore, change-detection-mode):
  [Backup Client Usage](https://pbs.proxmox.com/docs/backup-client.html)
- proxmox-backup-manager man page (datastore/user/prune-job/verify-job):
  [proxmox-backup-manager](https://pbs.proxmox.com/docs/proxmox-backup-manager/man1.html)
- proxmox-backup-client man page (key create/paperkey):
  [proxmox-backup-client](https://pbs.proxmox.com/docs/proxmox-backup-client/man1.html)
- User management / ACL roles: [User Management](https://pbs.proxmox.com/docs/user-management.html)
- PVE-side storage stanza + `pvesm add pbs` + fingerprint:
  [Storage: Proxmox Backup Server](https://pve.proxmox.com/wiki/Storage:_Proxmox_Backup_Server)
- PBS 4.0 release notes (Debian 13, kernel, ZFS, native S3 support, sync-on-mount):
  [Proxmox Backup Server 4.0 released!](https://forum.proxmox.com/threads/proxmox-backup-server-4-0-released.169306/)
- PBS 4.1 / 4.2 release notes:
  [Proxmox Backup Server 4.1 released!](https://forum.proxmox.com/threads/proxmox-backup-server-4-1-released.176866/)
  ;
  [Proxmox Backup Server 4.2 released!](https://forum.proxmox.com/threads/proxmox-backup-server-4-2-released.183129/)
- Upgrade PBS 3 to 4: [Upgrade from 3 to 4](https://pbs.proxmox.com/wiki/Upgrade_from_3_to_4)
- PVE 9 / Debian 13 pairing:
  [Proxmox Virtual Environment 9.0 with Debian 13 released](https://www.proxmox.com/en/about/company-details/press-releases/proxmox-virtual-environment-9-0)
- Server-side job scheduler (no client backup scheduling), repo:
  [Proxmox backup proxy (github.com)](https://github.com/proxmox/proxmox-backup/blob/master/proxmox-backup/src/bin/proxmox-backup-proxy.rs)
