# Passing host hardware to guests

## What you'll be able to do

By the end of this guide you will be able to give a guest, a VM or a container, access to a physical
device attached to the host: a USB flash drive, a USB hard disk or SSD, a card reader, a USB audio
DAC or amplifier, a USB-serial microcontroller (Arduino, ESP32) or a Raspberry Pi on a USB-serial
link, and PCI or PCIe cards. The important skill is not one command, it is choosing the right one of
four mechanisms for the device in front of you, because the wrong choice is at best flaky and at
worst risky. Everything here is done from the shell; no GUI is involved. SPICE appears in this
corpus only for the attended install (guide [08 -- Windows guests](08-windows-guests.md)), not for
hardware passthrough.

One scope note up front: passing a graphics card through so a guest drives a _display_ is irrelevant
to a screen-reader operator and brings real single-GPU headaches, so this guide does not cover
GPU-for-display. It does cover the generally useful cases, including an integrated GPU's render node
for video transcoding.

For the non-interactive editing convention used for every config file below (here-doc, `tee`, or a
drop-in, never assuming vim or nano), see the "Editing files accessibly" section of guide
[02 -- The shell and the API](02-the-shell-and-the-api.md). Files under `/etc/pve` (the container
and VM config files) are normally changed through their CLI tool (`pct`, `qm`), which is what this
guide uses.

## Four mechanisms, and choosing between them

There are four distinct ways to hand a device to a guest, and they are not interchangeable:

- USB passthrough to a VM (`qm set <vmid> -usbN host=...`): the VM sees the actual USB device. Right
  for audio DACs, USB-serial microcontrollers and Pis, card readers, and anything you want to behave
  like a removable, hot-pluggable device.
- Physical disk passthrough to a VM (`qm set <vmid> -scsiN /dev/disk/by-id/usb-...`): the VM gets a
  whole block device as a virtual disk. This is the better path for a USB HDD or SSD used as real
  storage.
- Device passthrough to a container: either a bind mount of a filesystem the host has mounted
  (`pct set <vmid> -mpN /mnt/disk,mp=/data`, the right choice when you just want the files off a USB
  disk), or `dev0` passthrough of a single device node (`pct set <vmid> -dev0 /dev/...`, the right
  choice for a serial node, an audio node, or a render node).
- PCI or PCIe passthrough to a VM (`qm set <vmid> --hostpci0 ...`): the heaviest mechanism, for
  non-USB cards, an HBA (host bus adapter, a storage-controller card) or SATA controller, a
  secondary NIC, an integrated GPU, or even a whole USB controller. It requires enabling the IOMMU
  and is the only one of the four that can affect host boot if you get it wrong.

A quick decision list, by what you are holding:

- USB flash drive you treat as a removable stick: USB passthrough to a VM, or a host bind mount into
  a container if you only want the files.
- USB HDD or SSD as a data disk: physical disk passthrough to a VM (by-id), or a host bind mount
  into a container.
- Card reader: USB passthrough (the device), not disk passthrough, because the block device only
  exists while a card is inserted.
- USB audio DAC or amplifier: USB passthrough to a VM, or the `/dev/snd` nodes into a container.
- USB-serial microcontroller (Arduino, ESP32) or a Pi on USB serial: USB passthrough to a VM, or
  `dev0` of the `/dev/serial/by-id/...` node into a container.
- A PCI or PCIe card (HBA, NIC, integrated GPU for transcoding): PCI passthrough to a VM, or for
  transcoding specifically, the GPU render node into a container.

Two safety threads run through all of it. First, a passed-through device is generally removed from
the host's own use while the guest holds it, so do not pass a device the host itself needs. Second,
only the PCI section changes host boot configuration; treat that section with the same care as the
networking and firewall guides (a second SSH session, one change at a time, verify after each
reboot).

## USB devices to a VM

This is raw USB passthrough: the VM is given the actual USB device. It is the right mechanism for a
USB audio DAC or amplifier, a USB-serial microcontroller or Pi, a card reader, and a flash drive you
want to behave like a removable stick. For a USB HDD or SSD used as storage, prefer disk passthrough
(the next section) instead, which is a cleaner block path and less prone to a mid-write USB reset
corrupting the filesystem.

### Find the device

List the USB devices and note the one you want, by its `vendor:product` id:

```bash
lsusb
```

A line like `Bus 002 Device 013: ID 10c4:ea60 Silicon Labs CP210x UART Bridge` gives you the id
`10c4:ea60` (a common USB-serial chip, as used by many ESP32 boards and the Home Assistant Zigbee
dongle in recipe 07). For the physical-port form, read the topology:

```bash
lsusb -t
```

This prints the bus and port path you turn into a `bus-port` value such as `2-1.2.2`.

### Attach it

Give the VM the device with `qm set`, choosing one of two forms:

```bash
qm set <vmid> -usb0 host=10c4:ea60
```

or, to pin to a physical port rather than a specific device:

```bash
qm set <vmid> -usb0 host=2-1.2.2
```

Which form to use:

- `host=<vendor>:<product>` follows the device whatever port it is in, and is the simplest choice.
  Its one failure case is two identical devices (same id): Proxmox cannot tell them apart, so use
  the port form for those.
- `host=<bus>-<port>` pins to a physical port ("whatever is plugged in here goes to this VM"), which
  disambiguates identical devices, but you must update it if you move the device to another port.

For a USB-3 device (a USB-3 DAC, an SSD), the `usb3=1` flag is the older compatibility knob that
marks the assignment as USB 3. On modern guests, PVE says the flag is irrelevant because every USB
device is attached to the xHCI controller, but leaving it in an example is harmless and documents
what you intended:

```bash
qm set <vmid> -usb0 host=<vendor>:<product>,usb3=1
```

A modern VM (machine version 7.1 or newer with a Linux or recent-Windows guest type) provides slots
`usb0` through `usb14`; older machine types provide only `usb0` through `usb4`.

### Worked examples for your devices

- A USB audio DAC or amplifier: discover its id with `lsusb` (audio interfaces show as a vendor's
  "USB Audio" device), then `qm set <vmid> -usb0 host=<vendor>:<product>`. If it is a USB-3 DAC,
  adding `,usb3=1` is harmless and useful for older guest machine types; modern guests already use
  the xHCI controller. The guest's ALSA stack then sees the card directly.
- A microcontroller (Arduino, ESP32) or a Raspberry Pi on a USB-serial link: these enumerate as a
  USB-serial chip (FTDI `0403:6001`, CP210x `10c4:ea60`, CH340 `1a86:7523`, or a CDC-ACM Arduino
  such as `2341:...`). Pass the device with `qm set <vmid> -usb0 host=<vendor>:<product>`, and
  inside the guest it appears as `/dev/ttyUSB0` or `/dev/ttyACM0`. Use the port form if you have two
  identical boards.
- A card reader: pass the reader itself (`host=<vendor>:<product>`), not the card as a disk. The
  card's block device only exists while media is inserted, so passing the reader lets the guest see
  cards come and go.

### Caveats

- Passing a USB device pins the VM to this host (you cannot migrate it elsewhere while the device is
  attached).
- Before you physically unplug a passed-through device, stop using it inside the guest first
  (unmount a stick, stop the audio stream); the assignment otherwise survives unplug and re-plug and
  re-attaches to the same VM.
- While the VM holds the device, do not use it from the host as well.
- A single named mapping (`/etc/pve/mapping/usb.cfg`, referenced as
  `qm set <vmid> -usb0 mapping=<name>`) exists mainly for clusters and non-root users; on this
  single node the raw `host=` form is simpler and sufficient.

### Verify it worked

On the host, confirm the config landed:

```bash
qm config <vmid>
```

Look for a line like `usb0: host=10c4:ea60`. Then, inside the guest over SSH or the serial console
(`qm terminal <vmid>`, see guide
[04 -- Talking to guests without a GUI](04-talking-to-guests-without-a-gui.md)), confirm the device
arrived:

```bash
lsusb
dmesg | tail
```

The same `vendor:product` should appear; a serial device shows up as `/dev/ttyUSB0` or
`/dev/ttyACM0`, an audio device under `aplay -l`.

## A whole USB disk to a VM

For a USB HDD or SSD used as a data disk, attach the raw block device as a virtual disk rather than
passing the USB device. This is the cleaner, more robust path for storage.

### Find the disk by its stable name

Never use `/dev/sdX` for this: the kernel can renumber it across reboots and replugs, especially for
USB. Use the stable `/dev/disk/by-id/` name, which encodes the model and serial. Identify the USB
disk:

```bash
lsblk -o NAME,SIZE,MODEL,SERIAL,TRAN
ls -l /dev/disk/by-id/ | grep -i usb
```

`lsblk`'s `TRAN` column shows which disk is `usb`; match its model and serial to the `usb-...`
symlink under `/dev/disk/by-id/`. That `usb-<model>_<serial>` path is the one you pass.

### Attach it

First make sure the host is not using the disk (it must not be mounted or in a pool, or host and
guest will write the same blocks and corrupt it). Then set a modern SCSI controller and attach the
device as a disk:

```bash
qm set <vmid> -scsihw virtio-scsi-single
qm set <vmid> -scsi1 /dev/disk/by-id/usb-<model>_<serial>
```

The guest then sees a raw disk it can partition and format. (`-sata1` or `-virtio1` work too;
`-scsi` with `virtio-scsi-single` is the modern default.)

### Caveats

- The disk is a direct host-path mapping in the VM config; it is not a Proxmox storage and will not
  appear in `pvesm` or `storage.cfg`.
- It is whole-disk: the guest owns the partition table and filesystem.
- It is not captured by `qm` snapshots or by vzdump backups of the VM, so back up its data
  separately (from inside the guest, or with the VM stopped).
- It blocks live migration, and deep SMART/ATA passthrough inside the guest is limited (this is a
  block passthrough, not a full SCSI command passthrough).

### When to use disk passthrough versus USB passthrough

Use disk passthrough for a USB HDD or SSD that is a real data disk. Use USB passthrough (the
previous section) when you want removable-device semantics, hot-swapping, or a card reader, or for a
flash drive you treat as a stick rather than a fixed disk.

### Verify it worked

On the host, `qm config <vmid>` shows `scsi1: /dev/disk/by-id/usb-...`. Inside the guest, the new
block device appears:

```bash
lsblk
dmesg | tail
```

## Devices to a container

Containers take devices two ways, and the choice again follows the device. For a USB filesystem you
just want the files from, bind-mount it. For a raw device node, a serial port, an audio node, a
render node, use `dev0` passthrough.

### Bind-mount a USB filesystem (the storage case)

When you want a container to read and write files on a USB disk, the recommended path is to mount
the disk on the host and bind that mount into the container. (An unprivileged container generally
cannot mount a raw block device itself, so mounting on the host is also the only straightforward
way.)

Identify and mount the disk on the host, by UUID so it is stable. Edit `/etc/fstab`:

```text
UUID=xxxx-xxxx-xxxx  /mnt/usbdisk  ext4  defaults,nofail,x-systemd.device-timeout=5  0  2
```

`nofail` lets the host still boot if the disk is absent. Create the mountpoint and mount it:

```bash
mkdir -p /mnt/usbdisk
mount /mnt/usbdisk
```

Now the permission point that trips everyone up on unprivileged containers: inside the container,
root is host UID 100000 (the idmap shift, see guide
[05 -- Containers with LXC and pct](05-containers-with-lxc-and-pct.md)). So a host directory owned
by `root` shows up inside the container as `nobody`, unusable. The simplest fix is to give the host
directory to the shifted id that the container user maps to. For container root:

```bash
chown -R 100000:100000 /mnt/usbdisk
```

(For a non-root container user with UID 1000, use `101000:101000`.) Then bind the mount into the
container:

```bash
pct set <vmid> -mp0 /mnt/usbdisk,mp=/data
```

Add `,ro=1` for a read-only mount. The container now sees the files under `/data`.

For a card reader, this host-side approach is also the better one: have the host automount the card
on insertion and the files appear under the bind mount, rather than trying to pass a block device
that does not exist until media is in.

### dev0 passthrough of a device node (serial, audio, render)

For a single device node, the modern option is `dev[n]` (available since PVE 8.1). Its advantage
over the old hand-edited method is that it sets the in-container ownership for you and handles the
unprivileged idmap shift automatically. The syntax:

```bash
pct set <vmid> -dev0 <path>,uid=<n>,gid=<n>,mode=<octal>
```

`uid` and `gid` are the owner the node should have _inside_ the container; `mode` is the octal
access mode. It accepts stable `/dev/disk/by-id/` and `/dev/serial/by-id/` paths, which you should
prefer over `/dev/ttyUSB0`-style names that renumber.

Worked examples for your devices:

- A USB-serial microcontroller or a Pi on a serial link, into a container. Find the stable path and
  the host group that owns the node:

  ```bash
  ls -l /dev/serial/by-id/
  getent group dialout        # the serial group, commonly GID 20
  ```

  Pass it through, owned inside the container by the `dialout` group so the app can use it:

  ```bash
  pct set <vmid> -dev0 /dev/serial/by-id/usb-FTDI_FT232R_USB_UART_AB0001-if00-port0,gid=20,mode=0660
  ```

  Add the container's app user to `dialout` inside the guest (`usermod -aG dialout <user>`).

- An integrated GPU's render node for hardware video transcoding, into a container. Find the render
  group's host GID, then pass the render node owned by that group inside the container:

  ```bash
  ls -l /dev/dri/
  getent group render         # host render GID, often 104
  pct set <vmid> -dev0 /dev/dri/renderD128,gid=104
  ```

  No UID mapping is needed; access is by group. Add the transcoding app's user to the `render` group
  inside the container. (For a single mini-PC, sharing the integrated GPU's render node into a
  container is the clean, accessible way to get hardware transcoding, and avoids the reset quirks of
  passing a whole GPU to a VM.)

For USB audio (a DAC or amplifier) into a container, note one wrinkle: ALSA exposes a directory of
nodes at `/dev/snd`, not a single node, so `dev0` (which targets one node) does not fit cleanly. Use
the older bind-and-allow method here. Edit the container config `/etc/pve/lxc/<vmid>.conf` and add:

```text
lxc.cgroup2.devices.allow: c 116:* rwm
lxc.mount.entry: /dev/snd dev/snd none bind,optional,create=dir 0 0
```

(`116` is the ALSA character-device major; the mount-entry target is relative, with no leading
slash.) Add the container's audio user to the `audio` group inside the guest. This is also the
general pattern when a device is a set of nodes rather than one.

Device and mount changes apply on container restart:

```bash
pct reboot <vmid>
```

### Verify it worked

On the host, confirm the config:

```bash
pct config <vmid>
```

You should see your `dev0:` or `mp0:` line. Then enter the container and check the device or mount
is present and usable:

```bash
pct enter <vmid>
```

Inside:

```bash
ls -l /dev/serial/by-id/                         # only the path you actually passed; not nobody:nogroup
findmnt /data                                    # for a bind mount
touch /data/.wtest && rm /data/.wtest && echo "write OK"
```

List the one node you passed (`/dev/serial/by-id/`, `/dev/dri/`, or `/dev/snd`), not all three at
once; an absent path prints not-found noise that reads like a failure when it is simply a path you
did not use.

If a write test fails with permission denied, the host-side ownership or idmap is wrong; recheck the
`chown` to the shifted UID.

## PCI and PCIe devices to a VM

This is the heaviest mechanism and the only one that changes host boot configuration, so read the
caution first. Use it for non-USB cards: an HBA or SATA controller, a secondary NIC, an integrated
GPU, or a whole USB controller (the blunt way to give a VM every USB port on it).

### Read this first: the host-boot caution

Enabling the IOMMU and binding a device away from the host both change how the host boots and what
hardware it keeps. A wrong step here can leave the host unable to boot, or strip it of a device it
needs, on a machine with no screen. So treat this like the networking and firewall guides:

- Never bind away a device the host depends on: its only network card, or the disk controller it
  boots from. Passing those to a guest takes them from the host.
- You pass through a whole IOMMU group, not a single function. If a group contains a device the host
  needs, you cannot cleanly pass the rest.
- Keep a second SSH session open, change one thing at a time, reboot, and verify before the next
  change. Be clear on what that second session does and does not buy you: it guards only the
  pre-reboot window, so you can undo a bad edit before you reboot into it. It does not survive the
  reboot, so once a bad cmdline or vfio bind actually breaks boot, no SSH session can help. The
  kernel-command-line edits below go through the same `proxmox-boot-tool` path as guide
  [03 -- Repositories, updates, and the host](03-repositories-updates-and-the-host.md); on a machine
  with no screen, the only recovery for a host that will not boot is the physical Rescue Boot from
  the install ISO covered in guide
  [03 -- Repositories, updates, and the host](03-repositories-updates-and-the-host.md).

### Enable the IOMMU

On this AMD host, hardware IOMMU support (`amd_iommu`) is on by default in the kernel; you add
`iommu=pt` (pass-through mode, which is lighter on devices the host keeps). Set it on the kernel
command line the host-boot way. Edit `/etc/default/grub` and append `iommu=pt` to whatever the
`GRUB_CMDLINE_LINUX_DEFAULT` line already holds; do not replace it. If you set serial-console flags
per guide 03, the line might already read `"quiet console=tty0 console=ttyS0,115200n8"`, and you
keep all of that:

```text
GRUB_CMDLINE_LINUX_DEFAULT="quiet console=tty0 console=ttyS0,115200n8 iommu=pt"
```

If yours only had `quiet`, it becomes `"quiet iommu=pt"`. Either way, preserve the existing flags
and add `iommu=pt` at the end.

Then sync it onto the managed boot partition with the explicit Proxmox boot-tool path and reboot:

```bash
proxmox-boot-tool refresh
reboot
```

After the reboot, the proof that your edit took effect is the running kernel command line itself:

```bash
cat /proc/cmdline
```

It must contain `iommu=pt`. This is the primary check: if your GRUB edit was wrong, or the boot
config was not regenerated onto the ESP, `iommu=pt` will be absent here even though everything else
below still looks fine.

The next two are the already-default IOMMU-active confirmation, not proof of your edit: on this AMD
host `amd_iommu` is on by default, so these are typically populated before any change you make.

```bash
dmesg | grep -e DMAR -e IOMMU -e AMD-Vi
find /sys/kernel/iommu_groups/ -type l | wc -l
```

A non-zero count from the second command (the IOMMU groups are populated) confirms the IOMMU is
active.

### Find the device and its IOMMU group

Identify the card's PCI address and current driver:

```bash
lspci -nnk
```

Note the address (for example `0000:01:00.0`) and the `[vendor:device]` id. Then see which IOMMU
group it is in, and what else shares that group:

```bash
for d in /sys/kernel/iommu_groups/*/devices/*; do
  g=${d%/devices/*}; g=${g##*/}
  echo "group $g: $(lspci -nns "${d##*/}")"
done | sort -V
```

Everything in the group moves together. If the group also holds a device the host needs, stop:
passing it would take that device from the host. (The "ACS override" trick to split groups exists
but is unsafe and unsupported; do not use it on a node you cannot easily recover.)

### Bind the device to vfio-pci

So the host's normal driver does not claim the card, bind it to `vfio-pci` by its id. Create a
drop-in. File `/etc/modprobe.d/vfio.conf`:

```text
options vfio-pci ids=<vendor>:<device>
softdep <host-driver> pre: vfio-pci
```

Replace `<vendor>:<device>` with the id from `lspci -nnk`, and `<host-driver>` with the driver that
command showed in use. Rebuild the initramfs and reboot:

```bash
update-initramfs -u -k all
reboot
```

After the reboot, `lspci -nnk` for that device should show `Kernel driver in use: vfio-pci`. (On PVE
9 the `vfio` modules load on demand, so you do not need to list them in `/etc/modules`; and do not
list the old `vfio_virqfd`, which no longer exists.)

### Attach it to the VM

PCIe passthrough needs the `q35` machine type and OVMF/UEFI firmware (see guide
[06 -- Virtual machines with qm](06-virtual-machines-with-qm.md)). Attach the device:

```bash
qm set <vmid> --hostpci0 0000:01:00.0,pcie=1
```

Worked cases that fit a single mini-PC:

- An HBA or a _secondary_ SATA/NVMe controller (never the one the host boots from): a clean way to
  give a storage VM (for example a NAS guest) direct disk control.
- A _secondary_ NIC (never the host's only network card): direct network hardware for a router or
  firewall VM.
- The integrated GPU for transcoding: possible, but on a single integrated GPU it is often cleaner
  to share the GPU's render node into a container instead (see the container section), which avoids
  the AMD reset quirks of handing the whole GPU to a VM.
- A whole USB controller: the blunt alternative to per-device USB passthrough, handing a VM every
  port on that controller at once.

As with USB, a named mapping (`/etc/pve/mapping/pci.cfg`, used as `--hostpci0 mapping=<name>`)
exists mainly for clusters; raw addresses are fine on one node.

### Verify it worked

On the host, `qm config <vmid>` shows `hostpci0: 0000:01:00.0,pcie=1`, and `lspci -nnk` shows the
device bound to `vfio-pci`. Inside the guest, the card appears in its own `lspci`, and its function
works (the disks behind an HBA enumerate, the NIC shows a link, the render node appears under
`/dev/dri`).

## Giving the device back

Each mechanism reverses, and reversing matters: a passed-through device is taken from the host, and
a PCI bind in particular changes host boot, so undoing it follows the same one-change-at-a-time
discipline as setting it up.

For the three config-line mechanisms (USB to a VM, disk to a VM, a container `dev` or mount),
deleting the config line releases the device. The device returns to the host on the next power-cycle
of the guest:

```bash
qm set <vmid> -delete usb0          # a USB device passed to a VM
qm set <vmid> -delete scsi1         # a whole disk passed to a VM
pct set <vmid> -delete dev0         # a device node passed to a container
pct set <vmid> -delete mp0          # a bind mount into a container
```

For a VM, stop it first (`qm stop <vmid>`) so the device is not in use, then delete the line and
start it again. For a container, delete the line and `pct reboot <vmid>`.

The container audio case is the exception, because it was set by hand-editing the config rather than
through a `dev` line. Edit `/etc/pve/lxc/<vmid>.conf` and remove the two lines you added:

```text
lxc.cgroup2.devices.allow: c 116:* rwm
lxc.mount.entry: /dev/snd dev/snd none bind,optional,create=dir 0 0
```

Then `pct reboot <vmid>`.

PCI is the involved reversal, because binding to `vfio-pci` and enabling the IOMMU both changed host
boot. Undo it in the reverse order you set it up, one change and one reboot at a time. Keep a second
SSH session open before each reboot so you can catch a bad pre-reboot edit, but remember the session
will not survive the reboot itself; if the host fails to boot, you need the Rescue Boot path from
guide 03.

1. Stop the VM and detach the device:

   ```bash
   qm stop <vmid>
   qm set <vmid> -delete hostpci0
   ```

2. Remove the vfio bind so the host's normal driver claims the card again. Delete
   `/etc/modprobe.d/vfio.conf` (the file you created), then rebuild the initramfs and reboot:

   ```bash
   rm /etc/modprobe.d/vfio.conf
   update-initramfs -u -k all
   reboot
   ```

   After the reboot, `lspci -nnk` for that device should show its normal `Kernel driver in use:`
   line again (the host driver, not `vfio-pci`).

3. Only if you also want to undo the IOMMU change: edit `/etc/default/grub` and remove the
   `iommu=pt` flag you appended to `GRUB_CMDLINE_LINUX_DEFAULT` (leave the other flags in place),
   then `proxmox-boot-tool refresh` and reboot. Leaving `iommu=pt` in place is harmless, so this
   last step is usually unnecessary.

## Sources

- USB and disk passthrough to a VM: the Proxmox wiki
  [USB Devices in Virtual Machines](https://pve.proxmox.com/wiki/USB_Devices_in_Virtual_Machines)
  and
  [Passthrough Physical Disk to Virtual Machine](<https://pve.proxmox.com/wiki/Passthrough_Physical_Disk_to_Virtual_Machine_(VM)>),
  and the [qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html) man page (the `usb[n]` and
  `scsi[n]`/`scsihw` option specifications, the `usbN` slot count, and the device-pins-the-VM
  caveat).
- Container device passthrough: the Proxmox
  [pct administration chapter](https://pve.proxmox.com/pve-docs/chapter-pct.html), the
  [pct.conf](https://pve.proxmox.com/wiki/Manual:_pct.conf) manual (the `dev[n]` and `mp[n]`
  options), the
  [Unprivileged LXC containers](https://pve.proxmox.com/wiki/Unprivileged_LXC_containers) wiki (the
  idmap shift), and the PVE 8.2 release notes (device passthrough available via CLI/API since 8.1).
- PCI(e) passthrough: the Proxmox wiki
  [PCI(e) Passthrough](<https://pve.proxmox.com/wiki/PCI(e)_Passthrough>) and the IOMMU and
  `hostpci[n]` material in the [qm.conf](https://pve.proxmox.com/wiki/Manual:_qm.conf) manual.
- Related guides:
  [03 -- Repositories, updates, and the host](03-repositories-updates-and-the-host.md) (the kernel
  cmdline via `proxmox-boot-tool refresh`),
  [05 -- Containers with LXC and pct](05-containers-with-lxc-and-pct.md) (unprivileged containers,
  idmap, mount points), [06 -- Virtual machines with qm](06-virtual-machines-with-qm.md) (q35/OVMF
  and the `qm` surface), [09 -- Storage](09-storage.md) (by-id disk naming), and the Home Assistant
  recipe [recipes/07](recipes/07-home-assistant-haos-vm.md), which already uses USB passthrough for
  a Zigbee dongle.

---

Previous: [20 -- Reinstalling the host remotely](20-reinstalling-the-host-remotely.md) | Next:
[22 -- When things break](22-when-things-break.md)
