# PVE 9 Host Bootloader, Kernel Management, and AMD CPU Microcode

Target: latest Proxmox VE 9.x (Debian 13 "trixie"), mid-2026. Single node, AMD Ryzen 6800H mini-PC,
single 1TB NVMe, host root = **BTRFS**, no RAID. Shell-only, screen-reader / serial-console
workflow.

This file gives the TRUE-IN-PVE-9 picture with deltas from PVE 8 flagged, exact commands, file
paths, gotchas, and citations.

---

## TL;DR for THIS node (BTRFS root, single NVMe, UEFI, no Secure Boot)

- The Proxmox installer puts a **512 MB EFI System Partition (ESP)** on the NVMe and the ESP **is
  managed by `proxmox-boot-tool`**. The synced bootloader on a BTRFS (or ext4/xfs) UEFI install is
  **GRUB** (not systemd-boot). systemd-boot is only chosen for **ZFS** root on UEFI with Secure Boot
  OFF.
- Because GRUB is the bootloader, the kernel command line lives in **`/etc/default/grub`**
  (`GRUB_CMDLINE_LINUX_DEFAULT`), and this corpus applies changes with the explicit
  **`proxmox-boot-tool refresh`** path so the managed ESP is regenerated and synced. Current Proxmox
  docs also describe `update-grub` as a valid GRUB apply path when the proxmox-boot-tool hook is
  present. Do NOT hand-edit `/etc/kernel/cmdline` on this node - that file is the systemd-boot path
  and is ignored under GRUB.
- Default kernel moves by PVE 9 point release: **6.14.x** on 9.0, **6.17.x** on 9.1, and **7.0** on
  current 9.2. 6.8 (the PVE 8 default) is gone.
- **Install `amd64-microcode`** from Debian `non-free-firmware`. On a Ryzen 6800H this delivers
  AMD's CPU errata/security fixes via early-microcode loading. Reboot required.
- **Secure Boot is supported and signed** since PVE 8.1, but for a headless home single node it is
  **optional and adds friction** (every custom/out-of-tree module needs MOK enrolment).
  Recommendation: leave Secure Boot **off** unless you have a specific threat model that needs it.
- **Serial console on the host bootloader is fully feasible** and is the single most valuable
  accessibility win here: configure GRUB's serial terminal + `console=ttyS0` so even early boot
  (GRUB menu + kernel boot) is on the serial line. Steps below.

---

## 1. How PVE 9 boots: bootloader selection rule

The selection rule (unchanged in spirit from PVE 8) is:

> "For EFI Systems installed with ZFS as the root filesystem systemd-boot is used, unless Secure
> Boot is enabled. All other deployments use the standard GRUB bootloader."

Decoded for the possible cases:

- **UEFI + ZFS root + Secure Boot OFF** uses **systemd-boot**.
- **UEFI + ZFS root + Secure Boot ON** uses **GRUB** (shim chain).
- **UEFI + ext4 / xfs / BTRFS root** (Secure Boot on or off) uses **GRUB**.
- **Legacy BIOS** (any FS) uses **GRUB** in BIOS mode, installed to the 1 MB BIOS Boot Partition.

=> **This BTRFS node uses GRUB in UEFI mode.**

### The installer's partition layout (every selected disk)

- 1 MB BIOS Boot Partition (gdisk type EF02) - for legacy/BIOS GRUB.
- 512 MB EFI System Partition (ESP, vfat, gdisk type EF00).
- Remaining space - the root filesystem (here BTRFS) / data.

ESPs are kept **unmounted** during normal operation (to avoid vfat corruption on a crash);
`proxmox-boot-tool` mounts them only transiently when syncing.

Cite: Proxmox VE Host Bootloader wiki
([Host Bootloader](https://pve.proxmox.com/wiki/Host_Bootloader)); pve-docs system-booting.adoc
([pve-docs/system-booting.adoc at master · proxmox/pve-docs](https://github.com/proxmox/pve-docs/blob/master/system-booting.adoc));
pve-docs chapter-sysadmin
([Host System Administration](https://pve.proxmox.com/pve-docs/chapter-sysadmin.html)).

---

## 2. proxmox-boot-tool - what it is and whether it runs on a BTRFS root

`proxmox-boot-tool` keeps the contents of the ESP(s) configured and synchronized: it copies the
selected kernel + initrd images onto every managed vfat ESP and configures the bootloader (GRUB or
systemd-boot) to boot from them. This is what lets ZFS/BTRFS root work without a separate boot pool
and keeps redundant ESPs in lockstep on multi-disk setups.

**Does it run on BTRFS/ext4 root?** YES, when the system was installed by the Proxmox installer on
such roots its ESP is registered with `proxmox-boot-tool`. The official wiki states plainly:

> "Running `proxmox-boot-tool refresh` is the equivalent to running `update-grub` on systems with
> ext4 or xfs on root."

So on this node, the direct command to remember is `proxmox-boot-tool refresh`. Current Proxmox docs
also say `update-grub` can trigger a refresh on proxmox-boot-tool systems, and
`update-initramfs`/`apt` trigger refreshes when needed.

> GOTCHA / CONFLICTING SOURCE: Some third-party write-ups (e.g. free-pmx.org) claim
> proxmox-boot-tool is "not at use on non-ZFS UEFI installs." That is **inaccurate for current
> installer-made systems** - the official wiki's "equivalent to update-grub on ext4/xfs root" line
> and the per-disk ESP design show it is in use. Always confirm on the actual box with
> `proxmox-boot-tool status` rather than trusting blog generalizations.

### How to tell what your system is doing (run these first)

```bash
proxmox-boot-tool status # lists managed ESPs + which bootloader/mode
efibootmgr -v # shows UEFI boot entries; grubx64.efi vs systemd-bootx64.efi
cat /etc/kernel/proxmox-boot-uuids # one UUID line per ESP that proxmox-boot-tool manages
```

- `proxmox-boot-tool status` printing one or more `<UUID> (grub)` / `(grub-uefi)` / `(systemd-boot)`
  lines => the tool manages the ESP(s).
- If it prints "E: ... not configured" / "uninitialized", the tool is NOT in charge (rare for
  installer systems; common only on hand-built/Debian-on-top installs).
- `/etc/kernel/proxmox-boot-uuids` is the authoritative list of managed ESPs.

Cite: Host Bootloader wiki; chapter-sysadmin.

---

## 3. proxmox-boot-tool command reference (all shell, accessible)

```bash
# Inspect
proxmox-boot-tool status

# Kernel list management (what gets synced to the ESP)
proxmox-boot-tool kernel list # all bootable kernels + which are pinned
proxmox-boot-tool kernel add <abi-version> # e.g. 6.14.8-2-pve (keep + sync this kernel)
proxmox-boot-tool kernel remove <abi-version> # stop keeping/syncing it

# Pinning (boot a specific kernel)
proxmox-boot-tool kernel pin <abi-version> # pin permanently
proxmox-boot-tool kernel pin <abi-version> --next-boot # pin for the NEXT boot only (test)
proxmox-boot-tool kernel unpin # remove permanent pin
proxmox-boot-tool kernel unpin --next-boot # clear a one-shot next-boot pin

# Sync after ANY manual change (kernel list, cmdline, etc.)
proxmox-boot-tool refresh # copies kernels+initrds to all ESPs and configures the bootloader

# ESP (re)initialization - for adding/recreating an ESP
proxmox-boot-tool format /dev/nvme0n1pX # format a partition as a synced ESP
proxmox-boot-tool init /dev/nvme0n1pX # register an existing unmounted ESP
proxmox-boot-tool init /dev/nvme0n1pX grub # force GRUB mode instead of systemd-boot
proxmox-boot-tool reinit # re-run init on all already-registered ESPs
proxmox-boot-tool clean # drop stale UUIDs no longer present
```

Notes:

- `<abi-version>` is the ABI name as shown by `proxmox-boot-tool kernel list` or `uname -r` (e.g.
  `6.14.8-2-pve`), NOT the package name.
- `refresh` is the catch-all "apply" command. `update-initramfs` and `apt` trigger it automatically
  when needed, so most of the time you only call it manually after editing the kernel cmdline.
- The `init ... grub` override is the relevant one for keeping a UEFI box on GRUB (e.g. for Secure
  Boot or for predictable serial-console GRUB behaviour).

Cite: Host Bootloader wiki; chapter-sysadmin; system-booting.adoc.

---

## 4. PVE 9 kernel line, opt-in kernels, pinning

### Versions (CONFIRMED)

- **PVE 9.0 default kernel: Linux 6.14.x** (early shipping build `6.14.8-2-pve`), based on the
  Ubuntu kernel, on a Debian 13 "trixie" userland.
- **PVE 9.1 default kernel: Linux 6.17.x** (release build `6.17.2-1-pve`).
- **PVE 9.2 default kernel: Linux 7.0**. A current 2026 fresh install should be expected to land on
  the 7.0 line unless you install from older media or intentionally pin another kernel.

> DELTA from PVE 8: PVE 8's default was 6.8 (later 6.8.x); the 6.5/6.8 line is replaced. Mid-2026 a
> fully updated PVE 9 node is realistically on **7.0** if it tracks the current 9.2 line, or on
> **6.14.x/6.17.x** only if it was installed earlier or pinned. Confirm with `uname -r` and
> `proxmox-boot-tool kernel list`.

### Kernel compatibility caveats

Treat kernel compatibility notes as point-release facts, not permanent PVE 9 rules:

- **NVIDIA vGPU:** older 6.14-only advice is obsolete. PVE 9.1 release notes say NVIDIA vGPU
  Software 19.4 is compatible with kernel 6.17. The current Proxmox NVIDIA vGPU page lists PVE 9.2.2
  with kernel `7.0.2-6-pve` tested against vGPU Software branches 19.5 and 20.1. If you use vGPU,
  match the NVIDIA vGPU branch, host driver, guest driver, and PVE kernel from the current NVIDIA
  vGPU support table, and keep `proxmox-default-headers` or the matching `proxmox-headers-*` package
  installed for DKMS.
- **LINSTOR/DRBD:** the 9.1 release history recorded a kernel 6.17 DKMS compatibility issue for
  LINSTOR/DRBD. This corpus does not use LINSTOR or DRBD; if you do, verify the current LINSTOR
  plugin and DRBD kernel-module status before taking a new kernel.
- **Dell PowerEdge 6.17 boot issue:** the 9.1 known issue concerned some Dell PowerEdge servers on
  kernel 6.17. Current 9.2 defaults to kernel 7.0, so do not keep an old 6.14 pin unless you have
  reproduced a hardware-specific regression and have a plan to unpin after a fixed kernel ships.
- **AMD Zen 5 RDSEED:** the 9.1 release history notes an RDSEED issue on Zen 5 systems with kernels
  6.17.9 and newer when microcode is missing or outdated. This Ryzen 6800H is not Zen 5, but the
  general lesson applies: keep BIOS/UEFI and `amd64-microcode` current before blaming QEMU.

### Pinning a specific kernel for testing

To test a specific installed kernel safely (auto-revert on next boot if it hangs - very useful when
you cannot see the screen): pin it `--next-boot`, and if it boots fine make the pin permanent; if it
hangs, a power-cycle returns to the previous default.

```bash
proxmox-boot-tool kernel list
proxmox-boot-tool kernel pin <abi-version> --next-boot
reboot
# good: proxmox-boot-tool kernel pin <abi-version> ; proxmox-boot-tool refresh
# bad: power-cycle returns to the prior default automatically
```

> SECURITY NOTE: a permanent pin freezes you on one kernel and you stop getting kernel security
> updates booted. Pin only to work around a regression, then `unpin` once a fixed kernel ships.

Cite: Proxmox VE Roadmap release history (9.0, 9.1, 9.2 kernels and known issues); NVIDIA vGPU on
Proxmox VE wiki (current tested PVE/kernel/vGPU driver table); system-booting.adoc; Host Bootloader
wiki.

---

## 5. initramfs (update-initramfs)

The initramfs builds the early-userspace image that mounts the BTRFS root and also carries the
**early CPU microcode** blob (see microcode section).

```bash
update-initramfs -u # rebuild initramfs for the current kernel
update-initramfs -u -k all # rebuild for ALL installed kernels
```

- On a proxmox-boot-tool system, `update-initramfs` **automatically triggers a
  `proxmox-boot-tool refresh`**, so the rebuilt initrd is copied to the ESP. You normally don't call
  refresh separately after this.
- Rebuild the initramfs after: installing `amd64-microcode`, changing `/etc/initramfs-tools/`
  config, or after certain driver/firmware changes.

> BTRFS-ROOT GOTCHA: the initramfs must contain the btrfs module and correct root reference.
> Installer-built systems handle this; if you ever rebuild or migrate the root, verify the new
> initrd boots (use the `--next-boot` pin trick) before removing the old kernel.

Cite: chapter-sysadmin; Host Bootloader wiki.

---

## 6. AMD CPU microcode (amd64-microcode) - DO THIS on the Ryzen 6800H

### Why it matters

The Ryzen 6800H (Zen 3+, "Rembrandt") ships with whatever microcode the mini-PC's UEFI baked in,
which is often old. `amd64-microcode` lets Linux load a **newer AMD microcode revision at early
boot**, fixing CPU errata and security vulnerabilities. Per Proxmox: "Microcode updates are intended
to fix found security vulnerabilities and other serious CPU bugs," and a patched microcode is
usually faster than running with kernel software mitigations on unpatched silicon. It is
firmware-loaded fresh each boot - non-persistent, re-applied every time.

### Step 1 - enable Debian `non-free-firmware` (Debian 13 Deb822 format)

> DELTA: PVE 9 is on **Debian 13 "trixie"**, which uses the **Deb822 `.sources`** format in
> `/etc/apt/sources.list.d/*.sources` (the old single-line `/etc/apt/sources.list` still works
> through ~2029 but new installs use Deb822).

Edit the Debian base sources file (name may be `debian.sources`) and ensure the `Components:` line
includes `non-free-firmware`:

```text
# /etc/apt/sources.list.d/debian.sources (Deb822)
Types: deb
URIs: http://deb.debian.org/debian
Suites: trixie trixie-updates
Components: main contrib non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb
URIs: http://security.debian.org/debian-security
Suites: trixie-security
Components: main contrib non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
```

(If your node still has the legacy one-line format, append `non-free-firmware` to each
`deb http://...debian.org...` line in `/etc/apt/sources.list` instead.)

### Step 2 - install and apply

```bash
apt update
apt install amd64-microcode
update-initramfs -u -k all # embeds the new microcode in early initramfs (usually auto)
reboot # REQUIRED - microcode is applied at boot
```

The `amd64-microcode` postinst normally rebuilds the initramfs itself; the explicit
`update-initramfs` is belt-and-suspenders. On a proxmox-boot-tool system the refresh to the ESP is
automatic.

### Step 3 - verify after reboot

```bash
dmesg | grep -i microcode # look for "microcode updated early to revision ..."
grep -m1 microcode /proc/cpuinfo # shows the loaded microcode revision
journalctl -b | grep -i microcode
```

If you see "microcode updated early to revision 0x..." the early load worked. If you only see a
late/"will be updated" message, confirm the initramfs was rebuilt and the ESP refreshed.

> ACCESSIBILITY TIE-IN: pair the post-microcode reboot with the serial console (Section 8) so you
> can watch the early `microcode updated early` line and the rest of boot over serial.

Cite: Proxmox Firmware Updates wiki
([Firmware Updates](https://pve.proxmox.com/wiki/Firmware_Updates)); Debian SourcesList wiki
([SourcesList](https://wiki.debian.org/SourcesList)); "8 to 9 amd64-microcode warning" forum thread
([8 to 9 | amd64-microcode warning](https://forum.proxmox.com/threads/8-to-9-amd64-microcode-warning.169263/)).

---

## 7. Secure Boot in PVE 9 - supported, but optional for a home node

### Status (CONFIRMED)

- Secure Boot has been **supported and signed since PVE 8.1 (Nov 2023)** and carries into PVE 9. The
  chain is the standard **Microsoft-signed `shim`** to `grub-efi-amd64-signed` to **signed Proxmox
  kernel**.
- Signed components: `shim-signed` (MS-signed shim embedding Proxmox keys), `grub-efi-amd64-signed`,
  and the **Proxmox kernel ships pre-signed** in dedicated `-signed` packages (since 6.5.11-4-pve).
  Kernel module signing is enabled at build time (`CONFIG_MODULE_SIG`, since 6.2.16-8), so in-tree
  modules load under Secure Boot without manual signing.
- Secure Boot only applies to **UEFI + GRUB** here (which is what a BTRFS node uses), so the chain
  is compatible with this hardware in principle.

### Two enable approaches

1. **Custom DB key** - full control, but you sign every boot component yourself.
2. **shim + MOK (Machine Owner Key)** - uses the vendor-trusted MS signature; Proxmox recommends
   this if unsure. You only enrol a MOK for _custom / out-of-tree_ kernel modules (e.g. ZFS DKMS,
   some NIC/GPU drivers).

### Recommendation for THIS single home node: leave Secure Boot OFF

Reasons specific to a headless, screen-reader, single-node homelab:

- **MOK enrolment is interactive at the firmware/MOK-Manager screen**, which is _not_ on the serial
  console and is hard to drive blind. Every out-of-tree module rebuild can re-trigger this. That is
  exactly the kind of GUI/early-screen interaction you want to avoid.
- The security benefit (preventing tampered-bootloader attacks) is low for a home node with physical
  control and no untrusted local users.
- Turning it off keeps kernel testing/pinning and any future DKMS modules friction-free.

If you later want it, enable it via the **shim + MOK** path per the wiki, and do the MOK enrolment
with a monitor temporarily attached (one-time).

Cite: Proxmox Secure Boot Setup wiki
([Secure Boot Setup](https://pve.proxmox.com/wiki/Secure_Boot_Setup)).

---

## 8. Serial console on the HOST bootloader + kernel (the big accessibility win)

Goal: get the **GRUB menu and the kernel boot messages** onto the serial line (`ttyS0`) so early
boot is capturable - not just the post-boot login getty. This is feasible on GRUB (this node's
bootloader). Three layers:

### 8a. Kernel command line to serial console

Because this node uses **GRUB via proxmox-boot-tool**, edit the GRUB cmdline, NOT
`/etc/kernel/cmdline`:

```bash
# /etc/default/grub
GRUB_CMDLINE_LINUX_DEFAULT="quiet console=tty0 console=ttyS0,115200n8"
```

The **last** `console=` becomes the primary console that gets the boot log and a login prompt;
listing `tty0` first then `ttyS0` gives you both screen and serial, with serial primary.

### 8b. GRUB menu itself to serial terminal

Add to `/etc/default/grub` so the GRUB _menu_ (not just the kernel) is on serial:

```bash
# /etc/default/grub
GRUB_TERMINAL="console serial"
GRUB_SERIAL_COMMAND="serial --speed=115200 --unit=0 --word=8 --parity=no --stop=1"
```

Optionally raise `GRUB_TIMEOUT` (e.g. `10`) so you have time to pick a kernel over serial.

### 8c. Apply (proxmox-boot-tool path)

```bash
proxmox-boot-tool refresh # regenerate boot entries and sync the ESP directly
# update-grub can also trigger the hook on proxmox-boot-tool systems; refresh is explicit.
reboot
```

### 8d. Login getty on serial (post-boot)

```bash
systemctl enable --now serial-getty@ttyS0.service
```

### Feasibility / notes

- **Feasible end-to-end on GRUB**: GRUB serial terminal + `console=ttyS0` gives you the menu, the
  kernel ring buffer, and a login - full early-boot capture.
- Match the baud (`115200`) on both GRUB and kernel lines and on whatever you connect with
  (USB-serial adapter or the mini-PC's COM header / BIOS console redirection). Also enable
  **BIOS/UEFI console redirection** in firmware if you want the pre-GRUB POST too - that part is
  firmware-dependent and outside PVE.
- > GOTCHA: do NOT put serial flags in `/etc/kernel/cmdline` on this node - that file is only
  > consulted under **systemd-boot**. On GRUB it is ignored, and you would wrongly conclude serial
  > "doesn't work." Use `/etc/default/grub`.
- If this were a ZFS-root systemd-boot node, the equivalent would be editing `/etc/kernel/cmdline`
  (one line, append `console=ttyS0,115200n8`) then `proxmox-boot-tool refresh`; systemd-boot has no
  GRUB-style serial menu config.

Cite: Host Bootloader wiki (kernel cmdline / refresh); chapter-sysadmin (GRUB cmdline editing);
Proxmox serial console wiki guidance.

---

## 9. BTRFS-root + bootloader gotchas (flagged)

- **PVE 8 to 9 BTRFS boot regression seen in the wild**: forum reports of nodes landing on a bare
  "Welcome to GRUB" prompt then rebooting after the 8 to 9 upgrade on BTRFS. Root cause is GRUB /
  ESP sync state across the upgrade. Have a recovery plan (Proxmox "Recover From GRUB Failure" wiki,
  and a live USB) and, on a single node, take a backup before the major upgrade.
  ([\[SOLVED\] - PVE 8 to 9 ... "Welcome to GRUB" then reboot (BTRFS)](https://forum.proxmox.com/threads/pve-8-to-9-welcome-to-grub-then-reboot-btrfs.169676/))
- **GRUB's BTRFS support is more fragile than ext4**: subvolume layout and compression options can
  confuse GRUB's btrfs reader. Keep the default installer subvolume layout; avoid exotic `compress=`
  on the subvolume GRUB must read from unless you have tested it.
- **Single ESP = single point of boot failure**. With one NVMe there is exactly one ESP.
  `proxmox-boot-tool status` should list it; if it ever shows as unconfigured, re-`init` it.
  Consider periodically backing up the ESP contents.
- **Apply boot changes with `proxmox-boot-tool refresh`** so the synced ESP copy stays in step.
  Current Proxmox docs also describe `update-grub` as a valid GRUB apply path when its
  proxmox-boot-tool hook is present, but `refresh` is the less ambiguous command for this corpus.
- **Pin to security drift**: a permanent kernel pin stops new kernels from booting; unpin once a
  regression is fixed.
- **Confirm reality on the box**: run `proxmox-boot-tool status`, `efibootmgr -v`, `findmnt /`, and
  `uname -r` before trusting any generic guide (third-party blogs disagree about whether
  proxmox-boot-tool manages non-ZFS roots - the box's own `status` output is authoritative).

---

## 10. Quick command cheat-sheet (this node)

```bash
# Identify boot setup
proxmox-boot-tool status
efibootmgr -v
findmnt / # confirm BTRFS root
uname -r # running kernel

# Kernel mgmt
proxmox-boot-tool kernel list
proxmox-boot-tool kernel pin <ver> --next-boot # safe test
proxmox-boot-tool kernel unpin
proxmox-boot-tool refresh

# Microcode (AMD)
# (ensure non-free-firmware in /etc/apt/sources.list.d/debian.sources)
apt update && apt install amd64-microcode
update-initramfs -u -k all
reboot
dmesg | grep -i microcode

# Serial console: edit /etc/default/grub (GRUB_CMDLINE_LINUX_DEFAULT + GRUB_TERMINAL/SERIAL),
# then:
proxmox-boot-tool refresh
systemctl enable --now serial-getty@ttyS0.service
reboot
```

---

## Sources

- Proxmox VE Host Bootloader wiki: [Host Bootloader](https://pve.proxmox.com/wiki/Host_Bootloader)
- Proxmox VE chapter-sysadmin (admin guide):
  [Host System Administration](https://pve.proxmox.com/pve-docs/chapter-sysadmin.html)
- pve-docs system-booting.adoc:
  [pve-docs/system-booting.adoc at master · proxmox/pve-docs](https://github.com/proxmox/pve-docs/blob/master/system-booting.adoc)
- Proxmox VE Secure Boot Setup wiki:
  [Secure Boot Setup](https://pve.proxmox.com/wiki/Secure_Boot_Setup)
- Proxmox VE Firmware Updates wiki:
  [Firmware Updates](https://pve.proxmox.com/wiki/Firmware_Updates)
- Proxmox VE 9.0 press release:
  [Proxmox Virtual Environment 9.0 with Debian 13 released](https://www.proxmox.com/en/about/company-details/press-releases/proxmox-virtual-environment-9-0)
- NVIDIA vGPU on Proxmox VE wiki:
  [NVIDIA vGPU on Proxmox VE](https://pve.proxmox.com/wiki/NVIDIA_vGPU_on_Proxmox_VE)
- Proxmox VE Roadmap release history (PVE 9.0, 9.1, and 9.2 kernels and known issues):
  [Roadmap](https://pve.proxmox.com/wiki/Roadmap)
- 8 to 9 amd64-microcode warning (forum):
  [8 to 9 | amd64-microcode warning](https://forum.proxmox.com/threads/8-to-9-amd64-microcode-warning.169263/)
- PVE 8 to 9 "Welcome to GRUB" BTRFS (forum):
  [\[SOLVED\] - PVE 8 to 9 ... "Welcome to GRUB" then reboot (BTRFS)](https://forum.proxmox.com/threads/pve-8-to-9-welcome-to-grub-then-reboot-btrfs.169676/)
- Debian SourcesList wiki (Deb822): [SourcesList](https://wiki.debian.org/SourcesList)
- Upgrade from 8 to 9 wiki: [Upgrade from 8 to 9](https://pve.proxmox.com/wiki/Upgrade_from_8_to_9)
