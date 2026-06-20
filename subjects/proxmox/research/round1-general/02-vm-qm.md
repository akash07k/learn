# Proxmox VE: Virtual Machine (KVM/QEMU) Management via `qm` and Config Files

Research source material for a shell-only, screen-reader-friendly PVE guide. Single home-lab node,
no cluster/HA. Target PVE 8.x (Debian 12); 9.x notes inline. Audience cannot use the noVNC/SPICE
graphical console - the **serial console path is mandatory** and is emphasized throughout.

All actions are CLI commands or edits to named config files. There is no GUI step anywhere in this
document.

---

## 1. Mental model and where things live

- VMs are QEMU/KVM guests, identified by a numeric **VMID** (100 - 999999999). IDs below 100 are
  reserved for internal use. On a single node VMIDs only need to be unique on that node.
- The single tool for VM lifecycle and config is **`qm`** (run as `root`). Every `qm set ...` flag
  corresponds 1:1 to a key in the config file, so you can do everything two ways:
  `qm set <vmid> --<key> <value>` OR edit the file directly.
- Config file: **`/etc/pve/qemu-server/<vmid>.conf`**. This lives on the `pmxcfs` cluster filesystem
  (a FUSE-mounted SQLite DB at `/etc/pve`), so do not treat it like an ordinary disk file for
  locking purposes, but it is plain text you can read and edit with any editor (`nano`, `vi`).
- Disks themselves live in **storages** (e.g. `local-lvm`, `local`), not in the conf file - the conf
  only references them by volume ID like `local-lvm:vm-100-disk-0`.

`man qm`, `man qm.conf`, and `qm help <subcommand>` are the authoritative on-box references.
`qm help` lists every subcommand.

Citations: [qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html) ,
[qm.conf(5)](https://pve.proxmox.com/pve-docs/qm.conf.5.html) ,
[QEMU/KVM Virtual Machines](https://pve.proxmox.com/pve-docs/chapter-qm.html)

---

## 2. The config file format (`/etc/pve/qemu-server/<vmid>.conf`)

Simple `key: value` lines. `#` starts a comment line. Blank lines ignored. Options with
sub-properties use comma-separated `k=v` pairs. Example minimal file:

```text
boot: order=virtio0;net0
cores: 1
sockets: 1
memory: 512
name: webmail
ostype: l26
net0: e1000=EE:D2:28:5F:B6:3E,bridge=vmbr0
virtio0: local:vm-100-disk-1,size=32G
```

Snapshots appear as `[snapshotname]` sections appended to the same file (do not edit those by hand).
A `lock:` line indicates an in-progress operation.

Citation: [qm.conf(5)](https://pve.proxmox.com/pve-docs/qm.conf.5.html)

---

## 3. The `qm` command surface (lifecycle)

| Command                                    | Purpose                                               |
| ------------------------------------------ | ----------------------------------------------------- |
| `qm create <vmid> [opts]`                  | Create (or restore from backup with `--archive`) a VM |
| `qm set <vmid> [opts]`                     | Change config of an existing VM (hot or cold)         |
| `qm start <vmid>`                          | Start VM                                              |
| `qm shutdown <vmid>`                       | Clean ACPI shutdown (asks guest OS)                   |
| `qm reboot <vmid>`                         | Clean reboot (applies pending config changes)         |
| `qm stop <vmid>`                           | Hard stop (pulls the plug - may corrupt data)         |
| `qm reset <vmid>`                          | Hard reset                                            |
| `qm suspend <vmid>` / `qm resume <vmid>`   | Pause / unpause (add `--todisk` to hibernate to disk) |
| `qm destroy <vmid>`                        | Delete VM and (optionally) its disks                  |
| `qm clone <vmid> <newid>`                  | Copy a VM/template                                    |
| `qm config <vmid>`                         | Print current (effective) config                      |
| `qm list`                                  | List all VMs with status                              |
| `qm status <vmid>`                         | Show run state (add `--verbose` for full detail)      |
| `qm monitor <vmid>`                        | Enter the QEMU monitor (low-level)                    |
| `qm terminal <vmid>`                       | Open serial console (CRUCIAL - see section 9)         |
| `qm sendkey <vmid> <key>`                  | Inject a keystroke (e.g. for boot menus)              |
| `qm resize <vmid> <disk> <size>`           | Grow a disk                                           |
| `qm importdisk <vmid> <file> <storage>`    | Import a disk image into a VM                         |
| `qm importovf <vmid> <manifest> <storage>` | Create a VM from an OVF/OVA manifest                  |
| `qm template <vmid>`                       | Convert VM to a template                              |
| `qm cloudinit dump/update/pending <vmid>`  | Inspect/regenerate cloud-init data                    |
| `qm guest cmd <vmid> <cmd>`                | Send a QEMU Guest Agent command                       |
| `qm cleanup`, `qm unlock <vmid>`           | Maintenance / clear a stale lock                      |

Note: `qm migrate` exists but is cluster-only and irrelevant for a single node - skip.

### Important lifecycle flags

- `qm shutdown <vmid> --timeout 60 --forceStop 1` - wait 60s for the guest, then hard-stop if it has
  not exited. Best general-purpose "make it stop" command.
- `qm stop <vmid> --overrule-shutdown 1` - abort an in-progress `qm shutdown` and force stop.
- `qm start <vmid> --timeout N` - default wait is `max(30, vmRAM_in_GiB)` seconds.
- `qm destroy <vmid> --purge 1 --destroy-unreferenced-disks 1` - also removes the VM from backup
  jobs/HA and deletes disks not referenced in the config.

Citations: [qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html)

---

## 4. CPU: sockets, cores, type, limits

Config keys / `qm set` flags:

- `--sockets <n>` (default 1) and `--cores <n>` (cores per socket, default 1). Total vCPUs = sockets
  x cores. For a home lab, **use 1 socket and set cores** (matches a consumer CPU topology).
  Example: `qm set 100 --sockets 1 --cores 4`.
- `--cpu <type>` - CPU model exposed to the guest. Key choices:
- `host` - passes through all host CPU features. **Best performance**, recommended when you will
  never migrate (always true on a single node). `qm set 100 --cpu host`.
- `x86-64-v2-AES` - a good portable default Proxmox uses for new VMs; works on almost all modern
  hardware. Use only if you have a reason to avoid `host`.
- `kvm64` - most compatible, slowest; legacy default.
- `--vcpus <n>` - number of _online_ vCPUs at boot (allows CPU hotplug up to sockets x cores).
- `--cpulimit <float>` - hard ceiling in whole-CPU units (e.g. `2` = at most 2 cores of wall time).
  `0` = unlimited.
- `--cpuunits <int>` - CPU scheduling weight (relative share under contention; default 100, range
  roughly 1-10000 / 2-262144 depending on cgroup version).
- `--affinity 0,2-3` - pin guest to specific host cores.
- `--numa 1` - enable NUMA (only relevant on multi-socket hosts; usually leave off).

Citation: [qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html) (CPU section of chapter-qm)

---

## 5. Memory and ballooning

- `--memory <MiB>` - maximum RAM. Example `--memory 4096` = 4 GiB.
- `--balloon <MiB>` - minimum RAM target. If `balloon < memory`, the **balloon driver** dynamically
  reclaims RAM between the two values under host memory pressure (auto-ballooning). The balloon
  driver is **on by default**.
- `--balloon 0` - **disables ballooning entirely**; the VM always gets the full `memory` value. Set
  this if you want fixed RAM (simpler, more predictable for a home lab), or for guests where the
  balloon driver misbehaves.
- The guest needs the balloon driver / guest agent for the host to reclaim RAM and to report real
  "used" memory.

Example fixed 4 GiB: `qm set 100 --memory 4096 --balloon 0` Example 2-4 GiB dynamic:
`qm set 100 --memory 4096 --balloon 2048`

Citation: chapter-qm "Memory" section.

---

## 6. Machine type, BIOS/UEFI, EFI disk

### Machine type (chipset)

- `--machine i440fx` (default, legacy PC) or `--machine q35` (modern, provides a virtual **PCIe**
  bus). **Recommend `q35`** for new Linux VMs and anything doing PCI passthrough. Windows 11
  effectively needs q35 + OVMF + TPM.
- You can pin a versioned machine for stability across PVE upgrades, e.g. `--machine pc-q35-9.0`.
  New VMs default to the latest; existing VMs keep their pinned version.

### BIOS firmware

- `--bios seabios` (default, legacy BIOS boot) or `--bios ovmf` (UEFI).
- **OVMF/UEFI requires an EFI disk** to persist boot variables. Create it with:

```bash
qm set <vmid> --efidisk0 local-lvm:1,efitype=4m,pre-enrolled-keys=1
```

- `efitype=4m` is the current standard (use this; `2m` is legacy).
- `pre-enrolled-keys=1` enrolls Microsoft Secure Boot keys (needed for SB; for Linux you can use
  `pre-enrolled-keys=0` to avoid signing hassles).
- The `:1` means "allocate a 1 GiB-ish volume" (size is fixed/small regardless).

### Windows 11 extras

- TPM 2.0 state disk: `qm set <vmid> --tpmstate0 local-lvm:1,version=v2.0`.

Citations: chapter-qm "BIOS and UEFI", [qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html)

---

## 7. Disks: controllers, bus types, formats, performance

### SCSI controller

- `--scsihw virtio-scsi-single` - **recommended** controller. Pair with `scsiN` disks.
  `virtio-scsi-single` uses one controller per disk and enables a dedicated **IO thread** per disk
  (`,iothread=1` on the disk), which is the best-performing, most-recommended modern setup.
  (`virtio-scsi-pci` is the older shared-controller variant; `lsi`/`megasas` are legacy for old
  guests.)

### Disk bus/device and how it appears in config

A disk line looks like: `scsi0: local-lvm:vm-100-disk-0,size=32G,iothread=1,discard=on,ssd=1`

Bus options:

- `scsiN` with `virtio-scsi-single` - **recommended default** for Linux. Good perf, supports
  discard/TRIM, hotplug.
- `virtioN` - VirtIO Block; also fast, slightly fewer features than virtio-scsi (no native SCSI
  passthrough). Fine, but `scsi` + virtio-scsi-single is now preferred.
- `sataN` - SATA emulation; **use for guests lacking VirtIO drivers** (e.g. a Windows install ISO
  before you load drivers, or odd appliances). Slower.
- `ideN` - IDE; only for very old guests and for the cloud-init drive (`ide2`).

Useful per-disk properties:

- `iothread=1` - dedicated I/O thread (requires `virtio-scsi-single` or virtio-blk).
- `discard=on` + `ssd=1` - enables TRIM/UNMAP so deleting files in the guest frees space on thin
  storage; `ssd=1` advertises the disk as non-rotational.
- `cache=none|writeback|writethrough` - leave default (`none`) for safety/perf on most setups.
- `backup=0` - exclude this disk from backups.

### Creating / growing / importing disks

- Create an empty disk: `qm set <vmid> --scsi0 local-lvm:32` (32 = GiB).
- Grow a disk (cannot shrink): `qm resize <vmid> scsi0 +10G` (add 10 GiB) or
  `qm resize <vmid> scsi0 64G` (absolute). Then grow the filesystem inside the guest.
- Disk formats: on file storages (`dir`, NFS) you choose `qcow2` (thin, supports snapshots), `raw`
  (fastest, thick), or `vmdk`. On LVM-thin (`local-lvm`) format is always raw-on-thin and snapshots
  work via LVM. **For a home lab on `local-lvm`, defaults are fine; on a directory storage prefer
  `qcow2`** for snapshot support.

### Importing an existing image (two methods)

Modern (preferred, qemu-server >= 7.1): use `import-from` on a disk you set:

```bash
qm set <vmid> --scsi0 local-lvm:0,import-from=/root/disk.qcow2,discard=on,ssd=1
```

The `:0` means "allocate sized from the source image." This both imports and attaches in one step
and lets you set bus/flags simultaneously.

Legacy / explicit utility:

```bash
qm importdisk <vmid> /root/disk.qcow2 local-lvm
```

This imports as an _unused_ disk; you then attach it:
`qm set <vmid> --scsi0 local-lvm:vm-<vmid>-disk-N`.

### Importing an OVF/OVA appliance

```bash
qm importovf <vmid> /path/to/appliance.ovf local-lvm
```

Reads CPU/RAM/disks from the manifest and creates the VM. Review and fix bus types and add a serial
console afterward.

Citations: chapter-qm "Hard Disk" / "VirtIO SCSI",
[qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html) , Proxmox forum import-from threads.

---

## 8. Network

Config key `netN`: `net0: virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,firewall=1`

- `--net0 virtio,bridge=vmbr0` - **VirtIO (paravirtualized) is the recommended model** (best
  throughput, low CPU). MAC is auto-generated if omitted.
- Use `e1000` or `rtl8139` only for guests without VirtIO drivers (e.g. a stock Windows installer
  before driver load).
- `bridge=vmbr0` - attach to the Linux bridge created during PVE install (your LAN).
- Optional: `,tag=10` (VLAN), `,rate=100` (rate limit MB/s), `,firewall=1` (enable per-VM firewall),
  `,mtu=1500`.
- Multiple NICs: `net1`, `net2`, ...

Example: `qm set 100 --net0 virtio,bridge=vmbr0,firewall=1`

Citation: chapter-qm "Network Device".

---

## 9. SERIAL CONSOLE + `qm terminal` - the headless / screen-reader path (CRUCIAL)

The graphical noVNC/SPICE console is inaccessible. The fully accessible path is a **virtual serial
port** on the VM connected to a host-side socket, reached with `qm terminal`. This gives a plain
text login over the terminal the screen reader already reads.

### Step A - add a serial device to the VM (host side)

```bash
qm set <vmid> --serial0 socket
```

Equivalent config line: `serial0: socket`.

Optional but recommended for cloud images / to make serial the primary display so you also see the
boot/GRUB output as text:

```bash
qm set <vmid> --serial0 socket --vga serial0
```

`--vga serial0` tells QEMU to route the "display" to the serial port. (If a guest misbehaves with
this, revert to `--vga std`.)

### Step B - make the GUEST emit a login on the serial port

For most modern cloud images this is already configured. For a manually installed Debian/Ubuntu
guest:

1. Enable a serial getty (systemd):

```bash
systemctl enable --now serial-getty@ttyS0.service
```

1. Send kernel + bootloader output to serial by editing `/etc/default/grub` in the guest:

```text
GRUB_CMDLINE_LINUX="console=tty0 console=ttyS0,115200"
GRUB_TERMINAL="console serial"
GRUB_SERIAL_COMMAND="serial --unit=0 --speed=115200"
```

Then in the guest: `update-grub` (Debian/Ubuntu) or `grub2-mkconfig -o /boot/grub2/grub.cfg` (RHEL
family). Reboot the guest. 3. Verify the port exists in the guest: `dmesg | grep ttyS` (expect
`ttyS0`).

The last `console=` listed wins as the primary console, so put `console=ttyS0,115200` last to make
the serial port the main console.

### Step C - connect from the PVE host

```bash
qm terminal <vmid>
```

- Press **Enter** once or twice to get the login prompt.
- **Exit** the terminal with the escape char, default **Ctrl-O** (shown as `^O`).
- Pick a specific port: `qm terminal <vmid> --iface serial1`.
- Change escape char: `qm terminal <vmid> --escape '^X'`.

### Practical notes for the screen-reader workflow

- Set up `serial0` BEFORE installing the OS when possible, so even the installer text appears over
  serial. Debian's installer and most cloud images support serial.
- `qm terminal` is the day-to-day "log into the VM at the console" command - use it whenever SSH is
  not yet available (first boot, network broken, rescue).
- For boot-menu interaction without a console you can also inject keys from the host:
  `qm sendkey <vmid> ret`, `qm sendkey <vmid> esc`, `qm sendkey <vmid> down`, etc.

Citations: [Serial Terminal](https://pve.proxmox.com/wiki/Serial_Terminal) , qm.1 `qm terminal`,
qm-cloud-init `--serial0 socket --vga serial0`.

---

## 10. ostype, ACPI, and guest hints

`--ostype <value>` tells PVE to tune defaults (clock, devices). Important values:

- `l26` - Linux kernel 2.6 and later (use for **all modern Linux**).
- `l24` - old Linux 2.4.
- `win11`, `win10`, `win8`, `win7`, `wvista`, `wxp`, `w2k*`, `w2k`,... - Windows versions (PVE
  adapts Hyper-V enlightenments, etc.).
- `other` - anything else (BSD, Solaris, etc.).
- `solaris`.

Example: `qm set 100 --ostype l26`. For Windows 11 use `--ostype win11` together with q35 + OVMF +
TPM (sections 6).

Citation: chapter-qm / qm.1 `--ostype`.

---

## 11. QEMU Guest Agent

The guest agent lets PVE do clean shutdowns, freeze filesystems for consistent snapshots/backups,
report the guest IP, and run commands.

1. Enable on the VM:

```bash
qm set <vmid> --agent enabled=1,fstrim_cloned_disks=1
```

(Config: `agent: 1`. `fstrim_cloned_disks=1` runs TRIM after clone/migrate to reclaim space.
Optional `freeze-fs=1` to fsfreeze on backup.) 2. Install the agent **inside the guest**:

- Debian/Ubuntu: `apt install qemu-guest-agent` then `systemctl enable --now qemu-guest-agent`.
- Windows: install `virtio-win-guest-tools` from the VirtIO driver ISO.

1. Use it from the host:

- `qm guest cmd <vmid> network-get-interfaces` - get guest IPs.
- `qm guest cmd <vmid> get-fsinfo`, `... fsfreeze-freeze`, `... ping`.
- `qm guest exec <vmid> -- <cmd...>` - run a command inside the guest and get output (e.g.
  `qm guest exec 100 -- uname -a`).
- `qm agent <vmid> <command>` is an alias for `qm guest cmd`.

With the agent enabled, `qm shutdown` and snapshot/backup operations become "smarter" (graceful,
filesystem-consistent).

Citation: chapter-qm "Qemu Guest Agent", qm.1 `qm guest cmd`.

---

## 12. Boot order

`--boot order=<dev>;<dev>;...`. Only listed devices are bootable, tried left to right.

```bash
qm set <vmid> --boot order=scsi0;ide2;net0
```

- `scsi0` first = boot the OS disk. List `net0` to allow PXE. List the cloud-init or install CD
  (`ide2`) only while you need it, then drop it to speed boot.
- Older `bootdisk:` and `boot: cdn` legacy forms are deprecated - use `order=`.

Citation: chapter-qm, qm-cloud-init boot example.

---

## 13. ISOs from the shell, and end-to-end manual VM creation

### Get an ISO onto the node

ISOs live in the `local` storage's `template/iso` dir, i.e. `/var/lib/vz/template/iso/`. Download
directly there:

```bash
cd /var/lib/vz/template/iso
wget https://cdimage.debian.org/.../debian-12.x.x-amd64-netinst.iso
```

Or use the storage API downloader (verifies checksum):

```bash
pvesm download-iso local <name>.iso --url <https-url> --checksum-algorithm sha256 --checksum <hash>
```

List available ISOs: `pvesm list local --content iso`.

### Create a Linux VM end-to-end from CLI (with serial console)

```bash
# 1. Create the VM shell (q35 + virtio-scsi-single + virtio net + serial + agent)
qm create 100 \
 --name debian12 \
 --ostype l26 \
 --machine q35 \
 --bios seabios \
 --cores 4 --sockets 1 --cpu host \
 --memory 4096 --balloon 0 \
 --scsihw virtio-scsi-single \
 --net0 virtio,bridge=vmbr0 \
 --serial0 socket --vga serial0 \
 --agent enabled=1

# 2. Add an OS disk (32 GiB on local-lvm, iothread + discard)
qm set 100 --scsi0 local-lvm:32,iothread=1,discard=on,ssd=1

# 3. Attach the installer ISO on IDE2 as CD-ROM
qm set 100 --ide2 local:iso/debian-12.x.x-amd64-netinst.iso,media=cdrom

# 4. Boot from CD first, then disk
qm set 100 --boot order=ide2;scsi0

# 5. Start and attach to the serial console for the (text) install
qm start 100
qm terminal 100 # exit with Ctrl-O
```

Use the Debian text/serial installer (it supports serial consoles). After install, inside the guest
enable `serial-getty@ttyS0` and set GRUB `console=ttyS0,115200` (section 9B), then on the host drop
the CD and boot from disk:

```bash
qm set 100 --boot order=scsi0
qm set 100 --ide2 none # or: --delete ide2
```

(`qm set <vmid> --delete <key>` removes any config key.)

---

## 14. Cloud-Init from the CLI (fast, repeatable VMs)

Cloud-init injects hostname, users, SSH keys, and network config at first boot from a generated
config drive. This is the **best path for a screen-reader user**: no installer interaction at all -
you pre-bake everything and the VM comes up reachable over SSH, with serial console as backup.

### Build a reusable template from a cloud image

```bash
# 1. Download a cloud image (qcow2/img) to the host
cd /root
wget https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img

# 2. Create the VM with virtio net + virtio-scsi-single + serial console
qm create 9000 --name ubuntu-template --ostype l26 \
 --machine q35 --cpu host --cores 2 --memory 2048 \
 --net0 virtio,bridge=vmbr0 \
 --scsihw virtio-scsi-single \
 --serial0 socket --vga serial0 \
 --agent enabled=1

# 3. Import the cloud image as scsi0 (modern import-from, one step)
qm set 9000 --scsi0 local-lvm:0,import-from=/root/jammy-server-cloudimg-amd64.img,discard=on,ssd=1

# 4. Add the cloud-init drive on ide2
qm set 9000 --ide2 local-lvm:cloudinit

# 5. Boot straight off the imported disk
qm set 9000 --boot order=scsi0

# 6. (Cloud images are small) grow the disk before/after clone as needed
qm resize 9000 scsi0 +18G

# 7. Convert to a template
qm template 9000
```

### Clone the template and inject cloud-init settings

```bash
# Linked clone (fast, thin) from the template
qm clone 9000 101 --name web01

# Cloud-init: user, SSH keys, and static IP (or DHCP)
qm set 101 --ciuser akash
qm set 101 --sshkeys ~/.ssh/id_ed25519.pub # file of one-or-more public keys
qm set 101 --ipconfig0 ip=192.168.1.50/24,gw=192.168.1.1
# DHCP instead: qm set 101 --ipconfig0 ip=dhcp
# Optional DNS: qm set 101 --nameserver 1.1.1.1 --searchdomain lan
# Password (discouraged; prefer keys): qm set 101 --cipassword 'secret'

qm start 101
qm terminal 101 # serial console available as a fallback if SSH/network fails
```

### Key cloud-init config keys (all settable via `qm set --<key>` or in the conf)

- `ciuser` - default user to create. `cipassword` - that user's password (use keys instead where
  possible; old cloud-init needs plaintext, newer accept hashes).
- `sshkeys` - URL-encoded public keys (the `--sshkeys <file>` flag handles encoding).
- `ipconfig0` (per NIC: `ipconfig1`, ...) - `ip=`, `gw=`, `ip6=`, `gw6=`; `ip=dhcp` or `ip6=auto`
  supported.
- `nameserver`, `searchdomain` - DNS.
- `citype` - `nocloud` (Linux default) or `configdrive2`.
- `ciupgrade` - run a package upgrade on first boot (default on for newer images).
- `cicustom` - point to custom user/network/meta YAML snippets stored on a snippets storage, e.g.
  `cicustom=user=local:snippets/user.yaml`. This is how you do anything cloud-init can do that has
  no dedicated key.

### Inspect / regenerate cloud-init

- `qm cloudinit dump 101 user` - print the generated user-data YAML (also `network`, `meta`).
- `qm cloudinit pending 101` - show config changes not yet applied to the CI drive.
- `qm cloudinit update 101` - regenerate the CI drive after changing keys without a full reboot
  cycle. (Cloud-init normally only re-applies most settings on a _fresh_ boot / when the instance-id
  changes.)

Citations: [Cloud-Init Support](https://pve.proxmox.com/wiki/Cloud-Init_Support) ,
qm-cloud-init.adoc, [qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html)

---

## 15. Snapshots

```bash
qm snapshot <vmid> <snapname> [--description "text"] [--vmstate 1]
qm listsnapshot <vmid> # list snapshots (also: qm snapshot list / qm config shows them)
qm rollback <vmid> <snapname> [--start 1]
qm delsnapshot <vmid> <snapname> [--force 1]
```

- `--vmstate 1` also saves **live RAM**, so rollback returns to a running state exactly. Without it,
  only disk state is captured (VM is effectively powered-off at that point).
- `qm rollback` discards all changes since the snapshot. `--start 1` starts the VM afterward (it
  auto-starts if the snapshot included RAM).
- `--force 1` on delete lets the config entry be removed even if deleting the underlying disk
  snapshot fails.
- Storage support: snapshots work on `qcow2` files, ZFS, LVM-thin, Ceph. **Raw on plain LVM or
  directory storage does NOT support snapshots** - pick qcow2 or LVM-thin/ZFS if you want snapshots
  in a home lab.

Citation: [qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html)

---

## 16. Templates and clones (linked vs full)

- `qm template <vmid>` marks a stopped VM as a template (its disks become read-only base images; it
  can no longer start). Templates are the basis for fast cloning.
- `qm clone <vmid> <newid> [opts]`:
- From a **template**, the default is a **linked clone**: near-instant, shares the read-only base
  image, only stores deltas. Great for spinning up many VMs cheaply. Linked clones depend on the
  template existing and on a storage that supports it.
- `--full 1` forces a **full clone**: an independent deep copy of all disks (slower, more space, but
  self-contained - can move/delete the template afterward). Cloning a _non-template_ VM is always a
  full clone.
- Useful flags: `--name`, `--storage <id>` (target storage for full clone),
  `--format qcow2|raw|vmdk` (full clone, file storage), `--snapname <snap>` (clone from a specific
  snapshot).

Typical home-lab pattern: build one cloud-init template (section 14), then `qm clone` linked copies
per service and `qm set` their cloud-init params.

Citation: [qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html)

---

## 17. PCI / USB passthrough basics (CLI)

Passthrough gives a VM direct access to host hardware (GPU, NIC, USB device). Requires IOMMU enabled
on the host.

### Host prerequisites (one-time)

1. Enable IOMMU in firmware (host BIOS) - then on the kernel cmdline. For GRUB edit
   `/etc/default/grub`, append to `GRUB_CMDLINE_LINUX_DEFAULT`:

- Intel: `intel_iommu=on iommu=pt`
- AMD: `amd_iommu=on iommu=pt` Then `update-grub` and reboot. (On systemd-boot installs edit
  `/etc/kernel/cmdline` and run `proxmox-boot-tool refresh`.)

1. Load VFIO modules - add to `/etc/modules`:

```text
vfio
vfio_iommu_type1
vfio_pci
```

Run `update-initramfs -u -k all` and reboot. 3. Find the device's PCI address: `lspci -nn` (e.g.
`01:00.0`), and group info via `find /sys/kernel/iommu_groups/ -type l` or
`pvesh get /nodes/<node>/hardware/pci`.

### Attach a raw PCI device

```bash
qm set <vmid> --hostpci0 0000:01:00.0,pcie=1
```

- `pcie=1` requires `--machine q35`.
- For GPUs add `,x-vga=1` (primary GPU) and pass the whole IOMMU group; you typically pass all
  functions with `0000:01:00` (no function suffix) to grab `.0` and `.1`.

### Recommended: device _mapping_ (cleaner, stable across reboots)

Create a named cluster-wide mapping, then reference it (insulates you from PCI address changes and
is the documented best practice):

```bash
pvesh create /cluster/mapping/pci --id mygpu \
 --map node=<node>,path=0000:01:00.0,id=<vendor:device>
qm set <vmid> --hostpci0 mapping=mygpu,pcie=1,x-vga=1
```

### USB passthrough

```bash
qm set <vmid> --usb0 host=1234:5678 # by vendor:product (lsusb)
qm set <vmid> --usb0 host=2-3 # by bus-port path
# or via a USB mapping:
pvesh create /cluster/mapping/usb --id mydongle --map node=<node>,path=2-3,id=1234:5678
qm set <vmid> --usb0 mapping=mydongle
```

`lsusb` lists `vendor:product` IDs and bus/port paths. USB passthrough does not need IOMMU and
supports hotplug.

Citations: chapter-qm "PCI(e) Passthrough" / "USB Passthrough",
[PCI Passthrough](https://pve.proxmox.com/wiki/PCI_Passthrough) , qm.1 `--hostpci` / `--usb`.

---

## 18. QEMU monitor and key injection (low-level)

- `qm monitor <vmid>` - drops you into the human QEMU monitor for the running VM. Useful commands
  inside: `info block`, `info network`, `info status`, `system_powerdown`,
  `sendkey ctrl-alt-delete`. Exit with `quit` (this quits the monitor, not the VM).
- `qm sendkey <vmid> <key>` - inject one keystroke without entering the monitor. Key names are QEMU
  names: `ret`, `esc`, `spc`, `tab`, `up`/`down`/`left`/`right`, `f2`, `ctrl-alt-delete`, single
  letters, etc. Handy for navigating a BIOS/boot menu when you have no graphical console.

Citation: [qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html)

---

## 19. Resource limits summary (handy reference)

- CPU cap: `--cpulimit <cores>`; CPU share: `--cpuunits <weight>`.
- RAM cap / floor: `--memory` / `--balloon`.
- Disk I/O throttle (per disk, via the disk property), e.g.
  `qm set 100 --scsi0 local-lvm:vm-100-disk-0,mbps_rd=100,mbps_wr=50,iops_rd=2000,iops_wr=1000`.
- Network rate limit: `--net0 virtio,bridge=vmbr0,rate=50` (MB/s).
- Start/shutdown ordering & delay (for autostart sequencing): `--startup order=1,up=30,down=60`.
- Auto-start on boot: `qm set <vmid> --onboot 1`.

Citation: chapter-qm.

---

## 20. Recommended home-lab defaults (cheat sheet)

For a modern Linux guest on a single node, screen-reader-friendly:

- `--ostype l26`
- `--machine q35`
- `--cpu host`, `--sockets 1`, `--cores <n>`
- `--memory <MiB> --balloon 0` (fixed RAM; simplest)
- `--scsihw virtio-scsi-single`, disks on `scsiN` with `iothread=1,discard=on,ssd=1`
- `--net0 virtio,bridge=vmbr0`
- `--serial0 socket --vga serial0` (ALWAYS - this is your console)
- `--agent enabled=1` plus `apt install qemu-guest-agent` in the guest
- For UEFI/Win11: `--bios ovmf` + `--efidisk0 ...efitype=4m` (+ `--tpmstate0` for Win11)
- Build a cloud-init template once, `qm clone` + `qm set --ciuser/--sshkeys/--ipconfig0` for
  everything else.

---

## 21. Gaps / things to verify on the actual box

- Exact default `--cpu` for new VMs differs by PVE version (8.x ships `x86-64-v2-AES`); confirm with
  `qm config` after a GUI-less create.
- Storage IDs (`local`, `local-lvm`) and which support snapshots depend on the install - verify with
  `pvesm status` and `pvesm list <storage>`.
- `qm cloudinit update` vs full reboot semantics: most settings only re-apply on a fresh instance
  boot; confirm behavior for the specific cloud image used.
- PCI passthrough success is hardware-specific (IOMMU grouping); the commands here are correct but
  real groups must be inspected per machine.
- PVE 9.x: machine-type versions and some defaults advance; the `qm` surface above is stable, but
  check `man qm` on the installed version for any new flags (e.g. virtiofs directory sharing
  `--virtiofs`).

---

### Primary citations

- qm(1) manual: [qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html)
- qm.conf(5): [qm.conf(5)](https://pve.proxmox.com/pve-docs/qm.conf.5.html)
- VM chapter: [QEMU/KVM Virtual Machines](https://pve.proxmox.com/pve-docs/chapter-qm.html)
- Serial Terminal wiki: [Serial Terminal](https://pve.proxmox.com/wiki/Serial_Terminal)
- Cloud-Init Support wiki: [Cloud-Init Support](https://pve.proxmox.com/wiki/Cloud-Init_Support)
- PCI Passthrough wiki: [PCI Passthrough](https://pve.proxmox.com/wiki/PCI_Passthrough)
