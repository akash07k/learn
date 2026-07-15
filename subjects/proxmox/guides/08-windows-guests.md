# Windows guests

## What you'll be able to do

By the end of this guide you will have a running Windows 11 VM that you built entirely from the
shell: installed hands-off through an `autounattend.xml` answer file (no graphical installer to
drive), reachable over RDP with NVDA already speaking inside the guest, and with an EMS/SAC serial
console wired up as a boot-and-recovery lifeline. No Proxmox web GUI, no noVNC, and no SPICE for
daily use; SPICE appears only as the attended-install fallback documented below. The daily desktop
path is RDP plus an in-guest screen reader; the serial console is for diagnosis only.

## Before you start

Some of what follows is specific to Proxmox VE 9, so confirm your version first:

```bash
pveversion
```

You should see a `9.x` release. Two steps in this guide are genuinely version-sensitive. First,
snapshots of a VM that has a vTPM: on this btrfs node they already work on any 9.x, but Proxmox VE
9.1 widens where vTPM snapshots are possible (qcow2 vTPM state on file storage, NFS/CIFS, and
offline LVM-chain), and 9.2 adds live snapshots on volume-chain storages with the caveat that the
top-most snapshot still cannot be removed while the VM is running. Second, Secure Boot certificate
enrollment: current PVE 9.2 EFI disks should show the Microsoft 2023 certificate marker
`ms-cert=2023k`; older EFI disks may need `qm enroll-efi-keys` while the VM is shut down.

You supply two things yourself: your own official Microsoft Windows 11 ISO, and a valid Windows 11
license key. This guide does not provide either.

You will need three pieces of media on the host before you build the VM:

- The Windows 11 ISO (from Microsoft).
- The `virtio-win.iso` (the paravirtualized Windows drivers; see "Get the media").
- A small `autounattend.xml` answer disk (a tiny ISO holding the answer file and the first-boot
  scripts).

This guide builds directly on guide 06 ("Virtual machines with qm"). The shared `qm` machinery (OVMF
and the `efidisk0`, `virtio-scsi-single`, the guest agent, snapshots, clones, disk import,
downloading ISOs with the storage `download-url` API) is taught there and not repeated here. Read
guide 06 first if you have not.

## Why Windows is different

Be honest with yourself up front: a Windows desktop CANNOT be driven over the serial console the way
a Linux guest can. A Linux VM puts a full login shell on `ttyS0`, so guide 06 routes the whole
machine to serial and you drive even the installer as text. Windows does not do this. Windows over
serial gives you only SAC, a limited recovery console (covered later), never a usable desktop and
never the graphical installer.

So the accessible model for Windows is fundamentally different:

- Install Windows 11 fully unattended via `autounattend.xml`. The graphical installer still runs,
  but you never touch it: there is nothing to see and nothing to do.
- The answer file and first-boot scripts auto-enable RDP and its firewall rule, install the VirtIO
  guest tools, and silently install NVDA, so the desktop is reachable with speech the first time it
  boots.
- Daily use: RDP from the control station with `mstsc`, with NVDA speaking inside the guest.
- Diagnosis only: SAC over `qm terminal`, for boot and recovery when the desktop or network is dead.

State the single biggest trap now, because it is the one thing most likely to break this build if
you copy the Linux pattern from guide 06. Guide 06's Linux VMs use `--vga serial0`, which makes the
serial line the primary display. A Windows VM must NOT do that. A Windows VM uses `--vga std` (a
real emulated display, which the desktop and RDP need) WITH `--serial0 socket` as an ADDITIONAL
channel. On Windows, serial is an extra channel, not the display. If you set `--vga serial0` on
Windows you cripple the display the desktop and RDP depend on. So a Windows VM has BOTH `vga: std`
and `serial0: socket`. This is the most important Windows-versus-Linux distinction in the whole
guide.

## Get the media

You need three images on a Proxmox storage that carries the `iso` content type. On this btrfs node
that is the active `local-btrfs` storage (the plain `local` directory storage is disabled, per guide
09); its iso directory is on disk at `/var/lib/pve/local-btrfs/template/iso/`. Guide 06 covers
fetching ISOs with the storage `download-url` API and listing them with
`pvesm list local-btrfs --content iso`.

The Windows 11 ISO. Download the official image from Microsoft's
[Windows 11 download page](https://www.microsoft.com/software-download/windows11) on the control
station, then place it on the host's iso storage (copy it across with `scp`, or fetch it on the host
with `curl` into `/var/lib/pve/local-btrfs/template/iso/`). Use your own genuine ISO and license
key.

The `virtio-win.iso`. Windows Setup ships with no virtio-scsi and no virtio-net driver, so without
these drivers the installer sees no disk to install onto and no network. The canonical upstream that
Proxmox points to is the Fedora-hosted build. Download the always-latest stable ISO straight into
the host's iso storage with the storage `download-url` API (run on the host):

```bash
pvesh create /nodes/$(hostname)/storage/local-btrfs/download-url \
 --content iso --filename virtio-win.iso \
 --url https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso
```

If you would rather pin a known-good build, the
[versioned archive](https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/archive-virtio/)
holds the 0.1.2xx series. The Proxmox
[Windows VirtIO Drivers wiki](https://pve.proxmox.com/wiki/Windows_VirtIO_Drivers) sometimes
recommends a specific version when a newer one has a regression, so check it.

The `autounattend.xml` answer disk. You author the answer file (and the first-boot scripts) on the
control station, then build a small ISO that holds `Autounattend.xml` at its root plus an `$OEM$`
tree and your NVDA installer. The answer file is a plain-text XML file, so author it accessibly the
same way you author any config file: see guide 02's "Editing files accessibly" (VS Code Remote-SSH,
or shell-only methods). The fastest way to produce a correct, schema-valid answer file without
Windows SIM is the open
[Schneegans unattend generator](https://schneegans.de/windows/unattend-generator/), which has
checkboxes for "enable RDP", local account, autologon, and a custom first-logon script. It is a
tool, not a primary source, so validate the emitted XML against the Microsoft component docs.

## Create the Windows 11 VM

Windows 11 has mandatory hardware requirements: UEFI plus Secure Boot plus a TPM 2.0. You satisfy
them with real virtual devices, so no registry bypass is needed (more on that under "The
autounattend.xml answer file"). The Proxmox
[Windows 11 guest best practices](https://pve.proxmox.com/wiki/Windows_11_guest_best_practices) wiki
prescribes: guest OS type Windows 11, the guest agent enabled, OVMF (UEFI) firmware with an EFI
disk, a vTPM, the q35 machine type, the disk on the SCSI bus with the virtio-scsi-single controller,
IO thread and discard enabled, and a virtio NIC.

The shared pieces (OVMF and the `efidisk0`, `virtio-scsi-single`, the guest agent, the
`iothread=1,discard=on,ssd=1` disk line) are explained in guide 06; do not re-derive them here. What
is new and Windows-specific is the `ostype: win11`, the vTPM, the pinned machine version, and above
all the display wiring.

### Create the VM shell

Note `--vga std` (NOT `--vga serial0`) plus `--serial0 socket` as the additional EMS/SAC channel:

```bash
VMID=9300

qm create $VMID \
 --name win11-desktop --ostype win11 \
 --machine q35 --bios ovmf \
 --cores 4 --sockets 1 --cpu host \
 --memory 8192 --balloon 0 \
 --scsihw virtio-scsi-single \
 --net0 virtio,bridge=vmbr0 \
 --agent enabled=1 \
 --vga std \
 --serial0 socket
```

Say this plainly, because it is the trap: on Windows the display is `--vga std` and serial is the
EXTRA channel `--serial0 socket`. Guide 06's Linux VMs use `--vga serial0` (serial as the primary
display); a Windows VM must not, or the desktop and RDP lose the display adapter they need. The
Windows VM keeps BOTH `vga: std` and `serial0: socket`.

A note on the options that differ from guide 06:

- `--ostype win11` applies Windows-specific hardware tuning and the default Hyper-V enlightenments
  KVM uses for Windows guests.
- `--cpu host` is right on a single node with no live migration; Windows is sensitive to CPU-model
  churn, and `host` is stable on one fixed node. Do not hand-add `hidden=1` or `hv-vendor-id` tweaks
  for plain Win11 unless you hit a specific problem.
- `--balloon 0` disables ballooning. On Windows, ballooning only reclaims memory if the balloon
  driver and its service (from the guest tools) are installed; many operators set `balloon: 0` on
  Windows for predictable memory. If you want ballooning, install the balloon service and leave a
  conservative `balloon` floor instead.

### Add the EFI disk and vTPM

Add the EFI variables disk (Secure Boot, with Microsoft's keys pre-enrolled so the signed Windows
bootloader is trusted out of the box) and the vTPM. Windows 11 requires a TPM 2.0, so the vTPM uses
`version=v2.0`:

```bash
qm set $VMID --efidisk0 local-btrfs:1,efitype=4m,pre-enrolled-keys=1
qm set $VMID --tpmstate0 local-btrfs:1,version=v2.0
```

The `efitype=4m` variant is mandatory for Secure Boot (`2m` is legacy and not Secure-Boot-capable).
On current PVE 9.2 packages, newly created pre-enrolled EFI disks include the 2011 and 2023
Microsoft UEFI certificates and are marked `ms-cert=2023k` in the VM config. If an older Windows VM
starts warning about missing Microsoft certificate enrollment, shut it down and run
`qm enroll-efi-keys <vmid>` before relying on Secure Boot with newer Windows bootloaders. If
BitLocker is enabled later, suspend BitLocker protectors first or you may be asked for the recovery
key on the next boot.

The vTPM `version` is fixed at create time and cannot be changed to or from v1.2 later; use `v2.0`
for Win11 because `v1.2` does not satisfy its TPM 2.0 requirement. On this `local-btrfs` target you
do not choose a TPM state format manually. PVE 9.1+ can also store TPM state as qcow2 on supported
file-level storages, which is what widens vTPM snapshot support beyond native snapshot-capable
storage.

### Add the OS disk

Add the OS disk on btrfs, with iothread and discard. The wiki recommends cache "Write back" for
Windows performance, so this disk uses `cache=writeback` (the raw default `cache=none` is also safe;
writeback trades a little safety for speed). Give Win11 at least about 64 GiB:

```bash
qm set $VMID --scsi0 local-btrfs:64,iothread=1,discard=on,ssd=1,cache=writeback
```

### The full VM config

A full example config follows. This is what `/etc/pve/qemu-server/9300.conf` looks like for the
Windows 11 VM above. Note the contrast with guide 06's Linux example: there it was `vga: serial0`
(serial as primary display); here it is `vga: std` PLUS `serial0: socket` (a real display for RDP,
serial as the extra EMS/SAC channel). Note too that the `machine` version is PINNED (`pc-q35-11.0`)
for Windows.

File `/etc/pve/qemu-server/9300.conf`:

```ini
agent: enabled=1
balloon: 0
bios: ovmf
boot: order=scsi0
cores: 4
cpu: host
efidisk0: local-btrfs:9300/vm-9300-disk-0.raw,efitype=4m,ms-cert=2023k,pre-enrolled-keys=1,size=528K
machine: pc-q35-11.0+pve1
memory: 8192
name: win11-desktop
net0: virtio=BC:24:11:DE:AD:BE,bridge=vmbr0
numa: 0
ostype: win11
scsihw: virtio-scsi-single
scsi0: local-btrfs:9300/vm-9300-disk-2.raw,iothread=1,discard=on,ssd=1,cache=writeback,size=64G
serial0: socket
sockets: 1
tpmstate0: local-btrfs:9300/vm-9300-disk-1.raw,size=4M,version=v2.0
vga: std
vmgenid: a1b2c3d4-0000-0000-0000-000000000001
```

For Windows, PVE pins the machine version (here `pc-q35-11.0+pve1`) at create time and keeps it
stable across host upgrades, because Windows reacts badly to its virtual chipset changing underneath
it (it can force driver re-enumeration or even reactivation). The base number tracks the QEMU
version current when you created the VM, not the PVE version: PVE 9.2 ships QEMU 11.0, so a Windows
VM created on it pins `pc-q35-11.0` (an earlier PVE 9 point release on QEMU 10.x would pin
`pc-q35-10.x`). PVE then appends its own downstream hardware revision, `+pveN`, which is why the
config above reads `pc-q35-11.0+pve1`; that suffix is set for you and bumps only when Proxmox
changes a machine default. The exact value does not matter; what matters is that it is pinned and
you do not change it casually. Linux guests track `latest`; Windows stays pinned. Read the
[QEMU Machine Version Upgrade wiki](https://pve.proxmox.com/wiki/QEMU_Machine_Version_Upgrade)
before changing it.

### Building without Secure Boot

The build above turns Secure Boot on, which is the recommended default. If you specifically need
Secure Boot off (to boot an unsigned bootloader, load unsigned drivers, or dual-boot another OS),
you can build Windows 11 without it. Microsoft's requirement is "UEFI, Secure Boot capable", and for
a VM "Secure boot capable, virtual TPM enabled" -- capable, not enabled (see
[Windows 11 requirements](https://learn.microsoft.com/en-us/windows/whats-new/windows-11-requirements)).
The `efitype=4m` OVMF firmware is Secure-Boot-capable and the vTPM satisfies the TPM 2.0 rule, so
Windows 11 still installs with Secure Boot inactive and no `LabConfig` registry bypass.

Create the EFI disk with `pre-enrolled-keys=0` instead of `1`, and leave everything else (including
`efitype=4m` and the vTPM) unchanged:

```bash
qm set $VMID --efidisk0 local-btrfs:1,efitype=4m,pre-enrolled-keys=0
qm set $VMID --tpmstate0 local-btrfs:1,version=v2.0
```

With no keys enrolled the firmware is in Secure Boot "setup mode": it does not enforce signatures,
so Secure Boot is effectively off, but the firmware is still Secure-Boot-capable, which is what the
Windows 11 check wants. Understand the tradeoff before choosing this: Secure Boot off removes the
boot-chain tamper protection, so keep it on unless you have a concrete reason not to.

You can turn Secure Boot on later without rebuilding: shut the VM down and run
`qm enroll-efi-keys <vmid>` to enroll Microsoft's keys into the existing EFI disk. Going the other
way (on to off) means clearing the keys from inside the OVMF setup menu or recreating the EFI disk.

### Enabling memory ballooning

The create command above set `--balloon 0`, which disables ballooning for predictable memory. If you
want the host to reclaim idle guest memory under pressure instead, enable it in two places: the VM
config and the guest.

First, set a balloon floor on the VM (a value greater than 0 and at most `memory`). With
`memory: 8192` and a 4 GB floor, the guest boots seeing 8 GB and the host may reclaim down toward 4
GB when it is under memory pressure:

```bash
qm set $VMID --balloon 4096
```

Second, the guest needs the VirtIO Balloon driver AND the balloon service running, or the config
change does nothing and Windows can misreport its RAM. Both are installed by the VirtIO guest tools
(`virtio-win-gt-x64.msi`), which the first-boot bootstrap already runs, so a VM built that way needs
nothing more. If you installed the driver by hand, register the service from an elevated prompt in
the guest using the `blnsvr.exe` the tools placed under `C:\Program Files\Virtio-Win\` (the exact
subfolder depends on the build):

```powershell
& "C:\Program Files\Virtio-Win\Balloon\blnsvr.exe" -i
```

Verify from the host that the balloon device is live:

```bash
qm status $VMID --verbose
```

Once the driver and service are running the output includes a `ballooninfo` block with live guest
memory stats; without them `ballooninfo` is absent and the reported `balloon` size never moves. On a
Linux guest none of this applies: the `virtio_balloon` module is in the kernel and loads
automatically, so setting the floor is all it takes (guide 06 covers the Linux side).

## Attach the install media

Attach three CD-ROMs: the Windows ISO, the `virtio-win.iso` as a SECOND CD-ROM (so Setup can load
the `vioscsi` storage driver it needs to see the virtio-scsi disk), and the `autounattend.xml`
answer media. The virtio and answer ISOs go on a virtual SATA bus, which the installer can read with
its in-box AHCI/IDE driver. Note that `ide2`, `sata0`, and `sata1` are controllers EMULATED inside
the VM; they have nothing to do with your host's physical disk, which stays on `local-btrfs` (your
NVMe SSD) either way. The ISOs ride SATA/IDE only because Windows Setup already has a driver for
those emulated buses, but none for virtio-scsi until you load it.

```bash
qm set $VMID --ide2 local-btrfs:iso/win11.iso,media=cdrom
qm set $VMID --sata0 local-btrfs:iso/virtio-win.iso,media=cdrom
qm set $VMID --sata1 local-btrfs:iso/autounattend.iso,media=cdrom
```

Set the boot order to start from the Windows ISO, but keep the disk in the order as a fallback:

```bash
qm set $VMID --boot 'order=ide2;scsi0'
```

The disk (`scsi0`) must be in the boot order during the install, not just the CD. Windows Setup
reboots itself one or more times partway through, while the ISO is still attached. If the CD were
the only boot entry, each of those self-reboots would return to the firmware with nothing to boot
but the installer again, and on a headless host that is a silent loop you cannot see or interrupt.
With `scsi0` second in the order, the self-reboots land on the half-installed disk and Setup
continues. (Quote the whole `order=...` value: the `;` is a command separator in both the shell and
PowerShell, so an unquoted form would be split.)

Windows Setup searches for an answer file at the start of each configuration pass. Removable media
holding `Autounattend.xml` at its root is one of the implicit search locations, so a small CD-ROM
with `Autounattend.xml` at the root is picked up automatically with no `setup.exe` arguments. To
save a CD slot you may put `Autounattend.xml` plus the `$OEM$` tree at the root of a re-mastered
copy of the `virtio-win.iso`, so two ISOs (Windows plus a combined virtio-and-answer ISO) is the
common minimal setup.

## The autounattend.xml answer file

The answer file is organized into configuration passes. For this accessible flow you populate three:

- windowsPE (`Microsoft-Windows-Setup`): configure the disk (wipe and create the EFI, MSR, and
  Windows partitions for a UEFI/GPT layout), LOAD the virtio storage driver (via a
  `Microsoft-Windows-PnpCustomizationsWinPE` `DriverPaths` entry pointing at the virtio CD's
  `vioscsi\w11\amd64`, so Setup can address the virtio-scsi disk with zero interaction), select the
  image, accept the EULA, and provide the product key. The product key also selects the Win11
  edition and skips the "which edition" prompt.
- specialize: set the computer name (`Microsoft-Windows-Shell-Setup`), enable RDP (through the
  `TerminalServices` components, not Shell-Setup), and set the `BypassNRO` registry flag so the
  local-account path is offered even on recent 24H2 builds.
- oobeSystem (`Microsoft-Windows-Shell-Setup`): create the local user account, configure AutoLogon
  (so first boot lands logged in without a visible prompt), and hide the OOBE privacy/region/network
  screens.

You author this file accessibly on the control station; see guide 02's "Editing files accessibly".
The skeleton below is representative and ELIDED. Placeholders are in angle brackets, and `...` marks
omitted attributes and blocks. Do not treat it as a complete file: generate the real one with the
Schneegans generator or Windows SIM and validate it.

File `Autounattend.xml` (at the root of the answer media):

```xml
<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">

 <settings pass="windowsPE">
 <!-- Load the VirtIO SCSI driver so Setup can see the disk -->
 <component name="Microsoft-Windows-PnpCustomizationsWinPE" processorArchitecture="amd64" ...>
 <DriverPaths>
 <PathAndCredentials wcm:keyValue="1" wcm:action="add">
 <Path>E:\vioscsi\w11\amd64</Path> <!-- virtio-win CD -->
 </PathAndCredentials>
 </DriverPaths>
 </component>

 <component name="Microsoft-Windows-Setup" processorArchitecture="amd64" ...>
 <DiskConfiguration>
 <!-- wipe + create EFI System + MSR + Windows partitions (GPT/UEFI) -->
 <Disk wcm:action="add"> ... <CreatePartitions> ... </CreatePartitions> ... </Disk>
 </DiskConfiguration>
 <ImageInstall>
 <OSImage>
 <InstallFrom><MetaData wcm:action="add">
 <Key>/IMAGE/INDEX</Key><Value>6</Value> <!-- e.g. Win11 Pro -->
 </MetaData></InstallFrom>
 <InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo>
 </OSImage>
 </ImageInstall>
 <UserData>
 <ProductKey><Key><PRODUCT-KEY></Key></ProductKey>
 <AcceptEula>true</AcceptEula>
 </UserData>
 </component>
 </settings>

 <settings pass="specialize">
 <component name="Microsoft-Windows-Shell-Setup" ...>
 <ComputerName>WIN11LAB</ComputerName>
 </component>
 <!-- Force the local-account path on recent 24H2 builds (belt and braces with the
 HideOnlineAccountScreens / LocalAccounts settings in oobeSystem below) -->
 <component name="Microsoft-Windows-Deployment" processorArchitecture="amd64" ...>
 <RunSynchronous>
 <RunSynchronousCommand wcm:action="add">
 <Order>1</Order>
 <Path>reg add HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\OOBE /v BypassNRO /t REG_DWORD /d 1 /f</Path>
 </RunSynchronousCommand>
 </RunSynchronous>
 </component>
 <!-- Enable RDP declaratively -->
 <component name="Microsoft-Windows-TerminalServices-LocalSessionManager" ...>
 <fDenyTSConnections>false</fDenyTSConnections>
 </component>
 <component name="Microsoft-Windows-TerminalServices-RDP-WinStationExtensions" ...>
 <UserAuthentication>1</UserAuthentication>
 </component>
 </settings>

 <settings pass="oobeSystem">
 <component name="Microsoft-Windows-Shell-Setup" ...>
 <UserAccounts>
 <LocalAccounts><LocalAccount wcm:action="add">
 <Name><USERNAME></Name><Group>Administrators</Group>
 <Password><Value><PASSWORD></Value><PlainText>true</PlainText></Password>
 </LocalAccount></LocalAccounts>
 </UserAccounts>
 <AutoLogon>
 <Enabled>true</Enabled><Username><USERNAME></Username>
 <Password><Value><PASSWORD></Value><PlainText>true</PlainText></Password>
 <LogonCount>1</LogonCount>
 </AutoLogon>
 <OOBE>
 <HideEULAPage>true</HideEULAPage>
 <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
 <ProtectYourPC>3</ProtectYourPC>
 </OOBE>
 </component>
 </settings>

</unattend>
```

### The cleartext admin password

A note on that password: `PlainText=true` stores the account password as cleartext in the answer
file (the base64 `PlainText=false` form is only obfuscation, not encryption). That answer file lives
on the install media you built and on your control station, so once setup finishes: destroy or
securely wipe the answer media and any local copy, and change the admin password after the first
logon. Windows cleans the cached copy it writes to `C:\Windows\Panther`, but it does not touch your
source media.

### Enabling RDP from the answer file

Enabling RDP is the load-bearing accessibility step. The declarative toggle in specialize
(`fDenyTSConnections = false`, and `UserAuthentication = 1` to keep Network Level Authentication on)
sets the registry, but the firewall rule still has to be opened. Keep NLA on: it forces the client
to authenticate before a full RDP session and desktop are created, the main mitigation against
pre-auth RDP attacks, and every modern `mstsc`/Remote Desktop client supports it, so it is not a
connectivity obstacle. Only if an old client during early bring-up cannot connect should you
temporarily set `UserAuthentication = 0`, and then revert it once you are in; an NLA-disabled
endpoint must never be reachable beyond the trusted LAN or tailnet (guide
[12 -- Remote access](12-remote-access.md) covers how services get exposed). The most robust
approach is to do BOTH the registry toggle and the firewall rule as commands, in `SetupComplete.cmd`
(which runs as SYSTEM before any logon, covered next), so RDP is ready the moment the desktop
appears:

```cmd
reg add "HKLM\System\CurrentControlSet\Control\Terminal Server" /v fDenyTSConnections /t REG_DWORD /d 0 /f
netsh advfirewall firewall set rule group="remote desktop" new enable=Yes
```

(If your answer-file generator emits a `FirstLogonCommands` block instead, that is an equally valid
place for these two lines; `SetupComplete.cmd` is used here because it also installs the drivers and
NVDA in the same script.)

RDP is not reachable DURING the OOBE phase; it only works once OOBE has completed and the account
exists. With AutoLogon configured, OOBE completes automatically on first boot, so RDP comes up
shortly after.

### You do not need a hardware-check bypass

You do NOT need a Win11 hardware-check bypass. Because the VM has a real vTPM v2.0, Secure Boot with
pre-enrolled keys, and UEFI, Windows 11's TPM, Secure Boot, and RAM checks pass natively. The
`LabConfig` registry bypass exists and the generators offer it, but on a correctly-built PVE Win11
VM it is unnecessary. (You would only need it if you undersized RAM below 4 GB or skipped the vTPM.)

## The full build in one block

The sections above explain each command; this gathers the default unattended build into one
copy-paste sequence for the recommended path (an `autounattend.xml` answer disk, `vga std`, and RDP
afterward). It configures the VM but does NOT start it; you start it in the last step below, after
applying any of the variations. It assumes the ISOs are already on the `local-btrfs` iso storage
(see "Get the media") and that you have built the `autounattend.iso` answer disk (see "The
autounattend.xml answer file"). Adjust the id, ISO filenames, core count, and disk size to taste:

```bash
VMID=9300

# 1. VM shell. Windows uses vga std with serial0 as an EXTRA channel, never vga serial0.
qm create $VMID \
 --name win11-desktop --ostype win11 \
 --machine q35 --bios ovmf \
 --cores 4 --sockets 1 --cpu host \
 --memory 8192 --balloon 0 \
 --scsihw virtio-scsi-single \
 --net0 virtio,bridge=vmbr0 \
 --agent enabled=1 \
 --vga std \
 --serial0 socket

# 2. Firmware: EFI variables disk (Secure Boot on) and a vTPM 2.0.
qm set $VMID --efidisk0 local-btrfs:1,efitype=4m,pre-enrolled-keys=1
qm set $VMID --tpmstate0 local-btrfs:1,version=v2.0

# 3. OS disk on the VirtIO SCSI bus (64 GiB, iothread + discard, writeback cache).
qm set $VMID --scsi0 local-btrfs:64,iothread=1,discard=on,ssd=1,cache=writeback

# 4. Install media: Windows ISO on ide2; virtio-win and the answer disk on SATA.
qm set $VMID --ide2 local-btrfs:iso/win11.iso,media=cdrom
qm set $VMID --sata0 local-btrfs:iso/virtio-win.iso,media=cdrom
qm set $VMID --sata1 local-btrfs:iso/autounattend.iso,media=cdrom

# 5. Boot order: CD first, disk second (the disk must stay listed for Setup's self-reboots).
qm set $VMID --boot 'order=ide2;scsi0'
```

Apply any of these variations BEFORE you start the VM (none of them is hotpluggable); each is
explained in full in the section named:

- Secure Boot off: use `pre-enrolled-keys=0` on the `efidisk0` line (see "Building without Secure
  Boot").
- Memory ballooning: replace `--balloon 0` with a floor such as `--balloon 4096`, and install the
  guest balloon service (see "Enabling memory ballooning").
- A fixed IP address: unlike an LXC container's `pct create --net0 ...,ip=...,gw=...`, a VM's
  `--net0` has no guest-IP option (Proxmox cannot set a full guest OS's network stack from outside),
  so give the guest a static address inside Windows or a DHCP reservation (see "Give the guest a
  fixed address"). The Linux equivalent is cloud-init's `ipconfig0` in guide 07.
- Fully attended, no answer file: omit the `--sata1 ... autounattend.iso` line so nothing drives
  Setup, and step through the installer yourself by ear over the SPICE console (next).

To watch the install over the SPICE console with Narrator, give the VM a SPICE display and audio and
grant the console token its ACL (this too must be applied before starting). It works with EITHER the
unattended block above or the attended variant: the answer disk decides whether Setup runs itself,
while the SPICE display and audio only let you see and hear it. Create the `spice@pve` user and
token first (see "Attended install over the SPICE console"):

```bash
# Use the SPICE display and audio for the install, instead of --vga std:
qm set $VMID --vga qxl
qm set $VMID --audio0 device=ich9-intel-hda,driver=spice

# Let the console token reach THIS VM (one-time; needs the spice@pve user + token):
pveum acl modify /vms/$VMID --users 'spice@pve' --roles PVEVMUser
pveum acl modify /vms/$VMID --tokens 'spice@pve!console' --roles PVEVMUser
```

With the config and any variations in place, start the unattended install:

```bash
qm start $VMID
```

If you set up the SPICE display above, open the console from the control station with
`spice-connect.bat` and start Narrator; it speaks in the Windows installer whether or not an answer
file is driving it, so you can follow an unattended install by ear. After the install, switch the
display back for the RDP path. A `vga` (or `audio0`) change is not hotpluggable: it only takes
effect on the next cold start, so shut the VM down first, then start it again before connecting over
RDP:

```bash
qm shutdown $VMID
qm set $VMID --vga std
# The audio0 device is harmless to leave; remove it with: qm set $VMID --delete audio0
qm start $VMID
```

Once Windows reaches the desktop, ask the guest agent for the VM's address from the host (the guest
tools install the QEMU agent on first logon, and `--agent enabled=1` is already set above), then
connect over RDP with NVDA speaking inside the guest (see "Connect over RDP" for the full path):

```bash
qm agent $VMID network-get-interfaces
```

Pick the IPv4 address on the `vmbr0` subnet from the JSON (skip loopback and link-local), then from
the control station run `mstsc /v:<guest-ip>`. If the command errors that the agent is not running,
the first-logon guest-tools install has not finished yet; wait and retry, or pin the address with a
DHCP reservation (see "Give the guest a fixed address").

## Attended install over the SPICE console (no answer file)

This section documents the fallback to the `autounattend.xml` path above. Use it when you do not
have an answer file, cannot get one right, or want a one-off install without the automation
overhead. It is the install-time sibling of the RDP-plus-NVDA daily path (see the RDP sections below
and [ADR-0005](../docs/adr/0005-interactive-install-over-spice.md)): a graphical console you drive
by ear, not by eye. `autounattend.xml` stays the recommended default; this is the escape hatch.

The SPICE console -- unlike noVNC -- carries the guest's audio to `remote-viewer` on your control
station. You start Windows Narrator inside Setup; it speaks to you over that audio channel while
your keystrokes go to the guest. The whole Windows graphical installer becomes audible without any
sighted assistance.

The sub-steps below are ordered so you can follow them strictly top to bottom: configure the display
and audio, handle the storage driver, set the boot order, start the VM, set up the client once
(token, fingerprint, ports), fetch and connect, drive the installer by ear with Narrator, then
restore the daily RDP display afterward. The `qm` commands here reuse the `VMID=9300` shell variable
you set when you created the VM; if your shell session has changed since then, run `VMID=9300` again
first.

### Configure the VM display and audio for the install

Set the display adapter to `qxl` and attach a SPICE audio device:

```bash
qm set $VMID --vga qxl
qm set $VMID --audio0 device=ich9-intel-hda,driver=spice
```

Without an audio device the install is silent. The audio path requires `qxl`; a `std` or `serial0`
display will not carry sound. If the VM fails to start after these changes, try the fallback audio
device:

```bash
qm set $VMID --audio0 device=intel-hda,driver=spice
```

After the install completes you switch back to `std` for the RDP path (covered in "After the
install" below).

### Storage-driver caveat

Windows Setup cannot see a VirtIO SCSI or VirtIO block disk without its driver loaded. The
recommended path for this by-ear install is to load the driver during Setup; the SATA bus-swap is a
second option for operators who would rather avoid the disk-selection dialog.

The driver-load approach (recommended). Attach the `virtio-win.iso` as a second CD drive (the same
ISO described in "Get the media" above). When Setup reaches the disk-selection screen it shows no
disks. Drive the "Load driver" step from the keyboard: the keyboard path and the audible cues are in
"Loading the storage driver by ear" below, after you are connected and Narrator is speaking. The
driver set itself is the same one described in the `autounattend.xml` section above.

The SATA bus-swap approach (optional). Give the install disk a SATA bus for the duration of Setup so
Setup sees it natively with its in-box AHCI driver, then swap it back to VirtIO afterward. This is a
full two-way change, not a one-way trap, so both directions are given. First read the backing-store
path (the `<storage>:<disk-id>` value, for example `local-btrfs:9300/vm-9300-disk-2.raw`) from the
config:

```bash
qm config $VMID # note the scsi0 backing-store path
```

Forward, before the install (move the disk from the SCSI bus to a SATA bus):

```bash
qm set $VMID --sata0 local-btrfs:9300/vm-9300-disk-2.raw
qm set $VMID --delete scsi0
```

Reverse, after the install (move it back to the VirtIO SCSI bus):

```bash
qm set $VMID --scsi0 local-btrfs:9300/vm-9300-disk-2.raw,iothread=1,discard=on,ssd=1,cache=writeback
qm set $VMID --delete sata0
```

The bus change takes effect on the next VM start, and Windows re-enumerates the storage controller
when you switch back, so do the reverse swap while the VM is shut down. The driver-load approach has
no such post-install cleanup, which is why it is the primary recommendation.

### Set the boot order: CD first, disk second

A Windows ISO shows a brief, timed "Press any key to boot from CD or DVD" prompt that you cannot see
or hear, and Windows Setup reboots itself one or more times during the install. Set the boot order
with the CD first and the system disk second:

```bash
qm set $VMID --boot 'order=ide2;scsi0'
```

(`ide2` is the Windows ISO drive and `scsi0` is the system disk used throughout this guide. Quote
the whole `order=...` value: the `;` separator is a shell and PowerShell metacharacter.) This order
is what makes the install run hands-off. On the first boot the disk is still empty, so the firmware
boots the installer straight from the CD. Once Setup has written Windows to the disk, the CD's
"press any key" prompt goes unanswered on each self-reboot and the firmware falls through to the
now-bootable disk, so Setup continues from disk instead of looping back into the installer.

Then, once you reach the desktop, detach the ISO and switch to disk-only boot in "After the install"
below. Removing the install media is what guarantees a later reboot can never re-enter Setup.

(Do not rely on pressing a key in `remote-viewer` during the CD prompt: it would need the viewer
already open and focused before the VM starts, which the short-lived SPICE ticket cannot achieve,
since the ticket can only be fetched from an already-running VM. With the disk second in the boot
order you do not need to -- the install proceeds without a keypress.)

### One-time client setup

Do these three steps once on the control station before your first connection:

1. Install `virt-viewer` (from [virt-manager.org](https://virt-manager.org/download)); it provides
   `remote-viewer` and associates `.vv` files automatically. Also install PowerShell 7 (`pwsh`),
   which the launchers require: `winget install Microsoft.PowerShell`. Windows ships only Windows
   PowerShell 5.1, which the script's `#requires -Version 7.2` line rejects, so the double-click
   path fails without it.
2. Create a dedicated, least-privilege Proxmox API token for opening the console; do not use your
   login password or a high-privilege token. Guide
   [13 -- Users, permissions, and API tokens](13-users-permissions-and-api-tokens.md) covers
   creating tokens; for the SPICE console the built-in `PVEVMUser` role on `/vms/<vmid>` suffices
   (it grants `VM.Console` and nothing else). Scope the ACL to the specific VMID, not all of `/vms`,
   to limit the blast radius. The commands, run on the host:

```bash
pveum user add spice@pve --comment 'SPICE console access'
pveum user token add spice@pve console --privsep 1
pveum acl modify /vms/$VMID --users 'spice@pve' --roles PVEVMUser
pveum acl modify /vms/$VMID --tokens 'spice@pve!console' --roles PVEVMUser
```

Note the two `acl modify` lines: with privilege separation on (`--privsep 1`), a token's effective
rights are the intersection of the owning user's rights and the token's own rights (the intersection
rule from guide 13). The freshly created `spice@pve` user has no rights anywhere, so granting the
role to the token alone leaves the intersection empty and every `spiceproxy` call fails with
`Permission check failed (/vms/<vmid>, VM.Console)`. Assign `PVEVMUser` on the VM to BOTH the user
and the token so the intersection is non-empty. Confirm both bindings landed with `pveum acl list`
before moving on. (A `--privsep 0` token would inherit the user's rights and need only the user
binding, but a privilege-separated token is safer, so this guide keeps `--privsep 1`.)

1. Get the node's TLS certificate SHA-256 fingerprint for the config file. Run this on the host (it
   prints the colon-separated fingerprint):

```bash
openssl x509 -in /etc/pve/local/pve-ssl.pem -noout -fingerprint -sha256
```

Paste the hex value (everything after the `SHA256 Fingerprint=` prefix) into the config file. The
fetch tool uses it to pin its own HTTPS call to the Proxmox API on TCP 8006, protecting the API
token from a LAN man-in-the-middle. It does NOT go into the `.vv` file: `remote-viewer` connects
without a certificate prompt because Proxmox embeds a `ca=` PEM certificate in the returned
`console.vv`, which the tool passes through untouched.

Network prerequisite. The control station must reach the host on BOTH TCP 8006 (the API, used by the
fetch tool to mint the ticket) and TCP 3128 (the SPICE proxy, used by `remote-viewer` for the actual
console stream). If `remote-viewer` opens but shows no picture and stays silent, TCP 3128 is the
usual cause. If you run a host firewall (guide [11 -- Firewall](11-firewall.md)), confirm both ports
are allowed from your control station's address.

After filling in the host address, node name, token ID, token secret, and fingerprint (see "The
fetch tool"), keep the config file private: the token secret is the only credential in it. It lives
under the gitignored `tmp\` directory so it is never committed, and on Windows the tool restricts it
to your account, SYSTEM, and Administrators on every run. That hardening is best-effort: if it fails
it warns and carries on, so if you see that warning, tighten the file by hand with:

```powershell
icacls "tmp\spice-console.config.psd1" /inheritance:r /grant:r "$($env:USERNAME):(F)" "*S-1-5-18:(F)" "*S-1-5-32-544:(F)"
```

Because the token is least-privilege (it can only open a SPICE console on one VM), a leak is far
less damaging than a login password, but treat the file as private regardless.

Each connection also writes a short-lived `tmp\console.vv` under the same gitignored `tmp\`
directory. The tool restricts that file the same way. It expires quickly, but while it is valid it
is still console connection material, so treat it as private too.

### Start the VM

Start the VM before you fetch a ticket. The spiceproxy API has no SPICE session for a stopped VM and
returns a hard error if you try to connect to one:

```bash
qm start $VMID
```

### The fetch tool

The scripts live under `subjects/proxmox/scripts/`. Use the double-clickable launchers from the
control station:

- `spice-connect.bat` -- fetches a fresh SPICE ticket and opens the console in `remote-viewer`.
- `spice-fetch.bat` -- fetches the `console.vv` file only, without opening it.

The underlying PowerShell script is `spice-console.ps1`.

On first run the tool writes a template config to `tmp/spice-console.config.psd1` (that path is
gitignored). It is a PowerShell data file (`.psd1`): the tool reads it as plain data with
`Import-PowerShellDataFile`, never executing it as code, so the file that holds your token secret
can never run commands. Fill in the host address, node name, token ID, token secret, and certificate
fingerprint (retrieved above) between the `@{` and `}`, and keep the file private as noted above.
Each connection fetches a fresh `console.vv` into the repo's `tmp/` directory because a SPICE ticket
expires in roughly 30 seconds; the file is not reusable. With the VM running, run
`spice-connect.bat`; the console opens in `remote-viewer`.

### If the SPICE console will not connect

If `spice-connect.bat` shows no picture or errors out, check the usual causes first: the VM is
running (`qm status $VMID`), the control station can reach the host on BOTH TCP 8006 (the API) and
TCP 3128 (the SPICE proxy), and the token id, node name, and fingerprint in the config are correct.
The `tmp\remote-viewer.err.log` the launcher writes usually names the failure.

While you sort that out you are not blind to the machine: attach the serial line from the host to
watch the firmware and boot phase as text.

```bash
qm terminal $VMID # exit with Ctrl-O (the letter O, not zero)
```

Be clear about what this gives you. Because the VM has `serial0: socket`, OVMF, the UEFI boot
manager, and POST render over `qm terminal`, so you can confirm the VM is actually booting the
installer and read any firmware error. But the Windows graphical installer never appears on serial,
and SAC is not available until Windows is installed with EMS enabled, so here `qm terminal` is a
diagnosis channel, not a way to drive Setup; the "Serial console for boot and recovery (EMS/SAC)"
section below has the full picture. If SPICE stays broken, the `autounattend.xml` unattended path
needs no console at all and is the more robust route.

### Operating remote-viewer by ear

The most important key is the one that gets you back to the host. `remote-viewer` uses SPICE's
built-in ungrab, `Left Ctrl + Left Alt` (the two left-side keys pressed together), and the launcher
deliberately leaves that default in place rather than remapping it, because it is the most reliable
way off the guest on Windows. The launcher also passes two extra hotkeys with `--hotkeys`. You never
need to reach the menus:

- `Left Ctrl + Left Alt` releases the keyboard back to the host (host NVDA begins speaking again).
- `Shift+F11` toggles fullscreen.
- `Ctrl+Alt+End` sends `Ctrl+Alt+Del` to the guest.

One quirk to know: while the guest is actively holding the keyboard, only the low-level
`Left Ctrl + Left Alt` ungrab is guaranteed to fire; the `Shift+F11` and `Ctrl+Alt+End` hotkeys, and
the View menu, respond once the guest is not grabbing. So if `Shift+F11` seems dead, press
`Left Ctrl + Left Alt` first to release, then `Shift+F11`. The View menu's "Full screen" item is the
same toggle if you would rather use the menu.

While the console has focus the keyboard is grabbed to the guest and host NVDA goes quiet. That is
expected: you are listening to the guest. Press `Left Ctrl + Left Alt` to step back out to the host
at any time; if a stuck window ever ignores it, `Alt+Tab` away, or `Alt+F4` to close the console
(the SPICE ticket is disposable, so just fetch a fresh one). Do not launch `remote-viewer` with
`--kiosk`; kiosk mode locks the keyboard grab and window so no release key can get you back to the
host, which would trap you in the guest console.

`remote-viewer` prints a stream of harmless `GLib` and `GSpice` diagnostics on Windows (a missing
`usbdk` USB-redirection driver, and enumeration of your installed apps). The launcher redirects them
to `tmp\remote-viewer.out.log` and `tmp\remote-viewer.err.log` so they do not clutter the console;
you can ignore both files unless you are debugging a connection.

### Starting Narrator

After `remote-viewer` opens, the boot and Setup-loading phase is silent and can take roughly two to
five minutes (OVMF, POST, the UEFI boot manager, and Windows PE loading all run with no audio). Do
NOT press `Win+Ctrl+Enter` during this phase; presses while still in firmware or WinPE do nothing.
Wait until you hear the Narrator startup sound or SPICE audio activates, then press
`Win+Ctrl+Enter`. Narrator's own startup announcement -- "Narrator is loading" -- confirms it is
running; if it stays silent, press the combination again. On Windows 11, Narrator is available from
the very first screen (language selection), so the entire install is audible from the start. If
several minutes pass with no audio at all, check that the VM is running (`qm status $VMID`) and that
the audio device is attached.

Narrator does not survive a reboot, and Windows Setup reboots itself one or more times during the
install. Each reboot kills Narrator. When speech goes silent mid-install, that is usually a phase
transition, not a crash: wait a beat for the next phase to settle, then press `Win+Ctrl+Enter`
again. The same startup announcement confirms it is back.

### Loading the storage driver by ear

If you chose the driver-load approach, this is the one screen where the disk is invisible until you
act. With Narrator speaking, on the disk-selection screen:

1. Press `Tab` until Narrator announces the "Load driver" button (or press `Alt+L`, its keyboard
   accelerator in Windows 11 Setup), then press `Enter`.
2. In the file dialog, navigate to the virtio-win CD drive letter (Narrator announces the available
   drives as you arrow through them; the virtio CD is typically `D:` or `E:`) and into
   `vioscsi\w11\amd64`, then press `Enter` or activate OK.
3. Narrator announces each control as you `Tab` and arrow through the dialog, names the driver as it
   loads, and re-announces the disk list once the VirtIO disk appears. Select that disk and continue
   the install.

### After the install

The interactive path lands you in OOBE, not a finished desktop. After the final Setup reboot,
Windows Out-of-Box Experience (OOBE) runs and must be navigated by ear with Narrator. On Windows 11
Home, OOBE forces a Microsoft account by default. Open a command prompt with `Shift+F10` at OOBE and
run `oobe\BypassNRO.cmd` to get the local-account path. On recent 24H2 builds where that script has
been removed, set the same flag yourself and reboot -- the `BypassNRO` registry value still works
even though the script was dropped:

```cmd
reg add HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\OOBE /v BypassNRO /t REG_DWORD /d 1 /f
shutdown /r /t 0
```

After the reboot, OOBE offers the local-account path. (Windows 11 Pro also offers a local account
directly, without this step.) Because there is no answer media on this path, `SetupComplete.cmd`
never runs, so once you reach the desktop you must enable RDP and open its firewall yourself before
switching the display back. From an elevated CMD in the guest:

```cmd
reg add "HKLM\System\CurrentControlSet\Control\Terminal Server" /v fDenyTSConnections /t REG_DWORD /d 0 /f
netsh advfirewall firewall set rule group="remote desktop" new enable=Yes
```

Then restore the install-time changes. Detach the ISO, restore disk-first boot, and switch the
display back to `std` for the RDP path. The display change takes effect on the next VM start, so do
this while the VM is shut down and start it again before connecting over RDP:

```bash
qm shutdown $VMID
qm set $VMID --ide2 none,media=cdrom
qm set $VMID --boot 'order=scsi0'
qm set $VMID --vga std
qm start $VMID
```

The `audio0` device may be left in place or removed; RDP carries its own audio, so it is not needed
for daily use. To remove it: `qm set $VMID --delete audio0`.

Then follow the "Connect over RDP" section below to set up NVDA and connect over RDP. (The
"First-boot bootstrap" section assumes the autounattend `$OEM$` staging, so on this attended path
you install the VirtIO guest tools and NVDA by hand from the mounted `virtio-win.iso` and your NVDA
installer.) SPICE was only for the install; the daily path is RDP.

The same by-ear principle drives Windows recovery (WinRE) and graphical Linux installers too; guide
[04 -- Talking to guests without a GUI](04-talking-to-guests-without-a-gui.md) is where that
principle is stated.

## First-boot bootstrap: drivers, agent, and a screen reader

Windows Setup automatically runs `C:\Windows\Setup\Scripts\SetupComplete.cmd` at the very end of
setup, as the SYSTEM account, before any user logs on, if the file exists. That makes it the right
place to install the VirtIO guest tools, silently install NVDA, and re-assert the RDP toggle.

You stage the script (and the NVDA installer) onto disk through the `$OEM$` folder on the answer
media: files under `$OEM$\$$\Setup\Scripts\` are copied to `C:\Windows\Setup\Scripts\`, and
`$OEM$\$1\...` maps to the system drive root (`C:\`). Put `SetupComplete.cmd` and a copy of the NVDA
installer (for example `C:\nvda_setup.exe`) there.

Two things this script installs are NOT from apt; they are Windows-side installers:

- The VirtIO guest tools (`virtio-win-gt-x64.msi`, at the root of the `virtio-win.iso`). This one
  MSI installs the remaining paravirtual drivers PLUS the QEMU guest agent service and the balloon
  service. Until it runs, `agent: enabled=1` in the VM config is inert: the host cannot talk to the
  guest agent and cannot read the guest IP. Run it once here and the agent becomes real.
- NVDA, the Windows screen reader, installed silently so the desktop talks the first time you
  connect over RDP.

You author this script accessibly on the control station too; see guide 02's "Editing files
accessibly".

File `SetupComplete.cmd` (staged via `$OEM$` to `C:\Windows\Setup\Scripts\SetupComplete.cmd`):

```cmd
@echo off
REM --- Enable RDP and open the firewall (belt and braces) ---
reg add "HKLM\System\CurrentControlSet\Control\Terminal Server" /v fDenyTSConnections /t REG_DWORD /d 0 /f
netsh advfirewall firewall set rule group="remote desktop" new enable=Yes

REM --- Install VirtIO guest tools (agent + balloon + drivers) silently ---
REM virtio-win ISO is mounted; adjust drive letter as needed (often E:)
msiexec /i E:\virtio-win-gt-x64.msi /qn /norestart

REM --- Silently install NVDA and have it start at logon ---
C:\nvda_setup.exe --install --minimal --enable-start-on-logon=True

exit /b 0
```

Important caveat on the NVDA switches: they are version-sensitive. The documented options are
`--install` (install and start), `--install-silent` (install without starting the new copy),
`--minimal` (no sounds/UI/start message), and `--enable-start-on-logon=True|False` (whether NVDA
starts at the Windows sign-in screen). Do not abbreviate `--install-silent` as `-s`: current NVDA
documents `-s` as Secure Mode. Confirm the switches on the actual installer with
`nvda_setup.exe --help`, and consult the "Command Line Options" section of the current
[NVDA User Guide](https://download.nvaccess.org/documentation/userGuide.html), before you bake the
recipe.

### Start the install

Now start the VM. The install runs hands-off; you can watch the firmware and boot phase over serial
if you like, but you will NOT see the Windows GUI there:

```bash
qm start $VMID
qm terminal $VMID # optional: watch OVMF/boot; the Windows GUI never appears here
```

### Detach the media and destroy the answer disk

When the install and first boot finish, the VM has RDP on, the guest tools installed, and NVDA
running. Detach the install media and set the VM to boot from its disk:

```bash
qm set $VMID --ide2 none,media=cdrom
qm set $VMID --sata0 none,media=cdrom
qm set $VMID --sata1 none,media=cdrom
qm set $VMID --boot 'order=scsi0'
```

The `sata0` line assumes the unattended layout, where `sata0` holds the `virtio-win.iso` CD. If you
instead took the SATA bus-swap driver-load path earlier (which puts the OS disk on `sata0`), do that
path's reverse swap first and skip the `sata0` detach here, or you will detach the system disk.

With the install done, the answer media has served its purpose: detach it (above) and destroy or
wipe it along with any copy on the control station, since it still holds the cleartext admin
password.

## Give the guest a fixed address

RDP is only convenient if the guest is always at the same address. There are two ways to pin it.

The simplest is a DHCP reservation on your router or DNS server: leave Windows on DHCP (the default)
and bind its MAC address (the `net0: virtio=...` value in the VM config, or `Get-NetAdapter` in the
guest) to a fixed lease. Nothing changes inside Windows and the guest always gets the same address.
This is the recommended path unless you have a reason to configure the guest itself. To find the
address it currently holds (for example to set the reservation, or to RDP in before you pin it), ask
the guest agent from the host with `qm agent $VMID network-get-interfaces` (see "Connect over RDP").

The alternative is a static address configured inside Windows. Because the VirtIO NIC only works
after `NetKVM` is installed (the guest tools), set this after the first-boot bootstrap has run. From
an elevated PowerShell in the guest (over RDP, or baked into `SetupComplete.cmd`), find the adapter
and assign the address, gateway, and DNS server:

```powershell
$if = (Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | Select-Object -First 1).Name
Set-NetIPInterface -InterfaceAlias $if -Dhcp Disabled
New-NetIPAddress -InterfaceAlias $if -IPAddress 192.168.1.50 -PrefixLength 24 -DefaultGateway 192.168.1.1
Set-DnsClientServerAddress -InterfaceAlias $if -ServerAddresses 192.168.1.1
```

Use your own address, prefix length (`24` is a `/24`, the `255.255.255.0` mask), gateway, and DNS
server. To bake it into the unattended build, append the same steps to `SetupComplete.cmd` after the
guest-tools MSI installs (so `NetKVM` exists), calling PowerShell from the batch file:

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -Command "$if=(Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | Select-Object -First 1).Name; Set-NetIPInterface -InterfaceAlias $if -Dhcp Disabled; New-NetIPAddress -InterfaceAlias $if -IPAddress 192.168.1.50 -PrefixLength 24 -DefaultGateway 192.168.1.1; Set-DnsClientServerAddress -InterfaceAlias $if -ServerAddresses 192.168.1.1"
```

After a static address is set, connect with `mstsc /v:192.168.1.50` and it stays put across reboots.
For a Linux guest the equivalent is cloud-init's `ipconfig0` (guide
[07 -- Cloud-init templates](07-cloud-init-templates.md)) or the in-guest network config from guide
[10 -- Networking](10-networking.md).

## Connect over RDP

Once the guest tools are up, the guest agent can report the VM's IP. Read it from the host:

```bash
qm agent $VMID network-get-interfaces
```

That returns the guest's network interfaces and addresses as JSON, which reads cleanly with a screen
reader. (If it errors with an agent-not-running message, the guest tools are not installed yet;
revisit the first-boot bootstrap.)

From the control station, connect with the built-in Remote Desktop client to that IP:

```text
mstsc /v:<guest-ip>
```

Log in with the local user the answer file created. NVDA is already running and speaks inside the
session. This is the daily-use desktop path: RDP in, NVDA talks, you work.

For files that should outlive the VM, keep them off the OS disk: attach a persistent data disk (the
disposable-OS pattern in guide [06 -- Virtual machines with qm](06-virtual-machines-with-qm.md)) or
share a host directory into the guest (see "Sharing a host directory with virtiofs" below).

## Serial console for boot and recovery (EMS/SAC)

This is where Windows differs most sharply from the Linux serial guides, so be precise: serial on
Windows is a DIAGNOSIS channel, not a usable console.

What EMS/SAC is, and is not. Emergency Management Services (EMS) redirects the boot manager, the
loader, and a special in-OS console to a serial port for out-of-band administration when the machine
is otherwise unreachable. The in-OS piece is the Special Administration Console (SAC), a limited
text console available even when the network or desktop is down. SAC gives you: list and kill
processes (`tlist`, `kill`), restart and shutdown (`restart`, `shutdown`), show or set the IP on an
interface (`i`), change the admin password, and open a separate CMD channel (`cmd` creates a
channel; `ch` lists and switches channels; `ch -?` for help). It is enough to recover a box that
lost its network, or to read why it will not boot.

What SAC does NOT give you: a graphical desktop, a normal interactive login shell, or any way to use
Windows applications. You cannot run a screen reader through it, and you cannot drive the GUI
installer through it. It is a recovery lifeline, full stop. For real accessible work you use RDP
with NVDA inside the guest. This is exactly why the serial channel is wired as an EXTRA channel
alongside `vga: std`, not as the display.

Enable EMS inside Windows. Run these from an elevated CMD or PowerShell after install (or bake them
into `SetupComplete.cmd` so EMS is on from the first boot, which is useful since you cannot easily
run them through the GUI later if the box is sick). These edits run inside Windows, over RDP or SAC;
author and run them accessibly the way guide 02's "Editing files accessibly" describes for in-guest
config. `serial0` maps to COM1 in the guest, so the EMS port is 1:

```cmd
bcdedit /emssettings EMSPORT:1 EMSBAUDRATE:115200
bcdedit /ems {current} on
bcdedit /ems {bootmgr} on
```

The `/emssettings` line sets the global EMS port and baud for all entries; it does not by itself
enable EMS on any entry (the default baud if unspecified is 9600, so set 115200 to match the fast
serial socket). The `/ems {ID} on` lines enable EMS redirection for one boot entry: `{current}` is
the running OS entry (this is what gives you SAC once Windows is up), and `{bootmgr}` is the boot
manager (so the boot menu itself is on serial). The Windows Recovery Environment entry can be
EMS-enabled too, so recovery is reachable over serial.

Reach SAC from the host:

```bash
qm terminal $VMID # exit with Ctrl-O
```

Press Enter to get the `SAC>` prompt. Useful commands: `?` or `help`; `cmd` (spawn a CMD channel);
`ch` (list channels), `ch -?` for the channel help; `i` (show or set the IP); `restart` and
`shutdown`. To leave a CMD channel back to SAC the escape is Esc then Tab. Because `{bootmgr}` EMS
is on, the OVMF and boot-manager output and POST also render over `qm terminal`, so you can watch
the firmware and boot phase as text even though the Windows desktop never appears there. Exit
`qm terminal` with Ctrl-O (the letter O, not zero).

This is the boot-error and recovery lifeline: when the desktop or network is dead, SAC over serial
is how you read what happened, kill a stuck process, reset the IP, or restart, all from the shell.

## Snapshots and the guest agent

Snapshots work on this VM with the usual `qm snapshot`, `qm rollback`, `qm delsnapshot`, and
`qm listsnapshot` from guide 06; the mechanics are the same and are taught there. One
Windows-specific note: snapshots of a VM that has a vTPM need a recent Proxmox VE. On this btrfs
node they already work on any 9.x. Proxmox VE 9.1 widens snapshot and restore of vTPM VMs to more
storage (qcow2 vTPM state, NFS/CIFS, and offline LVM-chain), which does not change anything on your
btrfs root but is worth knowing if you ever move storage.

The guest agent (installed by `virtio-win-gt-x64.msi` in the first-boot bootstrap, not by apt) is
what makes `agent: enabled=1` real: with it, `qm shutdown` becomes a clean guest-initiated shutdown,
and the host can report the guest's IP via `qm agent <vmid> network-get-interfaces`. The serial
console is independent of the agent: keep both, because SAC over serial is your always-available
recovery door even if the agent or the network is down.

If you want data that outlives the VM itself -- rebuild or reinstall the desktop but keep the files
-- attach a second disk as a data volume and reassign it to a keeper VM before you destroy this one.
A disk attached the normal way is owned by the VM and is deleted with it, so the full pattern
(attach, the deletion catch, and `qm disk move --target-vmid`) is worth reading before you build
anything you care about: see guide [06 -- Virtual machines with qm](06-virtual-machines-with-qm.md),
under "A persistent data disk".

## Sharing a host directory with virtiofs

virtiofs (guide [06 -- Virtual machines with qm](06-virtual-machines-with-qm.md)) shares a host
directory into the guest with no NFS or SMB server, and because the data lives on the host it
survives destroying the VM. On Windows it is officially a "Tech Preview": it works for moving plain
data files in and out, but it is a user-mode filesystem (not NTFS) with rough edges, so do not put
anything load-bearing on it. Known gaps include imperfect case-insensitivity and missing NTFS
behaviour (some file attributes, alternate data streams, and full security descriptors), so treat it
as "try it and verify".

Create the directory mapping and attach `virtiofs0` on the host as guide 06 shows, with one Windows
rule: do NOT set `expose-acl` (and do not rely on ACL passthrough). Windows cannot interpret
virtiofs ACLs, and if you expose them the share does not appear in the guest at all. The default (no
`expose-acl`, no `expose-xattr`) is what you want.

Inside Windows, two pieces are needed on top of the VirtIO guest tools:

- WinFsp, the user-mode filesystem layer virtiofs is built on. It is a separate install (from
  winfsp.dev) with at least the "Core" feature selected, and it is NOT bundled with the VirtIO guest
  tools; install it once in the guest.
- The VirtIO-FS driver and service. The `viofs` driver and the `virtiofs.exe` service binary ship
  with the guest-tools MSI already installed in the first-boot bootstrap; you just enable the
  service.

From an elevated PowerShell in the guest, set the service to start at boot and start it now (the
space after `start=` is required by `sc.exe`):

```powershell
sc.exe config VirtioFsSvc start= auto
sc.exe start VirtioFsSvc
```

The share then appears as a drive letter (the first free one counting down from Z:), and its files
live in the host directory you mapped, untouched when the VM is deleted. If the `VirtioFsSvc`
service does not exist, the guest-tools install did not register it: re-run the VirtIO guest-tools
installer and include the VirtioFS component, or register it by hand from the `viofs` folder (its
exact path depends on the build) with WinFsp already installed:

```powershell
sc.exe create VirtioFsSvc binPath= "C:\Program Files\Virtio-Win\VioFS\virtiofs.exe" start= auto depend= VirtioFsDrv
```

## PVE 9 deltas and gotchas

Run `pveversion` first and confirm you are on 9.x. The Windows-specific points to carry:

- `--vga std`, NOT `--vga serial0`. This is the biggest trap if you copy the Linux serial pattern
  from guide 06. Windows needs a real display adapter for the desktop and RDP; serial is an
  ADDITIONAL channel. Set both `vga: std` and `serial0: socket`.
- The machine version is pinned for Windows. PVE keeps `pc-q35-<ver>` stable across host upgrades
  for `ostype: win*`. Do not bump it without reading the Machine Version Upgrade wiki; a changed
  virtual chipset can trigger Windows driver re-enumeration and even reactivation.
- No driver, no disk, no network. With virtio-scsi plus virtio-net the installer sees nothing until
  `vioscsi` (disk) and `NetKVM` (net) load. Always attach the `virtio-win.iso` as a second CD; the
  unattend windowsPE `DriverPaths` loads the storage driver for you.
- The guest agent comes from `virtio-win-gt-x64.msi`, NOT apt. `agent: enabled=1` is inert on
  Windows until the guest tools install the QEMU agent service. The same is true of ballooning,
  which needs the balloon driver and service.
- The balloon driver and service are needed for ballooning, or set `balloon: 0`. Without the
  service, dynamic memory does not reclaim and the guest may misreport RAM.
- Secure Boot plus pre-enrolled keys let the Windows bootloader load.
  `efitype=4m,pre-enrolled-keys=1` enrolls Microsoft's keys so the signed Windows bootloader is
  trusted with no menu fiddling, which the Win11 Secure Boot check and the unattended boot both
  need. On current PVE 9.2 EFI disks, also expect `ms-cert=2023k`; if an older disk lacks the 2023
  Microsoft certificates, enroll them with `qm enroll-efi-keys <vmid>` while the VM is shut down.
- vTPM v2.0 is mandatory for Win11 and cannot be changed to or from v1.2 later.
- vTPM snapshots need recent PVE. On btrfs this already works; 9.1 widens where it works, and 9.2
  adds live snapshots for volume-chain storages while still blocking live removal of the top-most
  snapshot.
- SAC is recovery, not a desktop. `qm terminal` to a Windows VM gets you SAC and the boot-manager
  output, never the GUI, never a screen reader, never the installer. Real accessible use is RDP plus
  in-guest NVDA.
- Verify NVDA switches on-box. The switches are documented but version-sensitive, with known silence
  quirks; check `nvda_setup.exe --help` and the NVDA User Guide before committing the recipe.

## Verify it worked

Confirm the build from the shell, with no graphical console anywhere in the loop.

The config is the Windows-accessible shape:

```bash
qm config $VMID
```

The output should include `ostype: win11`, `vga: std`, `serial0: socket`, and a `tpmstate0` line.
Seeing `vga: std` together with `serial0: socket` (and not `vga: serial0`) confirms the VM is built
the Windows way: a real display for RDP, serial as the extra EMS/SAC channel.

The guest agent reports the IP (once the guest tools are installed):

```bash
qm agent $VMID network-get-interfaces
```

This returns the guest's interfaces and addresses as JSON. If it errors with an agent-not-running
message, the guest tools have not installed yet.

RDP connects and NVDA speaks. From the control station:

```text
mstsc /v:<guest-ip>
```

You should reach the desktop, log in with the answer file's user, and hear NVDA speaking inside the
guest.

The serial console reaches SAC for boot and recovery diagnosis:

```bash
qm terminal $VMID
```

Press Enter; you should reach the `SAC>` prompt. Exit with Ctrl-O. Reaching `SAC>` confirms the EMS
wiring (`bcdedit /ems`) and the `serial0: socket` channel both took, so your recovery lifeline is
live.

## Sources

- `research/round2-pve9/22-pve9-windows-guest.md` - the Windows 11 VM config on PVE 9
  (`ostype: win11`, `machine: pc-q35-<ver>` pinned, `bios: ovmf` plus `efidisk0` with
  `efitype=4m,pre-enrolled-keys=1` and current `ms-cert=2023k` marker, the vTPM
  `tpmstate0 version=v2.0`, `virtio-scsi-single`, the `iothread=1,discard=on,ssd=1,cache=writeback`
  OS disk, `net0: virtio`, `cpu: host`, `memory`/`balloon: 0`, and above all `vga: std` plus
  `serial0: socket` as the additional channel, contrasted with the Linux `vga: serial0`); the full
  example `9300.conf`; the `virtio-win.iso` download and why Setup needs `vioscsi`/`NetKVM`; the
  three-CD media attach and boot order; the `autounattend.xml` passes (windowsPE driver load plus
  product key plus disk, specialize RDP enable, oobeSystem local user plus AutoLogon plus OOBE
  hide), the RDP `fDenyTSConnections`/firewall lines, and that no LabConfig bypass is needed;
  `SetupComplete.cmd` via `$OEM$` for `virtio-win-gt-x64.msi` and the NVDA unattended install with
  the version-sensitive-switch caveat; the RDP plus NVDA daily flow with
  `qm agent network-get-interfaces` and `mstsc`; the EMS/SAC `bcdedit` enablement, the honest "SAC
  is recovery, not a desktop" framing, and `qm terminal` (exit Ctrl-O); the snapshot and guest-agent
  notes (vTPM snapshots need 9.1+ off btrfs); and the PVE 9 Windows gotchas.
- `GLOSSARY.md` and `CONTEXT.md` - the canonical definitions of autounattend.xml, EMS / SAC, RDP
  (Remote Desktop), VirtIO drivers (virtio-win), vTPM (tpmstate0), KVM/QEMU VM, `qm`, serial
  console, OVMF / UEFI, `virtio-scsi-single`, qemu-guest-agent, snapshot, `local-btrfs`, and `vmbr0`
  reused here, and the role names (Proxmox host, control station, guest, the three superpowers).
- Proxmox VE documentation:
  [Windows 11 guest best practices](https://pve.proxmox.com/wiki/Windows_11_guest_best_practices),
  [Windows VirtIO Drivers](https://pve.proxmox.com/wiki/Windows_VirtIO_Drivers),
  [qm.conf.5](https://pve.proxmox.com/pve-docs/qm.conf.5.html),
  [qm.1](https://pve.proxmox.com/pve-docs/qm.1.html),
  [Serial Terminal](https://pve.proxmox.com/wiki/Serial_Terminal),
  [QEMU Machine Version Upgrade](https://pve.proxmox.com/wiki/QEMU_Machine_Version_Upgrade), and the
  [Proxmox VE 9.1 release notes](https://www.proxmox.com/en/about/company-details/press-releases/proxmox-virtual-environment-9-1)
  for vTPM qcow2 snapshots.
- Microsoft Learn:
  [Windows 11 requirements](https://learn.microsoft.com/en-us/windows/whats-new/windows-11-requirements)
  (the firmware rule is "Secure Boot capable", not enabled),
  [Windows Setup automation overview](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/windows-setup-automation-overview)
  (answer-file search order, passes, `$OEM$`),
  [Automate Windows Setup](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/automate-windows-setup),
  [Add a custom script to Windows Setup](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/add-a-custom-script-to-windows-setup)
  (`SetupComplete.cmd`),
  [BCDEdit /emssettings](https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/bcdedit--emssettings),
  and
  [BCDEdit /ems](https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/bcdedit--ems).
- The
  [virtio-win stable download](https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso),
  the [NVDA User Guide](https://download.nvaccess.org/documentation/userGuide.html) (Command Line
  Options), and the
  [Schneegans unattend generator](https://schneegans.de/windows/unattend-generator/) (tooling, not a
  primary source).

---

Previous: [07 -- Cloud-init templates](07-cloud-init-templates.md) | Next:
[09 -- Storage](09-storage.md)
