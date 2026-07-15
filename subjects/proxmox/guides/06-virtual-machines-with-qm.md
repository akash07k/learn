# Virtual machines with qm

## What you'll be able to do

By the end of this guide you will have built a full KVM/QEMU VM from the shell, with its serial
console wired up before the operating system is installed, so even the installer is reachable as
plain text over `qm terminal`. You will know the `qm` command surface, the config file at
`/etc/pve/qemu-server/<vmid>.conf` and the options that matter for a headless btrfs single node
(UEFI with OVMF, q35, `cpu: host`, `virtio-scsi-single`, the guest agent), how to fetch an install
ISO from the shell, how to snapshot, clone, and templatize a VM on btrfs, and the Proxmox VE 9
deltas that change how new VMs are built. A container (guide 05) is the fastest path to a running
guest; a VM is the path you take when you need a full machine with its own kernel, and this guide
teaches it end to end.

## Before you start

Some of what follows is specific to Proxmox VE 9, so confirm your version first:

```bash
pveversion
```

You should see a `9.x` release, with QEMU 11.x underneath it on 9.2 (10.x on an earlier 9.x point
release); `pveversion -v` lists the `qemu-server` and `pve-qemu-kvm` package versions on their own
lines. Several steps below differ between Proxmox VE 8 and 9 (the default CPU model, the `qm disk`
command namespace, the EFI disk type), so run this first and confirm 9.x before relying on the 9.x
form.

The mental model is small and worth holding in your head before you type anything:

- A VM is a KVM/QEMU VM: a guest with its own emulated hardware and its own kernel, identified by a
  numeric VMID (100 and up; ids below 100 are reserved).
- One tool drives its whole lifecycle: `qm`, run as root on the Proxmox host. Every
  `qm set <vmid> --<key> <value>` maps one-to-one to a line in the config file, so you can always do
  the same thing two ways: with `qm` or by editing the file.
- The config file lives at `/etc/pve/qemu-server/<vmid>.conf`. It is plain text on pmxcfs (the
  `/etc/pve` filesystem), safe to change two ways: with `qm set <vmid> --<key> <value>` (which
  validates the change), or by hand using the accessible, non-interactive methods in the "Editing
  files accessibly" section of guide [02 -- The shell and the API](02-the-shell-and-the-api.md) (a
  here-doc, `tee`, or `sed -i` -- never a terminal editor like vim or nano). A `lock:` line means an
  operation is in progress, and snapshots are appended as `[snapname]` sections you must never
  hand-edit.
- The disk _contents_ live in storage (here `local-btrfs`, the btrfs storage; the storage model is
  taught in guide 09), referenced from the config by a volume id such as
  `local-btrfs:9100/vm-9100-disk-1.raw`, not stored inline in the config.

One honest pointer before you commit to this path. For the smoothest accessible install, you may
prefer the cloud-init path in guide 07: a cloud image boots already configured and SSH-reachable
with no interactive installer to drive at all. This guide teaches the ISO-installer path instead,
because driving an installer over serial is how you understand the whole machine, and because the
serial console you wire here is the same skill the cloud-init path also depends on. If you only want
a running VM fast, read guide 07; if you want to know how the machine goes together, stay here.

## The qm command surface

`qm` is a thin front end over the VM config file and the running QEMU process. You do not need every
subcommand, but it helps to know the shape of the surface. Each line below is one verb and what it
does; reach for `qm help <subcommand>` on the host for the full options of any one.

Lifecycle and inspection:

- `qm list` shows every VM with its status; `qm status <vmid>` (add `--verbose`) shows one.
- `qm create <vmid> [options]` creates a VM (and can restore one).
- `qm start` / `qm stop` / `qm shutdown` / `qm reboot` control power. `stop` is a hard power-off;
  `shutdown` is a graceful ACPI or guest-agent shutdown.
- `qm set <vmid> --<key> <value>` changes config (hotplugging the change where the device supports
  it).
- `qm config <vmid>` prints the effective config; `qm pending <vmid>` shows values that are set but
  waiting for a power-cycle.
- `qm destroy <vmid> [--purge]` -- DESTRUCTIVE: irreversibly deletes the VM and its config; confirm
  the VMID with `qm list` first. `--purge` also drops it from backup jobs and HA.

Console and access (the accessible core):

- `qm terminal <vmid>` attaches to the guest serial line; exit with Ctrl-O. This is the door into a
  VM, covered next.
- `qm monitor <vmid>` opens the low-level QEMU monitor (a `qm>` prompt) for advanced poking; you
  rarely need it.
- `qm agent <vmid> <command>` runs a guest-agent command (for example `network-get-interfaces` to
  read the guest's IPs); it needs the agent installed and enabled, covered later.

Disks and storage:

- `qm disk import <vmid> <source> <storage>` imports a disk image from a host path (the old
  `qm importdisk` is now an alias for this).
- `qm disk move <vmid> <disk> <storage>` moves a disk between storages.
- `qm disk rescan` picks up volumes added on disk; `qm disk resize <vmid> <disk> +10G` grows one.

Snapshots: `qm snapshot`, `qm rollback`, `qm delsnapshot`, `qm listsnapshot` (covered later).

Cloud-init: `qm cloudinit dump` / `update` / `pending` (the subject of guide 07).

Other useful verbs: `qm unlock <vmid>` clears a stale `lock:` line left by an interrupted operation,
and `qm showcmd <vmid> --pretty` prints the exact KVM command line Proxmox would run, which is the
single best debugging aid when a VM will not start.

## Wire the serial console first

This is the load-bearing step, and the reason it comes before everything else: you want the serial
line live before the VM has an OS, so the firmware and the boot menu render as text you can read
over `qm terminal`. (Whether the OS installer itself renders to serial depends on the installer, not
just on this wiring; the install section below is honest about that.) Two `qm set` commands do it
(here on VMID `9100`):

```bash
qm set 9100 --serial0 socket
qm set 9100 --vga serial0
```

The first adds a serial port backed by a Unix socket on the host. The second routes the VM's primary
display to that serial port, so OVMF (the UEFI firmware) and the boot menu appear over serial
instead of to a graphical screen you cannot read. A serial-aware installer appears too; a generic
graphical installer may not, which the install section below explains and works around. When you
build the VM with `qm create` below, you pass both flags right there, so the port exists from the
start.

Attach to it from the host shell, and press Enter once or twice to wake the output:

```bash
qm terminal 9100
```

Exit with Ctrl-O (the letter O, not zero). One gotcha catches everyone: a `serial0` you add to an
already-running VM does not take effect until a full power-cycle, which means `qm stop 9100` then
`qm start 9100`, not a reboot. Build the port in at create time, as below, and you avoid this.

That is the short version. Guide 04 is the full reference for the serial door: the `--iface serial1`
fallback, the stop/start gotcha in detail, and (crucially) the guest-side setup that keeps a login
prompt on `ttyS0` after the OS is installed (`console=ttyS0,115200` last in `/etc/default/grub`,
then `serial-getty@ttyS0`). You will need that guest-side step once the install finishes; do not
repeat it here, follow guide 04.

## The config file -- key options for a headless btrfs node

`qm` writes a single plain-text config file per VM. Knowing its key lines lets you read `qm config`
output fluently and edit by hand when that is quicker.

The file is:

```text
/etc/pve/qemu-server/<vmid>.conf
```

It lives on pmxcfs, is an INI-style `key: value` file (with comma-separated `k=v` sub-properties on
a line), and is safe to change two ways: with `qm set <vmid> --opt val` (which validates), or by
hand. The key options for a headless btrfs single node:

- `cores: 4` and `sockets: 1`: keep `sockets: 1` on a consumer Ryzen (it is a single socket) and
  scale `cores`.
- `cpu: host`: on a single node with no live migration, the Proxmox docs explicitly recommend
  `host`, which exposes every Ryzen CPU flag (AES, AVX2, and the rest) for maximum performance. The
  Proxmox VE 9 default for a new VM is the portable `x86-64-v2-AES` model, which exists so a VM can
  migrate between different CPUs; you have one node and never migrate, so override it to `host`.
- `memory: 4096` (in MiB) with optional `balloon: 2048`: ballooning lets the host reclaim memory
  down to the `balloon` floor when it is under pressure. The guest needs the balloon driver for
  ballooning to actually shrink; on Linux the `virtio_balloon` module is in the kernel and loads
  automatically, so setting the floor is enough (a Windows guest needs the balloon driver and
  service from the guest tools, covered in guide 08). `balloon: 0` disables it. Confirm it is live
  with `qm status <vmid> --verbose`, which shows a `ballooninfo` block once the guest side is
  running.
- `machine: q35`: the modern PCIe machine type. Prefer it for new Linux guests and anything doing
  PCIe passthrough, over the older `i440fx` default.
- `bios: ovmf` with a required `efidisk0`: choosing OVMF / UEFI firmware requires a small EFI
  variables disk. Write it as `efidisk0: local-btrfs:1,efitype=4m,pre-enrolled-keys=1`. Use
  `efitype=4m` for every new VM (it is Secure Boot capable and has room for the vars); `2m` is
  legacy. `pre-enrolled-keys=1` enrolls Microsoft's Secure Boot keys, which you can still disable
  from the OVMF menu later.
- `scsihw: virtio-scsi-single`: the recommended SCSI controller, which gives each disk its own
  controller so a per-disk `iothread` works for the best throughput.
- A disk line such as
  `scsi0: local-btrfs:9100/vm-9100-disk-1.raw,iothread=1,size=32G,discard=on,ssd=1`: `iothread=1`
  pairs with `virtio-scsi-single`, and `discard=on` plus `ssd=1` enable TRIM passthrough, which is
  the right choice on a btrfs-backed SSD.
- `net0: virtio,bridge=vmbr0`: a virtio NIC (the high-performance type, built into the Linux kernel)
  on the host bridge `vmbr0`, the default Linux bridge created at install; networking and the
  default bridge are covered in guide 10. Append `,firewall=1` or `,tag=<vlan>` as needed.
- `agent: enabled=1`: turns on guest-agent integration (graceful shutdown, consistent snapshots, IP
  reporting). You still install the agent inside the guest, covered later.
- `ostype: l26`: marks the guest as a modern Linux (2.6+ kernel), which tunes default hardware.
- `boot: order=scsi0;net0`: the boot device priority; the first bootable device wins.
- `serial0: socket` and `vga: serial0`: the serial-first pair from the previous section.

A full example config follows. This is what `/etc/pve/qemu-server/9100.conf` looks like for a Debian
13 VM with UEFI, q35, and serial-first display, on btrfs storage.

File `/etc/pve/qemu-server/9100.conf`:

```ini
agent: enabled=1
bios: ovmf
boot: order=scsi0;net0
cores: 4
cpu: host
efidisk0: local-btrfs:9100/vm-9100-disk-0.raw,efitype=4m,pre-enrolled-keys=1,size=528K
machine: q35
memory: 4096
balloon: 2048
name: debian-lab
net0: virtio=BC:24:11:AA:BB:CC,bridge=vmbr0,firewall=1
numa: 0
ostype: l26
scsihw: virtio-scsi-single
scsi0: local-btrfs:9100/vm-9100-disk-1.raw,iothread=1,size=32G,discard=on,ssd=1
serial0: socket
sockets: 1
vga: serial0
vmgenid: a1b2c3d4-0000-0000-0000-000000000000
```

A few notes on the example. `vga: serial0` is what makes the serial line the primary display, so the
firmware and the boot menu render over serial (the installer too, if it is serial-aware; see the
install section below). The `efidisk0` is tiny (it stores only the EFI variables, here 528K). The OS
disk is `scsi0`. The `vmgenid` line is added automatically at create time; you do not write it
yourself.

## Download an install ISO from the shell

ISOs live on a storage that carries the `iso` content type. On this btrfs node that is the active
`local-btrfs` storage (the plain `local` directory storage is disabled, per guide
[09 -- Storage](09-storage.md)); its iso directory is on the host disk at
`/var/lib/pve/local-btrfs/template/iso/`.

The preferred way to fetch one is the storage `download-url` API, because it downloads straight into
the storage's iso directory and validates the checksum. There is no `pvesm download-iso` subcommand
(it does not exist in PVE 9); call the API endpoint with `pvesh` instead. This is the same endpoint
the web UI's "Download from URL" button uses:

```bash
pvesh create /nodes/$(hostname)/storage/local-btrfs/download-url \
 --content iso --filename debian-13-netinst.iso \
 --url https://cdimage.debian.org/<path>/debian-13.0.0-amd64-netinst.iso \
 --checksum-algorithm sha256 --checksum <sha256sum>
```

The `$(hostname)` expands to this node's name (the API path is per node); run it on the host itself.
Copy the real URL and the published `sha256` sum from the Debian download page; the validation step
is the point, so do not skip the `--checksum` arguments. If you would rather just fetch the file,
`curl` it into the iso directory by hand:

```bash
curl -L -o /var/lib/pve/local-btrfs/template/iso/debian-13-netinst.iso \
 https://cdimage.debian.org/<path>/debian-13.0.0-amd64-netinst.iso
```

Either way, confirm the ISO is visible to Proxmox:

```bash
pvesm list local-btrfs --content iso
```

That prints one line per ISO on `local-btrfs`, with its volume id
(`local-btrfs:iso/debian-13-netinst.iso`), which is how you reference it when you attach it to the
VM below.

## Build a VM end to end (ISO path)

Now build VMID `9100` step by step. The order matters: the serial display goes in at create time,
the required EFI disk and the OS disk come next, then the installer ISO, then you start and drive
the install over serial.

First create the VM shell with the serial-first display, q35, OVMF, `cpu: host`, virtio-scsi-single,
the virtio NIC, and the guest agent enabled:

```bash
qm create 9100 \
 --name debian-lab --ostype l26 \
 --machine q35 --bios ovmf \
 --cores 4 --sockets 1 --cpu host \
 --memory 4096 --balloon 2048 \
 --scsihw virtio-scsi-single \
 --net0 virtio,bridge=vmbr0,firewall=1 \
 --agent enabled=1 \
 --serial0 socket --vga serial0
```

Add the EFI variables disk, which OVMF requires:

```bash
qm set 9100 --efidisk0 local-btrfs:1,efitype=4m,pre-enrolled-keys=1
```

Add the OS disk on btrfs, with iothread and discard:

```bash
qm set 9100 --scsi0 local-btrfs:32,iothread=1,discard=on,ssd=1
```

Here `local-btrfs:32` means "allocate a 32 GiB disk on storage `local-btrfs`", and `local-btrfs:1`
for the EFI disk is a placeholder size that Proxmox replaces with the correct tiny size for a `4m`
vars store. Attach the installer ISO as a virtual CD-ROM and set the boot order to try the disk,
then the CD, then the network:

```bash
qm set 9100 --ide2 local-btrfs:iso/debian-13-netinst.iso,media=cdrom
qm set 9100 --boot 'order=scsi0;ide2;net0'
```

Start the VM and attach to the serial line to drive the install:

```bash
qm start 9100
qm terminal 9100
```

Press Enter once or twice to wake the output. Set honest expectations here, because this is the
hardest accessibility moment in the whole build. The `vga: serial0` wiring puts the firmware and the
GRUB boot menu on serial, so you will reach the menu and can read it. It does not, by itself, put
the installer's own kernel on serial: a generic graphical installer renders to a screen you cannot
see and shows nothing over `qm terminal`. If you select an install entry and the console goes
silent, that is the cause, not a broken serial wire and not a sleeping prompt that another Enter
would wake.

The fix is to tell the installer kernel to use the serial console. With Debian's netinst, at the
GRUB boot menu highlight the install entry and press `e` to edit it, find the line that starts with
`linux`, append `console=ttyS0,115200` to the end of that line, and press Ctrl-X (or F10) to boot
it. The installer now runs entirely as text over `qm terminal`, and you drive the whole install from
the keyboard. If the menu offers a dedicated serial or text-mode install entry, that does the same
thing. Exit the terminal at any time with Ctrl-O.

If an installer cannot be coaxed onto serial at all, stop here and use the cloud-init path in guide
07 instead: a cloud image has no interactive installer to render, so the accessibility problem
disappears entirely. That path, not a fight with a graphical installer, is the recommended way to
stand up most VMs.

When the install finishes, detach the ISO so the VM boots from its disk:

```bash
qm set 9100 --ide2 none,media=cdrom
```

One thing remains, and it is essential: the host-side serial wiring gets you through firmware and
the installer, but the installed guest must keep its own login prompt on `ttyS0` or `qm terminal`
will connect to a silent port after the first reboot. Do the guest-side serial setup from guide 04
(the `console=ttyS0,115200` line last in the guest's `/etc/default/grub`, `update-grub`, then
`systemctl enable --now serial-getty@ttyS0.service`) inside the freshly installed system. That guide
is the full reference; follow it rather than repeating it here.

If you ever decide to bake an SSH key into a VM (for example through cloud-init in guide 07),
remember the lockout caveat from guide 02: keep an independent copy of your public key in
`~/.ssh/authorized_keys2`, a real file outside `/etc/pve`, so a pmxcfs problem cannot lock you out.
The ISO path here installs no key, so you log in at the serial console first; the detailed
key-injection story is guide 07.

## Install the guest agent

The guest agent has two halves, one on each side of the boundary. The host side you already enabled
in the example, but to be explicit:

```bash
qm set 9100 --agent enabled=1
```

The guest side, run inside the VM over `qm terminal` (or SSH once it is reachable), installs and
starts the qemu-guest-agent service:

```bash
apt install qemu-guest-agent
systemctl enable --now qemu-guest-agent
```

With both halves in place, Proxmox can talk to the running guest: a `qm shutdown` becomes a clean
guest-initiated shutdown, snapshots and backups can freeze the guest filesystem for consistency, and
the host can report the guest's IP addresses. The serial console is independent of the agent: the
agent does not replace `qm terminal`, and `qm terminal` does not need the agent. Keep both, because
the serial console is your always-available recovery door even if the agent or the network is down.

## Snapshots, clones, templates

Because the VM's disks sit on btrfs storage, Proxmox stores each disk as a raw file inside its own
btrfs subvolume, and `qm snapshot` uses native btrfs subvolume snapshots underneath. They are
instant to take and initially share all their blocks with the original. Take one before any risky
change:

```bash
qm snapshot 9100 pre-upgrade --description "before apt full-upgrade"
qm snapshot 9100 with-ram --vmstate 1
qm listsnapshot 9100
qm rollback 9100 pre-upgrade
qm delsnapshot 9100 pre-upgrade
```

`qm snapshot` creates one, `qm listsnapshot` lists them, `qm rollback` reverts the VM to one, and
`qm delsnapshot` removes one. By default a snapshot is disk-only (crash-consistent); add
`--vmstate 1` to also capture the live RAM, so a rollback resumes the VM at the exact running
moment. With the guest agent present, Proxmox freezes the guest filesystem during the snapshot for a
clean, consistent capture. The snapshot metadata is recorded as `[snapname]` sections in
`/etc/pve/qemu-server/9100.conf`; never hand-edit those.

Two honest cautions. First, a snapshot lives on the same disk and storage as the VM, so it is not a
backup: it dies with the disk. Second, the btrfs storage integration in Proxmox VE 9 is still a
technology preview, which is another reason not to lean on snapshots as your safety net. Real
backups (vzdump and Proxmox Backup Server) are a later guide in Part F; treat snapshots as a quick
undo for a change you are about to make, not as your data-protection strategy.

To mass-produce VMs, turn a prepared, generalized VM into a template and clone from it:

```bash
qm template 9100
qm clone 9100 130 --name app-1
qm clone 9100 131 --name app-2 --full
```

A template is marked read-only and is not run directly; you clone from it. Cloning a template
defaults to a linked clone: a fast, thin copy that shares the template's base disk via copy-on-write
and stores only its own changes. Because a linked clone depends on that base, do not delete a
template that still has linked clones. Pass `--full` to force an independent full copy that does not
depend on the template. (Cloning a normal, non-template VM is always a full clone.)

## Importing a disk

To bring an existing disk image (a `.qcow2`, `.raw`, `.vmdk`, or `.vdi`) into a VM, first put the
image somewhere on the host filesystem, then import it. The source must be a host filesystem path,
not a `storage:...` volume id.

The one-shot form imports the image straight onto a bus slot and is the one to prefer:

```bash
qm set 9100 --scsi1 local-btrfs:0,import-from=/root/data.qcow2
```

The `local-btrfs:0` placeholder size is replaced by the imported image's actual size. The two-step
form does the same thing in two moves, which is handy if you want to inspect the result before
attaching:

```bash
qm disk import 9100 /root/data.qcow2 local-btrfs
qm config 9100 | grep unused
qm set 9100 --scsi1 local-btrfs:9100/vm-9100-disk-2.raw,iothread=1
```

`qm disk import` lands the image as an `unused` disk in the config; the `grep` shows its volume id,
and the final `qm set` attaches it. On btrfs, images land as raw files inside subvolumes, which is
normal and what you want; do not force `--format qcow2` on a btrfs target. (For a whole-appliance
OVA/OVF, the matching verb is `qm importovf`.)

## A persistent data disk (surviving VM deletion)

A common pattern is a disposable OS VM with data that must outlive it: rebuild or reinstall the
machine, keep the data disk. Proxmox has no per-disk "keep on delete" flag (the VMware
independent-persistent idea); a disk you attach normally is _owned_ by the VM and is deleted with
it. Persisting one is a matter of decoupling it from the VM before you destroy the VM.

Attach a second disk on its own bus slot, leaving the OS on `scsi0`:

```bash
# 100 GiB data disk on scsi1 (discard + SSD hints; not the boot disk)
qm set 9100 --scsi1 local-btrfs:100,discard=on,ssd=1
```

That creates a volume named `local-btrfs:9100/vm-9100-disk-<n>.raw`, owned by VM 9100. The catch is
deletion: `qm destroy 9100` removes the config AND every disk the VM owns, including any you have
detached, because a detached disk is still referenced in the config as `unused0` and still carries
the VM's id in its name. Detaching alone does not save it.

The reliable way to keep the data is to reassign the disk to another VM before destroying this one.
Create or pick a "keeper" VM (say 9999) that just holds the volume, then:

```bash
# 1. Detach the data disk (it becomes unused0 in 9100's config).
qm set 9100 --delete scsi1

# 2. Reassign that volume to the keeper VM, landing on its scsi1.
qm disk move 9100 unused0 --target-vmid 9999 --target-disk scsi1

# 3. Destroy the original VM; only its remaining owned disks go.
qm destroy 9100
```

The volume is renamed to `9999/vm-9999-disk-<n>.raw` and lives on under the keeper. Later, reassign
it back to a fresh VM the same way. This is the pattern for "the OS is disposable, the data is not."

If you can plan ahead, skip the detach-and-reassign dance by giving the data disk the keeper's owner
id from the start. Allocate the volume under the keeper VMID with `pvesm alloc`, then attach that
existing volume to the working VM by its full volume id:

```bash
# 1. Pre-allocate a 100 GiB raw volume OWNED by keeper VM 9999 (note the 9999 in the name).
pvesm alloc local-btrfs 9999 vm-9999-data.raw 100G --format raw

# 2. Attach that existing volume to the working VM.
qm set 9100 --scsi1 local-btrfs:9999/vm-9999-data.raw,discard=on,ssd=1
```

Now `qm destroy 9100` leaves the disk alone, because ownership is decided by the VMID embedded in
the volume name (`vm-9999-...`), not by which VM the disk is attached to and not by whether you made
it by hand. The one cost is a harmless warning about a foreign-owned volume in some `qm` operations
(migration, rescan); on a single node it does not matter. Volume ids and ownership are covered in
full in [09 -- Storage](09-storage.md).

A few alternatives worth knowing:

- A host directory shared with virtiofs (Proxmox VE 9.0+), covered in the next section: the data
  lives in a host directory rather than a VM-owned volume, so it survives the VM without a separate
  machine. This is the single-node option that fits the disposable-OS pattern best.
- Shared or network storage instead of a VM-owned disk. Keep the data on an NFS or SMB share and
  mount it inside the guest over the network. Then it is never a VM-owned volume, so destroying the
  VM cannot touch it. That is the most decoupled option, at the cost of a network dependency and
  storage outside this single node's `local-btrfs`.
- Backups outlive the VM. A `vzdump` backup of the disk survives `qm destroy` and restores into a
  new VM. That is recovery, not live persistence, but it is the safety net if you forget to reassign
  before destroying.

One caution: `qm destroy 9100 --destroy-unreferenced-disks` additionally sweeps any
`9100/vm-9100-disk-*.raw` volumes still on storage, even ones not in the config. Only use that flag
once you have already reassigned (and so renamed) anything you meant to keep.

## Sharing a host directory with virtiofs

virtiofs (Proxmox VE 9.0+) shares a directory from the host straight into a VM at near-native speed,
with no NFS or SMB server in between. Because the data lives in a host directory and not a VM-owned
volume, it is independent of the VM: destroy the VM and the directory and its contents stay. That
makes it the single-node way to keep data across a rebuild without a separate NAS.

Map a host path to a mapping id once (on the host), then attach it to the VM by that id:

```bash
# 1. Map a host path to a mapping id (per node).
pvesh create /cluster/mapping/dir --id windata \
  --map node=$(hostname),path=/srv/windata

# 2. Attach it to the VM as virtiofs0.
qm set 9100 --virtiofs0 dirid=windata,cache=auto,direct-io=1
```

Other knobs are `cache=always|metadata|never|auto`, `expose-xattr=1`, and `expose-acl=1` (a Windows
guest must NOT set `expose-acl`, or the share will not appear in it; see guide 08). The `dirid` is
the mapping id, not the path. Two things to know: a VM with a virtiofs device cannot live-migrate or
hibernate (irrelevant on a single node), and the device needs a shared-memory backing, which Proxmox
sets up for you when you attach it. On a Linux guest, mount the share with its mapping id as the
tag:

```bash
mount -t virtiofs windata /mnt/windata
```

A Windows guest needs a driver and a service instead of a mount command; guide
[08 -- Windows guests](08-windows-guests.md) covers the WinFsp and VirtIO-FS service steps.

## PVE 9 deltas to know

Run `pveversion` first and confirm you are on 9.x before relying on these, because each is a point
where Proxmox VE 8 and 9 differ:

- Default CPU model. A new VM defaults to the portable `x86-64-v2-AES` model (it was `kvm64` on PVE
  8). That portability exists for migration between different CPUs; on a single node you never
  migrate, so override it to `cpu: host` for full Ryzen performance, as the example above does.
- The `qm disk` namespace. The current verbs are `qm disk import`, `qm disk move`, `qm disk rescan`,
  and `qm disk resize`. The old bare verbs (`importdisk`, `move-disk`, `rescan`) still work as
  aliases, but write the new namespaced form.
- EFI disk type. Always use `efitype=4m` for a new VM (Secure Boot capable, more space); `2m` is the
  legacy size and only appears on older VMs.
- A newly added `serial0` needs a full stop/start (not a reboot) to take effect. Adding it at create
  time, as this guide does, sidesteps the issue entirely.
- virtiofs directory sharing (new in Proxmox VE 9.0) lets you share a host directory into a VM at
  near-native speed without NFS or SMB. It is worth knowing exists, though it carries one limit: a
  VM with a virtiofs device cannot live-migrate or hibernate, which is irrelevant on a single node.

## Verify it worked

Confirm the VM from the shell, with no graphical console anywhere in the loop.

It is running:

```bash
qm list
```

You should see a row for `9100` with status `running`.

The serial console reaches a login prompt:

```bash
qm terminal 9100
```

Press Enter once or twice; you should land at the guest's login prompt. Exit with Ctrl-O. Reaching a
login here is the proof that the host-side serial wiring and the guest-side `serial-getty` setup
both took.

After the guest agent is up, the host can read the guest's IP from inside it:

```bash
qm agent 9100 network-get-interfaces
```

That returns the guest's network interfaces and their addresses (as JSON, which reads cleanly with a
screen reader). If it errors with an agent-not-running message, the agent is not installed or
started inside the guest yet; revisit the install-the-agent step.

The serial-first config is in place:

```bash
qm config 9100
```

The output should include `serial0: socket` and `vga: serial0`. Those two lines are what make the
whole machine reachable as text; seeing them confirms the VM is built the accessible way.

## Sources

- `research/round2-pve9/09-pve9-vms-qm.md` - the mental model and config-file location
  (`/etc/pve/qemu-server/<vmid>.conf` on pmxcfs, `qm set` mapping one-to-one to config lines,
  `[snapname]` sections not hand-edited); the `qm` command surface grouped by lifecycle,
  console/access, disks, snapshots, and cloud-init, plus `qm unlock` and `qm showcmd`; the
  serial-first pair (`--serial0 socket`, `--vga serial0`), `qm terminal`, Ctrl-O, and the stop/start
  gotcha; the per-option config reference (`cores`/`sockets: 1`/`cpu: host`, `memory`/`balloon`,
  `machine: q35`, `bios: ovmf` plus the required `efidisk0` with `efitype=4m,pre-enrolled-keys=1`,
  `scsihw: virtio-scsi-single`, the `iothread=1,discard=on,ssd=1` disk line,
  `net0: virtio,bridge=vmbr0`, `agent: enabled=1`, `ostype: l26`, `boot: order=...`) and the full
  example `9100.conf`; downloading ISOs with the storage `download-url` API (checksum-validated) or
  `curl` into `/var/lib/pve/local-btrfs/template/iso/` and `pvesm list local-btrfs --content iso`;
  the end-to-end ISO build (`qm create` with the serial-first flags, `qm set` for `efidisk0`, the OS
  disk, and the `ide2` CD-ROM, `--boot order=scsi0;ide2;net0`, `qm start`, `qm terminal`, then
  detaching the ISO); the guest agent on both host and guest sides; native btrfs snapshots
  (`qm snapshot`, `--vmstate 1`, `rollback`, `delsnapshot`) with the technology-preview and
  not-a-backup caveats; `qm template` and `qm clone` (linked by default, `--full` for independent);
  disk import (the `import-from` one-shot and the two-step `qm disk import`, host-path source, raw
  on btrfs); and the PVE 9 deltas (default `x86-64-v2-AES` overridden to `cpu: host`, the `qm disk`
  namespace with old aliases, `efitype=4m` always, the new `serial0` stop/start, and virtiofs).
- `GLOSSARY.md` and `CONTEXT.md` - the canonical definitions of KVM/QEMU VM, `qm`, serial console,
  OVMF / UEFI, `virtio-scsi-single`, qemu-guest-agent, snapshot, template / linked clone, cloud
  image, `local-btrfs`, `vmbr0`, and pmxcfs reused here, and the role names (Proxmox host, control
  station, guest, the three superpowers).
- Proxmox VE documentation: [qm.1](https://pve.proxmox.com/pve-docs/qm.1.html),
  [qm.conf.5](https://pve.proxmox.com/pve-docs/qm.conf.5.html),
  [the Qemu/KVM chapter](https://pve.proxmox.com/pve-docs/chapter-qm.html), and the
  [Serial Terminal wiki](https://pve.proxmox.com/wiki/Serial_Terminal).

---

Previous: [05 -- Containers with LXC and pct](05-containers-with-lxc-and-pct.md) | Next:
[07 -- Cloud-init templates](07-cloud-init-templates.md)
