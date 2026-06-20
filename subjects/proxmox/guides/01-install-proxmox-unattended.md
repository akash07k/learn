# Install Proxmox VE 9 unattended with answer.toml

## What you'll be able to do

By the end of this guide you will have taken a blank personal PC to a running Proxmox VE 9 host with
a btrfs root filesystem, reachable over SSH from your control station, without ever needing to read
the graphical installer. You author one text file, bake it into the installer ISO from inside WSL2,
flash the result to a USB stick, and boot the target once. The only moment that needs sighted help
is a brief, one-time visit to the machine's BIOS/UEFI setup; everything before and after it is plain
text on your control station.

## The big picture

The normal Proxmox VE installer is a graphical screen. It draws menus and form fields that a screen
reader cannot announce, so working through it by sight is the one part of standard Proxmox setup
that is genuinely inaccessible. Proxmox's own answer to this is the **Unattended Installation**
flow, introduced in Proxmox VE 8.2 and standard in 9.x: instead of answering the installer's
questions on screen, you write every answer ahead of time into a file called `answer.toml`, and the
installer reads them and installs with zero on-screen interaction.

That single fact is what makes the install accessible. There is no installer screen to interact
with. You compose a text file (fully accessible), prepare an ISO with a command-line tool (fully
accessible), flash that ISO to USB with one accessible Windows app, and boot the target. The
installer auto-selects an "Automated Installation" boot entry on a short timeout, partitions the
disk, installs Proxmox, and reboots into the finished system on its own.

Because you bake your SSH public key into the answer file, the moment the host finishes its first
boot it is already reachable over SSH. You never see its local screen, and you never need to. The
rest of this guide is the concrete recipe.

## Step 1 - Author answer.toml

The answer file is plain TOML. In Proxmox VE 9 the schema uses **kebab-case** keys (hyphens, not
underscores); the old snake_case keys such as `disk_setup` and `root_password` are deprecated and
`validate-answer` will warn about them, so use hyphens throughout.

Below is a complete, commented answer file for this corpus's target: one disk, a btrfs root, an
address from DHCP, and login by SSH key. The install disk is matched by its **serial number** rather
than by `sda`, so the right disk is chosen even if the kernel names the disks in a different order
on a given boot. A note on btrfs before the file: in Proxmox VE 9 the btrfs integration is still
labelled a **technology preview**, meaning Proxmox does not position it as production-grade. For
this single-disk home host it is a deliberate choice (it gives you checksums, compression, and
instant snapshots on one disk), but be aware of the preview status.

Write this file on your control station (any text editor) or inside WSL with `nano`. Use a folder
such as `D:\iso` or `C:\iso` and adjust the `/mnt/` path to match; this guide uses
`D:\iso\answer.toml`, which WSL sees as `/mnt/d/iso/answer.toml`.

### Generate your SSH key first

The answer file below needs your **public** key in `root-ssh-keys`, so generate the keypair before
you write the file. On the control station, in PowerShell:

```powershell
ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\proxmox -C "proxmox"
```

It will prompt for a passphrase; using one is recommended (you type it on first connect, not during
the install). This creates two files: `proxmox` (the private key, which never leaves the control
station) and `proxmox.pub` (the public key). The PUBLIC key, `proxmox.pub`, is what goes in
`root-ssh-keys`.

Print the public key so you can paste it:

```powershell
Get-Content $env:USERPROFILE\.ssh\proxmox.pub
```

That prints a single line beginning `ssh-ed25519 AAAA...`. Paste that whole line into the
`root-ssh-keys` array below, replacing the placeholder entry.

The file `answer.toml`:

```toml
# answer.toml -- single-node home Proxmox VE 9: btrfs on one disk, DHCP, SSH-key login.

[global]
keyboard = "en-us"
country = "us"
# Static hostname for the node. A .home.arpa name is the right choice on a home LAN.
fqdn = "pve.home.arpa"
# Root notification email (where the node mails alerts).
mailto = "you@example.com"
timezone = "America/New_York"
# Hashed root password. NEVER store the plaintext here -- see "Generate the password hash" below.
root-password-hashed = "$y$j9T$RXxfPAHqPMqk41tKVbXP./$TQkN9KnjzT0sSUFIYV33HkZe4bwD9U5brWuhnXaIHn0"
# Your SSH public key(s). THIS is what makes the host reachable headless on first boot.
# Put YOUR public key here, one entry per array element. Use the PUBLIC key (the .pub file).
root-ssh-keys = [
 "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyReplaceMe you@control-station"
]
# Pause (do NOT loop-reboot) if the install fails, so the error stays on screen for a helper.
reboot-on-error = false
reboot-mode = "reboot"

[network]
# Take the IP, gateway, and DNS from the LAN's DHCP server. Easiest for a single home node.
source = "from-dhcp"

[disk-setup]
# btrfs root on a SINGLE disk. NOTE: btrfs is a Proxmox technology preview.
filesystem = "btrfs"
# Single-device btrfs: btrfs.raid is REQUIRED. Set btrfs.raid = "raid0" -- that is how you name
# "one disk" to this installer (there is no "single" value). Omitting it makes validate-answer
# fail with: Btrfs raid level 'btrfs.raid' must be set. Use raid1/raid10 only with multiple disks.
btrfs.raid = "raid0"
# compress accepts on/off/zlib/lzo/zstd (default off); zstd is a good general-purpose choice.
btrfs.compress = "zstd"
# Optional: leave headroom on the disk in GB (omit to use the whole disk).
# btrfs.hdsize = 200
# Match the install disk by serial, which is stable across reboots. Find and test it with the
# device-info / device-match commands shown below, then paste the real serial glob here.
filter.ID_SERIAL = "CT1000MX500SSD1_*"
```

A few points about this file:

- `root-ssh-keys` is the single most important line for an accessible install. It bakes your public
  key into the host so that key-based SSH login works the instant the host comes up. Without it you
  would have no accessible way in if anything about the network differs from what you expected. This
  is the `proxmox.pub` line you generated in "Generate your SSH key first" above.
- For a single disk, set `btrfs.raid = "raid0"`. btrfs requires a raid level: omitting `btrfs.raid`
  makes `validate-answer` fail with "Btrfs raid level 'btrfs.raid' must be set". There is no
  `single` value; `raid0` is the single-disk form, and `raid1`/`raid10` need multiple disks.
- btrfs has no installer-created swap (the LVM swap knobs do not apply to it). If you want swap,
  reserve space with `btrfs.hdsize` here and add a swap file after install.

### Generate the password hash

Even though you log in by SSH key, set a root password too, as a fallback. Store only the **hash**,
never the plaintext, so the password is not sitting in the file or the ISO. Generate one of these on
any Linux box (including your WSL Debian) and paste the result verbatim into `root-password-hashed`:

```bash
# yescrypt (the modern default on Debian 13; prints a $y$... string)
mkpasswd --method=yescrypt
# mkpasswd comes from the 'whois' package: apt install whois

# OR SHA-512 crypt via openssl (prints a $6$... string)
openssl passwd -6
```

Both prompt for the password and print the hash. Either hash form is accepted by the installer.

### Choosing the install disk

There is a chicken-and-egg problem with `filter.ID_SERIAL`: reading a disk's serial means running
`device-info` on the target hardware, and the only on-target shells available before you have
flashed anything are the official ISO's terminal/debug shell (graphical, not screen-reader
accessible) or a Linux live USB. So for a single-NVMe build, the simplest accessible path is to skip
the serial entirely:

- If you have confirmed the host has exactly **one** disk, replace the `filter.ID_SERIAL` line with
  `disk-list = ["nvme0n1"]` (or `disk-list = ["sda"]` for a SATA/USB disk). With a single disk there
  is no wrong device to match, so the explicit name is both safe and the beginner path.

If you want the precise serial filter anyway - the right choice whenever the machine has any second
disk (for example a backup USB disk) that an over-broad rule might match - confirm the disk name or
serial during the **same one-time sighted BIOS helper visit** in Step 4, or on any Linux live
system, since the graphical installer shell is not screen-reader accessible:

```bash
# List the udev properties of every disk; read the ID_SERIAL value for your target.
proxmox-auto-install-assistant device-info -t disk

# Confirm your glob resolves to exactly ONE disk before trusting it.
proxmox-auto-install-assistant device-match disk ID_SERIAL='CT1000MX500SSD1_*'
```

Whichever you pick, only one disk should ever match - matching the wrong disk would erase the wrong
device.

## Step 2 - Prepare the ISO in WSL2

This step uses WSL2 with a Debian distribution on the control station; this guide assumes you
already have WSL2 Debian installed (if not, `wsl --install -d Debian` in PowerShell sets it up).

The tool that bakes the answer file into the installer ISO is `proxmox-auto-install-assistant`. It
is Linux-only and is not shipped on the Proxmox ISO, so you install it from the Proxmox repository.
Running it inside WSL2 (a Debian distribution) keeps the whole step on the command line and
therefore fully accessible; you do not need a running Proxmox host and you do not need a
subscription.

First, download the official Proxmox VE 9 ISO from
[www.proxmox.com/downloads](https://www.proxmox.com/downloads) in your browser (an accessible step)
to, for example, `D:\iso\` (use `D:\iso` or `C:\iso` and adjust the `/mnt/` path to match). WSL sees
your Windows drives under `/mnt/`, so that file is `/mnt/d/iso/proxmox-ve_9.x.iso` inside WSL.

Inside your WSL Debian, add the Proxmox no-subscription repository and its keyring, then install the
assistant and `xorriso` (which `prepare-iso` needs to repack the ISO). PVE 9 uses the
`proxmox-archive-keyring` package and the modern deb822 `.sources` format in place of the old
one-line `.list` style and the old `proxmox-release-*.gpg` keyring names.

First fetch the correct signing key for trixie. Your WSL Debian is not a Proxmox system, so unlike
the installed host it has no Proxmox keyring yet; that is why you fetch it by hand here.

```bash
sudo wget https://enterprise.proxmox.com/debian/proxmox-archive-keyring-trixie.gpg \
 -O /usr/share/keyrings/proxmox-archive-keyring.gpg
```

Verify the downloaded keyring against the published SHA256 before trusting it. Compute the local
hash with `sha256sum /usr/share/keyrings/proxmox-archive-keyring.gpg` and compare it to the value
published on the Proxmox [Package Repositories](https://pve.proxmox.com/wiki/Package_Repositories)
wiki page, in its SecureApt section. At the time of writing that value is
`136673be77aba35dcce385b28737689ad64fd785a797e57897589aed08db6e45`; confirm it against the wiki in
case the keyring is ever rotated.

Then write the no-subscription repo as a deb822 `.sources` file:

```bash
sudo tee /etc/apt/sources.list.d/proxmox.sources <<'EOF'
Types: deb
URIs: http://download.proxmox.com/debian/pve
Suites: trixie
Components: pve-no-subscription
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
EOF
```

Then update and install:

```bash
sudo apt update
sudo apt install -y proxmox-auto-install-assistant xorriso
```

Now confirm the version. This matters:

```bash
proxmox-auto-install-assistant --version
```

The version must be **8.2.6 or newer**. Earlier releases produced ISOs that, when written to a USB
stick and booted in UEFI mode, dropped to a blank `grub>` prompt and never reached the installer - a
silent failure you cannot diagnose without a screen. The fix shipped in assistant 8.2.6. Any build
from the Proxmox VE 9 repository is far newer than that, so this is really only a guard against
preparing the ISO on an older box; check it anyway before trusting a UEFI USB boot.

With the answer file and the stock ISO both visible to WSL, validate, then prepare. Always run
`validate-answer` first - TOML typos, a stray snake_case key, or a `raid` set on a single disk are
the most common failures, and `validate-answer` catches them before you build anything:

```bash
cd /mnt/d/iso

# 1. Schema-check the answer file. Fix anything it reports before continuing.
proxmox-auto-install-assistant validate-answer answer.toml

# 2. Bake the answer file directly into the ISO (the --fetch-from iso method).
proxmox-auto-install-assistant prepare-iso proxmox-ve_9.x.iso \
 --fetch-from iso \
 --answer-file answer.toml \
 --output pve-auto.iso

# 3. (Optional) Confirm what got baked in.
proxmox-auto-install-assistant inspect-iso pve-auto.iso
```

This produces `pve-auto.iso`, containing both the installer and your answers. The `--fetch-from iso`
mode embeds the answer file directly in the ISO, so nothing else is needed at boot - no network, no
second USB, no on-screen URL. It is the simplest and most accessible mode for a single home node,
and it is the one this corpus uses.

## Alternative - serve answer.toml over HTTP

You do not need this for a single home node; `--fetch-from iso` above is the recommended path. It is
here for completeness and in case you later provision several machines.

In HTTP mode the booted installer fetches `answer.toml` over the network instead of reading it from
the ISO. You can host the file from a tiny server in WSL:

```bash
# In the directory holding answer.toml:
python3 -m http.server 8080
```

Then prepare the ISO in HTTP mode. The key accessibility point is **how the installer learns the
URL**, because if it has to ask for the URL on screen, you are back to needing sight. There are two
ways to avoid that:

- Embed the URL at prepare time with `--url`. Then no on-screen entry is ever needed:

```bash
proxmox-auto-install-assistant prepare-iso proxmox-ve_9.x.iso \
 --fetch-from http \
 --url "http://<control-station-ip>:8080/answer.toml" \
 --output pve-auto-http.iso
```

- Or set up auto-discovery so the installer finds the URL itself, with no `--url` baked in. The
  installer reads either DHCP **option 250** (the answer URL) and **option 251** (the cert
  fingerprint), or DNS TXT records named `proxmox-auto-installer.{search-domain}` (URL) and
  `proxmox-auto-installer-cert-fingerprint.{search-domain}` (fingerprint). Configuring those needs
  control of your router or DNS.

The caveat to flag: if you prepare with `--fetch-from http` but neither embed a `--url` nor set up
working DHCP/DNS auto-discovery, the installer will require a URL typed at the console - which needs
the screen. So in HTTP mode, always either pass `--url` or have auto-discovery in place.

There is a third mode, `--fetch-from partition`, where the installer reads the answer from a
separately labelled USB partition. It is worth noting only to say it offers no accessibility gain:
it still requires running `prepare-iso` on the ISO (a stock ISO will not search for the partition),
so it adds a second stick without removing any sighted step. Prefer `--fetch-from iso`.

## Step 3 - Flash to USB

Flash `pve-auto.iso` to a USB stick from Windows with **Rufus**, the most reliably
screen-reader-usable USB flasher on Windows. The path you actually need is three labelled controls:

1. The "Device" combo box - select your USB stick.
2. The "Select" button - choose your `pve-auto.iso`.
3. The "Start" button - begin writing.

When Rufus asks how to write the image, choose **"Write in DD Image mode"**. The Proxmox ISO is a
hybrid image, and DD mode writes it byte-for-byte so it boots reliably; the other ("ISO") mode can
produce a stick that will not boot. Then acknowledge the data-destruction prompt and let it write.

Avoid balenaEtcher for this. Its interface is an Electron/Chromium app that is frequently
inconsistent with screen readers, and it gives you less control over the write mode. Rufus is the
accessible choice.

## Step 4 - Boot and install

This is the one moment that needs brief sighted help, and it is worth being honest about: the
firmware's BIOS/UEFI setup and one-time boot-menu screens are not screen-reader accessible. This is
the single unavoidable sighted-help step in the whole install, and it is short and one-time.

Have a sighted helper, once, enter the machine's BIOS/UEFI setup and do two things:

- Set the USB stick (often listed as "UEFI: \<USB stick name\>") as the **first boot device**, or
  enable "boot removable media first".
- Leave **Secure Boot off for this beginner, headless path**. Current Proxmox VE installers are
  signed and can boot with Secure Boot on; the Proxmox docs only require disabling Secure Boot for
  installer media older than PVE 8.1. This guide still recommends off for a single home node because
  it reduces early-boot variables and avoids later Secure Boot, MOK, or third-party module prompts
  that are not screen-reader friendly.

While the helper is in the firmware, it is also worth confirming the firmware is set to UEFI (rather
than Legacy/CSM), and noting the answer in case a UEFI USB boot ever misbehaves on older hardware
and you want to try the Legacy boot of the same stick as a fallback.

After that one-time setup, no further sight is needed. Insert the prepared USB and power the machine
on. The prepared ISO shows a GRUB menu whose default entry is **"Automated Installation"**, and it
auto-selects after roughly a 10-second timeout. The installer then reads your `answer.toml`,
partitions the disk, installs Proxmox VE unattended with no interaction, and reboots into the
finished system on its own. You do not have to see or touch anything during the install itself.

Give it roughly 10 to 20 minutes from power-on for the install and the first reboot (an SSD target
is on the faster end of that). Then move to verification, entirely from your control station.

## Step 5 - Verify it worked (headless)

The host reboots into Proxmox on its own, and because `root-ssh-keys` is baked in, it is reachable
by SSH the moment it finishes booting. You confirm success purely over the network - no monitor, no
local console.

"Already reachable" assumes two things went right: your LAN DHCP server leased the host an address,
and the installer recognized its NIC. Both are the usual case, but worth naming.

If the host never appears on the network:

- Because `reboot-on-error = false` (set in your answer file), a failed install halts rather than
  looping, so the error stays on screen and a helper can read it to you instead of watching the
  machine reboot endlessly.
- You can re-prepare the ISO pairing the automated-installation entry with the installer's **Serial
  Console** / Terminal UI boot entry. The research recommends this as the headless diagnosis
  fallback: serial output is plain text you can read over a serial link or IPMI SOL (Intelligent
  Platform Management Interface Serial-over-LAN, a server-board feature that pipes the serial
  console over the network; most mini-PCs lack it), so install progress and errors become
  accessible.

On the FIRST `ssh` connection you will see a host-key fingerprint prompt and must type `yes` to
accept it; if your key has a passphrase you will then be asked for it.

### Find the host's IP

With `source = "from-dhcp"`, the host's address comes from your router. Any one of these finds it
(run from PowerShell or from WSL on the control station):

- Check the router's admin page for its DHCP lease list and look for the hostname `pve` (your
  `fqdn`). This is usually the most reliable.
- Scan the subnet for the Proxmox API port 8006, from WSL with nmap:

```bash
nmap -p 8006 --open 192.168.1.0/24
```

The host that answers on 8006 is the new Proxmox node.

- Right after install, reach the host by its static IP (`192.168.1.10`); a stock Proxmox node runs
  no mDNS and no local DNS, so name resolution does not work yet. mDNS/Avahi
  ([10 -- Networking](10-networking.md)) later makes the host reachable as `pve.local`; network-wide
  `pve.home.arpa` resolution requires a local DNS server such as the one set up in
  [01 -- DNS sinkhole](recipes/01-dns-sinkhole.md) (see its "Local DNS names" section).

### SSH in and confirm

SSH in as root with the key you baked into the answer file. Key-based login works immediately
because the public key is already in the host's `authorized_keys`:

```bash
ssh -i ~/.ssh/proxmox root@<ip>
```

(From PowerShell the key path is `$env:USERPROFILE\.ssh\proxmox`.) Once you are in, confirm the
install with `pveversion`:

```bash
pveversion
```

Expected output is a single line naming the Proxmox manager version and the running kernel, of the
form:

```text
pve-manager/9.x-x/xxxxxxxx (running kernel: 6.x or 7.x-pve)
```

The exact kernel (a 6.x or 7.x `-pve` build - for example 6.14 on PVE 9.0, 6.17 on 9.1, or 6.17/7.0
on later 9.x point releases) depends on the point release; what matters is the `pve-manager/9....`
line. If you see a `pve-manager/9....` line, the install succeeded. Two more quick checks confirm
the network and the disk are as intended:

```bash
ip a # the NIC is up and holds the DHCP address you SSH'd to
findmnt / # the root is a btrfs filesystem, as configured
```

`findmnt /` reporting `btrfs` in the FSTYPE column confirms the btrfs root the answer file asked
for. With SSH working, `pveversion` reporting 9.x, and the root showing btrfs, you have a running,
reachable Proxmox VE 9 host and the unattended install is complete.

## Sources

- `research/round2-pve9/02-pve9-install-answer-toml.md` - the PVE 9 kebab-case `answer.toml` schema,
  the `proxmox-auto-install-assistant` subcommands, the three fetch modes, password-hash generation,
  the single-disk btrfs example, and the assistant >= 8.2.6 UEFI-USB requirement.
- `research/round1-general/10-automated-install-answer-toml.md` - deeper `answer.toml` mechanics:
  the full schema, fetch-mode commands, `device-info`/`device-match`, and the headless verification
  workflow.
- `research/round1-general/11-accessible-iso-prep-windows.md` - the Windows/WSL2 preparation path,
  Rufus in DD Image mode, the one-time BIOS reality, and the headless find-and-SSH verification.
- `research/round2-pve9/03-pve9-repositories-and-updates.md` - the Proxmox repository the assistant
  installs from, and the `pveversion -v` check.
- `research/round2-pve9/04-pve9-boot-kernel-microcode.md` - UEFI vs Legacy and Secure Boot notes for
  a btrfs-root, GRUB-booted host, and the recommendation to leave Secure Boot off on this node.
- Proxmox VE wiki, Automated Installation:
  [pve.proxmox.com/wiki/Automated_Installation](https://pve.proxmox.com/wiki/Automated_Installation)
- Proxmox VE wiki, Package Repositories:
  [pve.proxmox.com/wiki/Package_Repositories](https://pve.proxmox.com/wiki/Package_Repositories)
  (the SecureApt section carries the published `proxmox-archive-keyring` SHA256 to verify the
  fetched key against).
- Proxmox VE admin guide, section 2.4 "Unattended Installation":
  [pve.proxmox.com/pve-docs/pve-admin-guide.html](https://pve.proxmox.com/pve-docs/pve-admin-guide.html)
- Proxmox VE wiki, Secure Boot Setup:
  [pve.proxmox.com/wiki/Secure_Boot_Setup](https://pve.proxmox.com/wiki/Secure_Boot_Setup)
- `GLOSSARY.md` and `CONTEXT.md` - the canonical definitions of btrfs, the Proxmox host, the control
  station, and the roles used throughout.

---

Previous: [00 -- Orientation](00-orientation.md) | Next:
[02 -- The shell and the API](02-the-shell-and-the-api.md)
