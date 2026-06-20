# When things break: a troubleshooting runbook

## What you'll be able to do

By the end of this guide you will be able to diagnose and recover the most common ways a single
Proxmox node goes wrong, entirely as text over SSH, with no GUI and no local screen. Every section
follows the same arc: read what actually happened first, fix the smallest thing that explains it,
then verify from the shell that you are back. This guide consolidates diagnostics the earlier guides
introduced in passing and leans hard on the lifelines they told you to set up; the
symptom-to-section index below lists each failure it covers.

## Before you need it: the three lifelines

Every recovery below assumes you can still get a shell on the host. On a headless single node with
no easy local console, that is not guaranteed unless you arranged it in advance. Three lifelines,
set up in earlier guides, are what turn a lockout into a non-event:

- A second SSH session, kept open. An already-established SSH connection is auto-allowed as
  established traffic and survives a bad firewall rule, an `sshd` reload, and most networking
  reloads, because the socket is already open. Keep one session idle and untouched whenever you make
  a risky change, and use it only for fixing, never as proof that new logins work. Guides
  [11 -- Firewall](11-firewall.md) and
  [14 -- Best practices and hardening](14-best-practices-and-hardening.md) make this the golden
  rule.
- The `authorized_keys2` real-file key copy. `/root/.ssh/authorized_keys` is a symlink into
  [pmxcfs (/etc/pve)](GLOSSARY.md), so if `pve-cluster` fails to start, that file disappears and
  key-only SSH breaks even though your key is perfectly valid. The real file
  `/root/.ssh/authorized_keys2`, sitting on the btrfs root outside `/etc/pve`, is read by `sshd` by
  default and keeps you logged in through a pmxcfs outage. Guide
  [02 -- The shell and the API](02-the-shell-and-the-api.md) sets it up (and guides 13 and 14
  reinforce it); this guide depends on it.
- The host serial console, then a full reinstall. If even SSH is gone, the host's own serial console
  or IPMI Serial-over-LAN (guide
  [03 -- Repositories, updates, and the host](03-repositories-updates-and-the-host.md)) is the
  deeper rung; beyond that, guide
  [20 -- Reinstalling the host remotely](20-reinstalling-the-host-remotely.md) rebuilds the host
  over the network (a one-time UEFI USB boot, or `kexec`, with a PBS-first recovery ordering).
  Stated honestly: a mini-PC reached only over the network may have no serial port or IPMI at all,
  which is exactly why the second SSH session and `authorized_keys2` are the dependable break-glass,
  not the serial console.

Keep this order in mind as a ladder: surviving SSH session first, then serial or IPMI, then physical
access, with a full remote reinstall (guide 20) as the rebuild of last resort.

## A symptom-to-section index

If you already know the symptom, jump to the section:

- "I ran a command and something failed, and I want the real error": read
  [Step zero: read what happened](#step-zero-read-what-happened).
- "A VM or container will not start": [A guest will not start](#a-guest-will-not-start).
- "A backup or snapshot hangs, or `qm`/`pct` says the guest is locked":
  [A task is stuck or a guest is locked](#a-task-is-stuck-or-a-guest-is-locked).
- "Writes are failing or the host is sluggish and the disk looks full":
  [The disk is full (and why df lies on btrfs)](#the-disk-is-full-and-why-df-lies-on-btrfs).
- "`/etc/pve` is empty, or I get permission-denied writing config even as root":
  [`/etc/pve` is read-only or empty](#etcpve-is-read-only-or-empty-pmxcfs).
- "An upgrade broke, or the host will not boot the new kernel":
  [A failed upgrade, or a host that will not boot](#a-failed-upgrade-or-a-host-that-will-not-boot).
- "I cannot reach the host over SSH at all":
  [Locked out over the network](#locked-out-over-the-network).
- "The API or the web stack is unreachable, or a storage shows inactive":
  [A core daemon is down, or a storage is unavailable](#a-core-daemon-is-down-or-a-storage-is-unavailable).

## Step zero: read what happened

The first move in every case is the same: read, do not guess. For a blind operator over SSH the
linear text these commands produce is the diagnosis. Reach for fixes only after you have read the
actual error.

### The cheapest first read

Before anything else, ask systemd whether anything is broken:

```bash
systemctl is-system-running    # "running" when healthy, "degraded" if a unit failed
systemctl --failed             # names the failed units, as linear text
```

`degraded` plus a named unit often turns "something is weird" into "`pvestatd` failed" or "the
backup mount failed" in one step, and tells you which log to read next.

### The journal

[journald](GLOSSARY.md) is where the host records what it did. The flags that matter for a screen
reader are `--no-pager` (stream the output instead of opening the interactive pager at the oldest
line) and `-e` (jump to the newest entries). The vocabulary is small and composable:

```bash
journalctl -b --no-pager              # everything from this boot
journalctl -b -e                      # this boot, jump to the newest entries
journalctl -p err -b --no-pager       # errors and worse, this boot (fast triage)
journalctl -u pveproxy -b --no-pager  # one service (swap in any unit name)
journalctl -u 'pve*' -b --no-pager    # all Proxmox daemons at once (quote the glob)
journalctl -k -b --no-pager           # the kernel ring buffer (btrfs, NVMe, the OOM killer)
journalctl -fu pveproxy               # follow one unit live; Ctrl-C to stop
journalctl --since "-1h" -p warning --no-pager   # last hour, warnings and worse
```

The single most important point about the journal ties straight back to guide
[15 -- Monitoring, maintenance, and notifications](15-monitoring-maintenance-and-notifications.md):
reading the previous boot only works because guide 15 set journald to `Storage=persistent`. After an
unexpected reboot, the previous boot is where the cause lives:

```bash
journalctl --list-boots --no-pager    # more than one boot listed means persistence is on
journalctl -b -1 --no-pager           # the whole previous boot
journalctl -k -b -1 --no-pager        # the previous boot's kernel log (crash forensics)
```

If `--list-boots` shows only boot `0`, the journal was in memory and the pre-crash evidence is gone.
That is the one thing to fix in calm times, not during an incident.

### The task system

Every action `qm`, `pct`, `vzdump`, and the storage layer take runs as a task with a
[UPID](GLOSSARY.md), a unique identifier. Guide
[13 -- Users, permissions, and API tokens](13-users-permissions-and-api-tokens.md) introduced the
task system; the diagnostic workflow is to list the failures, then read the failing task's full log
to get the real cause:

```bash
pvenode task list --errors 1          # the tasks that failed, newest first
pvenode task log <UPID>               # the full captured output of one task
pvenode task status <UPID>            # just running/stopped and the exit status
```

Copy the exact UPID from the list. Narrow the list with `--vmid <id>` for one guest,
`--typefilter vzdump` for backups only, or `--source active` to see tasks still running rather than
the finished archive. For clean linear output (the bare command prints an ASCII-art table), read the
same data through [pvesh](GLOSSARY.md):

```bash
pvesh get /nodes/$(hostname)/tasks --output-format yaml
pvesh get /nodes/$(hostname)/tasks/<UPID>/log --output-format yaml
```

There is a fallback that makes this robust on a single node: task logs persist on the real btrfs
filesystem under `/var/log/pve/tasks/`, not inside `/etc/pve`. The `active` file there is the index
of running tasks; finished logs sit in single-hex-character subdirectories, and the file name is the
UPID. So when `/etc/pve` has gone read-only or `pve-cluster` is down (the very moment
`pvenode task list` itself may fail), you can still read recent task history straight from disk:

```bash
ls /var/log/pve/tasks/
cat /var/log/pve/tasks/active
```

### One snapshot to attach when you ask for help

`pvereport`, introduced in guide 15, collects versions, storage, network, btrfs and ZFS state,
running guests, and service status into one plain-text blob. Save it with a dated name to read end
to end or to attach to a forum post:

```bash
pvereport > /root/pvereport-$(date +%F).txt
```

One thing the task system will never show you: btrfs has no daemon that records scrub or device
errors as a task or notification. A btrfs problem surfaces only in the kernel log (`journalctl -k`,
look for `BTRFS error` or `BTRFS warning`) and in `btrfs device stats`. This is the diagnosis-side
mirror of the btrfs alerting gap guide 15 describes.

## A guest will not start

This is the most common "it is broken" call. The teaching order is the same for both guest types:
read what the start command prints, prove the storage and config are sound, and then, if the launch
itself succeeded, get inside the guest to watch its own boot.

### A VM (qm)

Run the start in the foreground and read the error verbatim. It usually names the cause outright: a
missing volume, an inactive storage, an OVMF/EFI problem, a leftover lock, or out-of-memory.

```bash
qm start 100
```

The single best follow-up is to print the exact KVM command line Proxmox would run, one option per
line, which reads cleanly with a screen reader and exposes a bad disk path, a wrong machine type, or
a missing EFI disk:

```bash
qm showcmd 100 --pretty
```

Now prove the storage layer. A guest whose disk lives on an inactive or disabled storage will not
start. On this node `local-btrfs` is active and `local` is a disabled directory storage, and that
disabled state is normal, not the bug (see guide [09 -- Storage](09-storage.md)):

```bash
pvesm status                          # is local-btrfs active?
pvesm list local-btrfs --vmid 100     # does the disk the config names actually exist?
pvesm path local-btrfs:vm-100-disk-0  # resolve a volume to its real path, then ls -l it
```

Cross-check the config against those volumes to catch a bad hand-edit, and remember
[OVMF / UEFI](GLOSSARY.md) VMs require an `efidisk0` line; if a hand-edit dropped it, the VM will
not start:

```bash
qm config 100        # check every storage-referencing line: scsi0, efidisk0, ide2, tpmstate0
```

If a leftover `lock:` line from an interrupted backup or snapshot is blocking the start, clear it
only once you are sure no operation is genuinely still running (the next section covers proving
that), then start again. For a single start that ignores the lock, `--skiplock` is the root-only
override:

```bash
qm unlock 100
qm start 100
qm start 100 --skiplock    # one-shot override; prefer qm unlock after confirming nothing runs
```

If `qm start` succeeds but the guest OS never comes up, remember that "QEMU launched" is not "the
guest booted". Attach the [serial console](GLOSSARY.md) and read the guest's own GRUB, a kernel
panic, or an `fsck` prompt as plain text. This is the superpower from guide
[04 -- Talking to guests without a GUI](04-talking-to-guests-without-a-gui.md), and it only works if
`serial0: socket` and `vga: serial0` were wired in advance:

```bash
qm terminal 100      # attach to the guest serial line; exit with Ctrl-O
```

A serial port added to an already-running VM does not engage until a full `qm stop` then `qm start`;
a reboot is not enough. That silent-terminal surprise is almost always why. If a crash left a tap
device or other resource behind so the next start fails, clear it by hand (normally `qmeventd` does
this automatically; the two zeros mean the previous exit was neither clean nor guest-requested):

```bash
qm cleanup 100 0 0
```

### A container (pct)

The parallel first step is to read the inline error, and the indispensable tool is the verbose debug
start, which streams the `lxc-start` debug log to your terminal and names the precise failing step:

```bash
pct start 110
pct start 110 --debug    # very verbose: shows the failing mount, idmap, or cgroup step
```

That is where you see a rootfs mount failure, an unprivileged idmap or subuid mismatch, a cgroup-v2
incompatibility with an ancient container userspace, or, very commonly, a bind mount (an absolute
host path in an `mpN` line) whose backing directory has been moved or deleted. Confirm volume mounts
against storage, and check bind-mount paths with a plain listing on the host:

```bash
pct config 110               # check rootfs and every mpN line
pvesm list local-btrfs --vmid 110
ls -ld /path/from/a/bind/mount
```

If the rootfs itself is corrupt, stop the container and check the filesystem; for deeper repair,
mount the rootfs on the host, fix it, then unmount to release the maintenance lock. `pct fsck` and
`pct mount` both modify or lock the volume, so snapshot first if the data matters:

```bash
pct fsck 110 --device rootfs   # run with the container stopped; snapshot first
pct mount 110                  # exposes the rootfs on the host (typically /var/lib/lxc/110/rootfs) for repair
pct unmount 110                # always pair with pct mount, or the CT looks stuck
pct unlock 110                 # clear a stale lock (confirm no job is running first)
```

Once a container starts but misbehaves inside, the access doors from guide
[05 -- Containers with LXC and pct](05-containers-with-lxc-and-pct.md) let you in without a GUI:

```bash
pct enter 110                              # clean root shell inside; exit with exit or Ctrl-D
pct exec 110 -- journalctl -b -p err --no-pager   # one diagnostic command; mind the -- separator
pct console 110                            # watch the raw boot; escape is Ctrl-a then q
```

### Verify it worked

```bash
qm status 100       # expect: status: running
pct status 110      # expect: status: running
```

For a VM, confirm the OS actually finished booting (not just QEMU) by asking the guest agent for its
interfaces; an "agent not running" error means the OS did not come up even though the VM is
"running":

```bash
qm agent 100 network-get-interfaces   # JSON list of interfaces and IPs when the OS is up
```

## A task is stuck or a guest is locked

A `lock:` line in `qm config` or `pct config` is not damage. It is Proxmox's deliberate interlock
saying an operation owns the guest right now: for a VM one of `backup`, `clone`, `create`,
`migrate`, `rollback`, `snapshot`, `snapshot-delete`, `suspending`, or `suspended`; for a container
also `mounted`, `disk`, `fstrim`, or `destroyed`. A lock is stale only when the task that set it has
crashed or been aborted and left the line behind. The main hazard in this whole topic is clearing a
lock on sight, so the first move is never `qm unlock` -- it is to prove the owning task is dead.

### Prove the owning task is dead

Two checks, both linear text. First, the task list: if the backup or snapshot that set the lock is
still in the active list, stop here, because the lock is live and clearing it could corrupt the disk
or the btrfs snapshot chain.

```bash
qm config 100 | grep -i '^lock'       # see which operation owns the guest
pvenode task list --vmid 100 --limit 20
pvenode task list --source active      # if the owning task is here, the lock is LIVE -- do not clear
```

Second, confirm the actual process. A VM records its PID under `/run/qemu-server/<vmid>.pid`; a
stale UPID in the index can outlive its worker, so the process check is the tie-breaker. A state of
`Z` (zombie) or `D` (uninterruptible sleep) is the signature of a genuinely stuck guest:

```bash
ps -p $(cat /run/qemu-server/100.pid 2>/dev/null) -o pid,stat,etime,cmd
```

Only once both checks agree the operation is dead do you clear the lock. Remember that unlock only
edits the config file -- it removes the guard rail, it does not stop or fix anything:

```bash
qm unlock 100      # VM
pct unlock 110     # container (if the lock is "mounted", run pct unmount 110 instead)
```

### Free a genuinely stuck guest

Escalate gently. Try the graceful path first if the guest can still answer; the guest agent makes
the VM case reliable:

```bash
qm shutdown 100 --timeout 60               # ACPI / agent clean shutdown
pct shutdown 110 --timeout 60 --forceStop 1
```

When the guest is truly unresponsive, the hard power-off is the normal tool. The Proxmox docs
describe `qm stop` as pulling the power plug, with the matching data risk, which journaled and btrfs
guests recover from on the next boot:

```bash
qm stop 100 --timeout 30
qm stop 100 --overrule-shutdown 1   # if a previous qm shutdown is stuck waiting on the guest, abort it and stop
pct stop 110
```

If a guest's own stale lock blocks the stop, the root-only `--skiplock` forces past it. This is the
sharp edge of the topic: use it only after you have proven no real operation is running, because
bypassing the interlock during a live backup or snapshot is exactly how data is corrupted. The
cleaner sequence is almost always unlock-then-stop:

```bash
qm stop 100 --skiplock 1    # only after proving the lock is stale
pct stop 110 --skiplock 1
```

If `qm stop` itself wedges (usually a `D`-state from stuck I/O or a misbehaving PCI passthrough
device, see guide [21 -- Passing host hardware to guests](21-passing-host-hardware-to-guests.md)),
the last resort is killing the process directly -- but only after both checks above have proven the
operation is dead. Read the PID once into a variable and confirm it is still VM 100's `kvm` process
before each signal, so that if QEMU has already exited and the kernel recycled its PID, you never
kill an unrelated process. A guest stuck in uninterruptible sleep may not die even to `SIGKILL`; if
it does not, a host reboot is the only remaining exit. Afterwards run `qm cleanup`, because the
`qmeventd` daemon that normally reaps tap devices may not have fired when you killed the process by
hand:

```bash
pid=$(cat /run/qemu-server/100.pid)
[ -n "$pid" ] && ps -p "$pid" -o comm= | grep -qx kvm && kill "$pid"      # SIGTERM, only if it is still VM 100's kvm
sleep 5
[ -n "$pid" ] && ps -p "$pid" -o comm= | grep -qx kvm && kill -9 "$pid"   # re-confirm, then SIGKILL as last resort
qm cleanup 100 0 0
lxc-stop -n 110 --kill      # the container equivalent last resort
```

### A wedged task daemon, not a guest

If many tasks hang or the task index has stale entries, the problem is a task worker, not a guest.
Those workers live in `pvedaemon`, with `pvescheduler` running backup jobs. Running guests are
independent of these daemons, so you can restart a hung worker without disturbing any VM or
container:

```bash
systemctl status pvedaemon pveproxy pvestatd pvescheduler
systemctl restart pvedaemon    # clears a hung worker; does not touch running guests
```

The one hard rule on this single headless node: never casually restart or disable
`pve-cluster`/pmxcfs. That takes `/etc/pve` offline and breaks all config access, which is a
near-lockout (the next section is about exactly that).

### Verify it worked

```bash
qm config 100 | grep -i '^lock'   # expect: no output (lock cleared)
qm status 100                     # expect: the state you intended (stopped or running)
```

## The disk is full (and why df lies on btrfs)

On a [btrfs](GLOSSARY.md) root, `df -h` misleads. It cannot see how space is carved into chunks
(block groups) for data and metadata, so it can report free space while writes fail with `ENOSPC`,
or report "used" that a balance would reclaim. The authoritative reads are:

```bash
btrfs filesystem usage /     # Device size, allocated, unallocated, free; per-profile used vs total
btrfs filesystem df /        # terse Data / Metadata / System / GlobalReserve summary
df -h /                      # contrast only -- learn to distrust this number on btrfs
pvesm status                 # Proxmox's own per-storage accounting
```

The pattern to recognize on this single-disk node is `ENOSPC`-with-free-space: `Device unallocated`
near zero, `Data` total far above `Data` used, and `Metadata` pressed up against its total. That
means data chunks ate all the raw space and metadata has nowhere to grow. The files were never the
real problem -- allocation was. On one disk, metadata uses the `DUP` profile (two copies) and data
is `single`, so metadata pressure bites a little sooner than people expect, and a non-zero
`GlobalReserve` is a red flag that you are already drawing on the filesystem's internal emergency
reserve.

Everything competes for one pool. On a btrfs-root install there is no separate `local-lvm` and no
fixed-size guest pool; the host root, guest disks, backups, ISOs, templates, and snapshots all share
the single btrfs filesystem (its whole capacity, whatever your NVMe's size), so a runaway log or a
pile of backups fills the same space the host root needs to function.

### Safe reclaim, in order

Before touching balance, free real space, biggest quiet sinks first. The crucial trap: deleting a
file frees nothing if a snapshot still references its blocks, and `du`/`ncdu` report logical sizes
and are blind to that. So check snapshots first.

```bash
# Stale guest snapshots are the usual hidden sink. List per guest, delete the stale ones:
qm listsnapshot 100 ; pct listsnapshot 110
qm delsnapshot 100 <name> ; pct delsnapshot 110 <name>

# Any hand-made btrfs snapshots Proxmox does not track (read the warning below before deleting):
btrfs subvolume list -s /

# Old backups: preview with a dry run, then apply by dropping --dry-run 1:
pvesm prune-backups local-btrfs --prune-backups keep-daily=7,keep-weekly=4,keep-monthly=6 --dry-run 1

# The systemd journal and the apt cache:
journalctl --vacuum-size=200M
apt-get clean

# Leftover ISOs and templates, an easy several-GB win:
pvesm list local-btrfs --content iso
pvesm list local-btrfs --content vztmpl

# Chase the rest, staying on one filesystem (-x):
du -xh --max-depth=1 / 2>/dev/null | sort -rh | head -n 20
ncdu -x /
```

Be very careful with `btrfs subvolume delete` on this single, no-redundancy disk: the delete is
immediate and irreversible, and several things you depend on are subvolumes. The read-only entries
named `...disk-N@<name>` in that list are your PVE guest snapshots; remove those only with
`qm`/`pct delsnapshot` above, never with a raw subvolume delete. Never touch the `local-btrfs`
storage subvolume or a container's rootfs. The only safe candidate for
`btrfs subvolume delete <path>` is a subvolume you created by hand and have confirmed, against
`qm listsnapshot`/`pct listsnapshot`, that Proxmox does not track.

Two accounting traps with [pvesm](GLOSSARY.md): `pvesm remove <id>` frees no space (it only deletes
the storage's config stanza); `pvesm free <volid>` is the one that deletes actual data. And for a
PBS datastore, prune only marks snapshots removable; garbage collection reclaims the space (guide
[17 -- Backups with Proxmox Backup Server](17-backups-with-pbs.md)).

### The btrfs-specific cure

When `usage` shows allocated far above used, return the empty data chunks to unallocated so metadata
can grow again. Start gentle and incremental. The honest caveat, confirmed upstream:
[btrfs balance](GLOSSARY.md) itself needs some completely-unused space to run, so on a genuinely
full filesystem it can fail with `ENOSPC` -- which is why you free something first, and why
`-dusage=0` (empty chunks only) is the variant most likely to succeed under pressure.

```bash
btrfs balance start -v -dusage=0 /    # cheapest: only fully-empty data chunks
btrfs balance start -v -dusage=10 /   # then climb: under-10%-full data chunks
btrfs balance start -v -musage=10 /   # metadata block groups, if those are the over-allocated ones
btrfs balance status /                # watch progress from a SECOND ssh session
btrfs balance cancel /                # stops cleanly at the next chunk boundary; safe to cancel
```

Raise the threshold incrementally (10, then 20, then 30) only if needed. On a single disk you never
run an unfiltered `btrfs balance start /` -- that is for re-striping across profiles or devices you
do not have, and it is needlessly IO-heavy.

A full root filesystem can wedge pmxcfs, block service restarts, and even prevent a fresh login, so
keep a second SSH session open before you start space surgery, and re-check
`btrfs filesystem usage /` after each delete to confirm `unallocated` is actually rising.

### Verify it worked

```bash
btrfs filesystem usage /     # Device unallocated should have risen; Free should be healthy
pvesm status                 # local-btrfs avail should reflect the reclaimed space
```

## `/etc/pve` is read-only or empty (pmxcfs)

[pmxcfs (/etc/pve)](GLOSSARY.md) is not a directory on the btrfs root. It is a FUSE filesystem
served by the `pve-cluster` service, and its only on-disk persistence is a single SQLite database at
`/var/lib/pve-cluster/config.db` (the live tree is held in RAM). That one fact explains the whole
failure class: if `pve-cluster` does not start, `/etc/pve` is an empty stub and everything stored
there -- `storage.cfg`, every guest config, the firewall rules, the root SSH key -- vanishes from
view at once, even though the data is safe in `config.db`.

### Is it mounted, and why not

The first diagnostic is always "is it mounted?":

```bash
findmnt /etc/pve                          # healthy: SOURCE pmxcfs, FSTYPE fuse. Empty output: it is NOT mounted
systemctl status pve-cluster.service      # "active (running)" is healthy
journalctl -u pve-cluster -b --no-pager   # why it would not start (SQLite errors, fuse failures, quorum)
ls -l /var/lib/pve-cluster/config.db      # the backing DB; a missing or zero-byte file is the problem
```

### Read-only because of quorum (and the single-node truth)

The subtler symptom is that `/etc/pve` is mounted but read-only, so even root cannot edit
`storage.cfg` or start a VM. pmxcfs deliberately goes read-only whenever the node lacks quorum. Here
the single-node context is decisive: a node that was never joined to a cluster has no
`/etc/corosync/corosync.conf`, corosync never starts, and the node is quorate by default -- so on a
clean standalone node you essentially never see this. Test writability directly:

```bash
touch /etc/pve/.rwtest && rm /etc/pve/.rwtest   # fails read-only as root => lost quorum
```

If a standalone node is read-only, the real cause is almost always leftover cluster config from a
past experiment, and the durable fix is to remove it. The immediate, non-destructive unblock is to
force expected votes to 1 ([quorum](GLOSSARY.md)); it changes nothing on disk and works only while
`pve-cluster`/corosync are running:

```bash
pvecm expected 1
```

### When the service will not come up

Escalate in order. A transient failure often clears with a restart:

```bash
systemctl restart pve-cluster
findmnt /etc/pve         # confirm the FUSE mount returned and the config is visible again
```

If startup refuses because of quorum or stale corosync config, start pmxcfs by hand in forced local
mode, which mounts `/etc/pve` while ignoring all cluster config so you can read and repair files
(for instance, delete the leftover corosync config). The manually launched process is not managed by
systemd, so kill it before returning to the normal service or two instances fight over the mount:

```bash
systemctl stop pve-cluster && pmxcfs -l    # forced local mode -- you MUST killall pmxcfs before restarting the service
pmxcfs -l -d -f                            # if even local mode fails: debug, foreground, Ctrl-C to stop
killall pmxcfs && systemctl start pve-cluster   # return to normal, then re-check findmnt
```

The non-negotiable discipline around the database: if you suspect `config.db` corruption, stop
`pve-cluster`, copy the DB (and its `-wal`/`-shm` siblings) to a dated backup, and only ever run a
read-only integrity check against the copy. The Proxmox docs document moving `config.db` to new
hardware and the read-only-on-quorum behavior, but no in-place repair, so a failed check means
restore-from-backup or rebuild, never ad-hoc SQLite surgery:

```bash
systemctl stop pve-cluster
backup_dir="/root/pmxcfs-configdb-$(date +%F-%H%M%S)"
mkdir -m 700 "$backup_dir"
for file in \
  /var/lib/pve-cluster/config.db \
  /var/lib/pve-cluster/config.db-wal \
  /var/lib/pve-cluster/config.db-shm; do
  [ -e "$file" ] && cp -a "$file" "$backup_dir"/
done
systemctl start pve-cluster
sqlite3 "$backup_dir/config.db" 'PRAGMA integrity_check;'   # "ok" means sound
```

### The lifeline that lets you do any of this

The reason you can still SSH in to run these commands is `authorized_keys2`. Confirm it exists and
that `sshd` still reads it (it does by default; a hardened single-path `AuthorizedKeysFile` would
silently defeat it):

```bash
ls -l /root/.ssh/authorized_keys /root/.ssh/authorized_keys2
sshd -T | grep -i authorizedkeysfile     # the list should still include authorized_keys2
```

Re-create it whenever you add or rotate a key, while pmxcfs is up so the source exists:

```bash
cp /etc/pve/priv/authorized_keys /root/.ssh/authorized_keys2 && chmod 600 /root/.ssh/authorized_keys2
```

### Verify it worked

```bash
findmnt /etc/pve                          # SOURCE pmxcfs, FSTYPE fuse
touch /etc/pve/.rwtest && rm /etc/pve/.rwtest   # succeeds => read-write again
pvecm status                              # on a standalone node, "no cluster configured" is normal and healthy
```

## A failed upgrade, or a host that will not boot

Recovery escalates by layer: fix the package state first, then the bootloader and kernel, and only
then reach for a reinstall. Guide
[03 -- Repositories, updates, and the host](03-repositories-updates-and-the-host.md) is the
companion for all of this.

### Broken packages after an interrupted upgrade

The first recovery step is always to finish what `dpkg` left half-done, then resolve dependencies.
The fix-broken step must never be allowed to remove `pve-manager`, the `proxmox-kernel`
meta-package, or `qemu-server`:

```bash
dpkg --configure -a            # configure packages left unpacked when apt was killed
apt --fix-broken install       # resolve broken dependencies (= apt -f install)
apt full-upgrade               # the supported path -- NOT plain apt upgrade
```

Plain `apt upgrade` holds the kernel and core PVE packages back and can leave the host unbootable;
`full-upgrade` (which `pveupgrade` wraps with extra reboot and running-guest checks) is the only
supported path. A "kept-back" report is usually this, not a real hold. Diagnose with:

```bash
apt list --upgradable          # what is held back
apt-mark showhold              # real holds (apt-mark hold/unhold toggles; a kernel hold stops security updates)
apt-get clean                  # clear a truncated/partial download, then retry
pveversion -v                  # confirm the resulting versions
```

### A kernel that will not boot

On this btrfs root the host boots via GRUB, with the kernel and initrd living on the small vfat EFI
System Partition managed by [proxmox-boot-tool](GLOSSARY.md). Use `proxmox-boot-tool refresh` as the
explicit ESP sync command after kernel-list or command-line changes. Current Proxmox docs also
describe `update-grub` as a valid GRUB apply path when the proxmox-boot-tool hook is present, but
the direct command is less ambiguous in a recovery checklist. The recovery for a bad new kernel is
to boot a known-good one. Because a permanent pin or a kernel hold also stops future security
kernels, the blind-operator-friendly move is a one-shot next-boot pin: it boots the chosen kernel
exactly once and then clears itself, so a power-cycle returns you to the default and there is
nothing to unpin afterward. Take the ABI string from `kernel list` (a still-installed earlier
kernel), not a guess; on a 9.2 node it looks like `7.0.x-y-pve`:

```bash
proxmox-boot-tool status                  # confirm one (grub) ESP on this btrfs host
proxmox-boot-tool kernel list             # the installed kernels and their ABI strings
proxmox-boot-tool kernel pin <abi-version> --next-boot   # boot a still-installed earlier kernel ONCE
proxmox-boot-tool refresh                 # write the updated boot entries to the ESP
```

If the initramfs is the problem, rebuild it (this auto-refreshes the ESP):

```bash
update-initramfs -u -k all
```

Set kernel command-line options in `/etc/default/grub` (`GRUB_CMDLINE_LINUX_DEFAULT`) and apply them
with the explicit `proxmox-boot-tool refresh` sync path. Do not edit `/etc/kernel/cmdline`; that is
the systemd-boot path and is silently ignored under GRUB on this host. Read a failed boot afterward
with `journalctl -b -1 -p err` and `journalctl -k -b -1`; reading it live needs the host serial
console (guide 03), which a mini-PC may not have.

### When remote recovery is not possible

If the host will not boot and you cannot reach it to fix the package or kernel state, that is the
boundary of this guide. Escalate to guide
[20 -- Reinstalling the host remotely](20-reinstalling-the-host-remotely.md): its USB BootNext route
(recommended) or `kexec` route, and its PBS-first recovery ordering. Decide to reinstall only after
the diagnosis here shows the host is genuinely unrecoverable in place.

### Verify it worked

```bash
pveversion -v                  # the expected package versions, no held-back core packages
uname -r                       # the kernel you intended to be running
proxmox-boot-tool status       # the managed ESP is present and current
systemctl is-system-running    # "running"
```

## Locked out over the network

This is the "it already broke, now what" side; the safe-change procedures live in guides 10
(networking), 11 (firewall), and 14 (sshd hardening). The recovery ladder is the one from the top of
this guide: the surviving second SSH session first, then serial or IPMI. One discipline above all:
an established session keeps working even when every new login is being dropped, so it lies --
always prove recovery by opening a brand-new connection.

```bash
who                                                          # who is logged in
ss -tnp state established '( dport = :22 or sport = :22 )'   # which source IPs are your live sessions
```

### A firewall lockout

From any surviving shell, the one recovery lever flushes the Proxmox firewall chains immediately.
The official docs are explicit that this leaves the host unprotected, which is exactly what you want
transiently to regain control:

```bash
pve-firewall stop
```

That is runtime-only; the [pve-firewall](GLOSSARY.md) service returns on the next boot or with
`pve-firewall start`. The durable fix is to flip the datacenter master switch off in config. The
trap that usually caused the lockout: `host.fw`'s `enable:` defaults to 1, so the host firewall went
live the instant the datacenter switch was turned on -- there is no separate host opt-in. Because
`/etc/pve` is pmxcfs, edit it non-interactively, never with `vim` or `nano`:

```bash
sed -i 's/^enable: 1/enable: 0/' /etc/pve/firewall/cluster.fw
grep -n '^enable:' /etc/pve/firewall/cluster.fw    # confirm the line actually changed
pve-firewall restart
```

When you later re-enable, do so only after `pve-firewall compile` shows your SSH allow rule and you
re-test from a brand-new session. One more trap from guide [11 -- Firewall](11-firewall.md): do not
rely on implicit management access for IPv6. Add an explicit IPv6 SSH rule for your control station
and verify a fresh IPv6 SSH session before closing the recovery shell.

### Networking broke

Read before you write. These change nothing and read cleanly as linear text:

```bash
ip -br link      # each interface, up/down, MAC -- is vmbr0 up? is the NIC name what you expect?
ip -br addr      # which IP sits on which interface -- is the management IP on vmbr0?
ip route         # the default gateway
```

The [ifupdown2](GLOSSARY.md) model applies changes live and is non-disruptive, so recovery is
usually edit-the-file-then-reload, no reboot needed. Validate first (the dry run catches syntax, but
not a config aimed at a wrong or kernel-renamed NIC, so confirm the NIC name with `ip -br link`
too):

```bash
ifreload -a -n    # dry run: validate, show what WOULD change
ifreload -a       # apply live
```

The most common single-node networking break is the PVE 8-to-9 NIC rename (for example `eno1`
becomes `enp1s0f0`), after which `vmbr0`'s `bridge-ports` points at a NIC that no longer exists and
the host boots with no network. Recovery is to console or serial in, fix the `bridge-ports` line to
the new name, and `ifreload -a`. Two facts that make recovery safer: keep a backup of the interfaces
file so a revert is a copy-and-reload, and remember a reboot re-applies the on-disk file -- so a bad
live state is undone by rebooting, but a bad on-disk file survives and must be edited.

```bash
# from the serial console, after a bad reload, if you kept a backup:
cp /etc/network/interfaces /etc/network/interfaces.bad
cp /etc/network/interfaces.bak /etc/network/interfaces
ifreload -a
```

### sshd locked you out

A typo in `/etc/ssh/sshd_config` or a `*.conf` drop-in makes `sshd` refuse to start; an already-open
session survives but new logins fail. Always test before reloading, and use `reload`, not `restart`,
so the surviving session stays as the safety net:

```bash
sshd -t                  # validates config; prints the offending line on error
systemctl reload ssh     # re-reads config without dropping existing connections
```

If key login broke specifically after a pmxcfs issue, this is the `authorized_keys` symlink trap
from the pmxcfs section: the real-file `authorized_keys2` is what saves you, provided
`AuthorizedKeysFile` was never hardened to a single path. One thing this section cannot do:
`qm terminal` and `pct enter` reach guest consoles from a working host shell -- they cannot recover
the host's own networking, firewall, or sshd when host SSH is gone.

### Verify it worked

Open a brand-new SSH session from the control station. If it connects, you are genuinely back. Then,
if you re-enabled the firewall:

```bash
pve-firewall status      # expect: enabled/running with your SSH allow rule present
ip -br addr              # the management IP is on vmbr0
```

## A core daemon is down, or a storage is unavailable

Localize the fault first: is the management plane broken, or is a storage backend gone? Start wide
and from the bottom up with the cheap triage from step zero
(`systemctl is-system-running; systemctl --failed`), then split into the two cases below.

### The daemon set

Anchor everything on pmxcfs. `pve-cluster` runs the FUSE filesystem behind `/etc/pve`, so if it is
down every other `pve*` command misbehaves downstream and chasing them wastes time. Check it first,
then the rest of the set in one pass:

```bash
systemctl status pve-cluster.service
systemctl status pvedaemon pveproxy pvestatd pvescheduler pve-firewall qmeventd
journalctl -u pveproxy -b --no-pager      # why one died (swap in any unit)
```

The roles, so a symptom points you at the right daemon: `pvedaemon` is the privileged REST API
worker (on 127.0.0.1:85, as root); `pveproxy` is the HTTPS API frontend (on 8006) that forwards
privileged calls inward; `pvestatd` polls and publishes status, so a dead `pvestatd` shows up as
stale or "grey" statuses while guests actually run fine; `pvescheduler` fires backup and replication
jobs; `pve-firewall` applies the ruleset; and `qmeventd` watches the QEMU control socket and runs
`qm cleanup` when a VM stops. (`spiceproxy`, the SPICE console broker, also appears in the full
restart command below, included only to preserve the upstream restart order; this corpus uses SPICE
only for the attended install (guide [08 -- Windows guests](08-windows-guests.md)), never for daily
operation.)

The reassurance to state plainly: restarting `pveproxy`, `pvedaemon`, `pvestatd`, or `pvescheduler`
does not touch running guests -- the QEMU and LXC processes are independent of the management
daemons. So the safe first move on a wedged API is simply to restart the frontend, and the safe
order when you restart several is pmxcfs first, then the privileged API, then the proxy, then status
and scheduler:

```bash
systemctl restart pveproxy     # most common single fix when "the API times out" but guests are fine
systemctl restart pvestatd     # when statuses are stale or grey but guests run
# full safe-order restart after an upgrade or cert change:
systemctl restart pve-cluster && systemctl restart pvedaemon && \
  systemctl restart pveproxy spiceproxy && systemctl restart pvestatd pvescheduler
```

(If the API fails with permission-denied as root, the cause is usually the read-only `/etc/pve` from
the previous section, not the daemons.)

### A storage backend is unavailable

The diagnostic is `pvesm status`, read top to bottom: `active` is healthy, `disabled` is a stanza
switched off (normal for `local` on a btrfs install), and `inactive` means the backend is
unreachable. On this host inactive almost always means a removable disk. A USB directory or btrfs
storage carries [is_mountpoint](GLOSSARY.md) `1`, so when its disk is unmounted PVE deliberately
marks the storage inactive rather than writing phantom data into the bare mount directory on the
btrfs root.

```bash
pvesm status                 # active / inactive / disabled per storage
findmnt /mnt/usb-backup      # prints the mount line when present; silent (exit 1) when absent
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,UUID,MODEL,SERIAL   # is the disk even present?
cat /etc/pve/storage.cfg     # the source of truth; note is_mountpoint on removable stores
```

Re-activate by mounting the disk again; the storage returns to active (force a refresh with
`systemctl restart pvestatd` if needed):

```bash
mount /mnt/usb-backup                          # if it has an fstab line
systemctl start mnt-usb\x2dbackup.mount        # if it uses a systemd .mount unit
zpool import -d /dev/disk/by-id <pool>         # for an external ZFS pool, then zpool status
```

The cascade ties this back to the guest-won't-start section: any guest whose disk lives on an
inactive storage will refuse to start, and that is correct, protective behavior, not corruption. The
fix is to re-activate the storage, not to fight the guest -- which is why `pvesm status` belongs
early in any start-failure diagnosis.

### Verify it worked

```bash
systemctl is-system-running    # "running"
pvesm status                   # the storage you fixed shows active
```

## When to stop and escalate

Not everything is fixable in place, and knowing when to stop chasing a fault is part of the skill.
Before you escalate, capture one full snapshot so you (or the forum) have the whole picture:

```bash
pvereport > /root/pvereport-$(date +%F).txt
```

Then choose the right escalation:

- For a question or a suspected bug, the Proxmox community forum and the official documentation are
  the right venues; attach the `pvereport` and the exact failing task log
  (`pvenode task log <UPID>`) rather than a paraphrase.
- For a host that cannot be recovered in place -- an unbootable system you cannot reach, or a
  corrupt `config.db` with no good backup -- move to guide
  [20 -- Reinstalling the host remotely](20-reinstalling-the-host-remotely.md). Its
  disaster-recovery ordering rebuilds the host and the PBS VM first (guide 17), then restores the
  guests from the independent copy (guide
  [18 -- The independent copy and restore](18-the-independent-copy-and-restore.md)).

The throughline of this whole guide: read the linear text the system gives you, fix the smallest
thing that explains it, verify from the shell, and keep your lifelines intact so a mistake during
recovery is never the end of the road.

## Sources

- `research/round2-pve9/19-pve9-hardening-and-monitoring.md` -- the journald persistent-storage
  precondition and the `journalctl -u`/`-p`/`-k` reads, `--vacuum-size`/`--vacuum-time`,
  `pvereport`, and the `pvesh ... --output-format yaml` rationale that the step-zero and disk-full
  sections reuse.
- `research/round2-pve9/05-pve9-host-and-services.md` -- the core daemon set (`pve-cluster`/pmxcfs,
  `pvedaemon`, `pveproxy`, `pvestatd`, `pvescheduler`, `qmeventd`, `spiceproxy`), their ports and
  roles and the safe restart order; pmxcfs as FUSE/SQLite with the read-only-on-quorum-loss
  behavior, `pvecm expected 1`, `pmxcfs -l` local mode, and the `config.db` recovery and `.debug`
  toggle; the single-node corosync caveat.
- `research/round2-pve9/09-pve9-vms-qm.md` -- the `qm` command surface and start-failure aids
  (`qm showcmd --pretty`, `qm unlock`, `qm cleanup`), the `lock:` values, and the serial-console
  recovery path with the `serial0` stop/start gotcha. The `--skiplock` and `--overrule-shutdown`
  semantics are from the official `qm` manual cited below.
- `research/round2-pve9/10-pve9-lxc-pct.md` -- `pct start --debug`,
  `pct fsck`/`pct mount`/`pct unmount`, `pct unlock`, the access verbs
  (`pct enter`/`exec`/`console`), bind-vs-volume mounts, the unprivileged idmap, and the cgroup-v2
  and version-sensitive `--keep-env` PVE 9 deltas.
- `research/round2-pve9/06-pve9-btrfs-deep.md` -- the "df lies on btrfs" explanation,
  `btrfs filesystem usage`/`df`, the `ENOSPC`-with-free-space failure mode, single-disk
  single-data/DUP-metadata, guest snapshots as read-only subvolumes, and the `btrfs balance -dusage`
  reclaim with its needs-free-space caveat.
- `research/round2-pve9/08-pve9-storage-model-and-pvesm.md` -- the `pvesm` surface (`status`,
  `list`, `path`, `free`, `prune-backups`), the active/inactive/disabled semantics, `is_mountpoint`
  behavior, and the "`pvesm remove` frees nothing" gotcha.
- `research/round2-pve9/03-pve9-repositories-and-updates.md` and
  `research/round2-pve9/04-pve9-boot-kernel-microcode.md` -- the `apt full-upgrade` rule and
  `dpkg --configure -a`/`apt --fix-broken` recovery, kept-back versus held packages, and the
  btrfs-root GRUB plus `proxmox-boot-tool` kernel `list`/`pin --next-boot`/`refresh` recovery.
- `research/round2-pve9/12-pve9-networking.md` and
  `research/round2-pve9/13-pve9-firewall-nftables.md` -- the `ifupdown2` live-apply model with
  `ifreload -a`/`-a -n`, the NIC-rename break, and the firewall master switches with
  `pve-firewall stop` as the recovery lever and the management allow-list trap.
- Existing guides this one extends rather than repeats:
  [03](03-repositories-updates-and-the-host.md) (daemons, boot, serial console),
  [04](04-talking-to-guests-without-a-gui.md) (the guest access doors),
  [05](05-containers-with-lxc-and-pct.md) and [06](06-virtual-machines-with-qm.md) (guest config and
  locks), [09](09-storage.md) (the storage model and btrfs usage), [10](10-networking.md) and
  [11](11-firewall.md) (the safe-change side of the lockout recovery),
  [13](13-users-permissions-and-api-tokens.md) (the task system),
  [14](14-best-practices-and-hardening.md) (the `authorized_keys2` lifeline),
  [15](15-monitoring-maintenance-and-notifications.md) (journald persistence, `pvereport`),
  [17](17-backups-with-pbs.md) and [18](18-the-independent-copy-and-restore.md) (recovery from
  backups), and [20](20-reinstalling-the-host-remotely.md) (reinstall as the last resort).
- `GLOSSARY.md` -- the canonical definitions reused here of [pmxcfs (/etc/pve)](GLOSSARY.md),
  [UPID](GLOSSARY.md), [quorum](GLOSSARY.md), [journald](GLOSSARY.md), [btrfs](GLOSSARY.md),
  [btrfs balance](GLOSSARY.md), [proxmox-boot-tool](GLOSSARY.md), [pve-firewall](GLOSSARY.md),
  [is_mountpoint](GLOSSARY.md), [serial console](GLOSSARY.md), [pvesh](GLOSSARY.md),
  [pvesm](GLOSSARY.md), and [OVMF / UEFI](GLOSSARY.md).
- [pvenode manual](https://pve.proxmox.com/pve-docs/pvenode.1.html),
  [qm manual](https://pve.proxmox.com/pve-docs/qm.1.html),
  [pct manual](https://pve.proxmox.com/pve-docs/pct.1.html),
  [pvesm manual](https://pve.proxmox.com/pve-docs/pvesm.1.html),
  [pmxcfs chapter](https://pve.proxmox.com/pve-docs/chapter-pmxcfs.html),
  [pmxcfs(8)](https://pve.proxmox.com/pve-docs/pmxcfs.8.html),
  [pvecm manual](https://pve.proxmox.com/pve-docs/pvecm.1.html),
  [pve-firewall(8)](https://pve.proxmox.com/pve-docs/pve-firewall.8.html), the
  [Host Bootloader wiki](https://pve.proxmox.com/wiki/Host_Bootloader), the
  [Service daemons wiki](https://pve.proxmox.com/wiki/Service_daemons), and the
  [btrfs Balance docs](https://btrfs.readthedocs.io/en/latest/Balance.html) -- consulted to verify
  the exact command syntax and behavior of each recovery step.

---

Previous: [21 -- Passing host hardware to guests](21-passing-host-hardware-to-guests.md)
