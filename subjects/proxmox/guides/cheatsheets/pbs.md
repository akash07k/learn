# Cheatsheet: pbs (backup client and Backup Server manager)

Proxmox Backup Server has two command-line tools, and which host you run them on is the whole point.
`proxmox-backup-client` runs where the data is: on the PVE node (for host-config archives) or inside
a guest, pushing backups into a datastore. `proxmox-backup-manager` runs ON the PBS host itself,
administering datastores, users, and the server-side jobs (prune, verify, garbage collection, sync).
Everything here is plain text you run as root over SSH, with no web GUI anywhere. PBS is amd64-only:
there is no official arm64 server or client, so the off-box Raspberry Pi copy either runs a
community arm64 build or takes a cold copy instead, both covered in guide 18. For the why and the
worked builds, see the full guides
[17 -- Backups with Proxmox Backup Server](../17-backups-with-pbs.md) (the push-from-PVE primary)
and [18 -- The independent copy and restore](../18-the-independent-copy-and-restore.md) (the off-box
Pi pull and the restore drills).

Never put a password, passphrase, or token secret inline on a command line where it lands in your
shell history and `ps` output; use the env-var or prompted forms shown below.

## proxmox-backup-client: back up and restore

Run these on the PVE node or inside the guest, where the data lives. The repository and credentials
come from the environment variables in the next section.

- `proxmox-backup-client backup pveconf.pxar:/etc/pve etc.pxar:/etc` -- back up host paths as
  [pxar archives](../GLOSSARY.md); the spec is `<name>.pxar:<path>`, one per path.
- `proxmox-backup-client backup pveconf.pxar:/etc/pve --change-detection-mode=metadata --keyfile /root/store1.key`
  -- the same with fast metadata-only re-scan and a named encryption key.
- `proxmox-backup-client snapshot list` -- list snapshots in the repository (e.g. `vm/100/...`,
  `ct/105/...`, `host/<hostname>/...`).
- `proxmox-backup-client restore host/<hostname>/<timestamp> pveconf.pxar /root/restore-staging/` --
  restore one archive from a snapshot into a directory. NEVER restore the host config over the live
  `/etc/pve` (it is the pmxcfs FUSE mount); restore to a staging path and copy files in
  deliberately.

## proxmox-backup-client: keys and repository

The client finds its target and credentials in environment variables, set in a root-only file
(`chmod 600`), never typed inline. `PBS_REPOSITORY` is `[[user@]server[:port]:]datastore`, for
example `backup@pbs!pve-node@192.168.1.50:store1` (the `--repository` flag takes the same form).
`PBS_PASSWORD` holds the user password or token secret; `PBS_FINGERPRINT` is the PBS TLS
[fingerprint](../GLOSSARY.md), which must match or the client refuses to connect. PBS 4.2 also
accepts the repository broken into individual flags -- `--server`, `--port`, `--datastore`, and
`--auth-id` -- as a clearer alternative to packing it all into one `--repository` string. `--ns` is
separate: it selects the namespace within the datastore, not part of the repository string.

`PBS_ENCRYPTION_PASSWORD` unlocks a password-protected key file; set it only if the key has one.
Caution: a wrong, missing, or unreadable key gives backups that fail SILENTLY until you try to
restore, and a lost key is unrecoverable, with no vendor recovery.

- `proxmox-backup-client key create /root/store1.key --hint 'home pbs store1'` -- create a
  client-side encryption key.
- `proxmox-backup-client key paperkey /root/store1.key --output-format text > /root/store1-paperkey.txt`
  -- a printable paper backup of the key; store it off the node and off the PBS host.
- `proxmox-backup-client key change-passphrase /root/store1.key` -- change the passphrase protecting
  the key file.
- `--keyfile /root/store1.key` -- point a `backup` or `restore` at a specific key.

## proxmox-backup-manager: datastores

Run these ON the PBS host. A datastore is a directory on a filesystem PBS controls; on this corpus
it lives on the external USB HDD, never the internal NVMe.

- `proxmox-backup-manager datastore create store1 /mnt/datastore/store1` -- create a plain datastore
  against an existing path.
- `proxmox-backup-manager datastore create usbstore /mnt/datastore/usbstore --backing-device <PARTITION-UUID>`
  -- a removable datastore tracked by partition UUID, mounted on demand (no `/etc/fstab` entry).
- A removable device with only one datastore can mount automatically when PBS detects it; explicit
  mount and unmount commands remain the clearest shell proof of state.
- `proxmox-backup-manager datastore mount usbstore` -- mount a removable datastore before use.
- `proxmox-backup-manager datastore unmount usbstore` -- unmount it; waits for running tasks first.
- `proxmox-backup-manager sync-job update <job-id> --run-on-mount true` -- run a relevant sync job
  automatically when its removable datastore is mounted.
- `proxmox-backup-manager sync-job update <job-id> --unmount-on-done true` -- detach the removable
  datastore after that sync job finishes; this requires `--run-on-mount true`.
- When a removable datastore is absent, verify, prune, and GC jobs are skipped; sync jobs fail with
  an error so a missed copy is visible.
- `proxmox-backup-manager datastore list` -- list datastores.
- `proxmox-backup-manager datastore show store1` -- show one datastore's path and properties.
- `proxmox-backup-manager datastore update store1 --gc-schedule 'Tue 04:27'` -- change a datastore
  property, such as the GC schedule.

## proxmox-backup-manager: disk (DESTRUCTIVE)

These erase the entire target disk. Confirm the device against its stable `/dev/disk/by-id/` name
first; `sdX` below is a placeholder, not a literal.

- `proxmox-backup-manager disk fs create store1 --disk sdX --filesystem ext4 --add-datastore true`
  -- DESTRUCTIVE: format a whole disk (ext4 here) and register the datastore in one step.
- `proxmox-backup-manager disk zpool create store1 --devices sdX --raidlevel single --add-datastore true`
  -- DESTRUCTIVE: create a ZFS pool on the disk and add the datastore.

## proxmox-backup-manager: users and access

PBS has its own user database and `@pbs` realm, separate from PVE's identities. Prefer a dedicated
least-privilege user and an API token over reusing `root@pam`.

- `proxmox-backup-manager user create backup@pbs` -- create a PBS-realm user. For unattended backup
  clients, leave it passwordless and use a token; current PBS CLI docs show `--password` as a
  value-taking option, not an interactive prompt.
- `proxmox-backup-manager user list` -- list users.
- `proxmox-backup-manager user generate-token backup@pbs pve-node` -- generate an API token (prints
  `backup@pbs!pve-node` and a secret shown ONCE; capture it now).
- `proxmox-backup-manager acl update /datastore/store1 DatastoreBackup --auth-id backup@pbs` --
  grant a role on the datastore path. `DatastoreBackup` can create backups and read its own;
  `DatastoreReader` is the minimal read-only role (used for the off-box sync puller in guide 18).
- `proxmox-backup-manager acl update /datastore/store1 DatastoreReader --auth-id sync@pbs` -- grant
  the sync token's owning user the same read-only ceiling; PBS token permissions are intersected
  with owner permissions.
- `proxmox-backup-manager acl update /datastore/store1 DatastoreReader --auth-id 'sync@pbs!offbox'`
  -- the read-only grant for a sync token. Create this ON THE PRIMARY: it is the credential the Pi's
  pull job authenticates with against the primary (guide 18).
- `proxmox-backup-manager acl list` -- list ACL entries.

## proxmox-backup-manager: jobs (prune, verify, GC, sync)

Run on the PBS host. These are PBS's own scheduled maintenance; schedules use systemd calendar-event
syntax (validate with `systemd-analyze calendar`). The model to keep straight: prune only MARKS
snapshots as removable and frees no space; garbage collection RECLAIMS the space by deleting
unreferenced chunks. Run prune first, then GC.

- Scheduled prune with a keep-\* retention policy:

  ```bash
  proxmox-backup-manager prune-job create prune-store1 --store store1 --schedule daily --keep-daily 7 --keep-weekly 4 --keep-monthly 6
  ```

- Scheduled [verify](../GLOSSARY.md) that re-reads chunks and checks them against their checksums:

  ```bash
  proxmox-backup-manager verify-job create verify-store1 --store store1 --schedule daily --ignore-verified true --outdated-after 30
  ```

- `proxmox-backup-manager verify store1` -- a manual, one-off verify.
- `proxmox-backup-manager garbage-collection start store1` -- a manual, one-off GC; DELETES chunks
  no surviving snapshot references.
- `proxmox-backup-manager garbage-collection status store1` -- report the last GC run, chunks
  examined, and space reclaimed.
- A sync job. It always PULLS the remote datastore INTO the local `--store`, so in guide 18 this
  runs ON THE PI to pull the primary's store into the Pi's own. `--remove-vanished false` keeps the
  off-box copy when snapshots vanish on the primary; that independence is the whole point:

  ```bash
  proxmox-backup-manager sync-job create sync-offbox --store store1 --remote primary --remote-store store1 --schedule weekly --remove-vanished false
  ```

- `proxmox-backup-manager sync-job list` -- list sync jobs (run on the host that owns them, the Pi).

## proxmox-backup-manager: remotes and certs

- Define a remote PBS to pull from. In guide 18 this runs ON THE PI, naming the primary as its
  source; `--password` with no value prompts for the token secret:

  ```bash
  proxmox-backup-manager remote create primary --host 192.168.1.50 --auth-id 'sync@pbs!offbox' --password --fingerprint <PRIMARY-PBS-FINGERPRINT>
  ```

- `proxmox-backup-manager cert info` -- print this host's TLS certificate details; pipe to
  `grep Fingerprint` to read the sha256 fingerprint that clients and remotes must trust.

## Full treatment

This card is a reminder, not a lesson. For the why and worked examples, see:

- [17 -- Backups with Proxmox Backup Server](../17-backups-with-pbs.md) -- the primary: datastore on
  the USB HDD, the backup user and token, client-side encryption keys, the host-config
  `proxmox-backup-client backup`, and the verify/prune/GC cycle.
- [18 -- The independent copy and restore](../18-the-independent-copy-and-restore.md) -- the off-box
  Pi second copy (community arm64 PBS plus a pull sync job, or a cold `zfs send`/rsync copy), and
  the `qmrestore`/`pct restore`/`proxmox-backup-client restore` drills.

---

Back to the [cheatsheets index](README.md). Browse all the [guides](../README.md).
