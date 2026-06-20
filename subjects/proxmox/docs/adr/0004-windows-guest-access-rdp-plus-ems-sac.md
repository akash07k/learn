# Windows guest access: RDP with a screen reader in the guest, EMS/SAC serial for diagnosis

Status: accepted

The operator (blind, shell-only) wants to run a Windows 11 VM. The Linux guides reach a guest's text
console over the serial line (`qm set --vga serial0` to route the display to serial, then
`qm terminal` to attach), but Windows is fundamentally different: it has no usable text-mode desktop
or installer over serial. Its only serial surface is EMS/SAC (Emergency Management Services /
Special Administration Console), a limited recovery console - not a desktop, a login shell, or a
screen-reader surface. So the Linux serial-console model cannot drive a Windows desktop.

Decision: a two-channel model, documented in guide 08.

- **Daily desktop use is over RDP**, with a Windows screen reader (NVDA) running INSIDE the guest.
  The VM keeps a real display adapter (`vga: std`) because RDP and the desktop need it;
  `serial0: socket` is added as an ADDITIONAL channel, never the primary display. This is the
  explicit inversion of the Linux guides' `vga: serial0`.
- **Install is hands-off via `autounattend.xml`** (the Windows analogue of guide 01's
  `answer.toml`): no graphical installer to see (when `autounattend.xml` is unavailable, the
  attended install over the SPICE console is the documented fallback - see ADR-0005). The answer
  file plus a first-boot `SetupComplete.cmd` enable RDP and its firewall rule, install the VirtIO
  guest tools (disk/net drivers + QEMU guest agent), and silently install NVDA, so the desktop is
  reachable with speech the first time the operator connects.
- **EMS/SAC over `qm terminal` is wired for boot and recovery diagnosis only**
  (`bcdedit /ems {current} on` for the running entry, plus `{bootmgr}` and `/emssettings`), giving a
  text lifeline to inspect a failed boot, restart, or read the IP when RDP is down - which is
  exactly the diagnostic capability the operator asked for.

## Considered and rejected

- **Serial console as the primary interface (the Linux model)**: rejected - Windows cannot render
  its desktop or installer to serial; `vga: serial0` would cripple RDP.
- **Interactive (attended) Windows install as the default**: rejected _as the default_ -
  `autounattend.xml` is hands-off and removes the installer interaction entirely. The attended
  install is not impossible for a blind operator, though: Narrator over the SPICE console's audio
  makes it sighted-help-free (see ADR-0005). It is the documented fallback, not the default.
- **A LabConfig/registry bypass of the Windows 11 TPM and Secure Boot checks**: rejected as
  unnecessary - the VM is given a real vTPM (`tpmstate0`, v2.0) and Secure Boot (OVMF + pre-enrolled
  keys), so the checks pass natively.

## Consequences

- The Windows VM config diverges from the Linux guides: `vga: std` (not `serial0`), `ostype: win11`,
  `machine: q35` (pinned version), `bios: ovmf` + `efidisk0`, and `tpmstate0` v2.0. Snapshots of a
  vTPM VM already work on this btrfs node on any 9.x; Proxmox VE 9.1 widens where vTPM snapshots are
  possible (qcow2 vTPM state, NFS/CIFS, offline LVM-chain), which does not affect this btrfs root.
- The QEMU guest agent comes from the VirtIO guest-tools installer inside Windows, not from a
  package manager, so `agent: enabled=1` is inert until that runs on first boot.
- RDP and NVDA-in-the-guest are an intentional, allowed exception to the corpus's "no graphical
  path" rule: they are how a blind operator uses Windows, and they are not the Proxmox web GUI. The
  Proxmox GUI and noVNC remain unused; SPICE is used only for the attended install/recovery fallback
  (ADR-0005), never for daily operation.
