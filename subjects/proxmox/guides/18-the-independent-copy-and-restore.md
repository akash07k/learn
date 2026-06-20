# The independent copy and restore

## What you'll be able to do

By the end of this guide you will be able to stand up a genuine off-box second copy of your backups
on the Raspberry Pi 4B, by either of two routes, and then prove the whole chain works by restoring
guests and the host configuration. This is written now to be implemented later: the Raspberry Pi
backup target is provisioned in a future step, so treat this as the plan you run once the Pi is
connected. The commands are ready to use then; where a step needs the Pi to exist, it is phrased as
a "when the Pi is in place, confirm it like this" check rather than something to run today.

For the non-interactive editing convention used for every config file below (here-doc, `tee`, or a
drop-in, never assuming vim or nano), see the "Editing files accessibly" section of guide
[02 -- The shell and the API](02-the-shell-and-the-api.md).

## Why a second copy off the box

Guide [17 -- Backups with Proxmox Backup Server](17-backups-with-pbs.md) builds the primary backup:
a [Proxmox Backup Server (PBS)](GLOSSARY.md) VM on this node, with its [datastore](GLOSSARY.md) on
an external USB HDD. That is a real improvement over no backup, but it shares one fatal property
with the guests it protects: it lives on the same physical machine. A node death, a theft, a flood,
or ransomware that reaches the host could take the guests and their only backup in a single event. A
backup that can die in the same incident as the original is not really a second copy.

The fix is the [3-2-1 backup rule](GLOSSARY.md): at least three copies of your data, on two kinds of
media, with one copy off the box. The architecture recorded in
[docs/adr/0002](../docs/adr/0002-backup-architecture.md) puts the independent off-box copy on the
Raspberry Pi 4B (8 GB): a separate machine, separate power, and a separate disk, so node death
cannot destroy both copies. An optional third leg, a second external USB HDD rotated off-site,
completes a true 3-2-1.

This guide gives you two ways to build that Pi copy, and you pick one. Option A (preferred) runs a
community arm64 PBS on the Pi, fed by a PBS [sync job](GLOSSARY.md), so the second copy is itself a
deduplicated, directly-restorable PBS. Option B stays entirely on official software, sending a cold
copy of the datastore to the Pi with `zfs send` or `rsync`. Both are off-box; they differ in what
software runs on the Pi and how quickly you can restore from it. Again, written now to be
implemented later: none of this assumes the Pi or a second PBS already exist. Stand the Pi up first,
then run the option you chose.

## The amd64-only reality

State this plainly before the options, because it is the reason there are two: PBS is officially
amd64-only. There is no official arm64 (aarch64) PBS server, and there is no official arm64 PBS
client either, even though Proxmox does ship an amd64 client. The Raspberry Pi 4B is an arm64
machine, so it cannot run official PBS at all. That single fact is what forces the choice below:
either you run an unofficial community arm64 build of PBS on the Pi (Option A), or you keep PBS off
the Pi entirely and use the Pi as a plain cold-copy target with official software only (Option B).

## Option A (preferred): community arm64 PBS on the Pi, fed by a sync job

The preferred architecture per ADR-0002: run a community arm64 build of PBS on the Pi as a second
datastore, and have the primary PBS feed it with a scheduled sync job. The result is a real,
directly-restorable second PBS with [deduplication](GLOSSARY.md) preserved, on independent hardware.

### Building it

The maintained community project is `wofferl/proxmox-backup-arm64`, which compiles the Proxmox
source into unofficial arm64 `.deb` packages for both the server and the client. Its `main` branch
targets PBS 4.x on Debian 13 ("trixie"), the same generation as this node. On a 64-bit Pi OS or
Debian 13 arm64, the fast path installs prebuilt packages. Before running these, read "The trust
caveat" below: `build.sh` runs code from the internet as root on the Pi, so understand what you are
about to execute first.

```bash
git clone https://github.com/wofferl/proxmox-backup-arm64
cd proxmox-backup-arm64

# install the latest prebuilt arm64 packages:
./build.sh install

# ...or pin a specific version to match your current PBS release:
./build.sh install=4.2.1-1

# ...or just fetch the .debs without installing:
./build.sh download
```

The `install=4.2.1-1` value is an EXAMPLE version, not a literal to copy blindly. Match it to
whatever PBS release the primary node is running, so the Pi's PBS speaks the same generation as the
source. Check the project's releases page for the current tag.

Two operational notes from the project. Compiling from source needs at least 4 GB of RAM (the
prebuilt `install`/`download` paths avoid that). And the official Proxmox apt repo does not serve
arm64, so disable any PBS enterprise repo file on the Pi or its `apt update` will break:

```bash
sudo sed -i 's#^Enabled:.*#Enabled: false#g' \
  /etc/apt/sources.list.d/pbs-enterprise.sources
```

One caveat that does NOT apply to you: the Raspberry Pi 5 needs a 4k-page kernel pinned for PBS to
work, but the Pi 4B is unaffected, so you can ignore that workaround on this hardware.

### The trust caveat (read this)

Be honest about what `build.sh` is: it is a curl-pipe-to-root-style act of trust. You are running a
third party's build harness, and ultimately third-party-compiled binaries of your backup system,
with root on the Pi. This is the same class of risk as the Helper-Scripts one-liners, and the same
mitigations apply; see "The curl-pipe-to-root caveat (read this)" section of guide
[16 -- Automation and the ecosystem](16-automation-and-the-ecosystem.md) rather than re-deriving it
here. In short: read the script before running it, pin a reviewed commit rather than tracking `main`
blindly, and review what you are about to execute.

What makes this acceptable is blast radius. Per ADR-0002, the unsupported community component is
confined to the SECONDARY copy. The primary, fast, frequently-used backup is official amd64 PBS on
the node (guide 17); the unofficial build is pushed to the off-box second copy, where slowness and
lack of support are tolerable and a compromise does not poison your primary store. Still, go in with
eyes open about the maintenance realities: there is no Proxmox support (the forum will tell you not
to ask), you carry the supply-chain trust yourself, you are on an update treadmill that tracks one
maintainer's releases rather than the official apt repo, and a single-maintainer project carries
bus-factor risk if it ever stalls.

### The sync job

With PBS running on the Pi, the Pi pulls from the primary. A PBS sync job always PULLS the remote
datastore INTO the local `--store` on the host where the job runs, so to land the copy on the Pi the
remote and the sync job are both defined ON THE PI: the Pi treats the primary as its `remote` and
pulls the primary's datastore into the Pi's own local datastore. A pull from the second-copy side is
also the more secure direction, because the off-box Pi reaches in to the primary rather than the
primary holding credentials that can write to the off-box copy.

The pull needs a credential that exists ON THE PRIMARY, and it must be a different one from guide
17's `backup@pbs`. That account is the push-side identity PVE uses to WRITE backups into the
primary; the off-box puller only needs to READ the primary's snapshots, never write them, so least
privilege says give it its own read-only account rather than reusing the writer. Create a dedicated
sync user and an [API token](GLOSSARY.md) for it, then grant only the read role on the datastore.
The user, token, and role concepts are in guide
[13 -- Users, permissions, and API tokens](13-users-permissions-and-api-tokens.md); `backup@pbs`
itself was created in guide [17 -- Backups with Proxmox Backup Server](17-backups-with-pbs.md). Run
this ON THE PRIMARY PBS (the source the Pi pulls from):

```bash
# on the PRIMARY PBS: create a read-only identity for the off-box puller
proxmox-backup-manager user create sync@pbs
proxmox-backup-manager user generate-token sync@pbs offbox
# prints tokenid sync@pbs!offbox and a secret shown ONCE -- capture it now
proxmox-backup-manager acl update /datastore/store1 DatastoreReader \
  --auth-id sync@pbs
proxmox-backup-manager acl update /datastore/store1 DatastoreReader \
  --auth-id 'sync@pbs!offbox'
```

Current PBS CLI docs show `user create --password` as a value-taking option, not a prompt, so this
sync-only identity is created without a password. `generate-token` prints the token secret exactly
once; that secret is what the Pi's `remote create` below asks for. API token permissions are
intersected with the owning user's permissions, so both `sync@pbs` and `sync@pbs!offbox` need the
same read-only grant. `DatastoreReader` is the minimal read-capable role on the datastore, which is
all a sync pull needs. With that read-only `sync@pbs!offbox` token now existing on the primary,
define the remote on the Pi's PBS:

```bash
# tell the Pi's PBS how to reach the primary PBS (the source it pulls from)
proxmox-backup-manager remote create primary \
  --host 192.168.1.50 \
  --auth-id 'sync@pbs!offbox' \
  --password \
  --fingerprint <PRIMARY-PBS-FINGERPRINT>

# create the sync job: pull the primary's store1 INTO the Pi's local store1,
# weekly, keeping vanished snapshots
proxmox-backup-manager sync-job create sync-offbox \
  --store store1 \
  --remote primary \
  --remote-store store1 \
  --schedule weekly \
  --remove-vanished false
```

Here `--store store1` is the Pi's OWN local datastore (the pull destination), while
`--remote primary` and `--remote-store store1` name the primary node and its datastore (the source).
The single most important flag is `--remove-vanished false`. With it, deleting (or pruning) a
snapshot on the primary never deletes the off-box copy on the Pi. The Pi keeps snapshots
independently, which is the whole point of an independent copy: a mistake or a ransomware deletion
on the primary does not propagate to the second copy. The `--fingerprint` is the PRIMARY PBS's TLS
[fingerprint](GLOSSARY.md), read ON THE PRIMARY with
`proxmox-backup-manager cert info | grep Fingerprint`, exactly as in guide 17. Giving `--password`
no value makes the command prompt for the secret instead of leaving it in your shell history. The
`--schedule weekly` value uses systemd calendar-event syntax; validate any schedule you pick with
`systemd-analyze calendar weekly`, the validator introduced in guide 17's scheduling section.

### Performance reality

The Pi 4B is a second-copy target, not a hot store. PBS hashes every chunk with SHA-256, and the
Pi's CPU has no SHA acceleration, while the datastore lives on a USB-attached HDD with poor random
IOPS. The CPU-and-IO-heavy operations, verify and garbage collection, are therefore slow on the Pi.
So schedule the sync and the verify weekly or monthly, not after every backup. Day-to-day this is
fine, because dedup means only changed chunks move; it is the periodic full re-read that is slow,
and you simply do not run that often. Treat the Pi as the resilient second copy it is, and keep the
fast restores expectation on the primary.

### Verify it worked

On the Pi (the host that owns the sync job):

```bash
proxmox-backup-manager sync-job list
```

When the Pi is in place, this lists `sync-offbox` with its local store (`store1`), its remote
(`primary`), and its schedule. After a sync run completes, the snapshots pulled from the primary
appear on the Pi's datastore; still on the Pi:

```bash
proxmox-backup-manager datastore list
proxmox-backup-client snapshot list   # with the Pi datastore in PBS_REPOSITORY
```

The Pi's `store1` should now hold the same `vm/<vmid>/...`, `ct/<vmid>/...`, and
`host/<hostname>/...` snapshots as the primary.

## Option B (all-supported): a cold copy with zfs send or rsync

If you are unwilling to run unsupported software anywhere on the backup path, keep PBS entirely on
the node and use the Pi as a plain cold-copy target with official software only. The cost is that
the Pi copy is not a queryable PBS: it is cold storage until you attach it under a PBS to restore.

The cleaner of the two forms is `zfs send`. The primary datastore on the node sits on a ZFS dataset
(per ADR-0002), so snapshot that dataset and stream it to a ZFS-on-USB disk on the Pi over SSH. The
`zfs send`/`zfs receive` mechanics, including the incremental `-i` form that transfers only the
delta between two snapshots, are taught in guide [09 -- Storage](09-storage.md); this guide shows
only the backup-specific framing. Snapshot the datastore dataset, then send it:

```bash
# on the node: snapshot the datastore dataset, then stream it to the Pi
zfs snapshot usbpool/store1@offbox-2026-06-11
zfs send usbpool/store1@offbox-2026-06-11 | \
  ssh pi 'zfs receive pipool/store1'

# later, incremental: send only the delta to the Pi
zfs send -i usbpool/store1@offbox-2026-06-11 \
  usbpool/store1@offbox-2026-07-11 | ssh pi 'zfs receive pipool/store1'
```

The alternative is `rsync` of the datastore directory. To get a consistent copy, run rsync against a
read-only snapshot of the dataset, not the live datastore that PBS may be writing to:

```bash
# rsync from a snapshot's mountpoint (consistent), not the live store
rsync -aH --delete \
  /usbpool/store1/.zfs/snapshot/offbox-2026-06-11/ \
  pi:/pipool/store1/
```

The trade-off versus Option A: this is fully supported software end to end, but the Pi copy is
"cold." No PBS runs on the Pi, so the copy is not directly restorable as-is. To restore from it you
attach the disk under a PBS, either the recovered node's PBS or a temporary PBS, and point a
datastore at the copied chunk store. It is a genuine independent copy and entirely shell-driven; it
simply costs you the immediacy and the queryability that Option A's running PBS gives.

### Verify it worked

After a send or rsync, confirm the copy landed on the Pi. For ZFS:

```bash
ssh pi 'zfs list -t snapshot pipool/store1'
```

When the Pi is in place, the Pi's `pipool/store1` lists the snapshot you just sent (or, for rsync,
the datastore directory on the Pi contains the chunk store with a matching size). The real proof,
that this cold copy restores, is the drill in the next sections after you attach it under a PBS.

## The off-site third copy (a real 3-2-1)

The Pi gives you the off-box second copy. The optional third leg from ADR-0002 makes it a true
3-2-1: a copy that survives losing the whole site. The practical home form is a second external USB
HDD that you rotate off-site, receiving the newest snapshots on the same `zfs send` or `rsync`
mechanics as Option B (or, if it is another PBS, a sync job as in Option A). Keep two such disks and
swap them, so one is always away from the building.

The point is geographic separation: the node, the Pi, and the on-site USB disk all live in the same
place, so a single fire, theft, or ransomware event could still reach all of them. A disk that
spends most of its life off-site is the copy that survives that. It need not be frequent; even a
monthly rotation of the newest snapshots to an off-site disk closes the 3-2-1 gap that the Pi alone
leaves open.

## Restore drills: prove it comes back

This is the heart of the guide. A backup you have never restored is a guess, so the discipline is to
restore on a schedule, not only in a disaster. The drill is deliberately NON-DESTRUCTIVE: restore to
a NEW, unused VMID or CTID with a fresh MAC, boot it, confirm it works, then destroy it. You never
restore over a live guest during a drill.

You address a PBS backup by its `pbs:` storage volid (the storage you added in guide 17, plus the
snapshot path). For a VM, `qmrestore` writes a new guest from that backup:

```bash
# restore the VM snapshot into a NEW, unused VMID (here 999), with a fresh MAC
qmrestore pbs-store1:backup/vm/100/2026-06-11T02:30:01Z 999 \
  --storage local-btrfs --unique
```

For a container, `pct restore` does the same:

```bash
# restore the CT snapshot into a NEW, unused CTID (here 999), fresh MAC, onto local
pct restore 999 pbs-store1:backup/ct/105/2026-06-11T02:30:01Z \
  --storage local-btrfs --unique
```

Two flags carry the whole safety story. `--unique` assigns fresh random MAC addresses, so the
restored copy does not collide on the network with the original that is still running. And the new
ID (999 above) means you are creating a throwaway guest beside the real one, never touching it. The
explicit `--storage local-btrfs` matters on this btrfs-root host because the plain `local` storage
is disabled, and the restore tools otherwise default to `local` for containers or to the backup's
recorded storage for VMs.

Contrast that with `--force`. The `--force` flag overwrites an EXISTING guest with that id, which is
destructive: it replaces the live guest's disks with the backup. That is the deliberate
disaster-recovery case, when you really do mean to roll a specific guest back, and you run it
knowingly. It is never part of a drill. Use the safe new-id form to test; reserve `--force` for the
moment you have decided to overwrite.

If you ever reach that disaster-recovery moment, make the existing guest id your confirmation token
before you type `--force`:

```bash
TARGET_VMID=100
qm list | grep "^ *$TARGET_VMID "
printf 'About to overwrite VMID %s from backup. Type the VMID to continue: ' "$TARGET_VMID"
read CONFIRM_VMID
[ "$CONFIRM_VMID" = "$TARGET_VMID" ] || { echo 'Aborted.'; exit 1; }
```

Only then run the destructive restore, substituting the same `$TARGET_VMID` as the destination id.

One restore feature is PBS-specific. `--live-restore` starts the VM immediately and streams its
blocks from PBS in the background, so a large VM is usable in seconds. It works only FROM PBS (a
`pbs:` storage); it does NOT work from a one-off `vzdump` `.vma.zst` or `.tar.zst` file. So it is
available for these PBS restores, but not for a restore off a loose vzdump archive.

Cadence: run a drill monthly. Restore one guest to a throwaway id, boot it, confirm it actually
serves, then destroy it. The cost is a few minutes; the payoff is knowing, rather than hoping, that
the chain works.

### Verify it worked

The throwaway guest boots and does its job (it serves its service, answers on its console, whatever
"working" means for that guest), proving the backup is genuinely restorable. Then you destroy it so
it leaves nothing behind. `qm destroy` and `pct destroy` are irreversible, so confirm with `qm list`
/ `pct list` that `999` is still the throwaway you just restored (and not a guest you have since
reused) before running them:

```bash
qm destroy 999     # for the test VM
pct destroy 999    # for the test container
```

A clean boot followed by a clean destroy is the whole signal: the backup restored, ran, and left no
clutter.

## Configuration disaster recovery

Restoring guests assumes a working PVE host. If the internal NVMe dies, you must rebuild the host
first, and the host's own configuration (`/etc/pve`, network, fstab, apt) is in no guest backup.
Guide 17 captures it for you as the [pxar archives](GLOSSARY.md) `pveconf.pxar` and `etc.pxar` with
[proxmox-backup-client](GLOSSARY.md); this section restores from them.

The hard rule, do not soften it: restore the config archive into a STAGING directory, NEVER over the
live `/etc/pve`. `/etc/pve` is the pmxcfs FUSE mount, not an ordinary directory, and writing a
restored tree straight onto it corrupts the cluster filesystem. Restore to a plain staging path,
then copy in the specific files you need, deliberately:

```bash
# restore the host-config archive into a staging dir, never over live /etc/pve
proxmox-backup-client restore \
  host/<pve-hostname>/2026-06-10T02:00:01Z \
  pveconf.pxar /root/restore-staging/
```

That reads the `host/...` snapshot and unpacks `pveconf.pxar` (the captured `/etc/pve`) into
`/root/restore-staging/`. The credentials come from the `PBS_REPOSITORY`, `PBS_FINGERPRINT`, and key
variables exactly as in guide 17.

The recovery order, then:

- Install a fresh PVE 9 host base on the replacement disk.
- Restore the config archives to a staging directory (the command above), not over live `/etc/pve`.
- Reapply the network, storage, and job configuration by copying the needed files from staging in
  deliberately (the high-value path list, `/etc/pve` and `/etc/network/interfaces` and `/etc/fstab`
  and `/etc/apt`, is in guide 17's host-config backup section).
- Re-add the `pbs:` storage so the host can reach the backups again (guide 17).
- Restore the guests from PBS with `qmrestore` and `pct restore` as above.

Cross-reference: guide 17 is where the `pveconf.pxar`/`etc.pxar` archives came from and where the
high-value host-config path list to reapply is given.

### Verify it worked

Before you copy anything into the live system, inspect the staging directory:

```bash
ls -R /root/restore-staging/etc/pve
```

When the restore has run, the staging tree contains the restored `/etc/pve` (the `qemu-server/` and
`lxc/` guest configs, `storage.cfg`, `jobs.cfg`, and so on), and those guest config files are
readable as plain text. Confirm that BEFORE copying any file onto the live host. A readable staging
tree is the signal that the host-config backup is intact and the recovery can proceed.

## Sources

- `research/round2-pve9/21-pbs-on-raspberry-pi.md` -- grounded the amd64-only reality (no official
  arm64 server or client), the `wofferl/proxmox-backup-arm64` community build (`./build.sh install`
  / `install=4.2.1-1` / `download`, the ~4 GB RAM to compile, disabling the arm PBS enterprise repo,
  the Pi 5 4k-page caveat not applying to the Pi 4B), the trust and maintenance caveats, the
  sync-job-with-`remove-vanished=false` approach, the SHA-256-plus-USB-HDD performance reality, and
  the second-copy framing.
- `research/round2-pve9/15-pve9-backup-and-restore.md` -- grounded the restore commands
  (`qmrestore <archive> <vmid>` and `pct restore <vmid> <archive>` with `--unique`, `--storage`,
  `--start`, `--force`), the non-destructive new-id-then-destroy drill, `--live-restore` being
  PBS-only, and the host-config disaster-recovery path list (copy from `/etc/pve` while pmxcfs
  runs).
- `research/round2-pve9/16-pbs-latest.md` -- grounded the PBS sync and remote command forms, the
  read-only sync credential on the primary (`user create`, `user generate-token`, and
  `acl update /datastore/store1 DatastoreReader --auth-id` for both the token owner and token with
  the narrower `DatastoreReader` role), and the rule to restore `pveconf.pxar` to a staging
  directory rather than over live `/etc/pve`, via `proxmox-backup-client restore`.
- [docs/adr/0002 -- Backup architecture](../docs/adr/0002-backup-architecture.md) -- the accepted
  decision this guide implements: the Pi 4B as the independent off-box copy (preferred community
  arm64 PBS plus sync job; all-supported `zfs send`/rsync cold copy), the unsupported component
  confined to the secondary copy, and the optional off-site third leg.
- `GLOSSARY.md` -- the reused definitions of [3-2-1 backup rule](GLOSSARY.md),
  [sync job (PBS)](GLOSSARY.md), [datastore](GLOSSARY.md), [deduplication](GLOSSARY.md),
  [Proxmox Backup Server (PBS)](GLOSSARY.md), [proxmox-backup-client](GLOSSARY.md),
  [send / receive](GLOSSARY.md), and [pxar archive](GLOSSARY.md).
- [PBS admin guide: managing remotes and sync](https://pbs.proxmox.com/docs/managing-remotes.html)
  -- the `remote create` and `sync-job create` forms and `remove-vanished`.
- [qmrestore(1)](https://pve.proxmox.com/pve-docs/qmrestore.1.html) -- VM restore, `--unique`,
  `--force`, `--live-restore`.
- [pct(1)](https://pve.proxmox.com/pve-docs/pct.1.html) -- container restore, `--unique`, `--force`,
  `--storage`.
- [wofferl/proxmox-backup-arm64](https://github.com/wofferl/proxmox-backup-arm64) -- COMMUNITY /
  UNSUPPORTED arm64 PBS build for the Pi; not published or supported by Proxmox.

---

Previous: [17 -- Backups with Proxmox Backup Server](17-backups-with-pbs.md) | Next:
[19 -- Applied recipes overview](19-recipes-overview.md)
