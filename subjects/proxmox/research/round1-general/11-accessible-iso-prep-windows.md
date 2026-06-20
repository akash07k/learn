# Accessible Proxmox VE Automated Install from Windows 11 (blind / screen-reader workflow)

Scope: a blind NVDA/JAWS user on Windows 11 prepares an `answer.toml` automated-install USB,
installs Proxmox VE (8.2+/9.x) onto a single personal PC (single node, no RAID), and reaches the box
headlessly afterward. Every step below is marked as either FULLY ACCESSIBLE or NEEDS BRIEF SIGHTED
HELP.

## TL;DR recommended path

1. Prepare `answer.toml` in a text editor (fully accessible) with `root-ssh-keys` and
   `network.source = "from-dhcp"`.
2. In WSL2 (Debian/Ubuntu), install `proxmox-auto-install-assistant` from the Proxmox repo and run
   `prepare-iso` to bake the answer file into the ISO (`--fetch-from iso`). This is the simplest
   accessible path: one USB stick, no labelling, fully command-line.
3. Flash the prepared ISO to USB with **Rufus** (most screen-reader-usable flasher on Windows).
   Fully accessible.
4. Boot the target PC from USB. The firmware boot-menu / boot-order step is the ONE step that may
   need brief sighted help; once it boots, the "Automated Installation" GRUB entry auto-selects on a
   timeout and runs unattended with no further interaction.
5. After ~10-20 minutes, find the box's IP from the router DHCP lease list / nmap / mDNS and SSH in
   using the key from `answer.toml`. Fully accessible.

The crucial finding: **`prepare-iso` (a Linux-only tool) cannot be avoided**, even for the
"partition" method - but running it inside WSL2 is fully command-line and therefore fully
accessible. The partition method does NOT let a Windows user skip the Linux tool (see below).

## Why the automated installer at all

The Proxmox graphical ISO installer is not screen-reader accessible. The official **Unattended /
Automated Installation** flow (Proxmox VE 8.2+) reads all answers from an `answer.toml` file and
adds a new boot entry "Automated Installation" that runs with zero keyboard/mouse interaction. That
is exactly what makes it usable without sight.

Source: Proxmox VE admin guide section 2.4 "Unattended Installation"
([Proxmox VE Administration Guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.html)) and
[Automated Installation](https://pve.proxmox.com/wiki/Automated_Installation)

## 1. Prepare answer.toml (FULLY ACCESSIBLE - plain text editor)

Write this in Notepad / VS Code / `nano` in WSL. Minimal single-disk, DHCP, SSH-key example:

```toml
[global]
keyboard = "en-us"
country = "us"
fqdn = "pve.home.arpa"
mailto = "you@example.com"
timezone = "America/New_York"
# Either set a root password, or rely purely on SSH keys. Set one anyway as fallback:
root-password = "ChangeMeStrong!"
# THIS is what gives you headless access - put YOUR public key here:
root-ssh-keys = [
 "ssh-ed25519 AAAA...your_public_key... you@windows"
]

[network]
source = "from-dhcp"

[disk-setup]
filesystem = "ext4"
# Pick the disk explicitly to avoid wiping the wrong one (see pitfalls):
disk-list = ["sda"]
```

Notes:

- `keyboard` / `country` / `timezone` matter: a wrong keyboard layout can mangle a typed root
  password - but since you log in by SSH key, this is low-risk. Still set it correctly.
- Generate the SSH key on Windows first (accessible):
  `ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\proxmox` in PowerShell, then paste the contents of
  `proxmox.pub` into `root-ssh-keys`.
- `disk-setup` can also use filter rules (`filter`, `filter-match`) instead of an explicit
  `disk-list`. For a single-disk personal PC an explicit `disk-list = ["sda"]` is safest.
- Validate later with `proxmox-auto-install-assistant validate-answer answer.toml`.

Answer-file structure reference:
[Automated Installation](https://pve.proxmox.com/wiki/Automated_Installation)

## 2. Bake the answer file into the ISO with WSL2 (FULLY ACCESSIBLE - command line)

### 2a. Install the assistant inside WSL2 (Debian or Ubuntu)

`proxmox-auto-install-assistant` is Linux-only and is NOT shipped on the ISO; install it from the
Proxmox `pve-no-subscription` repo. It installs fine on a plain Debian/Ubuntu WSL distro - you do
NOT need a running Proxmox host and you do NOT need a subscription.

Debian 12 (bookworm) WSL - recommended, matches Proxmox base:

```bash
# add the Proxmox no-subscription repo
echo "deb [arch=amd64] http://download.proxmox.com/debian/pve bookworm pve-no-subscription" \
 | sudo tee /etc/apt/sources.list.d/pve-install-repo.list

# add the repo signing key
sudo wget https://enterprise.proxmox.com/debian/proxmox-release-bookworm.gpg \
 -O /etc/apt/trusted.gpg.d/proxmox-release-bookworm.gpg

sudo apt update
sudo apt install -y proxmox-auto-install-assistant xorriso

proxmox-auto-install-assistant --version # verify
```

For Proxmox VE 9.x media use the `trixie` repo line instead:
`deb http://download.proxmox.com/debian/pve trixie pve-no-subscription` with the
`proxmox-release-trixie.gpg` key.

Confirmations:

- The package is in `pve-no-subscription`; a Proxmox staffer confirmed it was simply "missing from
  the documentation" and installs via plain `apt`.
  ([proxmox-auto-install-assistant Installation](https://forum.proxmox.com/threads/proxmox-auto-install-assistant-installation.145905/))
- `xorriso` is the dependency that actually rewrites the ISO; install it explicitly.

### 2b. Get the stock Proxmox ISO and your files into WSL

Download the ISO on Windows (browser, accessible) to e.g. `D:\iso\proxmox-ve_8.4-1.iso`. WSL sees
the Windows drives under `/mnt/`:

```bash
cd /mnt/d/iso
cp /mnt/c/Users/akash/answer.toml . # or edit it here directly with nano
```

### 2c. Validate, then prepare (bake-in) the ISO - the `--fetch-from iso` method

```bash
# sanity-check the answer file first
proxmox-auto-install-assistant validate-answer answer.toml

# bake the answer file directly into the ISO (single-USB method)
proxmox-auto-install-assistant prepare-iso proxmox-ve_8.4-1.iso \
 --fetch-from iso \
 --answer-file answer.toml \
 --output proxmox-ve_8.4-1-auto.iso
```

This produces `proxmox-ve_8.4-1-auto.iso` containing both the installer and your answers. This is
the most accessible path: ONE USB stick, no partition labelling, no HTTP server.

Source for exact flags:
[Automated Installation](https://pve.proxmox.com/wiki/Automated_Installation) and
[I Tried Proxmox Automated Installs and Am Never Going Back](https://www.virtualizationhowto.com/2026/06/i-tried-proxmox-automated-installs-and-am-never-going-back/)

> IMPORTANT version note: a bug caused prepared ISOs to drop to a blank `grub>` prompt when booted
> from USB in UEFI mode on real hardware. Fixed in **proxmox-auto-install-assistant 8.2.6**. Make
> sure `apt` installed at least that version (`proxmox-auto-install-assistant --version`). Otherwise
> the headless boot silently fails.
> ([\[SOLVED\] - Boot from auto-install .iso help](https://forum.proxmox.com/threads/boot-from-auto-install-iso-help.145936/))

### 2d. (Alternative) The partition / `--fetch-from partition` method - does NOT skip the Linux tool

The idea: flash the _stock_ ISO, and put `answer.toml` on a second small FAT partition/USB labelled
`PROXMOX-AIS` (or `proxmox-ais`). The installer searches removable media for that label and reads
the answer from it.

Reality check (important): you STILL must run `prepare-iso ... --fetch-from partition` on the ISO.
That command sets a flag inside the ISO instructing the installer to look for the labelled
partition. A truly untouched stock ISO will NOT search for the partition. So this method does NOT
let a Windows user avoid the Linux-only tool - it just moves where the answer file lives.

```bash
# still required - prepares the ISO to search a labelled partition
proxmox-auto-install-assistant prepare-iso proxmox-ve_8.4-1.iso \
 --fetch-from partition \
 --output proxmox-ve_8.4-1-auto.iso
# default label searched: proxmox-ais / PROXMOX-AIS (override with --partition-label NAME)
```

Then the labelled partition holding `answer.toml` can be created from Windows:

- A FAT32 partition labelled `PROXMOX-AIS` is writable from Windows (Disk Management / `diskpart` /
  `format /FS:FAT32`), so a Windows user can create the answer-carrying media without Linux. But
  because `prepare-iso` is still mandatory, there is no net accessibility win over
  `--fetch-from iso`, and it adds a second stick. **Recommendation: use `--fetch-from iso` instead**
  unless you specifically want to reuse one prepared ISO with swappable answer files.

Sources: [Automated Installation](https://pve.proxmox.com/wiki/Automated_Installation) ; forum
confirmation that prepare-iso is required for the partition label to take effect
([\[SOLVED\] - Getting partition_label error when fetching auto-install answers from iso](https://forum.proxmox.com/threads/getting-partition_label-error-when-fetching-auto-install-answers-from-iso.158158/)).

### 2e. (Alternative) The HTTP / `--fetch-from http` method - more moving parts, flag the URL issue

The installer POSTs system info (as JSON) to a URL and gets the answer back. You can host
`answer.toml` from a tiny server, e.g. in WSL: `python3 -m http.server 8080` (or a small endpoint
that returns the file).

```bash
proxmox-auto-install-assistant prepare-iso proxmox-ve_8.4-1.iso \
 --fetch-from http --url "http://192.168.1.50:8080/answer.toml" \
 --output proxmox-ve_8.4-1-auto-http.iso
```

Discovery / accessibility notes:

- If you EMBED the URL with `--url` at prepare time, no on-screen URL entry is needed - fully
  unattended and accessible. Good.
- Auto-discovery without `--url` uses DHCP option 250 or a DNS TXT record at
  `proxmox-auto-installer.<search-domain>`; configuring those needs router/DNS control.
- If neither an embedded URL nor working auto-discovery is present, the installer would require a
  URL typed at the console - that needs the screen. **Always pass `--url` to avoid this.** For a
  single personal PC the HTTP method is more setup than `--fetch-from iso` buys you; prefer the
  baked-in ISO.

Source: [Automated Installation](https://pve.proxmox.com/wiki/Automated_Installation)

## 3. Write the ISO to USB on Windows (FULLY ACCESSIBLE with Rufus)

Recommendation: **Rufus**. It is a native Win32 app and the most reliably screen-reader- usable USB
flasher on Windows. The core workflow is only three controls:

1. "Device" combo box - select your USB stick.
2. "Select" button - choose the prepared `...-auto.iso`.
3. "Start" button - confirm the "write in DD Image mode" / overwrite prompt, then write.

Accessibility status: Rufus has had specific NVDA/screen-reader bugs filed and addressed by the
maintainer (e.g. unlabelled toolbar buttons in issues #1215 and #1467, the latter closed and
milestoned for a release). The peripheral buttons (VHD, checksum) were the unlabelled ones; the main
device/Select/Start path that you actually need is labelled and operable. Use a current Rufus
version. Sources:
[Accessibility issues · Issue #1467 · pbatard/rufus](https://github.com/pbatard/rufus/issues/1467) ,
[Two controls in Rufus main windows lacks proper labels for assistive technologies. · Issue #1215 · pbatard/rufus](https://github.com/pbatard/rufus/issues/1215)

When Rufus prompts, choose **"Write in DD Image mode"** (the Proxmox ISO is a hybrid image; DD mode
writes it byte-for-byte and boots reliably). Then acknowledge the data-destruction prompt.

Alternatives and why they rank lower:

- **balenaEtcher**: Electron/Chromium UI. Electron apps are frequently inconsistent with NVDA (focus
  and unlabelled controls), and Etcher gives less control over write mode. Not recommended as first
  choice for a screen-reader user.
- **WSL2 `dd` to the raw USB**: technically possible but fragile and risky on Windows. `wsl --mount`
  explicitly does NOT support USB flash drives; you would need `usbipd-win` to pass the USB through
  to WSL, then `dd if=...-auto.iso of=/dev/sdX bs=4M`. `dd` has no confirmation and a wrong `of=`
  can destroy a disk. More steps, higher risk, no accessibility advantage over Rufus. Avoid unless
  Rufus is unavailable. Sources:
  [Get started mounting a Linux disk in WSL 2](https://learn.microsoft.com/en-us/windows/wsl/wsl2-mount-disk)
  ,
  [Dd On Windows: WSL2, Cygwin, And Native Alternatives](https://www.systutorials.com/how-to-dd-on-windows/)
- Native Windows `dd` ports exist but are unmaintained/unsafe; skip.

## 4. Boot the target PC from USB (THE ONE STEP THAT MAY NEED BRIEF SIGHTED HELP)

The firmware/UEFI boot menu and boot-order screens are NOT screen-reader accessible - this is the
single unavoidable sighted-help moment, and it is brief.

Minimise it with ONE of these:

- **Best, one-time:** have a sighted person, once, enter UEFI setup and set the USB / "UEFI: \<USB
  stick\>" as the first boot device (or enable "boot removable media first"). For this accessible
  home-lab path, also turn **Secure Boot OFF**. Current PVE 8.1+ installer media is signed and can
  boot with Secure Boot enabled, but keeping it off reduces early-boot variables and avoids later
  MOK or third-party module prompts that are not screen-reader friendly.
- **Alternative:** sighted help only to press the one-time boot-menu hotkey (often F12 / F11 / F8 /
  Esc, vendor-dependent) and pick the USB entry. A few seconds of help.
- Some PCs already boot removable media first by default - try inserting the USB and powering on
  before arranging help; it may "just work."

After it boots from USB, NO further sight is needed: the prepared ISO shows a GRUB menu whose
default entry is **"Automated Installation"**, and it auto-selects after a ~10-second timeout and
runs completely unattended. You do not have to see or touch anything during install. Sources:
[Installation](https://pve.proxmox.com/wiki/Installation) ; GRUB auto-select-after-timeout behaviour
confirmed
([\[SOLVED\] - Boot from auto-install .iso help](https://forum.proxmox.com/threads/boot-from-auto-install-iso-help.145936/)).

Reliability prerequisites so the headless boot does not stall:

- Use `proxmox-auto-install-assistant` >= 8.2.6 (fixes the UEFI-USB blank-`grub>` bug).
- Secure Boot disabled for this guide's recommended path, even though current PVE 8.1+ installer
  media supports Secure Boot.
- Confirm whether the firmware is set to UEFI vs Legacy; if UEFI USB boot misbehaves on old
  hardware, Legacy/CSM boot of the same stick is a fallback (decide with the one-time sighted helper
  while they are in the firmware).

## 5. Headless post-install verification (FULLY ACCESSIBLE)

The install runs unattended and the machine reboots into Proxmox on its own. With no monitor you
confirm success purely over the network.

Checklist (run from Windows PowerShell or WSL):

1. **Wait** ~10-20 minutes from power-on (install + first reboot). SSD installs are faster.
2. **Find the IP** (any one):

- Router admin page to DHCP lease list; look for the hostname `pve` / your `fqdn`. Most reliable.
- mDNS (if avahi is installed on the host, guide 10): `ping pve.local` from Windows.
- DNS by name (if the sinkhole is your resolver, recipe 01): `ping pve.home.arpa` from Windows.
- Scan the subnet for the Proxmox web port 8006:
- WSL/nmap: `nmap -p 8006 --open 192.168.1.0/24`
- PowerShell (no nmap):

```powershell
1..254 | % { $ip="192.168.1.$_"; if(Test-Connection -Count 1 -Quiet $ip){ if((Test-NetConnection $ip -Port 8006 -WarningAction SilentlyContinue).TcpTestSucceeded){"$ip : 8006 open"} } }
```

- `arp -a` after pinging the broadcast/subnet, to list responding MACs/IPs.

1. **Confirm services are up**: TCP 22 (SSH) and TCP 8006 (web GUI) open on that IP.
2. **SSH in with the key** from `answer.toml`: `ssh -i $env:USERPROFILE\.ssh\proxmox root@<IP>`
   (root SSH-key login works because you put the public key in `root-ssh-keys`.)
3. **Verify the host**: `pveversion`, `ip a` (NIC up, has the expected IP), `zpool status` or
   `lsblk` (correct disk used), `systemctl is-system-running`.
4. Optional: reach the web GUI at `https://<IP>:8006` for completeness (the GUI itself is a web app
   and generally more navigable than the ISO installer).

Sources:
[Can't find my (headless) Proxmox install on the network.](https://forum.proxmox.com/threads/cant-find-my-headless-proxmox-install-on-the-network.134282/)
,
[Setting Up a Headless Proxmox Server: My Journey and Lessons Learned](https://ashinto.sh/blog/setting-up-a-headless-proxmox-server/)

## 6. Community wisdom & pitfalls (real reports)

- **prepare-iso is mandatory for ALL fetch methods** (iso, partition, http). A stock, untouched ISO
  will not auto-install. (wiki + forum)
- **UEFI + USB blank `grub>` bug**: fixed in assistant 8.2.6; older versions silently fail to reach
  the installer on real UEFI hardware. Verify your tool version.
  ([\[SOLVED\] - Boot from auto-install .iso help](https://forum.proxmox.com/threads/boot-from-auto-install-iso-help.145936/))
- **Secure Boot**: current PVE 8.1+ installer media supports Secure Boot, and the official
  installation docs only require disabling it for pre-8.1 installers. This accessible home-lab path
  still recommends OFF to reduce early-boot and MOK friction.
  ([Secure Boot Setup](https://pve.proxmox.com/wiki/Secure_Boot_Setup))
- **Wrong disk wiped**: the automated installer formats whatever the disk rule matches. On a
  multi-disk box, an over-broad filter can wipe the wrong disk. Use an explicit
  `disk-list = ["sda"]` and double-check the device name. Use `validate-answer`.
  ([\[SOLVED\] - answer.toml: disk-setup doesn't work when using --fetch-from iso](https://forum.proxmox.com/threads/answer-toml-disk-setup-doesnt-work-when-using-fetch-from-iso.145944/))
- **Keyboard layout**: wrong `keyboard` can corrupt a typed root password - mitigated by logging in
  via SSH key rather than password.
- **Network not coming up**: `from-dhcp` needs a DHCP server and a recognised NIC. If the NIC needs
  non-default naming, use `network.interface-name-pinning`. If the box never appears on the network,
  network/NIC config is the usual culprit; a serial console (terminal-mode installer) is the
  headless fallback for diagnosis.
  ([Can't find my (headless) Proxmox install on the network.](https://forum.proxmox.com/threads/cant-find-my-headless-proxmox-install-on-the-network.134282/))
- **Rufus DD mode**: write the hybrid ISO in DD Image mode, not ISO/partition mode, for a reliably
  bootable stick.

## Accessibility summary table (plain list)

- answer.toml authoring - FULLY ACCESSIBLE (text editor).
- Install assistant in WSL2 + prepare-iso - FULLY ACCESSIBLE (command line).
- Flashing USB with Rufus - FULLY ACCESSIBLE (3-control workflow; use current version, DD mode).
- Booting target from USB / firmware boot order + optional Secure Boot change - NEEDS BRIEF SIGHTED
  HELP (one-time; set USB first, turn Secure Boot off for this guide's simpler path, then unattended
  forever after).
- Unattended install itself - FULLY ACCESSIBLE (auto-selected GRUB entry, no interaction).
- Find IP + SSH in - FULLY ACCESSIBLE (router leases / nmap / mDNS + SSH key).

## Sources

- Proxmox VE wiki, Automated Installation:
  [Automated Installation](https://pve.proxmox.com/wiki/Automated_Installation)
- Proxmox VE admin guide (2.4 Unattended Installation):
  [Proxmox VE Administration Guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.html)
- Proxmox VE wiki, Installation: [Installation](https://pve.proxmox.com/wiki/Installation)
- Proxmox VE wiki, Secure Boot Setup:
  [Secure Boot Setup](https://pve.proxmox.com/wiki/Secure_Boot_Setup)
- Forum, installing proxmox-auto-install-assistant:
  [proxmox-auto-install-assistant Installation](https://forum.proxmox.com/threads/proxmox-auto-install-assistant-installation.145905/)
- Forum, boot from auto-install ISO / UEFI bug fixed in 8.2.6:
  [\[SOLVED\] - Boot from auto-install .iso help](https://forum.proxmox.com/threads/boot-from-auto-install-iso-help.145936/)
- Forum, partition_label / prepare-iso required:
  [\[SOLVED\] - Getting partition_label error when fetching auto-install answers from iso](https://forum.proxmox.com/threads/getting-partition_label-error-when-fetching-auto-install-answers-from-iso.158158/)
- Forum, disk-setup with fetch-from iso:
  [\[SOLVED\] - answer.toml: disk-setup doesn't work when using --fetch-from iso](https://forum.proxmox.com/threads/answer-toml-disk-setup-doesnt-work-when-using-fetch-from-iso.145944/)
- Forum, can't find headless Proxmox on network:
  [Can't find my (headless) Proxmox install on the network.](https://forum.proxmox.com/threads/cant-find-my-headless-proxmox-install-on-the-network.134282/)
- Walkthrough (VirtualizationHowto):
  [I Tried Proxmox Automated Installs and Am Never Going Back](https://www.virtualizationhowto.com/2026/06/i-tried-proxmox-automated-installs-and-am-never-going-back/)
- Headless Proxmox setup blog:
  [Setting Up a Headless Proxmox Server: My Journey and Lessons Learned](https://ashinto.sh/blog/setting-up-a-headless-proxmox-server/)
- Rufus accessibility issues (#1467, #1215):
  [Accessibility issues · Issue #1467 · pbatard/rufus](https://github.com/pbatard/rufus/issues/1467)
  ,
  [Two controls in Rufus main windows lacks proper labels for assistive technologies. · Issue #1215 · pbatard/rufus](https://github.com/pbatard/rufus/issues/1215)
- WSL2 mount disk (USB limitation):
  [Get started mounting a Linux disk in WSL 2](https://learn.microsoft.com/en-us/windows/wsl/wsl2-mount-disk)
- dd on Windows / WSL2:
  [Dd On Windows: WSL2, Cygwin, And Native Alternatives](https://www.systutorials.com/how-to-dd-on-windows/)
