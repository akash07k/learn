# PVE 9 Virtual Machines via `qm` (shell-only, serial-console workflow)

Target: latest Proxmox VE 9.x (9.2 in mid-2026), based on Debian 13 "trixie". QEMU moved during the
9.x series: 9.0 shipped QEMU 10.0.2, 9.1 shipped QEMU 10.1.2, and 9.2 ships QEMU 11.0.

Audience: a blind, screen-reader, **shell-only** operator on a **single node** whose host root is
**BTRFS**, building home services + a dev lab. The graphical noVNC/SPICE console is unusable; the
**serial console (`qm terminal`)** is the primary in-guest interface and is emphasized throughout.
Set it up _before_ OS install so even the installer is reachable over serial.

This document reports what is TRUE in PVE 9 and flags deltas from PVE 8 and new 9.x features.

---

## 1. Mental model and where things live

- A VM is a QEMU/KVM guest with a numeric **VMID** (100 - 999999999; <100 reserved).
- One tool drives the VM lifecycle: **`qm`** (run as `root`). Every `qm set --<key> <value>` maps
  1:1 to a line in the config file, so you can always do it two ways.
- Config file: **`/etc/pve/qemu-server/<vmid>.conf`**. It lives on `pmxcfs` (the FUSE SQLite-backed
  cluster filesystem at `/etc/pve`), but it is plain text editable with `nano`/`vi`. Snapshots are
  appended as `[snapname]` sections - do not edit those by hand. A `lock:` line means an operation
  is in progress.
- Disk _contents_ live in **storage** (for this target, `local-btrfs`), referenced from the conf by
  volume ID (`local-btrfs:100/vm-100-disk-0.raw`), not stored inline.
- On-box authority: `man qm`, `man qm.conf`, `qm help`, `qm help <subcommand>`.

Citations: [qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html) ,
[qm.conf(5)](https://pve.proxmox.com/pve-docs/qm.conf.5.html) ,
[QEMU/KVM Virtual Machines](https://pve.proxmox.com/pve-docs/chapter-qm.html)

---

## 2. The `qm` command surface in PVE 9

Lifecycle and inspection:

- `qm list` - all VMs with status. `qm status <vmid> [--verbose]`.
- `qm create <vmid> [opts]` - create (or restore) a VM.
- `qm start|stop|shutdown|reboot|reset|suspend|resume <vmid>`.
- `stop` = hard power-off; `shutdown` = ACPI/guest-agent graceful.
- `qm set <vmid> --<key> <value>` - change config (hotplug where supported).
- `qm destroy <vmid> [--purge] [--destroy-unreferenced-disks]` - delete.
- `qm config <vmid> [--current]` - print effective config.
- `qm pending <vmid>` - pending vs active values (changes needing a reboot).
- `qm clone`, `qm template`, `qm migrate` (no-op use on single node).

Console / access (the accessible core):

- **`qm terminal <vmid> [--iface serial0] [--escape ^O]`** - attach to the guest serial line. Exit
  with **Ctrl-O** (default escape char `^O`).
- `qm monitor <vmid>` - QEMU monitor (`qm>` prompt). `qm sendkey <vmid> <key>`.
- `qm vncproxy` / `qm guest cmd ...` - guest-agent commands (see §11).

Disks / storage:

- **`qm disk import <vmid> <source> <storage> [--format ...] [--target-disk ...]`** (PVE 8/9
  spelling; **`qm importdisk` is now an alias** for it).
- `qm disk move <vmid> <disk> [<storage>] [opts]` (alias `qm move-disk`).
- `qm disk rescan [--vmid <n>]` (alias `qm rescan`) - pick up volumes added on disk.
- `qm disk unlink`, `qm disk resize <vmid> <disk> <size>` (e.g. `+10G`).
- `qm importovf <vmid> <manifest.ovf> <storage>`.

Snapshots: `qm snapshot`, `qm rollback`, `qm delsnapshot`, `qm listsnapshot` (§9).

Cloud-Init: `qm cloudinit dump <vmid> <type>`, `qm cloudinit update <vmid>`,
`qm cloudinit pending <vmid>`.

Other: `qm cleanup`, `qm unlock <vmid>` (clear a stale `lock:`), `qm showcmd <vmid> [--pretty]`
(prints the exact KVM command line - useful for debugging), `qm nbdstop`, `qm cpu` (list CPU
models), `qm wait <vmid>`.

Citation: [qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html)

---

## 3. The config file - every key option for our build

Format is `key: value`, with comma-separated `k=v` sub-properties. The key options for a headless
BTRFS single-node lab:

- **CPU topology**: `cores: N`, `sockets: 1`, optional `vcpus`. Keep `sockets: 1` on a consumer
  Ryzen (single socket) and scale `cores`.
- **CPU type**: `cpu: host`. The UI default in PVE 9 is `x86-64-v2-AES`, but for a **single node
  with no live migration**, the docs explicitly recommend `host` for maximum performance (exposes
  all Ryzen flags incl. AES, AVX2). New in 9.1: a vCPU flag to **enable nested virtualization** on
  top of a host-matching vCPU type (for running nested hypervisors / Windows VBS). On AMD, nested
  KVM also needs the host module option `kvm_amd nested=1`.
- **Memory**: `memory: 4096` (MiB). Ballooning: set `balloon: <min MiB>` below `memory` to allow
  reclaim; `balloon: 0` disables ballooning entirely. The guest needs the **balloon driver / guest
  agent** for ballooning to actually shrink.
- **Machine type**: `machine: q35` (modern PCIe) vs default `i440fx`. Prefer **q35** for new Linux
  guests and any PCIe passthrough. PVE pins the machine _version_ (e.g. `pc-q35-<current-qemu>`) for
  Windows; Linux tracks latest. Delta: disks attach differently internally for machine version
  `10.0+` (groundwork for thick-LVM snapshots) - generally transparent.
- **BIOS / UEFI**: `bios: ovmf` for UEFI (vs default `seabios`). UEFI **requires an EFI vars disk**:
  `efidisk0: <storage>:1,efitype=4m,pre-enrolled-keys=1`. Use **`efitype=4m`** for all new VMs
  (Secure Boot capable, more space); `2m` is legacy. `pre-enrolled-keys=1` enrolls MS Secure Boot
  keys (can be disabled in the OVMF menu).
- **SCSI controller**: `scsihw: virtio-scsi-single` - the recommended controller; it gives each disk
  its own controller so **`iothread=1`** per disk works for best throughput.
- **Disks**: `scsi0: local-btrfs:100/vm-100-disk-0.raw,iothread=1,size=32G,discard=on,ssd=1`.
  `discard=on` + `ssd=1` enable TRIM passthrough (good on BTRFS/SSD). `cache=none` (default) is safe
  and fast.
- **Network**: `net0: virtio,bridge=vmbr0` (optionally `,firewall=1,tag=<vlan>`). `virtio` is the
  high-performance NIC; needs virtio-net driver in guest (built into Linux).
- **Guest agent**: `agent: enabled=1` (often written `agent: 1`). Lets PVE do graceful shutdown,
  filesystem-freeze snapshots, and report guest IPs. Install the agent in the guest (§11).
- **OS type**: `ostype: l26` (Linux 2.6+/modern). Windows uses `win11`, `win10`, etc. Affects
  default hardware tuning.
- **Boot order**: `boot: order=scsi0;net0`. List devices in priority order; first bootable wins.
  Include `net0` to allow PXE fallback.
- **Serial / display** (accessibility - see §5): `serial0: socket` and `vga: serial0`.

Citations: [qm.conf(5)](https://pve.proxmox.com/pve-docs/qm.conf.5.html) ,
[QEMU/KVM Virtual Machines](https://pve.proxmox.com/pve-docs/chapter-qm.html) ,
[Qemu/KVM Virtual Machines](https://pve.proxmox.com/wiki/Qemu/KVM_Virtual_Machines)

---

## 4. A full example `/etc/pve/qemu-server/9100.conf`

A Debian-13 server VM, UEFI, q35, serial-console-first, on BTRFS storage:

```text
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

Notes: `vga: serial0` makes the serial line the primary display so even early boot / the installer
render to serial. `vmgenid` is auto-added at create time. The `efidisk0` size is tiny (the vars
store), the OS disk is `scsi0`.

---

## 5. SERIAL CONSOLE accessibility path (do this FIRST)

This is the load-bearing section. Goal: reach the guest entirely over serial, **before** installing
the OS, so the installer itself is on serial.

### 5a. Host side - give the VM a serial device and make it the display

```bash
qm set 9100 --serial0 socket
qm set 9100 --vga serial0
```

`serial0: socket` creates a Unix-socket-backed serial port; `vga: serial0` redirects the VM's
primary "screen" to that serial line. With both set, OVMF/SeaBIOS output, the boot menu, and a
serial-aware installer all appear over serial. A full power-cycle (`qm stop` then `qm start`, not
just reboot) activates a newly added serial port.

Connect from the host shell:

```bash
qm terminal 9100
```

Press Enter once or twice to get output/a prompt. **Exit with Ctrl-O** (the default escape character
`^O`; override with `--escape`). If serial0 ever misbehaves you can add a `serial1` and connect with
`qm terminal 9100 --iface serial1`.

### 5b. Choose a serial-friendly install path

Two reliable options for a blind operator:

1. **Cloud image + Cloud-Init** (no interactive installer at all). Download a Debian cloud `.qcow2`,
   import it, attach Cloud-Init, set the serial display, boot straight to a configured system. See
   §8 and §10. This is the smoothest accessible path.
2. **Net/serial installer**: use a distro whose installer speaks serial (Debian's text installer
   with `console=ttyS0,115200` works). Because `vga: serial0` is set, the boot loader and installer
   render to serial via `qm terminal`.

### 5c. Guest side - keep serial working after install

After the OS is installed, ensure the guest keeps a login on `ttyS0`:

1. Kernel console on serial - edit `/etc/default/grub`:

```text
GRUB_CMDLINE_LINUX="console=tty0 console=ttyS0,115200"
```

The **last** `console=` wins as the primary; put `ttyS0` last so kernel + init messages and the boot
menu go to serial. Then:

```bash
update-grub # Debian/Ubuntu
# grub2-mkconfig -o /boot/grub2/grub.cfg # RHEL/Rocky/Alma
```

1. Login getty on serial (systemd guests - Debian 13, etc.):

```bash
systemctl enable --now serial-getty@ttyS0.service
```

This template defaults to 115200 baud and respawns the login prompt. (On very old non-systemd guests
you'd add `S0:23:respawn:/sbin/getty -L ttyS0 115200 vt102` to `/etc/inittab` or an
`/etc/init/ttyS0.conf` upstart job, but Debian 13 is systemd.)

1. Reboot, reconnect with `qm terminal 9100`, confirm you get a login prompt.

Once configured, the entire guest lifecycle - install, login, recovery, single-user mode - is
reachable over `qm terminal` with no graphics.

Citations: [Serial Terminal](https://pve.proxmox.com/wiki/Serial_Terminal) ,
[qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html) , `man qm` (`terminal`).

---

## 6. Downloading ISOs / cloud images from the shell

ISOs live under a storage with `iso` content. On this btrfs-root target that is the active
`local-btrfs` storage at `/var/lib/pve/local-btrfs/template/iso/`; the plain `local` storage is
disabled. Download directly into the active storage:

```bash
# Use the storage download-url API (validates, shows in storage). There is no `pvesm download-iso`
# subcommand; call the API with pvesh:
pvesh create /nodes/$(hostname)/storage/local-btrfs/download-url \
 --content iso --filename debian-13.0.0-amd64-netinst.iso \
 --url https://cdimage.debian.org/.../debian-13.0.0-amd64-netinst.iso \
 --checksum-algorithm sha256 --checksum <sha256sum>

# Or just curl into the iso dir:
curl -L -o /var/lib/pve/local-btrfs/template/iso/debian-13-netinst.iso \
 https://cdimage.debian.org/.../debian-13.0.0-amd64-netinst.iso
```

Cloud images (qcow2) for the Cloud-Init path can go anywhere on the host disk (e.g. `/root/`) before
importing - `qm disk import` needs a host filesystem path, not a `storage:...` volid. List ISOs with
`pvesm list local-btrfs --content iso`.

Citation: [Proxmox VE Storage](https://pve.proxmox.com/pve-docs/chapter-pvesm.html)

---

## 7. Build a VM end-to-end from the CLI (ISO installer path)

```bash
# 1. Create the shell with serial-first display, q35, UEFI, virtio-scsi-single.
qm create 9100 \
 --name debian-lab --ostype l26 \
 --machine q35 --bios ovmf \
 --cores 4 --sockets 1 --cpu host \
 --memory 4096 --balloon 2048 \
 --scsihw virtio-scsi-single \
 --net0 virtio,bridge=vmbr0,firewall=1 \
 --agent enabled=1 \
 --serial0 socket --vga serial0

# 2. EFI vars disk on the BTRFS store (required for OVMF).
qm set 9100 --efidisk0 local-btrfs:1,efitype=4m,pre-enrolled-keys=1

# 3. OS disk on BTRFS with iothread + discard.
qm set 9100 --scsi0 local-btrfs:32,iothread=1,discard=on,ssd=1

# 4. Attach the installer ISO as a CD-ROM and set boot order.
qm set 9100 --ide2 local-btrfs:iso/debian-13-netinst.iso,media=cdrom
qm set 9100 --boot order=scsi0;ide2;net0

# 5. Start and drive the install over serial.
qm start 9100
qm terminal 9100 # exit with Ctrl-O

# 6. After install, detach the ISO.
qm set 9100 --ide2 none,media=cdrom
```

`local-btrfs:32` means "allocate a 32 GiB disk on storage `local-btrfs`"; `:1` for the efidisk means
a 1-unit allocation (PVE sizes it correctly for 4m). Then do the §5c guest-side serial setup inside
the installed system.

---

## 8. Cloud-Init path (most accessible - no interactive installer)

```bash
# Download a Debian 13 generic cloud image to the host.
curl -L -o /root/debian-13-genericcloud-amd64.qcow2 \
 https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2

# Create the VM shell (serial-first).
qm create 9200 --name cloud-lab --ostype l26 --machine q35 \
 --cores 2 --sockets 1 --cpu host --memory 2048 \
 --scsihw virtio-scsi-single --net0 virtio,bridge=vmbr0 \
 --agent enabled=1 --serial0 socket --vga serial0

# Import the cloud image as scsi0 (one step, no temp 'unused' disk).
qm set 9200 --scsi0 local-btrfs:0,import-from=/root/debian-13-genericcloud-amd64.qcow2,iothread=1,discard=on

# Cloud-Init drive + user config.
qm set 9200 --ide2 local-btrfs:cloudinit
qm set 9200 --ciuser akash --sshkeys ~/.ssh/authorized_keys
qm set 9200 --ipconfig0 ip=dhcp
qm set 9200 --boot order=scsi0

# Grow the root disk and boot.
qm disk resize 9200 scsi0 +18G
qm start 9200
qm terminal 9200
```

`local-btrfs:0,import-from=<path>` is the modern one-shot import (PVE 8/9): the `:0` placeholder
size is replaced by the imported image's size. Most Debian/Ubuntu cloud images already enable
`ttyS0`, so `qm terminal` works immediately. Inspect the rendered Cloud-Init with
`qm cloudinit dump 9200 user`.

Citation: [QEMU/KVM Virtual Machines](https://pve.proxmox.com/pve-docs/chapter-qm.html)
(Cloud-Init).

---

## 9. Snapshots on BTRFS storage

`qm` snapshot commands:

```bash
qm snapshot 9100 pre-upgrade --description "before apt full-upgrade"
qm snapshot 9100 with-ram --vmstate 1 # also save live RAM state
qm listsnapshot 9100
qm rollback 9100 pre-upgrade [--start] # revert; VM must be stopped (auto-starts if snap had RAM)
qm delsnapshot 9100 pre-upgrade [--force]
```

BTRFS specifics and limitations:

- The PVE **`btrfs` storage plugin supports `Snapshots`** as a capability - each VM disk is stored
  as a raw file inside its own BTRFS subvolume, and `qm snapshot` uses BTRFS subvolume snapshots
  underneath. So snapshots work natively on a BTRFS store.
- `--vmstate 1` adds a live-memory snapshot (resume to exact running state); without it you get a
  crash-consistent disk-only snapshot. With the guest agent, PVE freezes the guest filesystem during
  the snapshot for consistency.
- BTRFS in PVE is still labeled **technology preview**; for a home lab it is fine, but keep backups
  (vzdump/PBS) as the real safety net, not just snapshots.
- Snapshots are recorded as `[snapname]` sections in `9100.conf` - never hand-edit.
- Snapshots are **not a backup**: they live on the same disk/storage as the VM.

Citations: [qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html) ,
[Proxmox VE Storage](https://pve.proxmox.com/pve-docs/chapter-pvesm.html) (BTRFS plugin
capabilities).

---

## 10. Templates and clones (linked vs full)

```bash
# Turn a prepared, generalized VM into a template (read-only base).
qm template 9200

# Linked clone (fast, thin - default for templates; shares base, needs template intact).
qm clone 9200 130 --name app-1

# Full clone (independent copy of all disks).
qm clone 9200 131 --name app-2 --full --storage local-btrfs
```

- `qm clone` of a **template** defaults to a **linked clone** (copy-on-write off the base; small and
  instant). `--full` forces an independent full copy.
- Cloning a **normal (non-template) VM** is always a full clone.
- On BTRFS, full clones benefit from CoW; linked clones depend on the base template remaining
  present - do not delete a template that has linked clones.
- For Cloud-Init templates, each clone gets its own Cloud-Init drive; just re-set `--ciuser`,
  `--ipconfig0`, `--sshkeys` per clone. Regenerate `vmgenid` is automatic.

Citation: [qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html) (`clone`, `template`).

---

## 11. QEMU guest agent

```bash
# Enable in VM config (host side):
qm set 9100 --agent enabled=1,fstrim_cloned_disks=1

# Inside a Debian/Ubuntu guest:
apt install qemu-guest-agent
systemctl enable --now qemu-guest-agent
```

With the agent running, PVE can: do graceful `qm shutdown`, freeze/thaw filesystems for consistent
snapshots/backups, run `qm guest cmd 9100 get-fsinfo` / `network-get- interfaces` / `ping`, and
report the guest's IP in `qm agent`/`config`. The `fstrim_cloned_disks=1` flag auto-TRIMs after
clone/migrate (pairs well with `discard=on` on BTRFS/SSD). The serial console is independent of the
agent - keep both.

Citation: [QEMU/KVM Virtual Machines](https://pve.proxmox.com/pve-docs/chapter-qm.html) (Qemu Guest
Agent).

---

## 12. Importing a disk

Two equivalent modern forms (PVE 8/9):

```bash
# A) One-shot: import straight onto a bus slot (preferred).
qm set 9100 --scsi1 local-btrfs:0,import-from=/root/data.qcow2

# B) Two-step: import as an 'unused' disk, then attach.
qm disk import 9100 /root/data.qcow2 local-btrfs --format raw
qm config 9100 | grep unused # e.g. unused0: local-btrfs:9100/vm-9100-disk-2.raw
qm set 9100 --scsi1 local-btrfs:9100/vm-9100-disk-2.raw,iothread=1
```

- `qm importdisk` is now just an **alias** for `qm disk import`.
- The source must be a **host filesystem path** (qcow2/raw/vmdk/vdi), not a `storage:...` volid.
  Supported source formats are auto-detected.
- For whole-appliance OVAs/OVFs use `qm importovf 9100 appliance.ovf local-btrfs`.
- `--format` controls the _target_ on-disk format; on BTRFS, `raw` files inside subvolumes are
  typical.

Citation: [qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html) (`disk import`, `set` with
`import-from`, `importovf`).

---

## 13. New / changed in PVE 9 (deltas and gotchas)

New features:

- **virtiofs directory sharing** (new in PVE 9.0) - share a host directory into a VM with
  near-native performance, no NFS/SMB. Workflow:

```bash
# 1. Create a Directory mapping at the cluster/datacenter level (per node path):
pvesh create /cluster/mapping/dir --id shared1 \
--map node=$(hostname),path=/srv/share

# 2. Attach to the VM by dirid:
qm set 9100 --virtiofs0 dirid=shared1,cache=auto,direct-io=1
# other knobs: cache=always|never|metadata|auto, expose-xattr=1, expose-acl=1

# 3. Inside the Linux guest, mount it (virtiofs kernel module required):
mount -t virtiofs shared1 /mnt/share
```

Gotchas: virtiofs needs the VM to have enough RAM and uses a shared-memory backing; a VM with a
virtiofs device **cannot live-migrate or hibernate** (irrelevant on a single node, but note it). The
`dirid` you mount is the mapping id, not a path.

- **Default CPU model `x86-64-v2-AES`** for new VMs created via UI (delta from PVE 8's `kvm64`). For
  our single node, override to `cpu: host` for full Ryzen performance.
- **QEMU 10.0/10.1/11.0** machine versions changed internal disk attachment and continued the PVE 9
  VM feature line; transparent for typical use.
- **9.1 vTPM in qcow2** - vTPM state can be stored in qcow2, enabling **full snapshots of VMs with a
  vTPM** across more storage types (incl. offline snapshots on some LVM setups). Relevant if you run
  a Windows 11 guest needing TPM.
- **9.1 nested virtualization vCPU flag** - explicit flag to enable nested virt on a host-matching
  vCPU type (nested hypervisors, Windows VBS).
- **9.1 Intel TDX** basic / confidential-computing groundwork (Intel-only; N/A on Ryzen). AMD
  **SEV/SEV-ES/SEV-SNP** remain available via `qm set --amd-sev ...` on capable EPYC/Ryzen-Pro
  silicon (consumer Ryzen generally lacks full SEV).

Gotchas / deprecations:

- Use the new **`qm disk <import|move|rescan|resize>`** namespace; the old bare verbs (`importdisk`,
  `move-disk`, `rescan`) still work as aliases.
- `efitype=2m` is legacy - always `4m` for new VMs (Secure Boot capable).
- A newly added `serial0` needs a **full stop/start** (not reboot) to take effect.
- Put `console=ttyS0,115200` **last** in `GRUB_CMDLINE_LINUX` so serial is primary.
- BTRFS storage is still a **technology preview** - snapshots work, but keep real backups
  (vzdump/PBS).
- On a single node, `--migrate` and shared-storage clone targets are irrelevant; ignore cluster-only
  options.

Citations: [QEMU/KVM Virtual Machines](https://pve.proxmox.com/pve-docs/chapter-qm.html) (Virtiofs,
CPU type, Machine) ;
[Proxmox Virtual Environment 9.0 with Debian 13 released](https://www.proxmox.com/en/about/company-details/press-releases/proxmox-virtual-environment-9-0)
;
[Proxmox Virtual Environment 9.1 available](https://www.proxmox.com/en/about/company-details/press-releases/proxmox-virtual-environment-9-1)
; [Proxmox VE Roadmap release history](https://pve.proxmox.com/wiki/Roadmap#Release_History) ;
[Qemu/KVM Virtual Machines](https://pve.proxmox.com/wiki/Qemu/KVM_Virtual_Machines) ;
[QEMU Machine Version Upgrade](https://pve.proxmox.com/wiki/QEMU_Machine_Version_Upgrade)

---

## 14. Quick reference - the accessible VM checklist

1. `qm create <vmid> ... --serial0 socket --vga serial0` (serial first).
2. `qm set <vmid> --efidisk0 <store>:1,efitype=4m,pre-enrolled-keys=1` (if UEFI).
3. `qm set <vmid> --scsi0 <store>:<GiB>,iothread=1,discard=on` on `virtio-scsi-single`.
4. Install via Cloud-Init (preferred) or serial-aware ISO; drive with `qm terminal`.
5. In guest: `console=ttyS0,115200` in GRUB + `systemctl enable --now serial-getty@ttyS0`; install
   `qemu-guest-agent`.
6. `qm snapshot` before changes; `qm template` + `qm clone` to mass-produce.
7. Exit `qm terminal` with **Ctrl-O**.
