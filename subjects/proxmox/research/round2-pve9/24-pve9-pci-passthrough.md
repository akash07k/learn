# PVE 9 PCI(e) Passthrough on a single AMD host (shell-only)

Target: latest Proxmox VE 9.x on Debian 13 "trixie", mid-2026 (current line 9.2). Single node, **AMD
Ryzen 6800H** mini-PC (Zen 3+, "Rembrandt"), single 1 TB NVMe, host root = **BTRFS**, UEFI, **GRUB
via proxmox-boot-tool**, no Secure Boot. Shell-only, screen-reader / serial-console workflow.

This file reports what is TRUE in PVE 9, separates **VERIFIED** (official admin guide / wiki /
`qm.conf(5)` man page) from **COMMUNITY** technique (forum), gives exact commands, file paths, and
citations, and flags version-fragile 9.x details.

> ACCESSIBILITY FRAME (read first): the marquee passthrough use case online is **GPU passthrough to
> drive a physical display**. That is **irrelevant to a blind operator** and the single-GPU-host
> headaches (host loses its console, vendor-reset bugs, vBIOS dumps) are **out of scope** here. The
> genuinely useful cases on this mini-PC are: an **iGPU/render device for video transcoding**, an
> **HBA / SATA / NVMe controller**, a **NIC**, or a **USB controller** (the "nuclear option" for USB
> devices). Section 7 says which are clean and which are fraught. Section 8 is the lockout-safety
> section - it carries the same caution as the networking/firewall guides.

---

## TL;DR for THIS node

- **IOMMU on AMD is already on.** Official wiki: "With AMD CPUs IOMMU is enabled by default." You do
  **not** need `amd_iommu=on`. You DO want `iommu=pt` (passthrough mode) for performance. (VERIFIED)
- **Set the cmdline the same way guide 03 sets every host boot parameter:** edit
  `GRUB_CMDLINE_LINUX_DEFAULT` in `/etc/default/grub`, then run **`proxmox-boot-tool refresh`** as
  the explicit ESP sync command. Current Proxmox docs also describe `update-grub` as a valid GRUB
  apply path when the proxmox-boot-tool hook is present. The systemd-boot `/etc/kernel/cmdline` path
  is for ZFS-root nodes and is ignored here.
- **vfio modules:** on PVE 9 kernels (6.14 / 6.17 / 7.0 across the 9.0, 9.1, and 9.2 point releases)
  the `vfio` stack is a built-in/autoloaded part of the kernel and is pulled in automatically when a
  device is bound to `vfio-pci`. The official wiki/admin-guide instruction to add
  `vfio vfio_iommu_type1 vfio_pci` to `/etc/modules` is still documented and is harmless
  belt-and-suspenders, but **`vfio_virqfd` is gone** since kernel 6.2 - do not list it. (wiki =
  VERIFIED for the /etc/modules instruction; "autoloaded on bind" = COMMUNITY-confirmed,
  version-fragile.)
- **Verify after reboot:** `dmesg | grep -e DMAR -e IOMMU -e AMD-Vi` (look for `AMD-Vi: ... enabled`
  / `AMD-Vi: Interrupt remapping enabled`) and confirm `/sys/kernel/iommu_groups/` is populated:
  `find /sys/kernel/iommu_groups/ -type l | wc -l` returns a non-zero count.
- **Hard rule:** you pass through a **whole IOMMU group**, not one function. Read the groups first;
  never bind a device the host needs (its only NIC, its boot controller). Keep a second SSH session
  open before each reboot so you can undo bad pre-reboot edits, but do not treat SSH as a recovery
  path after a boot-level failure.
- **Attach with qm:** `qm set <vmid> --hostpci0 <BUS:SLOT.FUNC>,pcie=1` on a **q35 + OVMF** VM (tie
  to guide 06). Prefer a **resource mapping** (`/etc/pve/mapping/pci.cfg`, then
  `--hostpci0 mapping=<name>`) - it is fully CLI-doable and is the modern PVE 8+/9 way.
- **For iGPU transcoding specifically, the clean accessible answer is usually NOT PCI passthrough at
  all** - it is sharing the host's `/dev/dri/renderD128` into an **LXC container** (see guide 05 /
  §7a). Full iGPU PCI passthrough to a VM on AMD APUs is fraught (reset bugs, the well-known missing
  `renderD128`).

---

## 1. Enabling the IOMMU on AMD

### 1a. Do you even need a kernel parameter? (VERIFIED)

The official PCI(e) Passthrough wiki states plainly:

> "With AMD CPUs IOMMU is enabled by default. With recent kernels (6.8 or newer), this is also true
> for Intel CPUs."

So on the Ryzen 6800H you do **not** add `amd_iommu=on` - AMD-Vi is on once it is enabled in
firmware. (Modern AMD UEFI usually has it on; if not, enable "IOMMU" / "AMD-Vi" / "SVM" in the
mini-PC's BIOS.) What you DO add is the passthrough-mode hint, which the docs recommend for
performance:

> add `iommu=pt` to the kernel commandline.

`iommu=pt` ("passthrough") makes the IOMMU use 1:1 identity mapping for devices the host itself
drives (skips DMA translation overhead) while still isolating devices handed to VMs. It is a
performance/safety win, not strictly required.

(Sources: PCI(e) Passthrough wiki; community tutorial confirms `amd_iommu=on` is "unnecessary since
it's enabled by default for AMD systems".)

### 1b. Where to set it on THIS host - the guide-03 mechanism (VERIFIED)

This node boots **GRUB via proxmox-boot-tool** on a BTRFS root (see research 04 and guide 03).
Therefore the kernel cmdline lives in **`/etc/default/grub`**, and you apply it with
**`proxmox-boot-tool refresh`**, mirroring exactly how guide 03 sets host boot parameters and serial
console flags.

```bash
# 1. Edit /etc/default/grub - append iommu=pt to the existing default line.
# Keep whatever is already there (quiet, console=... for serial, etc.).
# Example resulting line:
GRUB_CMDLINE_LINUX_DEFAULT="quiet iommu=pt"

# 2. Apply the proxmox-boot-tool way (regenerates grub.cfg AND syncs the ESP):
proxmox-boot-tool refresh

# 3. Reboot.
reboot
```

> GOTCHA (version-fragile / host-specific): do **NOT** edit `/etc/kernel/cmdline` on this node. That
> is the **systemd-boot** path (ZFS-root nodes) and is ignored under GRUB. Use
> `proxmox-boot-tool refresh` as the explicit apply command so the ESP sync step is named. Current
> Proxmox docs also describe `update-grub` as valid when its proxmox-boot-tool hook is present, so
> the real trap is the wrong file or an unverified boot entry, not the word `update-grub` itself.
> This is the same trap called out in research 04 §8 for the serial console.

### 1c. systemd-boot alternative (for completeness only - NOT this host)

If this were a ZFS-root + systemd-boot node, the cmdline is a single line in `/etc/kernel/cmdline`
(append `iommu=pt` to the end of the existing line, do not add newlines), then the same apply
command:

```bash
# ONLY on a systemd-boot node - NOT this BTRFS+GRUB host.
# edit /etc/kernel/cmdline, append: iommu=pt
proxmox-boot-tool refresh
reboot
```

`proxmox-boot-tool refresh` is the explicit "apply and sync the ESP" command for this corpus - that
is why the guide-03 muscle memory transfers cleanly. (VERIFIED: Host Bootloader wiki.)

### 1d. Verify IOMMU is active after reboot (VERIFIED)

```bash
# 1. Kernel ring buffer - look for AMD-Vi enabled / interrupt remapping.
dmesg | grep -e DMAR -e IOMMU -e AMD-Vi
# AMD expected lines include:
# "AMD-Vi: ... enabled"
# "AMD-Vi: Interrupt remapping enabled" (docs quote this exact line)
# (On Intel hosts the analogous line is "DMAR-IR: Enabled IRQ remapping ...".)

# 2. The clinching check: IOMMU groups must be populated.
find /sys/kernel/iommu_groups/ -type l # lists every device, grouped
find /sys/kernel/iommu_groups/ -type l | wc -l # non-zero => IOMMU is grouping devices
```

- `dmesg | grep -e DMAR -e IOMMU` is the exact command in the admin guide / wiki.
  `AMD-Vi: Interrupt remapping enabled` is the verbatim "good" line the docs cite.
- A populated `/sys/kernel/iommu_groups/` is the definitive proof the IOMMU is not just present but
  actively partitioning the bus. An **empty** directory means IOMMU is off in firmware or the
  cmdline did not take - fix that before going further.

> The wiki's _own_ device-listing command is the API form
> `pvesh get /nodes/{nodename}/hardware/pci --pci-class-blacklist ""`, which is handy on PVE because
> it also prints each device's IOMMU group. Use it alongside the raw `/sys` walk (§2c) - both are
> fine; the `/sys` walk is the universal one.

---

## 2. Loading vfio and reading IOMMU groups

### 2a. The vfio modules - needed explicitly on PVE 9? (VERIFIED + COMMUNITY)

VFIO is the kernel framework that exposes a device safely to userspace/QEMU. The modules are:

- `vfio` - core framework
- `vfio_iommu_type1` - the IOMMU backend
- `vfio_pci` - the PCI driver you bind a device to
- ~~`vfio_virqfd`~~ - **removed**: folded into `vfio` since kernel 6.2; do NOT list it (it will fail
  to load on PVE 9). (COMMUNITY-confirmed across forum.)

What the official docs say (VERIFIED): the wiki/admin guide still instructs you to ensure these are
loaded by adding them to **`/etc/modules`**, then rebuild initramfs:

```bash
# /etc/modules (official documented approach)
vfio
vfio_iommu_type1
vfio_pci

# then:
update-initramfs -u -k all
# verify:
lsmod | grep vfio
```

The modern reality (COMMUNITY, version-fragile): on current PVE 9 kernels these are built/shipped
such that they **autoload when a device is bound to `vfio-pci`** (e.g. via the modprobe `ids=`
option in §2b). Many working PVE 9 setups never touch `/etc/modules`. The `/etc/modules` lines are
harmless and are still the documented belt-and-suspenders, so on a headless node it is reasonable to
add them for determinism. Either way, after any modules change:

```bash
update-initramfs -u -k all # on a proxmox-boot-tool host this auto-refreshes the ESP
```

> VERSION-FRAGILE FLAG: "explicitly required vs autoloaded" is exactly the kind of detail that
> drifts between 6.14 / 6.17 / 7.0. The safe stance: add them to `/etc/modules` if you want
> certainty, never add `vfio_virqfd`, and always confirm reality with `lsmod | grep vfio` and
> `lspci -nnk` (§3) on the box rather than trusting any one blog.

### 2b. Binding a device to vfio-pci so the host driver doesn't grab it (VERIFIED)

The point: a host driver (e.g. `amdgpu`, `ahci`, `nvme`, a NIC driver) will claim the device at
boot. To hand it to a VM cleanly you make **`vfio-pci`** claim it first. The documented modprobe
approach:

```bash
# /etc/modprobe.d/vfio.conf

# 1. Bind by PCI *device ID* (vendor:device, from `lspci -nn`). Comma-separated
# list; you can list every function in the group here.
options vfio-pci ids=1234:5678,4321:8765

# 2. Make vfio-pci win the race against the native driver (preferred over a hard
# blacklist; targeted at the specific driver that grabs this device):
softdep amdgpu pre: vfio-pci # example: keep amdgpu off the iGPU

# (Alternative / additional: hard blacklist the host driver entirely)
# blacklist amdgpu
```

```bash
# Find the vendor:device IDs and the current driver:
lspci -nn # ...: [1002:1681] from vendor:device in brackets
lspci -nnk # adds "Kernel driver in use: ..." and "Kernel modules: ..."

# After editing, rebuild initramfs and reboot:
update-initramfs -u -k all
reboot
```

- `ids=VENDOR:DEVICE` is the exact documented syntax. IDs come from `lspci -nn`.
- `softdep <hostdriver> pre: vfio-pci` is the wiki's documented "soft dependency" technique and is
  generally preferred to a blanket `blacklist`, because it only reorders loading for that one
  driver. The community GPU tutorial uses exactly `softdep amdgpu pre: vfio-pci`.
- The wiki also lists hard blacklists, e.g.
  `echo "blacklist amdgpu" >> /etc/modprobe.d/blacklist.conf` (and `radeon`, `nouveau`, `nvidia*`,
  `i915` for the other vendors). Use blacklist only when softdep is insufficient - blacklisting a
  driver the host shares is dangerous (see §8).

**PVE can also bind on demand.** With a `qm hostpci` entry (or a resource mapping) and the default
`driver=vfio`, PVE will reset the device and bind it to `vfio-pci` **at VM start** and release it at
VM stop - you do not strictly need the modprobe `ids=` pre-bind for many devices. Pre-binding via
modprobe is the robust choice for devices that the host driver grabs early or that misbehave on late
rebind (GPUs especially). Setting `driver=keep` on the hostpci line tells PVE to neither reset nor
rebind (rare; for self-managing devices). (VERIFIED: `qm.conf(5)` `driver` defaults to `vfio`,
`keep` documented.)

### 2c. Reading IOMMU groups + the HARD RULE (VERIFIED)

```bash
# Walk every group and show the devices in it, with names:
for g in /sys/kernel/iommu_groups/*/devices/*; do
 grp=$(basename "$(dirname "$(dirname "$g")")")
 dev=$(basename "$g")
 printf 'IOMMU group %s %s\n' "$grp" "$(lspci -nns "$dev")"
done | sort -V

# Simpler raw list:
find /sys/kernel/iommu_groups/ -type l

# PVE's own grouped view (also prints iommugroup per device):
pvesh get /nodes/$(hostname)/hardware/pci --pci-class-blacklist ""
```

**HARD RULE (VERIFIED):** the IOMMU group is the atomic unit of passthrough. You must pass through
**every device in the group** to the VM, not a single function. The admin guide / wiki:

> "It is important that the device(s) you want to pass through are in a separate IOMMU group."

and clarifies what counts as acceptable sharing:

> "It is okay if the device is in an IOMMU group together with its functions (e.g. a GPU with the
> HDMI Audio device) or with its root port or PCI(e) bridge."

So a GPU + its HDMI-audio function in one group is fine (pass both). But a group that also contains,
say, your boot SATA controller or your only NIC is **not** safe - you cannot hand those to a VM
without losing them on the host.

**ACS-override caveat (COMMUNITY / UNSAFE):** if a device you want is lumped into a big group with
unrelated devices, people add the kernel cmdline `pcie_acs_override=downstream` (or
`downstream,multifunction`) to force-split the groups. This is a **community patch behaviour,
explicitly unsafe**:

> the wiki warns ACS override is "not without risks" and should be a "last option"; community
> sources note it can let a VM "read all of the Proxmox host memory."

Do not use ACS override on a node holding any data you care about. On a mini-PC the better answer is
usually "pick a device that is already cleanly grouped" (often a discrete add-in card, a USB
controller, or the iGPU) rather than fighting the chipset's grouping.

---

## 3. Confirm the bind (VERIFIED)

After reboot, before attaching to a VM, confirm `vfio-pci` actually owns the device:

```bash
lspci -nnk -s 03:00.0 # inspect one device
# ...
# Kernel driver in use: vfio-pci from THIS is what you want
# Kernel modules: amdgpu
```

If "Kernel driver in use" still shows the host driver (`amdgpu`, `ahci`, the NIC driver, etc.), the
bind did not take - recheck the `ids=`, the `softdep`, and that you rebuilt initramfs + rebooted.

---

## 4. Attaching the device to the VM with `qm`

The VM must be **q35 + OVMF (UEFI)** for PCIe passthrough - tie this to guide 06's VM build (q35
machine type, `bios: ovmf`, `efidisk0`). The admin guide notes Q35 is wanted "if you want to pass
through PCIe hardware" and OVMF over SeaBIOS for PCIe passthrough.

### 4a. Direct host-address form (VERIFIED)

```bash
# Basic: assign host PCI device 03:00.0 as a PCIe device (needs q35).
qm set <vmid> --hostpci0 03:00.0,pcie=1

# Multi-function whole-device (omit the .func to grab all functions of 03:00):
qm set <vmid> --hostpci0 03:00,pcie=1
```

This writes one `hostpci0:` line into `/etc/pve/qemu-server/<vmid>.conf`. You can have several:
`hostpci0`, `hostpci1`, ... (up to the documented max).

### 4b. Full `hostpci[n]` option reference (VERIFIED - `qm.conf(5)`)

```text
hostpci[n]: [[host=]<HOSTPCIID[;HOSTPCIID2...]>] [,device-id=<hex>]
 [,driver=<vfio|keep>] [,legacy-igd=<1|0>] [,mapping=<mapping-id>]
 [,mdev=<string>] [,pcie=<1|0>] [,rombar=<1|0>] [,romfile=<string>]
 [,sub-device-id=<hex>] [,sub-vendor-id=<hex>] [,vendor-id=<hex>]
 [,x-vga=<1|0>]
```

- **host** - the host PCI ID `bus:dev.func` (hex), or a `;`-separated list of virtual functions.
  Either `host` or `mapping` must be set. (`lspci` to find it.)
- **mapping** - the ID of a cluster-wide resource mapping (§5). Either this or `host` must be set.
  **Preferred** (see §5).
- **pcie** - default `0`. `pcie=1` selects the PCI-express bus; **requires the `q35` machine
  model.** Use this on any modern device. (Some examples write `pcie=on`; `1`/`0` is the canonical
  man-page form.)
- **driver** - default `vfio`. `keep` = "the device will neither be reset nor bound to the
  `vfio-pci` driver" (for self-managing devices).
- **rombar** - default `1`. Whether the device's ROM is visible in the guest's memory map. Set
  `rombar=0` to hide it (occasionally needed when a device's ROM upsets the guest).
- **romfile** - a custom PCI ROM filename, "must be located in `/usr/share/kvm/`". (GPU-vBIOS
  territory - out of scope for a blind operator, listed for completeness.)
- **x-vga** - default `0`. "Enable vfio-vga device support." **Only for a primary GPU you intend to
  drive a display with** - irrelevant to a blind operator; do not set it for transcoding/HBA/NIC/USB
  passthrough.
- **mdev** - the mediated-device type to instantiate (§6). For vGPU / GVT-g only.
- **legacy-igd** - default `0`. Legacy Intel iGPU mode; "Requires `pc-i440fx` machine type and VGA
  set to `none`." Intel-only and rarely relevant on AMD.
- **vendor-id / device-id / sub-vendor-id / sub-device-id** - override the IDs the guest sees
  (occasionally needed to placate a driver). Hex.

**Address format (note for the operator):** `lspci` prints the short `bus:dev.func` (e.g.
`03:00.0`); the full form includes the PCI domain `0000:03:00.0`. PVE accepts the short
`bus:dev.func` form in `host=` and in `hostpci0`. The full `0000:` domain form is what appears under
`/sys/bus/pci/devices/` and in `lspci -D`; both refer to the same device (domain `0000` is the only
domain on this hardware). Use whichever you have - short is fine.

### 4c. Worked example - pass an add-in NIC to a VM

```bash
# 0. Identify it and its group.
lspci -nn | grep -i ethernet # 03:00.0 ... [8086:1539]
# confirm 03:00.0 is alone (or only with its own functions) in its IOMMU group (§2c)

# 1. Pre-bind to vfio-pci (optional but robust): /etc/modprobe.d/vfio.conf
# options vfio-pci ids=8086:1539
# softdep igb pre: vfio-pci
# then: update-initramfs -u -k all && reboot && lspci -nnk -s 03:00.0

# 2. VM must be q35+OVMF (guide 06). Attach:
qm set <vmid> --hostpci0 03:00.0,pcie=1

# 3. Start and check inside the guest the NIC appears.
qm start <vmid>
qm terminal <vmid> # serial console; exit Ctrl-O
```

---

## 5. Resource MAPPINGS for PCI (PVE 8+ / 9) - preferred, CLI-doable (VERIFIED)

Resource mappings decouple the VM config from a raw bus address: you define a named mapping once
(which device, on which node, by vendor:device + path + expected IOMMU group), then reference it by
name. Benefits: stable across hardware re-enumeration, usable by non-root users with the right ACL,
and PVE verifies the device identity at VM start. On a single node it is still the cleaner, more
self-documenting choice than a hardcoded address.

- Config file: **`/etc/pve/mapping/pci.cfg`** (USB equivalent: `/etc/pve/mapping/usb.cfg`). Lives on
  pmxcfs.
- Create from the CLI with `pvesh` against `/cluster/mapping/pci` (CLI-doable - no GUI needed):

```bash
# Create a PCI mapping named "nic-passthru" pointing at this node's 03:00.0.
pvesh create /cluster/mapping/pci \
 --id nic-passthru \
 --map node=$(hostname),path=0000:03:00.0,id=8086:1539

# Inspect mappings:
pvesh get /cluster/mapping/pci
pvesh get /cluster/mapping/pci/nic-passthru

# Use it on a VM (instead of host=...):
qm set <vmid> --hostpci0 mapping=nic-passthru,pcie=1
```

- The `--map` entry is a per-node descriptor: `node=`, `path=` (full `0000:bus:dev.func`),
  `id=VENDOR:DEVICE`, and optionally `subsystem-id=` and an `iommugroup=` the device is expected to
  be in. PVE checks these at start and refuses if the device identity/group no longer matches (a
  safety feature; on a single node the IOMMU-group check is the part most likely to bite after a
  BIOS update that renumbers groups - see the forum thread in Sources).
- Is it CLI-doable and preferred? **Yes and yes** - everything is `pvesh`/`qm`, no GUI, and the docs
  steer you toward mappings ("It is also possible to map devices on a cluster level ... non-root
  users can configure them. See Resource Mapping.").

> VERSION-FRAGILE FLAG: the exact `--map` sub-keys and whether `iommugroup` is enforced have shifted
> across 8.0 to 8.2 to 9.x. Confirm the accepted keys on the box with
> `pvesh usage /cluster/mapping/pci create -v` before scripting it.

---

## 6. Mediated devices (mdev / vGPU / GVT-g) (VERIFIED)

Mediated devices carve a physical card into virtual slices that are NOT separate PCI devices on the
host. Relevant only to enterprise vGPU (NVIDIA GRID) and Intel GVT-g - **not applicable to the Ryzen
6800H iGPU** (AMD APUs do not expose mdev). Listed for completeness:

```bash
# Discover supported mdev types for a device:
ls /sys/bus/pci/devices/0000:00:02.0/mdev_supported_types
# Intel GVT-g needs kernel param i915.enable_gvt=1
# Attach a type:
qm set <vmid> --hostpci0 00:02.0,mdev=i915-GVTg_V5_4
```

SR-IOV (also VERIFIED, also mostly N/A on this iGPU): some NICs/cards expose Virtual Functions;
enable via a module param `max_vfs=N` in `/etc/modprobe.d/` or
`echo N > /sys/bus/pci/devices/<addr>/sriov_numvfs`, then pass each VF "like a normal PCI(e)
device". Consumer Ryzen iGPUs generally do not offer SR-IOV.

---

## 7. Which real use cases are clean vs fraught on THIS mini-PC

### 7a. iGPU / render device for VIDEO TRANSCODING - prefer LXC, not VM passthrough

- **Cleanest accessible path (RECOMMENDED, COMMUNITY-standard):** do NOT PCI-pass the whole iGPU to
  a VM. Instead share the host render node `/dev/dri/renderD128` into an **LXC container**
  (Jellyfin/Plex/Tdarr) - guide 05 territory. No IOMMU, no vfio, no reset bugs; the host keeps the
  GPU and several containers can share it. This is the right answer for a blind operator who only
  wants hardware transcoding, not a display.
- **Full iGPU PCI passthrough to a VM on AMD APUs is FRAUGHT.** Forum reality on Ryzen APUs (incl.
  Rembrandt-class and newer): the AMD **reset bug** (device won't cleanly re-init after VM stop,
  sometimes hanging the host), the notorious **missing `/dev/dri/renderD128`** in the guest (only
  `card0` shows up, so transcoding still fails), and frequent need for a vBIOS `romfile`. The iGPU
  also tends to share a group with other APU functions. Treat VM iGPU passthrough as a project, not
  a quick win - and since the display output is useless to a blind operator anyway, §7a's LXC
  render-node sharing is almost always the better call.

### 7b. HBA / SATA / NVMe controller - clean IF it is a _separate_ controller

- **Clean** when you pass a **dedicated, add-in** HBA/SATA/NVMe controller that sits in its own
  IOMMU group and the host does **not** boot from it (classic "pass the whole disk controller to a
  TrueNAS/NAS VM" pattern). This is one of the most reliable passthroughs.
- **Dangerous / out of scope** on this node if it would mean passing the **onboard controller that
  holds the boot NVMe** - the host root is on that single NVMe (BTRFS). Passing the controller the
  host boots from removes the host's own root device. **Never** do this with the boot NVMe's
  controller (see §8).

### 7c. NIC - clean for a _secondary_ NIC, never the only NIC

- **Clean** when you pass a **second** NIC (e.g. a USB-NIC's controller, a Thunderbolt/PCIe NIC, or
  one port of a multi-port card in its own group) to a firewall/router VM (OPNsense/pfSense
  pattern).
- **Lockout risk** if you pass the **only** NIC the host manages - you lose SSH and the web UI to
  the host. On a single-NIC mini-PC, do NOT pass the management NIC. (See §8.)

### 7d. USB CONTROLLER - the "nuclear option" for USB devices (often clean)

- For passing USB _devices_, prefer ordinary **USB passthrough** first
  (`qm set --usb0 host=VENDOR:PRODUCT` or `host=bus-port`, covered in guide 06 / qm USB section) -
  no IOMMU needed, accessible, hot-pluggable.
- The **whole-USB-controller PCI passthrough** is the "nuclear option" when a device needs a real
  controller (low-latency, hubs, finicky devices). It is **often clean** because mini-PCs frequently
  expose a USB controller in its own IOMMU group. The catch: that controller may carry **all** the
  box's USB ports - passing it can take your keyboard/IPMI-USB/boot-USB away from the host. Identify
  exactly which physical ports hang off the controller before passing it, and keep network SSH (not
  a USB console) as your lifeline.

---

## 8. SAFETY - how a wrong step locks you out, and the safe approach

This guide must carry the **same lockout-style caution as the networking and firewall guides.** PCI
passthrough mistakes can break **host boot** or strip the host of a device it depends on. Enumerate
the failure modes:

### 8a. Ways to break the host

1. **Bind/blacklist the host's only NIC**: the host loses networking on next boot; no SSH, no web
   UI. Equivalent to the firewall-lockout scenario.
2. **Pass the boot controller** (the onboard SATA/NVMe controller holding the BTRFS root): the host
   has no root device, so it **does not boot**. Catastrophic.
3. **Blacklist a driver the host shares** (e.g. blanket `blacklist amdgpu` when the host console
   relies on it, or blacklisting a storage driver): the host boots degraded or hangs early. A blind
   operator cannot see an early hang.
4. **Wrong `iommu` cmdline / typo in `/etc/default/grub`**: GRUB or kernel refuses the line, or
   boots without IOMMU. On BTRFS+GRUB a bad `GRUB_CMDLINE_LINUX_DEFAULT` plus a botched refresh can
   land you at a "Welcome to GRUB" prompt (the same BTRFS boot fragility flagged in research 04 §9).
5. **ACS override**: not a boot break per se, but it silently destroys IOMMU isolation; a
   compromised guest can DMA host RAM. Treat as unsafe (§2c).
6. **Edited the wrong cmdline file** (`/etc/kernel/cmdline` on this GRUB host): change silently
   ignored; you think IOMMU is on when it is not, then pass a device that isn't actually isolated.

### 8b. The safe approach (checklist)

1. **Verify IOMMU groups FIRST** (§2c). Know exactly which devices are in the group you intend to
   pass. Never pass a group that also contains the boot controller or the management NIC.
2. **Never bind a device the host depends on.** Before any `blacklist`/`ids=`, confirm with
   `lspci -nnk` what the host currently uses the device for and that the host has an alternative (a
   second NIC; the boot disk on a _different_ controller).
3. **Keep a second SSH session open before each reboot**, but be precise about what that means. The
   second session protects only the pre-reboot window: if you make a bad edit and notice before
   rebooting, you can undo it. It does not survive the reboot itself. If the host comes back
   unreachable because a cmdline or vfio bind broke boot, SSH cannot be your recovery shell. Use the
   physical Rescue Boot path from guide 03, or real out-of-band access such as IPMI Serial-over-LAN
   where the hardware has it.
4. **Apply boot changes with the explicit proxmox-boot-tool path** - edit `/etc/default/grub`, run
   **`proxmox-boot-tool refresh`**, and verify `/proc/cmdline` after reboot. Current docs also
   describe `update-grub` as hook-compatible on proxmox-boot-tool systems, but `refresh` is clearer
   in an accessibility-first checklist. Test risky kernel/cmdline changes with the `--next-boot`
   kernel pin trick (research 04 §4) so a bad boot auto-reverts on power-cycle.
5. **Change one thing at a time and reboot between changes**, so when something breaks you know
   which step did it.
6. **Have a recovery plan:** a live USB / the Proxmox "Recover From GRUB Failure" wiki, and a fresh
   backup before the first passthrough attempt. To undo: remove the `hostpci` line
   (`qm set <vmid> --delete hostpci0`), delete the `/etc/modprobe.d/vfio.conf` (or the offending
   blacklist), remove `iommu=pt` if needed, `update-initramfs -u -k all`,
   `proxmox-boot-tool refresh`, reboot.
7. **Confirm reality on the box, not from a blog:** `proxmox-boot-tool status`, `findmnt /` (BTRFS
   root), `dmesg | grep AMD-Vi`, `find /sys/kernel/iommu_groups/ -type l | wc -l`, and `lspci -nnk`
   are the authorities - third-party guides disagree on the version-fragile details (vfio autoload,
   ACS, mapping keys).

---

## 9. Quick command cheat-sheet (this node)

```bash
# 1. Enable IOMMU passthrough mode (AMD-Vi already on by default on AMD).
# Edit /etc/default/grub: GRUB_CMDLINE_LINUX_DEFAULT="quiet iommu=pt"
proxmox-boot-tool refresh
reboot

# 2. Verify after reboot.
dmesg | grep -e DMAR -e IOMMU -e AMD-Vi
find /sys/kernel/iommu_groups/ -type l | wc -l # must be > 0

# 3. Read groups; pick a device that is cleanly isolated and NOT host-critical.
for g in /sys/kernel/iommu_groups/*/devices/*; do \
 echo "group $(basename "$(dirname "$(dirname "$g")")") $(lspci -nns "$(basename "$g")")"; done | sort -V
lspci -nn # get VENDOR:DEVICE ids

# 4. (Optional, robust) Pre-bind to vfio-pci: /etc/modprobe.d/vfio.conf
# options vfio-pci ids=VENDOR:DEVICE
# softdep <hostdriver> pre: vfio-pci
update-initramfs -u -k all && reboot
lspci -nnk -s <bus:dev.func> # expect: Kernel driver in use: vfio-pci

# 5a. Attach directly (VM must be q35 + OVMF, guide 06):
qm set <vmid> --hostpci0 <bus:dev.func>,pcie=1

# 5b. OR via a resource mapping (preferred):
pvesh create /cluster/mapping/pci --id <name> \
 --map node=$(hostname),path=0000:<bus:dev.func>,id=VENDOR:DEVICE
qm set <vmid> --hostpci0 mapping=<name>,pcie=1

# 6. Start; drive over serial.
qm start <vmid>
qm terminal <vmid> # exit Ctrl-O

# Undo (if it broke something):
qm set <vmid> --delete hostpci0
rm /etc/modprobe.d/vfio.conf
update-initramfs -u -k all && proxmox-boot-tool refresh && reboot
```

---

## 10. Verified vs community - at a glance

VERIFIED (official admin guide / PCI(e) Passthrough wiki / `qm.conf(5)`):

- AMD IOMMU on by default; `iommu=pt` recommended for performance.
- `dmesg | grep -e DMAR -e IOMMU`, `AMD-Vi: Interrupt remapping enabled`,
  `find /sys/kernel/iommu_groups/ -type l`.
- IOMMU-group whole-group rule; "okay to share with own functions / root port / bridge."
- vfio modules added to `/etc/modules`; `update-initramfs -u -k all`.
- `options vfio-pci ids=`, `softdep <drv> pre: vfio-pci`, `blacklist <drv>`.
- `lspci -nnk` showing `Kernel driver in use: vfio-pci`.
- Full `hostpci[n]` option set incl. `host`, `mapping`, `pcie`, `driver`, `rombar`, `romfile`,
  `x-vga`, `mdev`, `legacy-igd`, id-overrides.
- q35 + OVMF requirement for PCIe passthrough.
- Resource mappings exist, are config at `/etc/pve/mapping/pci.cfg`, referenced via
  `--hostpci0 mapping=<name>`, created with `pvesh /cluster/mapping/pci`.
- mdev / GVT-g syntax; SR-IOV `sriov_numvfs` / `max_vfs`.
- ACS override warned as risky / last-resort.

COMMUNITY / version-fragile (forum, confirm on box):

- vfio modules **autoload on bind** on PVE 9 kernels (so `/etc/modules` often unneeded);
  `vfio_virqfd` removed since 6.2 - never list it.
- AMD APU iGPU PCI passthrough reset bug + missing `/dev/dri/renderD128`; prefer LXC render-node
  sharing for transcoding.
- USB-controller passthrough usually clean on mini-PCs but may carry all ports.
- `pcie_acs_override=downstream` can expose host RAM - unsafe.
- Exact resource-mapping `--map` sub-keys / IOMMU-group enforcement vary across 8.x to 9.x; verify
  with `pvesh usage`.

---

## Sources

VERIFIED (official):

- Proxmox VE wiki, PCI(e) Passthrough:
  [PCI(e) Passthrough](<https://pve.proxmox.com/wiki/PCI(e)_Passthrough>)
- Proxmox VE wiki, PCI Passthrough (older page, still linked):
  [PCI Passthrough](https://pve.proxmox.com/wiki/PCI_Passthrough)
- Proxmox VE Administration Guide (Qemu/KVM, PCI passthrough + Resource Mapping):
  [QEMU/KVM Virtual Machines](https://pve.proxmox.com/pve-docs/chapter-qm.html)
- Proxmox VE Administration Guide (single page):
  [Proxmox VE Administration Guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.html)
- `qm.conf(5)` man page (hostpci[n] option):
  [qm.conf(5)](https://pve.proxmox.com/pve-docs/qm.conf.5.html)
- `qm(1)` man page: [qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html)
- Host Bootloader wiki (cmdline editing + proxmox-boot-tool refresh):
  [Host Bootloader](https://pve.proxmox.com/wiki/Host_Bootloader)

COMMUNITY (forum, technique / version notes):

- PCI/GPU Passthrough on Proxmox VE 8 - install & configuration (canonical tutorial):
  [\[TUTORIAL\] - PCI/GPU Passthrough on Proxmox VE 8 : Installation and configuration](https://forum.proxmox.com/threads/pci-gpu-passthrough-on-proxmox-ve-8-installation-and-configuration.130218/)
- Simple Working GPU Passthrough on up-to-date PVE and AMD hardware:
  [\[TUTORIAL\] - Simple Working GPU Passthrough on UpToDate PVE and AMD Hardware](https://forum.proxmox.com/threads/simple-working-gpu-passthrough-on-uptodate-pve-and-amd-hardware.145462/)
- AMD iGPU passthrough missing /dev/dri/renderD128:
  [\[SOLVED\] - Proxmox PCI Passthrough (AMD iGPU) missing /dev/dri/renderD128](https://forum.proxmox.com/threads/proxmox-pci-passthrough-amd-igpu-missing-dev-dri-renderd128.158122/)
- Proxmox 9.0 + AMD Radeon iGPU (Granite Ridge) passthrough:
  [\[SOLVED\] - Proxmox 9.0 + AMD Radeon iGPU (Granite Ridge) Passthrough: A Desperate Plea for Help](https://forum.proxmox.com/threads/proxmox-9-0-amd-radeon-igpu-granite-ridge-passthrough-a-desperate-plea-for-help.172139/)
- Should mapping PCI resources without matching IOMMU group be possible? (mapping/IOMMU-group
  enforcement):
  [Should mapping PCI resources without matching IOMMU group be possible?](https://forum.proxmox.com/threads/should-mapping-pci-resources-without-matching-iommu-group-be-possible.167349/)
- Mapped PCI-passthrough only partially working (mapping CLI behaviour):
  [Mapped' PCI-passthrough only partially working](https://forum.proxmox.com/threads/mapped-pci-passthrough-only-partially-working.144851/)
- Proxmox VFIO [SOLVED] (vfio_virqfd removed on 6.2):
  [Proxmox VFIO \[SOLVED\]](https://forum.proxmox.com/threads/proxmox-vfio-solved.145327/)
