# PVE 9 Windows 11 guest, the accessible way (unattended install, RDP + NVDA, serial for boot diagnosis)

Target: latest Proxmox VE 9.x on Debian 13 "trixie", mid-2026. PVE 9 shipped QEMU 10.0.2 in 9.0,
10.1.2 in 9.1, and 11.0 in current 9.2.

Audience: a blind, screen-reader, **shell-only** operator on a **single node** whose host root is
**BTRFS**, no GUI. The hard constraint that shapes everything below:

**A Windows desktop CANNOT be driven over the Proxmox serial console the way a Linux guest can.**
Linux puts a full login shell on `ttyS0`; Windows does not. Windows over serial gives you only SAC
(a limited recovery console, §5) - never a usable desktop, never the GUI installer. So the
accessible model is fundamentally different from the Linux guides:

1. Install Windows 11 **fully unattended** via `autounattend.xml` (the graphical installer runs but
   you never touch it - there is nothing to see and nothing to do).
2. The answer file + first-boot scripts auto-enable **RDP** and its firewall rule, install the
   **VirtIO guest tools**, and **silently install NVDA**, so the desktop is reachable with speech
   the first time it boots.
3. Daily use: **RDP from the Windows control station (`mstsc`)** with NVDA speaking _inside_ the
   guest.
4. Diagnosis only: **SAC over `qm terminal`** for boot/recovery when the desktop or network is dead.

This document reports what is TRUE in PVE 9 and is honest about the accessibility limits. Every
claim carries a citation.

---

## 1. The Windows 11 VM config on PVE 9 (`qm` options and conf keys)

Windows 11 has mandatory hardware requirements (UEFI + Secure Boot + TPM 2.0). On PVE we satisfy
them with real virtual devices - OVMF firmware, an EFI vars disk with pre-enrolled Microsoft keys,
and a swtpm-backed vTPM - so **no registry bypass is needed** (the `LabConfig` bypass exists but is
unnecessary here; see §6).

The Proxmox wiki "Windows 11 guest best practices" prescribes: guest OS type "Microsoft Windows
11/2022/2025", Qemu Agent enabled, **OVMF (UEFI)** firmware with an **EFI disk**, a **vTPM**, the
**q35** machine type, the disk on **SCSI** bus with the **VirtIO SCSI single** controller, **IO
Thread** and **Discard** enabled, cache "Write back", and a **VirtIO (paravirtualized)** NIC.
Citation:
[Windows 11 guest best practices](https://pve.proxmox.com/wiki/Windows_11_guest_best_practices)

The conf keys (`/etc/pve/qemu-server/<vmid>.conf`) and their `qm` equivalents:

- **`ostype: win11`** - sets Windows-specific hardware tuning and the pinned machine behavior.
  (`win10`, `win11` etc. are valid `ostype` values per `qm.conf`.) Citation:
  [qm.conf(5)](https://pve.proxmox.com/pve-docs/qm.conf.5.html)
- **`machine: pc-q35-<ver>`** - use **q35** (modern PCIe). For Windows, PVE **pins the machine
  version** (for example `pc-q35-11.0` on a current PVE 9.2 host) at create time and keeps it stable
  across upgrades, because Windows reacts badly to its virtual chipset changing underneath it (it
  can force driver re-enumeration / reactivation). You generally do NOT bump a Windows VM's machine
  version casually - see the Machine Version Upgrade wiki before changing it. Linux guests track
  `latest`; Windows stays pinned. Citation:
  [Qemu/KVM Virtual Machines](https://pve.proxmox.com/wiki/Qemu/KVM_Virtual_Machines) ;
  [QEMU Machine Version Upgrade](https://pve.proxmox.com/wiki/QEMU_Machine_Version_Upgrade)
- **`bios: ovmf`** - UEFI firmware (required for Secure Boot / Win11). Requires an EFI vars disk.
- **`efidisk0: <storage>:1,efitype=4m,pre-enrolled-keys=1`** - the EFI variable store.
  **`efitype=4m`** is mandatory for Secure Boot (4 MB OVMF variant; `2m` is legacy and not
  Secure-Boot-capable). **`pre-enrolled-keys=1`** enrolls the Microsoft Secure Boot keys so the
  signed Windows bootloader is trusted out of the box. On current PVE 9.2 packages, new pre-enrolled
  EFI disks should also be marked `ms-cert=2023k`, meaning the 2023 Microsoft UEFI certificate set
  is present; older EFI disks can be enrolled with `qm enroll-efi-keys <vmid>` while the VM is shut
  down. Citation: [qm.conf(5)](https://pve.proxmox.com/pve-docs/qm.conf.5.html) ;
  [Windows 11 guest best practices](https://pve.proxmox.com/wiki/Windows_11_guest_best_practices)
- **vTPM**: `tpmstate0: <storage>:1,version=v2.0`. Add it with
  **`qm set <vmid> --tpmstate0 <storage>:1,version=v2.0`**. The `tpmstate0` syntax includes a tiny
  managed TPM state volume and **`version` cannot be changed later**. Use **v2.0** for Win11 (v1.2
  does not satisfy Win11's TPM 2.0 requirement). On `local-btrfs`, do not choose a TPM state format
  manually; PVE 9.1+ can store TPM state as qcow2 on supported file-level storages to widen snapshot
  support. The state is realized by `swtpm`. Citation:
  [Manual: qm.conf](https://pve.proxmox.com/wiki/Manual:_qm.conf) ;
  [qm.conf(5)](https://pve.proxmox.com/pve-docs/qm.conf.5.html)
- **`scsihw: virtio-scsi-single`** - recommended controller; one controller per disk so per-disk
  `iothread=1` actually parallelizes I/O.
- **OS disk**:
  `scsi0: local-btrfs:<vmid>/vm-<vmid>-disk-N.raw,iothread=1,discard=on,ssd=1,size=64G`.
  `discard=on`+`ssd=1` enable TRIM passthrough (good on BTRFS/SSD). The wiki recommends cache "Write
  back" for Windows performance; that is `cache=writeback` on the disk (raw default `cache=none` is
  also safe - writeback trades a little safety for speed). Give Win11 at least ~64 GB. Citation:
  [Windows 11 guest best practices](https://pve.proxmox.com/wiki/Windows_11_guest_best_practices)
- **NIC**: `net0: virtio,bridge=vmbr0`. VirtIO has no in-box Windows driver, so the installer cannot
  see the network until `NetKVM` is loaded (§2). A real virtio NIC is what RDP rides on once the
  driver is in.
- **CPU**: `cpu: host` on a single node (no live migration) for full host flags. Windows is
  sensitive to CPU model churn; `host` is stable on a single fixed node. Some workloads benefit from
  `hidden=1` / `hv-vendor-id` enlightenment tweaks, but for plain Win11 on KVM the default Hyper-V
  enlightenments PVE applies for `ostype: win*` are sufficient - do not hand-add hidden-state unless
  you hit a specific problem. Citation:
  [Qemu/KVM Virtual Machines](https://pve.proxmox.com/wiki/Qemu/KVM_Virtual_Machines)
- **Memory / balloon**: `memory: 8192` (8 GB is a sane Win11 floor). Ballooning works on Windows
  ONLY if the **VirtIO Balloon driver + the balloon service** (from the guest tools) are installed;
  without them, `balloon: <min>` will not reclaim and the guest may misreport memory. Many operators
  set `balloon: 0` (disable) on Windows for predictability, or install the balloon service and leave
  a conservative `balloon` floor. Citation:
  [Windows VirtIO Drivers](https://pve.proxmox.com/wiki/Windows_VirtIO_Drivers)
- **Agent**: `agent: enabled=1` (commonly `agent: 1`). The QEMU guest agent on Windows comes from
  the **virtio-win guest tools**, NOT from apt (§2) - enabling the flag in the conf does nothing
  until the guest-side agent service is installed.
- **Display**: `vga: std`. THIS IS THE KEY WINDOWS DIFFERENCE - see §4. Windows needs a real
  emulated display adapter to have a desktop and accept RDP; you do NOT set `vga: serial0` on
  Windows. Serial is an _additional_ channel, not the primary display.

PVE 9.1 vTPM note: as of **9.1** the vTPM state can be stored in **qcow2**, which lets you take
**snapshots of a VM that has a vTPM** across many storage types (NFS/CIFS, and offline snapshots on
LVM volume-chain storage), without breaking the TPM trust chain. Before 9.1 you needed
snapshot-capable storage (ZFS/BTRFS/LVM-thin) for a vTPM VM to be snapshottable at all. On our BTRFS
root, snapshots of a vTPM VM already work; 9.1 just widens where it works. Citation:
[Proxmox Virtual Environment 9.1 available](https://www.proxmox.com/en/about/company-details/press-releases/proxmox-virtual-environment-9-1)

PVE 9.2 extends this area again: VMs with TPM state can take and remove live snapshots on storages
using snapshots as volume chains, although the top-most snapshot still cannot be removed while the
VM is running. Citation: [Roadmap](https://pve.proxmox.com/wiki/Roadmap)

---

## 2. VirtIO drivers (`virtio-win`) - why, where, how

Windows Setup ships with **no virtio-scsi and no virtio-net driver**. So with a virtio SCSI
controller, the installer shows **no disk** to install onto, and with a virtio NIC it has **no
network**, until you load the drivers. You feed them in from a second CD-ROM holding the
`virtio-win.iso`.

Get the ISO (Fedora-hosted, the canonical upstream that Proxmox points to):

- Stable, always-latest:
  `https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso`
- Versioned archive (pin a known-good build):
  `https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/archive-virtio/` Current stable
  around mid-2026 is the 0.1.2xx series (e.g. 0.1.285 was released 2025-09-12). The Proxmox wiki at
  times recommends a specific version if a newer one has a regression - check it. Citation:
  [Windows VirtIO Drivers](https://pve.proxmox.com/wiki/Windows_VirtIO_Drivers)

Download into an ISO storage on the host. There is no `pvesm download-iso` subcommand; call the
`download-url` storage API with `pvesh`:

```bash
pvesh create /nodes/$(hostname)/storage/local-btrfs/download-url \
 --content iso --filename virtio-win.iso \
 --url https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso
```

Present it as a **second CD-ROM** alongside the Windows ISO, on a SATA or IDE bus so the installer
(which has AHCI/IDE in-box) can read it:

```bash
qm set <vmid> --sata0 local-btrfs:iso/virtio-win.iso,media=cdrom
```

Driver paths on the ISO that matter for Win11 (per the Proxmox wiki walkthrough):

- **Disk (viostor / vioscsi)**: `vioscsi\w11\amd64` to "Red Hat VirtIO SCSI pass-through
  controller". This is the one the installer needs to SEE the disk. (`viostor` is the block driver
  for the plain `virtio-blk` bus; we use `virtio-scsi-single`, so it is the `vioscsi` folder.)
- **Network (NetKVM)**: `NetKVM\w11\amd64` to "Redhat VirtIO Ethernet Adapter".
- **Balloon**: `Balloon\w11\amd64` to "VirtIO Balloon Driver".
- **Guest agent MSI**: `guest-agent\qemu-ga-x86_64.msi`. Citation:
  [Windows 11 guest best practices](https://pve.proxmox.com/wiki/Windows_11_guest_best_practices)

The **`virtio-win-guest-tools`** wizard (`virtio-win-gt-x64.msi`, at the root of the ISO) installs
the remaining drivers PLUS the **QEMU Guest Agent service** and the **balloon service** in one shot.
Run it once on first boot (§3/§5) and you get the agent (so `agent: enabled=1` becomes real),
ballooning, and all paravirtual drivers. Citation:
[Windows VirtIO Drivers](https://pve.proxmox.com/wiki/Windows_VirtIO_Drivers)

In an unattended install, the storage driver is loaded for you by `autounattend.xml`: the
**windowsPE** pass uses a `Microsoft-Windows-PnpCustomizationsWinPE` `DriverPaths` entry pointing at
the virtio CD's `vioscsi\w11\amd64`, so Setup can address the virtio disk with zero interaction. The
rest of the tools install at the end via `SetupComplete.cmd` (§3). Citation:
[Windows Setup Automation Overview](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/windows-setup-automation-overview)

---

## 3. `autounattend.xml` essentials for an unattended, accessible install

### 3a. How Setup finds the answer file

Windows Setup searches for an answer file at the start of each configuration pass. **Removable
read/write media and removable read-only media, at the ROOT of the drive, named
`Autounattend.xml`**, are search locations 4 and 5 in the implicit search order - so a small second
virtual CD-ROM (or a vfat disk) holding `Autounattend.xml` at its root is picked up automatically,
with no `setup.exe` arguments. (You can also force one with `setup.exe /unattend:<file>`, but
auto-discovery is simpler for our hands-off boot.) Citation:
[Windows Setup Automation Overview](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/windows-setup-automation-overview)

You can put `Autounattend.xml` on the _same_ virtio-win CD or on its own tiny ISO. A common pattern:
a separate small ISO containing `Autounattend.xml` at the root plus a `$OEM$` tree and your NVDA
installer, attached as a third CD-ROM.

### 3b. The passes that matter

`autounattend.xml` is organized into configuration passes; for our flow you populate:

- **windowsPE** (`Microsoft-Windows-Setup`): disk configuration (wipe + create the EFI/MSR/Windows
  partitions for a UEFI/GPT layout), **load the virtio storage driver** (via
  `Microsoft-Windows-PnpCustomizationsWinPE` `DriverPaths`), select the image (`ImageInstall` /
  `InstallFrom`), accept the EULA, and provide the **product key** (`UserData/ProductKey`). The
  product key is what selects the Win11 edition and skips the "which edition" prompt.
- **specialize** (`Microsoft-Windows-Shell-Setup`): computer name; and the place to **enable RDP**
  (see 3c).
- **oobeSystem** (`Microsoft-Windows-Shell-Setup`): create the **local user account**, configure
  **AutoLogon** (so first boot lands logged in without a visible prompt), and set **OOBE** to hide
  all the privacy/region/network nag screens (`OOBE/HideEULAPage`, `HideOnlineAccountScreens`,
  `ProtectYourPC`, etc.), and **`FirstLogonCommands`** for last-mile setup. Citation:
  [Windows Setup Automation Overview](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/windows-setup-automation-overview)
  ;
  [Automate Windows Setup](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/automate-windows-setup)

Use the open **Schneegans unattend generator**
([Generate autounattend.xml files for Windows 10/11](https://schneegans.de/windows/unattend-generator/))
to produce a correct, schema-valid `Autounattend.xml` with checkboxes for "enable RDP", "bypass
Win11 hardware checks", local account, autologon, and a custom first-logon script - it is the
fastest way to get a working file without Windows SIM. (Generator, not an MS primary source; verify
the emitted XML against the MS component docs.)

### 3c. Enabling RDP + the firewall rule (the load-bearing accessibility step)

RDP can be turned on declaratively in **specialize** via
`Microsoft-Windows-TerminalServices-LocalSessionManager` `fDenyTSConnections = false` and
`Microsoft-Windows-TerminalServices-RDP-WinStationExtensions` `UserAuthentication = 1` (keep Network
Level Authentication on). NLA makes the client authenticate before a full RDP desktop is created;
temporarily use `0` only for an old client during trusted-LAN bring-up, then revert it. The firewall
rule still has to be opened. The most robust, easiest-to-reason-about approach is to do BOTH the
registry toggle and the firewall rule as commands. Put them in `SetupComplete.cmd` (runs as SYSTEM,
before any logon - see 3d) or in `FirstLogonCommands`:

```cmd
reg add "HKLM\System\CurrentControlSet\Control\Terminal Server" /v fDenyTSConnections /t REG_DWORD /d 0 /f
netsh advfirewall firewall set rule group="remote desktop" new enable=Yes
```

Caveat from MS Q&A: RDP is not reachable _during_ OOBE - it only works once OOBE has completed and
the account exists. With AutoLogon configured, OOBE completes automatically on first boot, so RDP
comes up shortly after. Prefer `SetupComplete.cmd` for these (it runs earlier, as SYSTEM, before the
user logon) so RDP is ready the moment the desktop appears. Citation:
[Is it possible to make RDP work on OOBE screen of Windows 11?](https://learn.microsoft.com/en-us/answers/questions/5523998/is-it-possible-to-make-rdp-work-on-oobe-screen-of)
;
[Add a Custom Script to Windows Setup](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/add-a-custom-script-to-windows-setup)

### 3d. `SetupComplete.cmd` - unattended NVDA + guest tools on first boot

Windows Setup automatically runs **`C:\Windows\Setup\Scripts\SetupComplete.cmd`** at the very end of
setup, **as the SYSTEM account, before any user logs on**, if the file exists. (Note: with a
`SetupComplete.cmd` present, Setup does NOT show its final interactive steps the same way - and on
modern builds it can suppress parts of OOBE.) It is the right place to: install the virtio guest
tools, silently install NVDA, and (as a belt-and-braces) re-assert the RDP toggle. Citation:
[Add a Custom Script to Windows Setup](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/add-a-custom-script-to-windows-setup)

Stage the files via the `$OEM$` folder so they land on disk: files under `$OEM$\$$\Setup\Scripts\`
are copied to `C:\Windows\Setup\Scripts\`, and `$OEM$\$1\...` maps to the system drive root (`C:\`).
Put `SetupComplete.cmd` and a copy of the NVDA installer (e.g. `C:\nvda_setup.exe`) there. Citation:
[Windows Setup Automation Overview](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/windows-setup-automation-overview)

NVDA unattended install: the NVDA launcher executable accepts installer switches. The documented
ones are **`--install`** (install and start), **`--install-silent`** (install without starting the
new copy), **`--minimal`** (no sounds/UI/start message), and
**`--enable-start-on-logon=True|False`** (control whether NVDA starts at the Windows sign-in/secure
screen). For an accessible-on-first-RDP setup you want NVDA installed and started, so use the long
options explicitly:

```cmd
C:\nvda_setup.exe --install --minimal --enable-start-on-logon=True
```

Do not abbreviate `--install-silent` as `-s`: current NVDA documents `-s` as Secure Mode. Also note
the difference between the two install modes: `--install` installs and starts the installed copy,
while `--install-silent` installs without starting it. Confirm the exact switches on the actual
installer with `nvda_setup.exe --help` before baking the recipe, and consult the "Command Line
Options" section of the current NVDA User Guide. Citation:
[NVDA 2026.1.1 User Guide](https://download.nvaccess.org/documentation/userGuide.html) (Command Line
Options) ;
[Command line switch --minimal isn't silent · Issue #12289 · nvaccess/nvda](https://github.com/nvaccess/nvda/issues/12289)

A representative `SetupComplete.cmd`:

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

### 3e. Win11 hardware-check interplay

Because we provide a real **vTPM v2.0 + Secure Boot (pre-enrolled keys) + UEFI**, Windows 11's
TPM/SecureBoot/RAM checks pass natively and you do NOT need the registry bypass. The `LabConfig`
bypass (`HKLM\System\Setup\LabConfig` with `BypassTPMCheck`, `BypassSecureBootCheck`,
`BypassRAMCheck`) exists and the unattend generators offer it, but on a correctly-built PVE Win11 VM
it is unnecessary. (If you ever undersize RAM below 4 GB or skip the vTPM, you'd need it.)

---

## 4. EMS / SAC serial console for Windows (boot/recovery diagnosis ONLY)

This section is where Windows differs most sharply from the Linux serial guides. **Be precise:
serial on Windows is a diagnosis channel, not a usable console.**

### 4a. What EMS/SAC is and is NOT

**Emergency Management Services (EMS)** redirects the boot manager, the loader, and a special in-OS
console to a serial port for out-of-band administration when the machine is otherwise unreachable.
The in-OS piece is the **Special Administration Console (SAC)** - a _limited_ text console available
even when the network/desktop is down. Citation:
[BCDEdit /emssettings - Windows drivers](https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/bcdedit--emssettings)
; [Emergency Management Services](https://en.wikipedia.org/wiki/Emergency_Management_Services)

What SAC **gives** you over serial: list/kill processes (`tlist`, `kill`), restart/ shutdown
(`restart`, `shutdown`, `crashdump`), set/show IP on an interface (`i`), change the admin password,
and open a separate **CMD channel** (`cmd` creates a channel; `ch` lists/switches channels; `ch -?`
for help). It is enough to recover a box that lost its network or to read why it will not boot.

What SAC **does NOT** give you: a graphical desktop, a normal interactive login shell, or any way to
_use_ Windows applications. You cannot run a screen reader through it; you cannot drive the GUI
installer through it. It is a recovery lifeline, full stop. For real work you use **RDP with NVDA
inside the guest** (§5).

### 4b. PVE side - add serial as an ADDITIONAL channel

```bash
qm set <vmid> --serial0 socket
```

Do **NOT** set `--vga serial0` on a Windows VM. On Linux that makes serial the primary display; on
Windows it removes/cripples the display adapter the desktop and RDP need. Windows must keep a real
display: **`vga: std`**. So the Windows VM has BOTH `vga: std` (for desktop/RDP) AND
`serial0: socket` (the extra EMS/SAC channel). This is the single most important Windows-vs-Linux
distinction in this whole document. Citation:
[Serial Terminal](https://pve.proxmox.com/wiki/Serial_Terminal) ;
[qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html)

A newly added `serial0` needs a full **stop then start** (not a reboot) to be wired in.

### 4c. Windows side - enable EMS on the boot entries

Run inside the guest (elevated CMD/PowerShell), after install. `serial0` maps to COM1 in the guest,
so EMSPORT:1:

```cmd
bcdedit /emssettings EMSPORT:1 EMSBAUDRATE:115200
bcdedit /ems {current} on
bcdedit /ems {bootmgr} on
```

- `/emssettings` sets the **global** EMS port/baud for all entries; it does NOT by itself enable EMS
  on any entry. Default baud if unspecified is 9,600 - set 115200 to match the fast serial socket.
  Citation:
  [BCDEdit /emssettings - Windows drivers](https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/bcdedit--emssettings)
- `/ems {ID} on` enables EMS redirection for one boot entry. `{current}` = the running OS entry (SAC
  once Windows is up); `{bootmgr}` = the boot **manager** (so the boot menu itself is on serial);
  you may also do `{default}`. Omitting the ID targets the current OS entry. Citation:
  [BCDEdit /ems - Windows drivers](https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/bcdedit--ems)
- The **Windows Recovery Environment (WinRE)** boot entry can also be EMS-enabled, so recovery is
  reachable over serial too.

You can bake these `bcdedit` lines into `SetupComplete.cmd` so EMS is on from the first boot -
useful since you cannot easily run them through the GUI later if the box is sick.

### 4d. Reaching SAC

```bash
qm terminal <vmid> # exit with Ctrl-O
```

Press Enter to get the `SAC>` prompt. Useful commands: `?` or `help`; `cmd` (spawn a CMD channel);
`ch` (list channels), `ch -sn <name>` / `ch -ci <#>` to switch; `i` (show/set IP); `restart` /
`shutdown`. To leave a CMD channel back to SAC, the escape is **Esc Tab**. Note that the
OVMF/boot-manager output and POST also render on serial when `{bootmgr}` EMS is on, so you can watch
the firmware/boot phase over `qm terminal` even though the Windows desktop never appears there.
Citation:
[BCDEdit /ems - Windows drivers](https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/bcdedit--ems)

Honesty note: EMS docs warn you may need to suspend Secure Boot/BitLocker before some `bcdedit`
changes on physical hardware; inside a PVE VM with our pre-enrolled-keys OVMF the `bcdedit /ems` and
`/emssettings` commands run fine, but if BitLocker is later enabled, changing boot config can
trigger a recovery-key prompt. Citation:
[BCDEdit /emssettings - Windows drivers](https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/bcdedit--emssettings)

---

## 5. End-to-end accessible flow + worked example

### 5a. The ordered recipe

```bash
VMID=9300

# 1. Create the Win11 shell. NOTE: vga std (NOT serial0 as display) + serial0 as extra.
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

# 2. EFI vars (Secure Boot, MS keys) + vTPM v2.0 (Win11 requirement).
qm set $VMID --efidisk0 local-btrfs:1,efitype=4m,pre-enrolled-keys=1
qm set $VMID --tpmstate0 local-btrfs:1,version=v2.0

# 3. OS disk on BTRFS with iothread + discard.
qm set $VMID --scsi0 local-btrfs:64,iothread=1,discard=on,ssd=1,cache=writeback

# 4. Three CD-ROMs: Windows ISO, virtio-win ISO, and the autounattend media.
qm set $VMID --ide2 local-btrfs:iso/win11.iso,media=cdrom
qm set $VMID --sata0 local-btrfs:iso/virtio-win.iso,media=cdrom
qm set $VMID --sata1 local-btrfs:iso/autounattend.iso,media=cdrom

# 5. Boot from the Windows ISO first.
qm set $VMID --boot 'order=ide2;scsi0'

# 6. Start. The install runs hands-off; you watch firmware/boot over serial if you like.
qm start $VMID
qm terminal $VMID # optional: watch OVMF/boot; you will NOT see the Windows GUI here

# 7. When install + first boot finish, the VM has: RDP on, guest tools in, NVDA running.
# Detach the install media and set the disk to boot.
qm set $VMID --ide2 none,media=cdrom
qm set $VMID --sata1 none,media=cdrom
qm set $VMID --boot order=scsi0

# 8. Find the guest IP (agent is now installed), then RDP in from the control station.
qm guest cmd $VMID network-get-interfaces
```

From the Windows control station: `mstsc /v:<guest-ip>`, log in with the local account the answer
file created, and NVDA is already speaking inside the session.

Tip: you can have the autounattend media also be the `virtio-win.iso` (put `Autounattend.xml` +
`$OEM$` at the root of a re-mastered copy) to save a CD slot. Two ISOs (Windows + a combined
virtio/answer ISO) is the common minimal setup.

### 5b. Representative `Autounattend.xml` skeleton (elided)

Placeholders in ANGLE BRACKETS. This is illustrative - generate the real one with Windows SIM or the
Schneegans generator and validate it.

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
 <!-- FirstLogonCommands is the fallback if you prefer it over SetupComplete.cmd -->
 <FirstLogonCommands>
 <SynchronousCommand wcm:action="add"><Order>1</Order>
 <CommandLine>cmd /c reg add "HKLM\System\CurrentControlSet\Control\Terminal Server" /v fDenyTSConnections /t REG_DWORD /d 0 /f</CommandLine>
 </SynchronousCommand>
 <SynchronousCommand wcm:action="add"><Order>2</Order>
 <CommandLine>netsh advfirewall firewall set rule group="remote desktop" new enable=Yes</CommandLine>
 </SynchronousCommand>
 </FirstLogonCommands>
 </component>
 </settings>

</unattend>
```

(`SetupComplete.cmd` shown in §3d handles guest-tools + NVDA. Use it OR `FirstLogonCommands` for the
RDP/firewall lines - doing it in both is harmless.)

### 5c. Full example `/etc/pve/qemu-server/9300.conf`

```text
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

Note the contrast with the Linux example in research file 09: there it was `vga: serial0` (serial as
primary display). Here it is **`vga: std` plus `serial0: socket`** - display for RDP, serial as the
extra EMS/SAC channel. The `machine` version is **pinned** (`pc-q35-11.0` on current PVE 9.2) for
Windows.

---

## 6. PVE 9 deltas / gotchas (Windows-specific)

- **`vga: std`, NOT `vga: serial0`.** The biggest trap if you copy the Linux serial pattern. Windows
  needs a real display adapter for the desktop and RDP; serial is an ADDITIONAL channel. Set both
  `vga: std` and `serial0: socket`.
- **Machine version is pinned for Windows.** PVE keeps `pc-q35-<ver>` stable across host upgrades
  for `ostype: win*`. Do not bump it without reading the Machine Version Upgrade wiki - a changed
  virtual chipset can trigger Windows driver re-enumeration and even reactivation. Citation:
  [QEMU Machine Version Upgrade](https://pve.proxmox.com/wiki/QEMU_Machine_Version_Upgrade)
- **No driver, no disk, no network.** With virtio-scsi + virtio-net, the installer sees nothing
  until `vioscsi` (disk) and `NetKVM` (net) load. Always attach the virtio-win ISO; the unattend
  windowsPE `DriverPaths` loads the storage driver for you. Citation:
  [Windows VirtIO Drivers](https://pve.proxmox.com/wiki/Windows_VirtIO_Drivers)
- **The guest agent comes from virtio-win-guest-tools, NOT apt.** `agent: enabled=1` is inert on
  Windows until `virtio-win-gt-x64.msi` installs the QEMU GA service. Same for ballooning (needs the
  balloon driver + service). Citation:
  [Windows VirtIO Drivers](https://pve.proxmox.com/wiki/Windows_VirtIO_Drivers)
- **Balloon caveat on Windows.** Without the balloon service, dynamic memory does not reclaim and
  the guest may misreport RAM; either install the service or set `balloon: 0`.
- **vTPM v2.0 is mandatory for Win11** and cannot be changed to/from v1.2 later. Realize it with
  `qm set --tpmstate0 <storage>:1,version=v2.0`. On `local-btrfs`, do not choose a TPM state format
  manually; PVE 9.1+ can store TPM state as qcow2 on supported file-level storages. Citation:
  [Manual: qm.conf](https://pve.proxmox.com/wiki/Manual:_qm.conf)
- **Secure Boot + pre-enrolled keys.** `efitype=4m,pre-enrolled-keys=1` enrolls MS keys so the
  signed Windows bootloader is trusted with no menu fiddling - required for the Win11 Secure Boot
  check to pass and for autounattend to proceed unattended. On current PVE 9.2 EFI disks, also
  expect `ms-cert=2023k`; if an older disk lacks the 2023 Microsoft certificates, enroll them with
  `qm enroll-efi-keys <vmid>` while the VM is shut down.
- **Snapshots of a vTPM VM need recent PVE.** On BTRFS this already works; PVE **9.1** extends
  snapshot/restore of vTPM VMs to more storage (qcow2 vTPM state, NFS/CIFS, offline LVM-chain), and
  PVE **9.2** adds live snapshots on volume-chain storages while still blocking live removal of the
  top-most snapshot. Citation:
  [Proxmox Virtual Environment 9.1 available](https://www.proxmox.com/en/about/company-details/press-releases/proxmox-virtual-environment-9-1)
- **SAC is recovery, not a desktop.** Be honest in the guide: `qm terminal` to a Windows VM gets you
  SAC (process kill, restart, set IP, CMD channel) and the boot-manager output - never the GUI,
  never a screen reader, never the installer. Real accessible use is RDP + in-guest NVDA. Citation:
  [BCDEdit /ems - Windows drivers](https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/bcdedit--ems)
- **Verify NVDA switches on-box.** `--install`, `--install-silent`, `--minimal`,
  `--enable-start-on-logon` are documented but version-sensitive and some have known silence quirks;
  do not use `-s` for silence because current NVDA documents it as Secure Mode. Check
  `nvda_setup.exe --help` / the NVDA User Guide before committing the recipe. Citation:
  [NVDA 2026.1.1 User Guide](https://download.nvaccess.org/documentation/userGuide.html)

---

## 7. Quick reference - the accessible Windows VM checklist

1. Create the VM (DISPLAY is std; serial is the extra channel):

```bash
qm create <vmid> --ostype win11 --machine q35 --bios ovmf --cpu host --vga std --serial0 socket --scsihw virtio-scsi-single --net0 virtio,bridge=vmbr0 --agent enabled=1
```

1. `qm set <vmid> --efidisk0 <store>:1,efitype=4m,pre-enrolled-keys=1`
2. `qm set <vmid> --tpmstate0 <store>:1,version=v2.0` (Win11 requires TPM 2.0).
3. `qm set <vmid> --scsi0 <store>:64,iothread=1,discard=on,ssd=1`.
4. Attach 3 CDs: Windows ISO + `virtio-win.iso` + `autounattend.iso`. Boot the Win ISO.
5. Answer file: windowsPE loads `vioscsi` + product key + disk; oobeSystem makes a local user +
   AutoLogon + hides OOBE; enable RDP (`fDenyTSConnections=0` + firewall rule).
6. `C:\Windows\Setup\Scripts\SetupComplete.cmd` (staged via `$OEM$`) installs
   `virtio-win-gt-x64.msi` and runs
   `nvda_setup.exe --install --minimal --enable-start-on-logon=True`.
7. Daily: `mstsc /v:<guest-ip>` from the control station; NVDA speaks inside the guest.
8. Diagnosis only: `bcdedit /emssettings EMSPORT:1 EMSBAUDRATE:115200` +
   `bcdedit /ems {current} on` + `bcdedit /ems {bootmgr} on`, then `qm terminal <vmid>` for SAC.
   Exit `qm terminal` with **Ctrl-O**.

---

## Primary sources cited

- Proxmox wiki, Windows 11 guest best practices:
  [Windows 11 guest best practices](https://pve.proxmox.com/wiki/Windows_11_guest_best_practices)
- Proxmox wiki, Windows 2022 guest best practices:
  [Windows 2022 guest best practices](https://pve.proxmox.com/wiki/Windows_2022_guest_best_practices)
- Proxmox wiki, Windows VirtIO Drivers:
  [Windows VirtIO Drivers](https://pve.proxmox.com/wiki/Windows_VirtIO_Drivers)
- Proxmox `qm.conf` manual (tpmstate0, efidisk0, ostype, machine):
  [qm.conf(5)](https://pve.proxmox.com/pve-docs/qm.conf.5.html) ;
  [Manual: qm.conf](https://pve.proxmox.com/wiki/Manual:_qm.conf)
- Proxmox `qm` manual (terminal, set): [qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html)
- Proxmox wiki, Qemu/KVM Virtual Machines (CPU/machine/Windows enlightenments):
  [Qemu/KVM Virtual Machines](https://pve.proxmox.com/wiki/Qemu/KVM_Virtual_Machines)
- Proxmox wiki, QEMU Machine Version Upgrade (Windows pinning):
  [QEMU Machine Version Upgrade](https://pve.proxmox.com/wiki/QEMU_Machine_Version_Upgrade)
- Proxmox wiki, Serial Terminal: [Serial Terminal](https://pve.proxmox.com/wiki/Serial_Terminal)
- Proxmox VE 9.1 press release (vTPM qcow2 snapshots):
  [Proxmox Virtual Environment 9.1 available](https://www.proxmox.com/en/about/company-details/press-releases/proxmox-virtual-environment-9-1)
- virtio-win downloads (Fedora-hosted stable + archive):
  [Virtio win (fedorapeople.org)](https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso)
  ;
  [Index of /groups/virt/virtio-win/direct-downloads/archive-virtio](https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/archive-virtio/)
- Microsoft Learn, Windows Setup Automation Overview (answer file search order, passes, $OEM$):
  [Windows Setup Automation Overview](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/windows-setup-automation-overview)
- Microsoft Learn, Automate Windows Setup (components/passes):
  [Automate Windows Setup](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/automate-windows-setup)
- Microsoft Learn, Add a Custom Script to Windows Setup (SetupComplete.cmd):
  [Add a Custom Script to Windows Setup](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/add-a-custom-script-to-windows-setup)
- Microsoft Q&A, RDP during OOBE limitation:
  [Is it possible to make RDP work on OOBE screen of Windows 11?](https://learn.microsoft.com/en-us/answers/questions/5523998/is-it-possible-to-make-rdp-work-on-oobe-screen-of)
- Microsoft Learn, BCDEdit /emssettings:
  [BCDEdit /emssettings - Windows drivers](https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/bcdedit--emssettings)
- Microsoft Learn, BCDEdit /ems:
  [BCDEdit /ems - Windows drivers](https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/bcdedit--ems)
- Microsoft Learn, Boot Parameters to Enable EMS Redirection:
  [Boot Parameters to Enable EMS Redirection - Windows drivers](https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/boot-parameters-to-enable-ems-redirection)
- Wikipedia, Emergency Management Services (SAC overview):
  [Emergency Management Services](https://en.wikipedia.org/wiki/Emergency_Management_Services)
- NVDA User Guide, Command Line Options:
  [NVDA 2026.1.1 User Guide](https://download.nvaccess.org/documentation/userGuide.html)
- NVDA silent-install switch quirks (GitHub issues #12289, #17851):
  [Command line switch --minimal isn't silent · Issue #12289 · nvaccess/nvda](https://github.com/nvaccess/nvda/issues/12289)
- Schneegans unattend generator (tooling, not primary):
  [Generate autounattend.xml files for Windows 10/11](https://schneegans.de/windows/unattend-generator/)
