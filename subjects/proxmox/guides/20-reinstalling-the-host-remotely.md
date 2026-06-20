# Reinstalling the host remotely with no physical access

## What you'll be able to do

By the end of this guide you will be able to trigger a complete, unattended reinstall of the Proxmox
host over SSH, driven by the `answer.toml` automated installer so it runs hands-off and reboots into
a fresh, SSH-reachable system. There are two ways to start that installer without ever seeing a
screen, and which one you use turns on a single question: can you physically plug a USB stick into
the host?

- If you can plug in a USB stick (you do not need to see the screen to do it), prefer the USB route.
  You write the unattended installer to a stick, plug it in, and then set a one-time UEFI boot over
  SSH so the firmware boots that stick on the next reboot. It is an ordinary firmware boot, which
  makes it the safer and simpler of the two.
- If no one can ever touch the machine, the `kexec` route jumps the running kernel straight into an
  installer kernel, with no firmware step, no boot-order change, and no media at all. It is
  powerful, but genuinely risky, and most of this guide is the care it demands.

Be warned up front about the `kexec` route specifically: it is the most dangerous procedure in the
corpus. Done on the wrong hardware, or without rehearsing, it leaves a headless machine that no
amount of SSH can recover, because the only thing left is physically touching the host. So this
guide spends most of its length on the gates you must clear first and on rehearsing the whole thing
safely in a throwaway VM before you ever point it at the real host. The USB route avoids most of
that risk, which is why it is the one to reach for whenever you can insert media.

For the non-interactive editing convention used for every config file below (here-doc, `tee`, or a
drop-in, never assuming vim or nano), see the "Editing files accessibly" section of guide
[02 -- The shell and the API](02-the-shell-and-the-api.md).

## The kexec route: read this first (the three gates and the brick risk)

These three gates and the brick risk apply to the `kexec` route. If you can plug in a USB stick, the
USB route later in this guide has much lighter prerequisites (UEFI boot mode, and Secure Boot as a
media question rather than a hard stop) and none of this brick risk; prefer it. Read on only if a
purely no-media reinstall is what you need.

A normal reboot hands control to the firmware (BIOS/UEFI), which re-initialises every device and
then runs your bootloader. `kexec` deliberately skips all of that: it boots a new kernel from inside
the running one, so the firmware never re-runs. That is exactly why it lets you "reboot into an
installer" without touching the boot order. It is also exactly why it is dangerous: devices the
firmware would normally reset, above all the network card, can be left in a state the new kernel
cannot use. If the NIC does not come back, your only channel to the host is gone.

So before anything else, clear three gates. If any one of them fails, stop: a purely remote
reinstall is not safe on this machine, and you should use the fallbacks at the end of this section
instead.

### Gate 1: Secure Boot and kernel lockdown (the hard stop)

If the host firmware has Secure Boot enabled, the running kernel is in "lockdown" mode, and lockdown
disables the classic `kexec_load` system call outright. You can only `kexec` a kernel whose
signature the firmware trusts, which an arbitrary installer kernel is not. There is no software
workaround, and you cannot disable Secure Boot without BIOS access. So this is a true stop, and you
check it first.

Run all three checks on the host:

```bash
mokutil --sb-state
cat /sys/kernel/security/lockdown
dmesg | grep -i lockdown
```

(If `mokutil` is missing, `apt install -y mokutil`; the lockdown file and the `dmesg` check are
authoritative on their own and need nothing installed.)

What you want to see, for `kexec` to be possible:

- `mokutil --sb-state` reports `SecureBoot disabled` (or `This system doesn't support Secure Boot`).
- `/sys/kernel/security/lockdown` shows `[none] integrity confidentiality` (the active mode is the
  one in square brackets; you want `[none]`).
- `dmesg | grep -i lockdown` prints nothing about being "locked down from EFI Secure Boot mode".

If instead Secure Boot is enabled, or lockdown is `[integrity]` or `[confidentiality]`, then `kexec`
of an installer kernel will fail with a "Operation not permitted" error, and you must stop here.
(Note: the coupling of Secure Boot to lockdown is a distribution behaviour, so trust the `dmesg`
line and the `lockdown` file over any assumption. Lockdown, once raised, cannot be lowered without a
reboot.)

### Gate 2: does this hardware tolerate kexec at all (the round-trip test)

Even with lockdown off, some firmware and some NICs do not survive a `kexec`. You must prove they do
before you bet the machine on it, and you can prove it safely: `kexec` back into a copy of the
kernel you are already running. If the host reconnects over SSH, then `kexec` works here and the
network re-initialises across the jump. If it does not reconnect, the worst case is a power-cycle
that boots the existing, still-working system, because you changed nothing on disk.

This test is covered in full, with the safe ordering, in the rehearsal section below; do not run it
casually on the real host before you have read that. The point to carry here is that "kexec works on
this host" is something you confirm empirically, never assume.

### Gate 3: enough RAM, and the installer must run entirely from RAM

You are about to wipe the disk you booted from. So the installer environment must load completely
into RAM first and never read that disk again, or it dies mid-wipe. The Proxmox installer is built
to run from a RAM disk, but you must boot it the right way (the `ramdisk_size` parameter below) and
the host needs enough free RAM to hold it. This is not a problem on a 24 GB host, but it is a hard
requirement, not a nicety: an installer that lazily reads from the disk it is erasing will hang or
corrupt itself, and on a headless host that is unrecoverable.

### If a gate fails: the honest fallbacks

If Secure Boot is on, or the round-trip test does not reconnect, a remote reinstall over `kexec` is
not available to you, and pretending otherwise risks a dead host. Your real options then are:

- Physical access, eventually: the Proxmox installer ISO on a USB stick, booted once at the machine.
  Slow and needs hands on the host, but certain.
- An IP-KVM such as a PiKVM (your Raspberry Pi can run one): it gives full remote BIOS access and
  virtual media, so a reinstall needs no one at the host. The catch for you specifically is that its
  output is a video stream of the BIOS and installer, which a screen reader cannot read; it helps a
  sighted remote helper, not you directly. The `answer.toml` automated install pairs well with it,
  though, because once the ISO is virtually inserted and booted, the install needs no interaction.

Decide this honestly before you start. A reinstall you cannot complete is worse than one you defer
until you can.

## The accessible linchpin: the unattended install needs no screen

The reason this is worth doing at all, for a blind operator, is that the Proxmox installer can run
with zero interaction. Since Proxmox VE 8.2 the installer ships two things that matter here: a
Terminal-UI installer with a dedicated serial-console entry, and a fully automated mode driven by an
`answer.toml` file (the same `answer.toml` family you met in guide
[01 -- Install Proxmox VE 9 unattended](01-install-proxmox-unattended.md)). In automated mode the
installer reads the answer file, wipes and installs with no prompts, and reboots into the new system
on its own.

That means you never need to see the installer. You trigger it over SSH, wait, and then SSH back
into a freshly installed host. The serial-console entry only matters when you want to watch progress
(most useful during the rehearsal); the real remote run is hands-off by design.

## Build and validate the answer file

The answer file decides everything the installer would otherwise ask: hostname, network, which disk,
which filesystem. Build it once, validate it, and keep it safe (it carries a root credential).

First, a hard safety point. The automated installer wipes and repartitions the entire selected disk
with no prompt. On this single-NVMe node that disk holds your guests too. A reinstall is a total
host rebuild, not a repair: every VM and container on the internal disk is destroyed. So before you
reinstall, make sure your guests and host config are backed up off the box and you have proven you
can restore them, exactly as guide
[18 -- The independent copy and restore](18-the-independent-copy-and-restore.md) describes.

One ordering point that is easy to miss on this single-node setup: PBS runs as a VM on this very
host, so a full wipe destroys the PBS VM itself. The backups survive (the USB-HDD datastore and the
off-site Pi copy are both off the host), but the server that reads them is gone. So the recovery
order is: reinstall the host first, then rebuild the PBS VM and re-point it at the surviving
datastore (guide 17), and only then restore your other guests from PBS (guide 18).

You build the answer file on the control station, where you also run the Linux-only
`proxmox-auto-install-assistant`. Generate the password hash separately so the plaintext never lands
in the file or your shell history:

```bash
mkpasswd -m sha-512
```

(`mkpasswd` is in the `whois` package; `openssl passwd -6` is an equivalent if you prefer.) Paste
the resulting hash into the file below.

File `answer.toml` (single NVMe, btrfs root, matching this corpus's identity):

```toml
[global]
keyboard = "en-us"
country = "us"
fqdn = "pve.home.arpa"
mailto = "you@example.com"
timezone = "America/New_York"
# The hash from mkpasswd above, never the plaintext password:
root-password-hashed = "$6$...replace-with-your-hash..."
# So you can SSH in the moment it reboots:
root-ssh-keys = [
    "ssh-ed25519 AAAA...your-control-station-key... you@control-station"
]
reboot-on-error = false

[network]
source = "from-dhcp"

[disk-setup]
filesystem = "btrfs"
btrfs.raid = "raid0"
disk-list = ["nvme0n1"]
```

Three things to get right:

- `btrfs.raid = "raid0"` is required for a single-disk btrfs install; it is how you name "one disk"
  to this installer. Omitting it makes `proxmox-auto-install-assistant validate-answer` fail with
  "Btrfs raid level 'btrfs.raid' must be set". There is no `single` value; use `raid1`/`raid10` only
  with multiple disks.
- `disk-list = ["nvme0n1"]` names the target disk explicitly. Confirm the real name on the running
  host with `lsblk -d -o NAME,MODEL,SIZE` before you trust it, and remember this disk will be
  erased. If you would rather match by hardware, the assistant's `device-info -t disk` prints the
  udev properties you can filter on.
- `source = "from-dhcp"` is simplest if your router gives the host a stable address (a DHCP
  reservation is worth setting up first, so the reinstalled host returns on the IP you expect). For
  a fixed address, use `source = "from-answer"` with `cidr`, `gateway`, and `dns` keys instead.

The keys use kebab-case (`root-password-hashed`, not `root_password_hashed`) on 9.x. Validate the
file before you go any further:

```bash
proxmox-auto-install-assistant validate-answer answer.toml
```

Treat the finished `answer.toml` like the Windows `autounattend.xml` in guide 08: it holds a
(hashed, but still sensitive) root credential, so keep it `chmod 600`, and when it has been baked
into install media, destroy that media and any stray copies afterward.

## The USB route: a one-time boot from a plugged-in installer (recommended)

If you can plug a USB stick into the host, even blind, this is the route to use. It sidesteps every
`kexec` hazard: the firmware boots the stick and re-initialises all hardware normally, so the
network card comes back; the installer runs from the stick, not from the disk being wiped, so there
is no run-in-RAM juggling; and because it is an ordinary firmware boot, it is not blocked by the
Secure Boot kernel lockdown that stops `kexec` outright. The one thing you cannot normally do
without a screen, choosing the boot device, you do over SSH with the UEFI `BootNext` variable: it
tells the firmware to boot one chosen entry on the very next boot only, then deletes itself so the
boot after that is normal again.

### Prerequisites (lighter than the kexec gates)

- The host must boot in UEFI mode, not legacy BIOS. Check it:

  ```bash
  [ -d /sys/firmware/efi ] && echo "UEFI" || echo "legacy BIOS"
  ```

  If this prints `legacy BIOS`, the USB route is not available: legacy BIOS firmware has no software
  one-time-boot, so selecting the USB would need the on-screen boot menu. On a legacy-BIOS host,
  `kexec` is your only no-screen option.

- Secure Boot here is only a media-signing question, not a hard stop. The Proxmox installer has been
  Secure Boot signed since PVE 8.1, so a current installer USB can boot with Secure Boot on. But
  some firmware still rejects external media under Secure Boot with an "Invalid signature" error you
  would not be able to see and diagnose. If you know Secure Boot is off, you are safe; if you are
  unsure, that uncertainty is the main risk of this route, so confirm the firmware's Secure Boot
  state before you rely on it.

### Make the USB an unattended installer

Make the installer stick exactly as guide
[01 -- Install Proxmox VE 9 unattended](01-install-proxmox-unattended.md) teaches: build and
validate the `answer.toml` (the section above), bake it into the ISO with
`proxmox-auto-install-assistant prepare-iso ... --fetch-from iso` (run in WSL2 on the Windows
control station, since the assistant is Linux-only), and flash the prepared ISO to the stick with
Rufus in "DD Image mode". Guide 01's "Prepare the ISO" and "Flash to USB" steps have the exact
commands and Rufus settings, so there is no need to repeat them here.

The only thing this route changes is what comes after the stick is made. In guide 01 you make a
one-time sighted visit to the firmware to set the boot order; here, because the host is already
running and reachable, you replace that visit with a one-time UEFI boot you set over SSH. The
prepared ISO still carries the "Automated Installation" boot entry that auto-selects after about ten
seconds, so once the firmware boots the stick the install runs with no keystrokes and no screen.

### Identify the stick on the host (do this carefully)

Plug the prepared stick into the host. Everything from here runs on the host over SSH. You are about
to name a whole disk in a boot command, so identifying the right one matters: aim it at your
internal NVMe or your backup USB HDD by mistake and you point the reinstall at the wrong disk. The
reliable, screen-reader-friendly way is to list the disks before and after you plug the stick in,
and let the difference name it.

Before plugging the stick in, record the current whole disks:

```bash
lsblk -dno NAME,TRAN,SIZE,MODEL | tee /tmp/disks-before.txt
```

Now plug the stick in, wait a few seconds, and show only what changed:

```bash
lsblk -dno NAME,TRAN,SIZE,MODEL | tee /tmp/disks-after.txt
diff /tmp/disks-before.txt /tmp/disks-after.txt
```

The line that appears only in the "after" list is your stick; note its name (for example `sdb`).
Confirm it on three counts before you trust it:

- its transport (the `TRAN` column) is `usb`, not `nvme` (your internal disk);
- its `SIZE` and `MODEL` match the flash drive you just inserted, and are clearly not the internal
  NVMe nor your larger backup USB HDD;
- it is flagged removable:

  ```bash
  lsblk -o NAME,RM,TRAN,SIZE,MODEL,SERIAL /dev/sdb
  cat /sys/block/sdb/removable        # 1 means removable
  ```

As a further cross-check, the stable by-id names for USB devices encode the vendor and model, so the
right stick is unmistakable there too:

```bash
ls -l /dev/disk/by-id/usb-*
```

You will see something like `usb-SanDisk_Ultra_...` pointing at your `sdb`.

Finally, find which partition on the stick is its EFI System Partition, because the boot entry must
point at that partition and you should not assume its number:

```bash
lsblk -o NAME,SIZE,FSTYPE,PARTTYPENAME /dev/sdb
```

The EFI partition is the one whose `PARTTYPENAME` is `EFI System` (its `FSTYPE` is `vfat`). Note the
trailing digit of its name (for example the `2` in `sdb2`); that is the `--part` value in the next
step. (If your `lsblk` is too old to show `PARTTYPENAME`, run `fdisk -l /dev/sdb`, which lists the
partitions and marks one "EFI System".)

### Set the one-time boot over SSH

Make the firmware variables writable, then create a boot entry pointing at the stick's EFI loader
(the conventional removable-media path), using the disk and EFI partition number you just
identified, and set that entry as the one-time next-boot target:

```bash
mount -o remount,rw /sys/firmware/efi/efivars 2>/dev/null

efibootmgr --create --disk /dev/sdb --part 2 \
  --loader '\EFI\BOOT\BOOTX64.EFI' --label "USB PVE installer"
# note the Boot#### number it prints, then point BootNext at it:
efibootmgr --bootnext XXXX
efibootmgr            # confirm a "BootNext: XXXX" line is present
```

Substitute your own values: `/dev/sdb` is the stick's disk from the diff above, `--part 2` is its
EFI System partition number, and `XXXX` is the four-hex-digit `Boot####` number that the `--create`
line printed.

No dead-man timer is needed here. Because `BootNext` is one-shot, a stick that fails to boot just
falls back to the existing boot order and the current system comes up as before; the firmware
re-initialises hardware the normal way either way. The command still starts an unattended reinstall
that wipes the internal disk if the stick boots, so require one last explicit confirmation:

```bash
[ -f /tmp/disks-before.txt ] && [ -f /tmp/disks-after.txt ] || { echo 'Missing disk diff notes; aborting.'; exit 1; }
printf 'FINAL WARNING: if BootNext works, this host will reinstall and wipe the internal disk. Type REINSTALL NOW to continue: '
read FINAL_CONFIRM
[ "$FINAL_CONFIRM" = 'REINSTALL NOW' ] || { echo 'Aborted.'; exit 1; }
reboot
```

The firmware boots the USB once (it consumes `BootNext` automatically), the unattended installer
wipes the NVMe and installs Proxmox per your `answer.toml`, and reboots. Because `BootNext` was
one-shot, that second reboot follows the normal boot order into the freshly installed host. Re-probe
SSH until it answers, rebuild the PBS VM and re-point it at the surviving datastore (guide 17; PBS
was a VM on the wiped disk, so it must come back first), then restore your guests from PBS (guide
18), and expect the SSH host-key change (`ssh-keygen -R <host>` on the control station, then
reconnect).

### Afterwards: tidy the boot order and pull the stick

The entry you created still exists and was placed first in the boot order, and some firmware prefers
removable media regardless of that order, so once you are back in, delete the stale entry, make sure
the internal install boots first, and physically unplug the USB:

```bash
efibootmgr -v                  # inspect entries and BootOrder
efibootmgr -b XXXX -B          # delete the leftover USB entry you created
efibootmgr -o YYYY,ZZZZ        # put the internal Proxmox entry first (hex, in order)
```

Physically removing the stick is the simplest guarantee it cannot boot again on a later reboot.

### Why this is the route to prefer

Compared with `kexec`: this is a real firmware boot, so hardware (above all the NIC) is
re-initialised the normal way and the canonical "network never came back" brick does not apply; the
installer lives on separate media, so there is no wipe-the-disk- you-booted-from problem; and it is
not subject to the Secure Boot lockdown that blocks `kexec` entirely. The only thing it asks that
`kexec` does not is your hand plugging in the stick. Reach for `kexec` only when no one can ever
insert media.

## The kexec route: rehearse in a nested VM first (do not skip this)

This is the heart of the guide. You can build a Proxmox VM on your own host, install Proxmox into
it, and practise the entire kexec-and-reinstall dance inside it, over a serial console, as text. If
you get it wrong there, you destroy a throwaway VM and start over. If you get it wrong on the real
host, you destroy the host. Rehearse until the VM procedure is boring, then run it on metal.

### Enable nested virtualisation on the real host

So the rehearsal VM can itself run a KVM installer, turn on nesting once. For the AMD Ryzen host in
this corpus:

File `/etc/modprobe.d/kvm-amd.conf`:

```text
options kvm-amd nested=1
```

Reload the module (stop any running VMs that use it first) and confirm:

```bash
modprobe -r kvm_amd && modprobe kvm_amd
cat /sys/module/kvm_amd/parameters/nested
```

A `1` (or `Y`) confirms nesting is on. (On an Intel host the file is
`/etc/modprobe.d/kvm-intel.conf` with `options kvm-intel nested=Y`, and the module is `kvm_intel`.)

### Create the rehearsal VM with a serial console

Build a VM with a serial console so the whole rehearsal is text, a fresh empty disk to stand in for
the NVMe, and the Proxmox ISO attached. Adjust the storage id to this node's `local-btrfs`:

```bash
qm create 9999 \
  --name pve-rehearsal --ostype l26 \
  --memory 6144 --cores 2 --cpu host \
  --scsihw virtio-scsi-single --scsi0 local-btrfs:32 \
  --net0 virtio,bridge=vmbr0 \
  --serial0 socket --vga serial0 \
  --ide2 local-btrfs:iso/proxmox-ve_9.2-1.iso,media=cdrom \
  --boot 'order=ide2;scsi0'
```

`--serial0 socket` plus `--vga serial0` routes the VM's console to the serial line, which you attach
to with `qm terminal 9999` (press Enter for a prompt; leave it with Ctrl-O). `--cpu host` forwards
the virtualisation flags so the nested installer can use KVM. The 6 GB of RAM gives the in-RAM
installer room.

### Install Proxmox into the VM, accessibly

Start the VM, then attach to its serial console:

```bash
qm start 9999
qm terminal 9999
```

Press Enter once or twice to wake the console.

At the ISO boot menu, choose "Install Proxmox VE (Terminal UI, Serial Console)". That entry sets the
installer kernel to use the serial line, so the whole text installer comes to you over
`qm terminal`. Install Proxmox into the VM's `scsi0` disk as a normal single-disk btrfs install.
When it reboots, you have a nested Proxmox host to experiment on. Give it a moment, then confirm it
over SSH (the guest agent or your DHCP server will tell you its address):

```bash
ssh root@<vm-ip> pveversion
```

You now have a safe stand-in for the real host. Everything below you do here first.

### Step 1 in the VM: prove kexec survives (the round-trip test)

Inside the rehearsal VM, install the kexec tools and load a copy of the kernel the VM is already
running:

```bash
apt update && apt install -y kexec-tools
kexec -l /boot/vmlinuz-$(uname -r) \
      --initrd=/boot/initrd.img-$(uname -r) \
      --append="$(cat /proc/cmdline)"
```

Then jump, using systemd so services stop and filesystems unmount cleanly first (this is the
graceful equivalent of a reboot that skips the firmware):

```bash
systemctl kexec
```

The VM's SSH session will drop. Wait, then reconnect:

```bash
ssh root@<vm-ip> 'uptime && pveversion'
```

A low uptime and a working `pveversion` mean the kexec round-trip succeeded: the kernel jumped, and
the network came back. This is exactly the test you will run on the real host as Gate 2, and the
reason it is safe there too: you changed nothing on disk, so the worst case is a power-cycle back
into the same system.

### Step 2 in the VM: prepare the installer to boot from RAM

The Proxmox installer's initrd expects to find the ISO as its install medium. The reliable way to
make it self-contained in RAM is to embed the whole ISO inside the initrd, then boot that augmented
kernel and initrd. The community tool [`pve-iso-2-pxe`](https://github.com/morph027/pve-iso-2-pxe)
does exactly this and emits a `linux26` kernel and an `initrd.img` you can boot. (This is community
tooling, not an official Proxmox procedure, which is precisely why you are proving it in a VM
first.)

Alternatively, the official `proxmox-auto-install-assistant` can emit boot artifacts directly,
fetching the answer file over HTTP, which avoids hand-rolling the initrd:

```bash
proxmox-auto-install-assistant prepare-iso proxmox-ve_9.2-1.iso \
  --fetch-from http --url "https://<answer-host>/answer" \
  --pxe --output /srv/installer/
```

Whichever route, you end up with a kernel and an initrd that carry the installer (or know how to
fetch it) and the answer file (baked in, on a labelled partition, or over HTTP). Place that kernel
and initrd somewhere the VM can read them. The two routes name the kernel differently, which matters
for the kexec command below: `pve-iso-2-pxe` produces a kernel called `linux26`, while
`proxmox-auto-install-assistant --pxe` produces one called `vmlinuz` (both produce `initrd.img`).
Note which name your route emitted.

### Step 3 in the VM: kexec into the installer

Load the installer kernel and initrd and boot them. For an unattended, serial-visible run inside the
VM:

```bash
kexec -l ./linux26 --initrd=./initrd.img \
      --append="ramdisk_size=16777216 rw quiet proxmox-start-auto-installer console=ttyS0,115200"
kexec -e
```

- The kernel is named `linux26` if you built it with `pve-iso-2-pxe` (as shown), or `vmlinuz` if you
  used `proxmox-auto-install-assistant --pxe`; use the name your route actually produced, or the
  load step fails on a missing file.
- `ramdisk_size=16777216` (the value Proxmox's own boot config uses) sizes the RAM disk so the whole
  installer loads into memory; this is what makes it independent of the disk being wiped.
- `proxmox-start-auto-installer` triggers the unattended install (it reads the fetch mode baked in
  at prepare time).
- `console=ttyS0,115200` lets you watch the install over `qm terminal` in the VM. On the real
  headless host you can include it harmlessly even though nothing reads it; the install does not
  depend on a console.

Watch the rehearsal over `qm terminal 9999`: the installer should wipe `scsi0`, install per your
`answer.toml`, and reboot into a fresh Proxmox. Then verify over SSH as below. When that works end
to end in the VM, and only then, you are ready to consider the real host.

## The kexec route: run it on the real host

With all three gates cleared and the VM rehearsal working, the real run is the same sequence, with
two non-negotiable additions because there is no console to save you:

1. Confirm Gate 1 again on the host (`mokutil --sb-state`, the lockdown file).
2. Run the Gate 2 round-trip test on the host: `kexec -l` the running kernel, `systemctl kexec`, and
   confirm SSH reconnects. Do this when you can tolerate the host rebooting, because if it does not
   come back, a power-cycle (someone toggling the power, eventually) boots the existing system
   unharmed.
3. Understand that there is no software safety net once you jump. A scheduled `reboot` cannot save
   you here: its spool lives on the NVMe you are about to wipe, `kexec -e` tears down userspace (so
   `atd` stops) and a successful jump wipes the spool anyway. If the kexec hangs or the network does
   not come back, the only lever left is a physical or remote power-cycle (someone toggling the
   power, eventually), which boots whatever is now on disk. Do not start the destructive jump unless
   you can tolerate that.
4. Make sure the installer kernel and initrd, and the answer file, are staged and that the answer
   file's network setting will bring the host back on an address you can predict (the DHCP
   reservation, or a static `from-answer` block).
5. Then require a final typed confirmation and execute the installer kexec exactly as rehearsed:

```bash
printf 'FINAL WARNING: kexec will jump into the installer and wipe the host disk. Type KEXEC INSTALL to continue: '
read FINAL_CONFIRM
[ "$FINAL_CONFIRM" = 'KEXEC INSTALL' ] || { echo 'Aborted.'; exit 1; }
kexec -e
```

After the jump, you wait. The install runs unattended and reboots into the new system. Re-probe SSH
until it answers, then verify (next section). Finally, rebuild the PBS VM and re-point it at the
surviving datastore (guide 17; it was a VM on the disk you just wiped, so it must come back before
it can serve restores), then restore your guests from PBS per guide 18. Expect, and accept, an SSH
host-key change: the reinstalled host has new host keys, so your control station will warn about a
changed key on first reconnect. Remove the old entry with `ssh-keygen -R <host>` and reconnect.

## Optional: a permanent reinstall escape hatch

The procedure above stages the installer each time. You can instead install a permanent "boot the
installer" path once, so a clean reinstall is always one SSH command and a reboot away. The idea:
keep the installer kernel and initrd on a small dedicated partition, and add a permanent entry to
the bootloader that boots them fully into RAM.

Two Proxmox-specific cautions shape the design:

- The EFI System Partition Proxmox creates is only 512 MB, and the Proxmox installer initrd (with
  the ISO embedded) is around a gigabyte. It will not fit on the ESP, so use a separate small
  partition (say 2 GB, labelled `RESCUE`) for the installer kernel and initrd.
- This host boots with GRUB (a btrfs root uses GRUB, not systemd-boot), and its boot files are kept
  in sync onto the ESP by `proxmox-boot-tool`. After any bootloader change, run
  `proxmox-boot-tool refresh` directly so the command you type names the ESP sync step. Current
  Proxmox docs also describe `update-grub` as a valid GRUB apply path on systems where the
  proxmox-boot-tool hook is installed, but this guide keeps the explicit sync command.

Add a permanent menu entry that finds the `RESCUE` partition by label and boots the installer into
RAM. File `/etc/grub.d/40_custom` (append below its existing header):

```text
menuentry 'Proxmox installer (RAM, serial)' --id pve-installer {
    insmod part_gpt
    insmod fat
    insmod search_fs_label
    search --no-floppy --label RESCUE --set=root
    linux  /linux26 ramdisk_size=16777216 rw quiet console=tty0 console=ttyS0,115200
    initrd /initrd.img
}
```

Use the kernel filename you actually copied onto the `RESCUE` partition: `linux26` from
`pve-iso-2-pxe` (as written here), or `vmlinuz` from `proxmox-auto-install-assistant --pxe`. Then
sync it onto the ESP the Proxmox way:

```bash
proxmox-boot-tool refresh
```

A note on triggering it for one boot only. GRUB's `grub-reboot <id>` is meant to boot an entry just
once and then fall back, but on a `proxmox-boot-tool` host the GRUB environment block lives on the
vfat ESP, which GRUB cannot reliably write, so the automatic one-shot fall-back is not dependable
here. Prefer a permanent, always-present entry like the one above (it survives kernel updates
because `/etc/grub.d/` is regenerated), and select it deliberately. Confirm on the host which
environment block GRUB actually reads before relying on `grub-reboot`:

```bash
proxmox-boot-tool status
grub-editenv /boot/grub/grubenv list
```

(On a `proxmox-boot-tool` host the environment block GRUB actually consults at boot is the copy on
the mounted ESP, not `/boot/grub/grubenv`, so treat this as a read-only sanity check rather than the
file to write.)

Searching by label (`--label RESCUE`), rather than a fixed disk like `(hd0,gpt3)`, keeps the entry
working even if disks are reordered or a data disk is wiped.

## Optional: the golden-image alternative

Instead of running the installer, you can restore a bit-for-bit image of a known-good host. Capture
the whole disk once, from a RAM rescue environment so the disk is not mounted, and store it off the
box:

```bash
dd if=/dev/nvme0n1 bs=64M status=progress \
  | zstd -T0 -19 | ssh you@backup-host 'cat > /backups/pve-golden.img.zst'
```

To restore, boot a RAM rescue environment (the same kexec-into-RAM idea), then write the image back.
Before you run the `dd`, identify the target disk: this overwrites the whole disk irreversibly, and
you must aim it at the internal NVMe, not the attached backup USB HDD you are reading the image
from. List the disks and confirm by model and serial:

```bash
lsblk -dno NAME,TRAN,SIZE,MODEL,SERIAL
ls -l /dev/disk/by-id/nvme-*
```

`/dev/nvme0n1` below is a placeholder; confirm it is your internal NVMe by its model and serial, and
prefer the stable `/dev/disk/by-id/nvme-...` name if you have it. Double-check the direction too;
`of=` is the disk you overwrite:

```bash
ssh you@backup-host 'cat /backups/pve-golden.img.zst' \
  | zstd -d -T0 | dd of=/dev/nvme0n1 bs=64M status=progress
sync
```

If you restore a smaller image onto the same or a larger disk, fix the GPT and grow the root
afterward:

```bash
sgdisk -e /dev/nvme0n1
partprobe /dev/nvme0n1
growpart /dev/nvme0n1 3
partprobe /dev/nvme0n1
mount /dev/nvme0n1p3 /mnt
btrfs filesystem resize max /mnt
umount /mnt
```

Because you are restoring onto the same machine's only disk, keep the original UUIDs (do not
regenerate them): `/etc/fstab`, the GRUB config, and `proxmox-boot-tool`'s recorded ESP UUIDs all
depend on them. Confirm the bootloader afterward with `proxmox-boot-tool status`.

The trade-off: a golden image is fully deterministic and carries your entire configuration, so it
restores an instantly working host, but it goes stale as packages and kernels move on, and the
restore has more moving parts (GPT fix, grow, possible boot re-enrolment). Running the installer is
always current and ends in a clean supported state, but leaves a bare host to reconfigure (or drives
it with the answer file). Keeping both is reasonable: the installer escape hatch as the robust
primary, and a golden image (refreshed after each major upgrade) for a fast exact-configuration
restore.

## Verify it worked

After a reinstall (in the rehearsal VM first, then the real host), confirm purely over text:

```bash
nc -vz <host> 22
ssh root@<host> pveversion
ssh root@<host> pveversion -v
ssh root@<host> 'systemctl is-system-running'
```

The port answers, `pveversion` returns a version string, `pveversion -v` shows a complete and
consistent set of `pve-*` components (proof the install finished cleanly), and
`systemctl is-system-running` returns `running` (a `degraded` result is acceptable only if you can
explain each failed unit). If you wired a serial console in the rehearsal VM, a `login:` prompt on
`qm terminal` is the same confirmation by another channel.

For the escape hatch, these two commands confirm only that the menu entry exists and that the
bootloader is synced onto the ESP -- not that selecting it actually boots the installer:

```bash
grep -A7 'pve-installer' /etc/grub.d/40_custom
proxmox-boot-tool status
```

To prove it really boots, exercise it once in the rehearsal VM: at the GRUB menu over `qm terminal`,
select the "Proxmox installer (RAM, serial)" entry by hand and watch it come up. That is the only
check that proves the entry is bootable, not merely present.

## Sources

- Proxmox VE wiki: [Automated Installation](https://pve.proxmox.com/wiki/Automated_Installation)
  (the `answer.toml` schema, `proxmox-auto-install-assistant` subcommands and `--fetch-from` modes,
  the HTTP/DHCP/DNS answer-fetch mechanisms) and the
  [Installing Proxmox VE](https://pve.proxmox.com/pve-docs/chapter-pve-installation.html) chapter
  (the Terminal-UI and serial-console installer boot entries, and that the whole selected disk is
  wiped).
- Proxmox VE wiki: [Host Bootloader](https://pve.proxmox.com/wiki/Host_Bootloader)
  (`proxmox-boot-tool`, GRUB versus systemd-boot by root filesystem, the partition layout and 512 MB
  ESP) and [Nested Virtualization](https://pve.proxmox.com/wiki/Nested_Virtualization) and
  [Serial Terminal](https://pve.proxmox.com/wiki/Serial_Terminal) for the rehearsal VM.
- kexec and lockdown: the [kexec(8)](https://man7.org/linux/man-pages/man8/kexec.8.html) and
  [kexec_load(2)](https://man7.org/linux/man-pages/man2/kexec_load.2.html) man pages,
  [kernel_lockdown(7)](https://man7.org/linux/man-pages/man7/kernel_lockdown.7.html), and the LWN
  write-up [Kernel lockdown](https://lwn.net/Articles/750730/) for why Secure Boot blocks the
  classic `kexec_load` syscall.
- The USB one-time boot route: the
  [efibootmgr README](https://github.com/rhboot/efibootmgr/blob/main/README.md) and
  [efibootmgr(8)](https://www.mankier.com/8/efibootmgr) for `BootNext`, `--create`, and
  `--bootorder`; the [UEFI specification](https://uefi.org/specs/UEFI/2.10/03_Boot_Manager.html)
  Boot Manager chapter for `BootNext` being a one-shot the firmware deletes itself; and the Proxmox
  [Secure Boot Setup](https://pve.proxmox.com/wiki/Secure_Boot_Setup) wiki for the installer being
  Secure Boot signed since PVE 8.1.
- Running entirely in RAM: the kernel.org
  [ramfs/rootfs/initramfs](https://docs.kernel.org/filesystems/ramfs-rootfs-initramfs.html)
  documentation (how an initramfs runs from RAM with no backing disk). Note this installer loads to
  RAM via its `ramdisk_size` boot parameter and the initrd itself, not via Debian live-boot's
  `toram`; it has no `toram`/`copytoram` option.
- Community tooling and technique (clearly not official, and the reason the rehearsal is mandatory):
  [`morph027/pve-iso-2-pxe`](https://github.com/morph027/pve-iso-2-pxe) for embedding the ISO in the
  initrd and the `ramdisk_size` boot parameter, and the Proxmox forum thread
  [kexec in Proxmox](https://forum.proxmox.com/threads/kexec-in-proxmox.5856/).
- The supported "install on Debian instead" alternative, if you would rather kexec the Debian
  netinstaller and add Proxmox on top:
  [Install Proxmox VE on Debian 13 Trixie](https://pve.proxmox.com/wiki/Install_Proxmox_VE_on_Debian_13_Trixie).
- GPT and resize tooling: [sgdisk(8)](https://manpages.debian.org/bookworm/gdisk/sgdisk.8.en.html),
  [growpart(1)](https://manpages.debian.org/testing/cloud-guest-utils/growpart.1.en.html), and the
  btrfs [filesystem resize](https://btrfs.readthedocs.io/en/latest/btrfs-filesystem.html) docs.
- Related guides: [01 -- Install Proxmox VE 9 unattended](01-install-proxmox-unattended.md) (the
  `answer.toml` you reuse here),
  [03 -- Repositories, updates, and the host](03-repositories-updates-and-the-host.md) (the host
  serial console and `proxmox-boot-tool`), and
  [18 -- The independent copy and restore](18-the-independent-copy-and-restore.md) (back up and
  prove your restores before you ever wipe the host).

---

Previous: [19 -- Applied recipes overview](19-recipes-overview.md) | Next:
[21 -- Passing host hardware to guests](21-passing-host-hardware-to-guests.md)
