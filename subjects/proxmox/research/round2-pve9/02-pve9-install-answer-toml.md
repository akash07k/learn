# PVE 9 Automated / Unattended Install via answer.toml (single-disk BTRFS)

Target: latest Proxmox VE 9.x on Debian 13 "trixie", mid-2026. Single node, shell-only, host root on
BTRFS. This document covers the full `answer.toml` schema (kebab-case), the
`proxmox-auto-install-assistant` tool, the three fetch modes, password-hash generation, and two
complete commented `answer.toml` examples. Snake_case keys are deprecated in PVE 9; use kebab-case
everywhere.

Primary sources:

- Official wiki, Automated_Installation:
  [Automated Installation](https://pve.proxmox.com/wiki/Automated_Installation)
- pve-docs installation chapter (Unattended Installation):
  [Installing Proxmox VE](https://pve.proxmox.com/pve-docs/chapter-pve-installation.html)
- pve-admin-guide section 2.4 Unattended Installation:
  [Proxmox VE Administration Guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.html)
- BTRFS compress/hdsize options (pve-installation.adoc):
  [pve-docs/pve-installation.adoc at master · proxmox/pve-docs](https://github.com/proxmox/pve-docs/blob/master/pve-installation.adoc)

## How the unattended installer works (overview)

You take a normal Proxmox VE 9 installer ISO and "prepare" it with `proxmox-auto-install-assistant`.
The tool injects an answer file (or the instructions to fetch one) plus a small auto-installer
payload, and produces a new ISO with an extra boot-menu entry named **"Automated Installation"**.
When that entry runs, the installer reads `answer.toml`, partitions the target disk, installs PVE
without any prompts, and reboots into the finished system.

The answer file provides the core config: root password, network, target disk, filesystem, hostname,
etc. Disk and NIC selection can be by explicit name or by **filters** that match udev properties
(serial, model, MAC) - important on machines where device names are not stable.

Accessibility note for a blind, shell-only operator: this whole flow is text/file driven. There is
no GUI step. You write a TOML file, validate it on any Debian/PVE box, prepare the ISO, write it to
USB, and boot. Combine with the installer's **Serial Console** debug entry (and post-install
`pct enter` / `pvesh`) for a fully non-graphical workflow.

## Install the tooling

On any Debian 13 / PVE 9 system (does not have to be the target):

```bash
apt update
apt install proxmox-auto-install-assistant xorriso
```

`xorriso` is required by `prepare-iso` to repack the ISO. Confirm the version:

```bash
proxmox-auto-install-assistant --version
```

### Version requirement - avoid the blank GRUB on UEFI USB

Early releases of the assistant produced ISOs that, when written to a USB stick and booted in
**UEFI** mode, dropped to a blank `grub>` prompt (the same ISO booted fine as a virtual CD-ROM over
IPMI). The fix shipped in **proxmox-auto-install-assistant 8.2.6**. Any PVE 9.x repo build is far
newer than 8.2.6 and includes the fix, but if you are preparing the ISO on an older box, make sure
the assistant is **>= 8.2.6** before trusting a UEFI USB boot. (Source: Proxmox forum threads "Boot
from auto-install .iso help" and "Auto install USB issues",
[\[SOLVED\] - Boot from auto-install .iso help](https://forum.proxmox.com/threads/boot-from-auto-install-iso-help.145936/))

## proxmox-auto-install-assistant subcommands

- `prepare-iso <source.iso> --fetch-from <mode> [...]` - produce the automated ISO. Core subcommand;
  details below.
- `validate-answer <answer.toml>` - parse and schema-check the answer file. Run this on every edit.
  Add `--debug` for verbose output.
- `device-info [-t disk|network|all]` - dump the udev properties of the current machine's disks/NICs
  so you know which keys (e.g. `ID_SERIAL`, `ID_MODEL`, `ID_NET_NAME_MAC`) to filter on. Run this on
  the **target** hardware (e.g. from the installer's debug/serial shell, or a live Debian USB).
- `device-match <disk|network> '<KEY>=<glob>'` - test a filter expression against the current
  machine and print which devices match. Use it to confirm a filter resolves to exactly one disk
  before committing.
- `validate-answer` / `prepare-iso` also have an inspect helper:
  `inspect-iso <prepared.iso> [--show-sensitive]` shows what answer/fetch config is baked into an
  already-prepared ISO.
- `system-info` - dump full hardware report (superset of `device-info`).

Examples:

```bash
proxmox-auto-install-assistant validate-answer answer.toml
proxmox-auto-install-assistant device-info -t disk
proxmox-auto-install-assistant device-info -t network
proxmox-auto-install-assistant device-match disk ID_SERIAL='KIOXIA_KCMYXVUG1T60*'
```

## The answer.toml schema (PVE 9, kebab-case)

All keys below are kebab-case. Snake_case (the old `[disk_setup]`, `root_password`, etc.) is
**deprecated in PVE 9** - `validate-answer` will warn, and you should migrate. Sections: `[global]`,
`[network]`, `[disk-setup]`, `[first-boot]`, `[post-installation-webhook]`.

### [global]

Required:

- `keyboard` - keymap. Valid values:

```text
de, de-ch, dk, en-gb, en-us, es, fi, fr, fr-be, fr-ca, fr-ch, hu, is, it, jp, lt, mk, nl, no, pl, pt, pt-br, se, si, tr
```

- `country` - two-letter ISO country code, e.g. `"us"`, `"at"`.
- `fqdn` - either a literal hostname string (e.g. `"pve.home.arpa"`) **or** a dynamic table:

```toml
fqdn.source = "from-dhcp"
fqdn.domain = "some.fallback.domain.local" # used if DHCP gives no domain
```

- `mailto` - root notification email.
- `timezone` - tzdata zone, e.g. `"Europe/Vienna"`, `"America/New_York"`.
- Exactly one of `root-password` (plaintext) **or** `root-password-hashed` (preferred - a
  yescrypt/SHA-512 crypt string). Mutually exclusive.

Optional:

- `root-ssh-keys` - TOML array of authorized public keys:

```toml
root-ssh-keys = ["ssh-ed25519 AAAA...", "ssh-rsa BBBB..."]
```

- `reboot-on-error` - bool, default `false`. If `true`, the machine reboots even when the install
  fails (otherwise it pauses so you can read the error). For a headless, screen-reader operator,
  leaving this `false` is usually safer so a failed run does not loop.
- `reboot-mode` - `"reboot"` (default) or `"power-off"`. (PVE 8.4+.) Also accepts the older spelling
  in some builds; prefer `reboot-mode`.
- `subscription-key` - **PVE 9.2+** - a subscription key that is registered and activated
  automatically on first boot. Omit for the no-subscription repo.

### [network]

- `source` - `"from-dhcp"` (recommended for a single home node) or `"from-answer"` (static).
- When `source = "from-answer"`, also set:
- `cidr` - e.g. `"10.10.10.10/24"` (IPv4 or IPv6).
- `gateway` - e.g. `"10.10.10.1"`.
- `dns` - e.g. `"10.10.10.1"`.
- `filter.<UDEV_KEY>` - pick which NIC to configure, e.g.
  `filter.ID_NET_NAME_MAC = "*e43d1afa379a"`.

#### Interface name pinning (NEW in PVE 9.1)

PVE 9.1 added the ability to pin predictable interface names to MAC addresses, so your bridge config
always lands on the right NIC regardless of kernel enumeration order:

```toml
[network.interface-name-pinning]
enabled = true

[network.interface-name-pinning.mapping]
"24:8a:07:1e:05:bc" = "lan0"
"24:8a:07:1e:05:bd" = "lan1"
"b4:2e:99:ac:ad:b4" = "mgmt"
```

This is optional and independent of `source`. For a single-NIC home node you can skip it; it shines
on multi-NIC boxes where stable names matter.

### [disk-setup]

- `filesystem` - `"ext4"`, `"xfs"`, `"zfs"`, or `"btrfs"`. **BTRFS is Proxmox-only and still a
  technology preview** - it works in the unattended installer but is not recommended for production
  by Proxmox. For this reader's single-disk home host it is a deliberate choice; just be aware of
  the preview status.
- Disk selection is **mutually exclusive**: either
- `disk-list = ["sda"]` - explicit device name(s), or
- `filter.<UDEV_KEY> = "<glob>"` - match by property (recommended for stability), e.g.
  `filter.ID_SERIAL = "..."` or `filter.ID_MODEL = "Samsung*"`.
- `filter-match` - `"any"` (default) or `"all"`, when multiple `filter.*` keys are given.

Filesystem-specific sub-tables:

- `[disk-setup.btrfs]` (or inline `btrfs.*`):
- `raid` - `raid0`, `raid1`, `raid10`. For a **single disk leave this unset** (the installer uses a
  single-device BTRFS profile, equivalent to `mkfs.btrfs -m single -d single`). Do not set `raid1`
  with one disk.
- `hdsize` - total disk size to use, in GB. Set this smaller than the disk to leave unpartitioned
  free space (e.g. for a later swap partition). Omit to use the whole disk.
- `compress` - `off` (default), `on` (= `zlib`), `zlib`, `lzo`, or `zstd`. `zstd` is the usual
  choice for a good speed/ratio balance on a home host.
- `[disk-setup.zfs]`: `raid`, `ashift`, `arc-max` (MiB), `checksum`, `compress`, `copies`, `hdsize`
  (GB). (For external-USB ZFS this is not the install target; the host root here is BTRFS.)
- `[disk-setup.lvm]` (ext4/xfs only): `hdsize`, `swapsize`, `maxroot`, `maxvz`, `minfree` (all GB).
  Note BTRFS does **not** use the LVM table - there is no installer-created swap on BTRFS, so
  reserve space via `btrfs.hdsize` and add a swap file/partition post-install if needed.

There is no subvolume-layout knob in the answer file; the installer creates its standard BTRFS
layout (top-level subvol with `@`/root and the PVE storage entry in `/etc/pve/storage.cfg`). The
only BTRFS tunables exposed are `raid`, `hdsize`, and `compress`.

### [first-boot] (optional hook)

Runs a script you supply on the freshly installed system the first time it boots. Useful for "apply
my config / pull my Ansible bootstrap" without baking it into the ISO content.

- `source` - `"from-iso"` (the executable is embedded into the prepared ISO via a `prepare-iso`
  flag) or `"from-url"` (downloaded at first boot).
- `ordering` - when in the boot the hook runs:
- `before-network` - earliest, before networking is configured.
- `network-online` - after the network is up.
- `fully-up` (default) - after the system has fully booted.
- When `source = "from-url"`: `url` (required) and optional `cert-fingerprint` (SHA-256 of the
  server cert for pinning).
- The first-boot executable is limited to **1 MiB**.

For `from-iso`, supply the script when preparing the ISO (see `prepare-iso` flags). For a
screen-reader operator this is the clean hook to drop in an SSH hardening / package-bootstrap script
so the box is ready over SSH on first boot.

### [post-installation-webhook] (optional)

POSTs a JSON status to an HTTPS endpoint when the install finishes:

- `url` - HTTPS endpoint.
- `cert-fingerprint` - optional SHA-256 pin.
- `auth-token` - optional bearer token, sent as a top-level JSON field (**PVE 9.2+** adds
  `auth-token`).

## The three fetch modes (--fetch-from)

`prepare-iso` decides **where the installer gets `answer.toml` at boot**:

1. **iso** (primary / simplest): the answer file is baked directly into the ISO. No network needed
   at install time. Best for a single home box.

```bash
proxmox-auto-install-assistant prepare-iso pve.iso \
--fetch-from iso --answer-file answer.toml --output pve-auto.iso
```

1. **partition**: the installer searches attached block devices for a partition **labelled
   `PROXMOX-AIS`** (case-insensitive; default labels `proxmox-ais` / `PROXMOX-AIS`) and reads
   `answer.toml` from it. Lets you keep one generic ISO and vary the answer per machine via a small
   labelled USB/partition.

```bash
proxmox-auto-install-assistant prepare-iso pve.iso \
--fetch-from partition [--partition-label PROXMOX-AIS] --output pve-auto.iso
```

(Partition mode requires PVE 8.3-1 / PBS 3.3-1 or newer - fine on PVE 9.)

1. **http**: the installer fetches the answer over HTTP(S) at boot. Discovery of the URL can be
   explicit or automatic:

- Explicit: `--url "https://10.0.0.100/answer"`, optional `--cert-fingerprint "<sha256>"` and
  `--answer-auth-token "user:secret"`.
- **DHCP**: option **250** carries the answer URL, option **251** the cert fingerprint.
- **DNS auto-discovery**: TXT records `proxmox-auto-installer.{search-domain}` (URL) and
  `proxmox-auto-installer-cert-fingerprint.{search-domain}` (fingerprint).

```bash
proxmox-auto-install-assistant prepare-iso pve.iso \
--fetch-from http \
--url "https://10.0.0.100/get_answer/" \
--cert-fingerprint "04:42:97:27:F6:29:2F:9F:..." \
--answer-auth-token "myhost:s3cr3t" --output pve-auto.iso
```

There is also a `--pxe` flag to emit a PXE-bootable tree: `--pxe --output /srv/tftp/proxmox-auto/`.

For this single-node, shell-only home setup, **`--fetch-from iso` is the recommended mode** - no
DHCP/HTTP infrastructure, fully self-contained.

## End-to-end prepare-iso (iso mode)

```bash
# 1. Validate the answer file (always)
proxmox-auto-install-assistant validate-answer answer.toml

# 2. Bake it into the ISO (add a first-boot script with --on-first-boot if used)
proxmox-auto-install-assistant prepare-iso \
 /root/proxmox-ve_9.x.iso \
 --fetch-from iso \
 --answer-file /root/answer.toml \
 --output /root/pve9-auto.iso

# (optional) embed a first-boot executable for [first-boot] source = "from-iso":
# --on-first-boot /root/first-boot.sh

# 3. Inspect what got baked in (sanity check; redact-free view needs --show-sensitive)
proxmox-auto-install-assistant inspect-iso /root/pve9-auto.iso

# 4. Write to USB (replace sdX with the real target - check with lsblk first!)
dd if=/root/pve9-auto.iso of=/dev/sdX bs=4M conv=fsync status=progress
```

Then boot the target from that USB and select the **"Automated Installation"** menu entry. For a
non-graphical workflow, the installer also exposes a **Serial Console** debug entry - pair the
auto-install entry with serial output (append console settings on the kernel cmdline) so progress is
readable over a serial link or IPMI SOL.

## Generating the root-password-hashed value

Prefer a hash so the plaintext is never stored in the answer file. Two options:

```bash
# yescrypt (modern default on Debian 13; produces a $y$... string)
mkpasswd --method=yescrypt
# (from the 'whois' package: apt install whois)

# OR SHA-512 crypt via openssl (produces a $6$... string)
openssl passwd -6
```

Both prompt for the password and print the hash. Paste the result verbatim into
`root-password-hashed`. A yescrypt example value looks like:
`$y$j9T$RXxfPAHqPMqk41tKVbXP./$TQkN9KnjzT0sSUFIYV33HkZe4bwD9U5brWuhnXaIHn0`.

## Complete example A - single-disk BTRFS, DHCP, SSH keys (RECOMMENDED)

This is the target configuration: one disk, BTRFS root, DHCP network, login by SSH key, hashed root
password. Disk is matched by **serial** so it is stable even if the kernel renames `sda`.

```toml
# answer.toml - single-node home PVE 9, BTRFS on one disk, DHCP, SSH-key login

[global]
keyboard = "en-us"
country = "us"
# Static hostname for the node. Use a .home.arpa name on a home LAN.
fqdn = "pve.home.arpa"
mailto = "admin@example.com"
timezone = "America/New_York"
# Hashed root password (generate: mkpasswd --method=yescrypt OR openssl passwd -6)
root-password-hashed = "$y$j9T$RXxfPAHqPMqk41tKVbXP./$TQkN9KnjzT0sSUFIYV33HkZe4bwD9U5brWuhnXaIHn0"
# Authorized SSH keys for root - primary accessibility path into the node.
root-ssh-keys = [
 "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyReplaceMe you@workstation"
]
# Pause (do not loop-reboot) if the install fails, so the error stays readable.
reboot-on-error = false
reboot-mode = "reboot"
# subscription-key = "pve1c-0123456789" # PVE 9.2+, omit for no-subscription repo

[network]
# Pull IP/gateway/DNS from the LAN DHCP server.
source = "from-dhcp"

[disk-setup]
# BTRFS root on a SINGLE disk. NOTE: btrfs is a Proxmox technology preview.
filesystem = "btrfs"
# Single-device BTRFS: btrfs.raid is REQUIRED. Set to "raid0" -- that is the single-disk value.
# Omitting it makes validate-answer fail: Btrfs raid level 'btrfs.raid' must be set.
btrfs.raid = "raid0"
btrfs.compress = "zstd"
# Optional: leave headroom on the disk (GB). Omit to use the whole disk.
# btrfs.hdsize = 200
# Match the install disk by serial (stable). Get it from:
# proxmox-auto-install-assistant device-info -t disk
# and test it with:
# proxmox-auto-install-assistant device-match disk ID_SERIAL='CT1000MX500SSD1_*'
filter.ID_SERIAL = "CT1000MX500SSD1_*"

# Optional first-boot hook embedded in the ISO (supply via --on-first-boot).
# Runs once after the network is online - good place to harden SSH / bootstrap.
[first-boot]
source = "from-iso"
ordering = "network-online"
```

Prepare it:

```bash
proxmox-auto-install-assistant validate-answer answer.toml
proxmox-auto-install-assistant prepare-iso proxmox-ve_9.x.iso \
 --fetch-from iso --answer-file answer.toml \
 --on-first-boot first-boot.sh \
 --output pve9-auto.iso
```

## Complete example B - single-disk BTRFS by explicit name, static IP

Same BTRFS single-disk target, but with a static address and the disk picked by explicit device name
(simpler when you know it is `sda`). Plaintext password shown only to contrast - prefer the hashed
form from example A.

```toml
# answer.toml - single-node home PVE 9, BTRFS on /dev/sda, static IPv4

[global]
keyboard = "en-us"
country = "us"
fqdn = "pve.home.arpa"
mailto = "admin@example.com"
timezone = "America/New_York"
root-password-hashed = "$y$j9T$RXxfPAHqPMqk41tKVbXP./$TQkN9KnjzT0sSUFIYV33HkZe4bwD9U5brWuhnXaIHn0"
root-ssh-keys = [
 "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyReplaceMe you@workstation"
]
reboot-on-error = false

[network]
source = "from-answer"
cidr = "192.168.1.10/24"
gateway = "192.168.1.1"
dns = "192.168.1.1"
# Pick the NIC by MAC (stable). Find the key with: device-info -t network
filter.ID_NET_NAME_MAC = "*001122aabbcc"

# PVE 9.1+: optionally pin a predictable name to that NIC's MAC.
[network.interface-name-pinning]
enabled = true
[network.interface-name-pinning.mapping]
"00:11:22:aa:bb:cc" = "lan0"

[disk-setup]
filesystem = "btrfs" # technology preview
btrfs.compress = "zstd"
disk-list = ["sda"] # explicit single disk
btrfs.raid = "raid0" # required for single-disk btrfs; there is no "single" value
```

## Deltas from PVE 8 and deprecations

- **kebab-case is now the schema**; snake_case keys (e.g. `disk_setup`, `root_password`,
  `root_password_hashed`) are **deprecated in PVE 9** - `validate-answer` flags them. Migrate all
  keys to hyphens.
- **`[network.interface-name-pinning]`** is **new in PVE 9.1** - MAC-to-name pinning was not
  available in PVE 8.
- **`subscription-key`** in `[global]` and webhook **`auth-token`** are **new in PVE 9.2**.
- `reboot-mode` (`reboot`/`power-off`) and dynamic `fqdn.source = "from-dhcp"` landed in PVE 8.4 and
  carry forward unchanged into PVE 9.
- `[first-boot]` hooks, `[post-installation-webhook]`, and `root-password-hashed` arrived in PVE 8.3
  and are standard in PVE 9.
- Partition fetch (`PROXMOX-AIS` label) requires PVE 8.3-1+; present in PVE 9.

## Gotchas / accessibility notes

- **Always `validate-answer` before `prepare-iso`.** TOML typos (wrong quoting, snake_case, omitting
  `btrfs.raid` on a single btrfs disk) are the most common failures.
- **BTRFS is a technology preview** in the Proxmox installer. It installs fine unattended, but
  Proxmox does not position it as production-grade. Acceptable as a deliberate choice for a home lab
  root.
- **Single-disk BTRFS:** `btrfs.raid` is **required**; omitting it makes `validate-answer` fail with
  "Btrfs raid level 'btrfs.raid' must be set". Use `raid0` for one disk -- there is no `single`
  value. `raid1`/`raid10` with one disk fails.
- **No installer swap on BTRFS.** The LVM swap knobs do not apply. Reserve space with `btrfs.hdsize`
  and create a swap file/partition after install if you want swap.
- **Prefer filter-by-serial over `disk-list = ["sda"]`** when device names might shift (USB
  controllers, multiple disks). Confirm the filter resolves to exactly one disk with `device-match`
  first - a filter that matches the external USB ZFS disk too could wipe the wrong device.
- **UEFI USB blank GRUB**: ensure assistant **>= 8.2.6** (guaranteed on PVE 9). If you ever see a
  blank `grub>` from USB, that is the old bug.
- Use **`--fetch-from iso`** for this single-node home setup; HTTP/DHCP discovery (options 250/251,
  DNS TXT) is overkill unless mass-provisioning.
- Pair the **Serial Console** installer entry with the auto-install entry for a fully non-graphical,
  screen-reader-friendly run; after install use `pct enter` and `pvesh` as the management backbone.

## Citations

- Automated Installation (wiki, authoritative schema + examples):
  [Automated Installation](https://pve.proxmox.com/wiki/Automated_Installation)
- pve-docs, Unattended Installation chapter:
  [Installing Proxmox VE](https://pve.proxmox.com/pve-docs/chapter-pve-installation.html)
- pve-admin-guide 2.4 Unattended Installation:
  [Proxmox VE Administration Guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.html)
- BTRFS compress/hdsize installer options:
  [pve-docs/pve-installation.adoc at master · proxmox/pve-docs](https://github.com/proxmox/pve-docs/blob/master/pve-installation.adoc)
- BTRFS as root filesystem / single-device mkfs:
  [pve-docs/local-btrfs.adoc at master · proxmox/pve-docs](https://github.com/proxmox/pve-docs/blob/master/local-btrfs.adoc)
- UEFI USB blank-GRUB fix (assistant 8.2.6), Proxmox forum:
  [\[SOLVED\] - Boot from auto-install .iso help](https://forum.proxmox.com/threads/boot-from-auto-install-iso-help.145936/)
