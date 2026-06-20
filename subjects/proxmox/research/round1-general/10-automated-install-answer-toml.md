# Proxmox VE Automated / Unattended Installation with `answer.toml`

Research target: the accessible (screen-reader-friendly) install path for Proxmox VE. The normal ISO
installer is a graphical TUI that does not announce to a screen reader. The **Automated
Installation** runs fully unattended from an `answer.toml` file, with no on-screen interaction
required, so it is the recommended accessible path for a blind user installing on a single personal
PC.

Primary sources:

- Proxmox wiki, "Automated Installation":
  [Automated Installation](https://pve.proxmox.com/wiki/Automated_Installation)
- PVE Admin Guide, section 2.4 "Unattended Installation":
  [Proxmox VE Administration Guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.html)
- PVE Installation chapter:
  [Installing Proxmox VE](https://pve.proxmox.com/pve-docs/chapter-pve-installation.html)
- Proxmox Datacenter Manager docs (same answer-file engine):
  [Automated Installations](https://pdm.proxmox.com/docs/automated-installations.html)

Feature availability: the automated installer was introduced in **PVE 8.2**. It is present in
current PVE 8.x (Debian 12 bookworm) and PVE 9.x (Debian 13 trixie). Version-specific caveats are
listed at the end.

---

## 1. The `proxmox-auto-install-assistant` tool

### What it is

A **Linux command-line tool** that prepares an installation ISO (or PXE artifacts) for unattended
install, and validates/tests the answer file. It does NOT run on Windows. You run it on any
Debian/Ubuntu Linux machine (or a Linux container/VM, or even WSL on the user's Windows PC). It
bakes the answer-file configuration into the official Proxmox ISO so that the resulting ISO boots
straight into an unattended install.

### Installing the tool

The package ships in the Proxmox APT repositories. On a Debian/Ubuntu host that has the Proxmox
`pve-no-subscription` (or enterprise) repo configured:

```bash
apt update
apt install proxmox-auto-install-assistant
# prepare-iso repacks the ISO, so xorriso is also required:
apt install xorriso
```

If you are on a plain Debian box without Proxmox repos, add the no-subscription repo first (Debian
12 example):

```bash
echo "deb http://download.proxmox.com/debian/pve bookworm pve-no-subscription" \
 > /etc/apt/sources.list.d/pve-install-repo.list
wget https://enterprise.proxmox.com/debian/proxmox-release-bookworm.gpg \
 -O /etc/apt/trusted.gpg.d/proxmox-release-bookworm.gpg
apt update
apt install proxmox-auto-install-assistant xorriso
```

(For PVE 9 / Debian 13 use `trixie` in place of `bookworm`.) There is also a community Docker
container that bundles the tool if you do not want to add repos:
[GitHub - jamestalmage/proxmox-auto-install-assistant-container: Docker container to create automated installations of proxmox, test and validate answer files.](https://github.com/jamestalmage/proxmox-auto-install-assistant-container)

### Subcommands

#### `prepare-iso`

Repacks an official Proxmox ISO into an auto-install ISO (or PXE artifacts).

```bash
proxmox-auto-install-assistant prepare-iso /path/to/source.iso [OPTIONS]
```

Key flags:

- `--fetch-from <iso|partition|http>` - how the booted installer locates the answer file (REQUIRED;
  see section 2).
- `--answer-file /path/to/answer.toml` - the answer file to embed (used with `--fetch-from iso`).
- `--partition-label LABEL` - custom volume label when `--fetch-from partition` (default label is
  `PROXMOX-AIS`; available from PVE 8.3-1 / PBS 3.3-1).
- `--url "https://host/answer"` - answer endpoint for `--fetch-from http`.
- `--cert-fingerprint "AA:E8:..."` - SHA-256 TLS cert fingerprint to pin for the HTTP fetch (cert
  pinning so a self-signed cert is trusted).
- `--on-first-boot /path/to/script` - embed a script that runs once after the first boot (see
  section 5). (Newer alternative: the `[first-boot]` section inside answer.toml.)
- `--output /path` - output ISO file (or output directory for PXE).
- `--pxe` - produce PXE kernel/initrd instead of an ISO.
- `--pxe-loader ipxe` - emit an iPXE config snippet.

#### `validate-answer`

Validates TOML syntax and schema against the installer's expectations. Run this BEFORE building the
ISO.

```bash
proxmox-auto-install-assistant validate-answer answer.toml
```

#### `device-info`

Lists the udev properties of the machine's disks and/or NICs, which are the fields you can filter on
in `answer.toml`. Run this on the TARGET hardware (e.g. boot the official ISO in "Debug Mode" /
terminal, or any Linux live USB on the same PC).

```bash
proxmox-auto-install-assistant device-info -t disk # disks only
proxmox-auto-install-assistant device-info -t network # NICs only
proxmox-auto-install-assistant device-info # both
```

It surfaces properties such as `DEVNAME`, `ID_SERIAL`, `ID_SERIAL_SHORT`, `ID_MODEL`, `ID_WWN`
(disks) and `ID_NET_NAME`, `ID_NET_NAME_MAC` (NICs).

#### `device-match`

Tests a filter rule against the actual hardware, so you can confirm a filter matches exactly one
(the correct) device before committing.

```bash
proxmox-auto-install-assistant device-match disk ID_SERIAL='KIOXIA_KCMYXVUG1T60*'
proxmox-auto-install-assistant device-match network ID_NET_NAME_MAC='*e43d1afa379a'
```

#### `inspect-iso`

Reports how a prepared ISO was built (fetch mode, embedded answer file). Sensitive fields are
redacted unless `--show-sensitive` is given.

```bash
proxmox-auto-install-assistant inspect-iso /path/to/prepared.iso [--show-sensitive]
```

#### `system-info`

Prints the DMI/MAC/system identification data that the installer would send to an HTTP answer server
(useful when matching machines server-side).

```bash
proxmox-auto-install-assistant system-info
```

---

## 2. The three `--fetch-from` modes

The booted installer must find the answer file somewhere. The mode is chosen at `prepare-iso` time
with `--fetch-from`.

### 2a. `--fetch-from iso` (answer baked into the ISO) - RECOMMENDED for a single PC

The answer file is embedded directly inside the prepared ISO. Simplest, fully offline, nothing else
to provide at boot. This is the recommended mode for one personal machine.

```bash
proxmox-auto-install-assistant prepare-iso proxmox-ve_8.4-1.iso \
 --fetch-from iso \
 --answer-file answer.toml \
 --output pve-auto.iso
```

### 2b. `--fetch-from partition` (answer file on a separate labeled volume / USB)

The ISO is prepared WITHOUT the answer; at boot the installer scans for a partition whose volume
label is **`PROXMOX-AIS`** (Proxmox Automated Installation Source) and reads a file named
`answer.toml` from it. This lets you reuse one prepared ISO and just swap the small answer USB.
(Custom label possible with `--partition-label`, PVE 8.3-1+.)

Prepare the ISO:

```bash
proxmox-auto-install-assistant prepare-iso proxmox-ve_8.4-1.iso \
 --fetch-from partition \
 --output pve-auto.iso
```

Create the answer USB (label MUST be `PROXMOX-AIS`, file MUST be `answer.toml`):

```bash
mkfs.vfat /dev/sdX1
fatlabel /dev/sdX1 "PROXMOX-AIS"
mkdir /mnt/usb
mount /dev/sdX1 /mnt/usb
cp my-prepared-answer.toml /mnt/usb/answer.toml
sync
umount /mnt/usb
```

(For exFAT use `exfatlabel`; the label string is the same.) Note: you can also put the
`PROXMOX-AIS`-labeled partition on the SAME USB stick that holds the ISO, as a second partition.

### 2c. `--fetch-from http` (installer downloads answer.toml over the network)

The installer fetches the answer file from an HTTP/HTTPS URL at boot. Useful for mass deployment;
overkill for one PC but documented here for completeness.

Prepare with an explicit URL and optional cert pinning:

```bash
proxmox-auto-install-assistant prepare-iso proxmox-ve_8.4-1.iso \
 --fetch-from http \
 --url "https://10.0.0.100/get_answer/" \
 --cert-fingerprint "04:42:97:27:F6:29:2F:9F:3D:7F:13:11:C8:E2:F5:5F:84:03:95:D9:F5:14:72:7C:9E:90:47:03:D2:96:2B:EC" \
 --output pve-auto.iso
```

- `--cert-fingerprint` pins the server's SHA-256 cert fingerprint so a self-signed HTTPS cert is
  accepted (no public CA needed).
- The installer POSTs system identification data (DMI, MACs - see `system-info`) to the URL, so the
  server can return a machine-specific answer.

**Auto-discovery (URL not baked in).** If you prepare with `--fetch-from http` but DO NOT pass
`--url`, the installer discovers the endpoint at boot via:

- DHCP options:
- Option **250** = the answer URL.
- Option **251** = the SHA-256 cert fingerprint.
- DNS TXT records (queried under the DHCP search domain):
- `proxmox-auto-installer.{search-domain}` = the answer URL.
- `proxmox-auto-installer-cert-fingerprint.{search-domain}` = the cert fingerprint.

Important rule from the docs: the cert fingerprint is only fetched via DHCP/DNS if the URL itself
was obtained by the same method ("Fetching the fingerprint via DHCP or DNS records is only done if
the same method is used to retrieve the URL").

---

## 3. The `answer.toml` schema

TOML format. Either `root-password` OR `root-password-hashed` MUST be set. Section keys historically
used `snake_case`; current docs use `kebab-case` (e.g. `root-password`). Snake_case is deprecated as
of PVE 9.0-1 but still accepted in 8.x - prefer kebab-case.

### `[global]`

- `keyboard` - layout. One of:
  `de de-ch dk en-gb en-us es fi fr fr-be fr-ca fr-ch hu is it jp lt mk nl no pl pt pt-br se si tr`.
- `country` - two-letter country code (e.g. `us`, `at`, `de`). Sets mirror/region defaults.
- `fqdn` - fully qualified hostname, e.g. `"pve.example.lan"`. Alternatively use the table form to
  derive from DHCP:
- `fqdn.source = "from-dhcp"`
- `fqdn.domain = "fallback.domain.local"` (fallback domain if DHCP gives none)
- `mailto` - admin email for notifications.
- `timezone` - e.g. `"America/New_York"`, `"Europe/Vienna"`.
- `root-password` - plaintext root password, OR
- `root-password-hashed` - a crypt hash (yescrypt `$y$...` or SHA-512 `$6$...`). Preferred so the
  plaintext password is not stored in the file. (See gotchas for generating it.)
- `root-ssh-keys` - array of authorized SSH public keys, e.g.
  `root-ssh-keys = ["ssh-ed25519 AAAA... user@host"]`. CRITICAL for headless/accessible use: bakes
  your key in so you can SSH in immediately after first boot.
- `reboot-on-error` - `true`/`false`. Set `false` so a failed install does NOT auto-reboot into a
  loop (lets you inspect logs).
- `reboot-mode` - `"reboot"` (default) or `"power-off"` after a successful install.
- `subscription-key` - optional PVE subscription key (added PVE 9.2-1 / PBS 4.2-1).

### `[network]`

- `source` - `"from-dhcp"` (default, recommended for a home LAN with DHCP) or `"from-answer"`
  (static config supplied below).
- With `source = "from-answer"` you must also give:
- `cidr` - address with prefix, e.g. `"192.168.1.50/24"` (IPv4) or `"2001:db8::10/64"`.
- `gateway` - default gateway IP.
- `dns` - DNS server IP.
- `filter.<PROPERTY> = "pattern"` - selects WHICH NIC is the management interface, by a udev
  property (see `device-info -t network`). Example matching by MAC suffix:
  `filter.ID_NET_NAME_MAC = "*e43d1afa379a"`. You can also match by name, e.g.
  `filter.ID_NET_NAME = "enp1s0"`.
- (PVE 9.1+) `[network.interface-name-pinning]` with `enabled = true` and a
  `[network.interface-name-pinning.mapping]` table mapping MAC to a stable name - not needed for a
  single-NIC PC.

### `[disk-setup]`

- `filesystem` - `"ext4"`, `"xfs"`, `"zfs"`, or `"btrfs"`.
- Disk selection (choose ONE approach):
- `disk-list = ["sda"]` - explicit device name(s). For a single disk this is the simplest, but
  device names can reorder across boots; serial/model filtering is safer.
- `filter.<PROPERTY> = "pattern"` - match by udev property, e.g. `filter.ID_MODEL = "Samsung*"` or
  `filter.ID_SERIAL = "KIOXIA_..."`. Use `device-info -t disk` / `device-match` to get and verify
  these.
- `filter-match = "any"` or `"all"` - combine multiple filter rules (default behavior is documented
  per version; with one rule it is moot).

Filesystem-specific option tables:

- `[disk-setup.lvm]` (for ext4/xfs, which install on LVM): `hdsize`, `swapsize`, `maxroot`, `maxvz`
  (a.k.a. `maxvol`), `minfree` - all in GiB. Set `swapsize = 0` for no swap; `maxvz = 0` to give all
  remaining space to root instead of a data volume.
- `[disk-setup.zfs]`: `raid` (`raid0`,`raid1`,`raid10`,`raidz-1`,`raidz-2`,`raidz-3`), `hdsize`,
  `ashift` (e.g. `12` for 4K-sector SSDs), `compress` (`on/off/lz4/zstd/gzip/...`), `checksum`
  (`on/fletcher4/sha256`), `copies`, `arc-max` (MiB cap on ZFS ARC).
- `[disk-setup.btrfs]`: `raid`, `hdsize`, `compress`.

**Single-disk note (this user):** there is no RAID. For ZFS, use `zfs.raid = "raid0"` - a
single-disk zpool with NO redundancy (a single-disk vdev is effectively raid0). For ext4/xfs the LVM
layout is inherently single-disk. The inline `key.subkey = value` ("dotted key") form, e.g.
`zfs.raid = "raid0"`, is equivalent to a `[disk-setup.zfs]` table.

### Other optional sections

- `[first-boot]` - run a script once after install (see section 5).
- `[post-installation-webhook]` - POST a notification to a URL after install: `url`,
  `cert-fingerprint`, `auth-token`.

### Filter wildcard syntax (disks and NICs)

- `?` one char, `*` zero-or-more, `[abc]`/`[a-z]` set, `[!abc]` negated set.

---

## 3a. COMPLETE commented example: single-disk ext4 + LVM

```toml
# ===== answer.toml: single-disk ext4 + LVM, DHCP, SSH-key login =====

[global]
keyboard = "en-us"
country = "us"
fqdn = "pve.home.lan" # this machine's hostname.domain
mailto = "you@example.com" # admin notification address
timezone = "America/New_York"

# Either set a plaintext password OR a hash. Hash preferred (see gotchas).
# root-password = "ChangeMeStrong!"
root-password-hashed = "$6$REPLACE_WITH_YOUR_OWN_HASH$..."

# Bake your SSH public key so you can log in headless right after first boot.
root-ssh-keys = [
 "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...your-key... you@laptop"
]

# Do NOT auto-reboot on a failed install, so you can inspect logs instead of
# looping. (true would reboot and likely retry/loop.)
reboot-on-error = false

[network]
source = "from-dhcp" # home LAN: let DHCP assign the address

[disk-setup]
filesystem = "ext4" # ext4 on LVM (classic, simple, single disk)
disk-list = ["sda"] # the single target disk (verify with device-info!)
# Safer alternative to disk-list, matching the disk by its serial so the right
# disk is always picked regardless of enumeration order:
# filter.ID_SERIAL = "Samsung_SSD_870_EVO_1TB_S5RXNF0...."

[disk-setup.lvm]
swapsize = 4 # GiB of swap (0 = none)
# hdsize = 0 # 0/omit = use whole disk
# maxroot = 0 # cap root LV (GiB); omit for default
# maxvz = 0 # 0 = no separate data volume; all space to root
# minfree = 0 # reserved free space in the volume group (GiB)
```

## 3b. COMPLETE commented example: single-disk ZFS (no redundancy)

```toml
# ===== answer.toml: single-disk ZFS (raid0 = single-disk zpool, NO redundancy) =====

[global]
keyboard = "en-us"
country = "us"
fqdn = "pve.home.lan"
mailto = "you@example.com"
timezone = "America/New_York"

root-password-hashed = "$6$REPLACE_WITH_YOUR_OWN_HASH$..."

root-ssh-keys = [
 "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...your-key... you@laptop"
]

reboot-on-error = false

[network]
source = "from-dhcp"

[disk-setup]
filesystem = "zfs"
# Single disk => raid0 (one-disk vdev, no parity/mirror, no redundancy).
zfs.raid = "raid0"
# Pick the one disk. With one disk you can use disk-list; serial filter is safest.
disk-list = ["sda"]
# filter.ID_SERIAL = "Samsung_SSD_870_EVO_1TB_S5RXNF0...."

[disk-setup.zfs]
ashift = 12 # 4K sectors (correct for virtually all modern SSDs/NVMe)
compress = "lz4" # cheap, recommended default ZFS compression
checksum = "on" # default checksum algorithm
copies = 1 # 1 = no extra in-pool copies (no redundancy on a single disk)
# hdsize = 0 # 0/omit = whole disk
# arc-max = 4096 # optional: cap ZFS ARC RAM use to 4 GiB on a small PC
```

---

## 4. End-to-end workflow to build a prepared ISO

1. Download the official Proxmox VE ISO from [Downloads](https://www.proxmox.com/downloads) (e.g.
   `proxmox-ve_8.4-1.iso`; for PVE 9.x grab the 9.x ISO). Verify its checksum.
2. On a Linux machine, install the tool: `apt install proxmox-auto-install-assistant xorriso`.
3. (Recommended) Identify the target disk/NIC on the actual PC so your filters are right: boot the
   PC from the official ISO and choose "Debug Mode" / terminal, or use any Linux live USB, then run
   `proxmox-auto-install-assistant device-info -t disk` and `... -t network`, and confirm with
   `device-match`.
4. Write `answer.toml` (use one of the examples above).
5. Validate it:

```bash
proxmox-auto-install-assistant validate-answer answer.toml
```

1. Build the auto-install ISO (iso mode is simplest for one PC):

```bash
proxmox-auto-install-assistant prepare-iso proxmox-ve_8.4-1.iso \
--fetch-from iso --answer-file answer.toml --output pve-auto.iso
```

1. (Optional) Inspect what got embedded:

```bash
proxmox-auto-install-assistant inspect-iso pve-auto.iso
```

1. Write `pve-auto.iso` to a USB stick (e.g. with `dd`, or balenaEtcher / Rufus in "DD" mode on
   Windows). Boot the target PC from it.

What the installer does on boot: the boot menu gains an **"Automated Installation"** entry which is
auto-selected (after a short ~10s timeout). The installer reads the answer file (per the fetch
mode), wipes/partitions the selected disk, installs Proxmox VE unattended with zero on-screen
interaction, and then reboots (or powers off, per `reboot-mode`). No keyboard/screen interaction is
needed - this is what makes it accessible.

On a FAILED install, log files are written to: `/tmp/fetch_answer.log`, `/tmp/auto_installer`,
`/tmp/install-low-level-start-session.log`.

---

## 5. First-boot / post-install automation

Two mechanisms run your own script once after the unattended install:

1. `prepare-iso --on-first-boot /path/to/script` - embeds a script (e.g. a shell script) that the
   installed system runs once on first boot. Good for fixing APT repos, adding extra SSH keys,
   installing packages, etc.

2. The `[first-boot]` section inside `answer.toml`:

- `source = "from-iso"` (script embedded in ISO) or `"from-url"` (downloaded).
- `ordering` = when it runs: `"before-network"`, `"network-online"`, or `"fully-up"`.
- `url` and `cert-fingerprint` when `source = "from-url"`.

Example (from-url, run once the network is online):

```toml
[first-boot]
source = "from-url"
ordering = "network-online"
url = "https://my.endpoint.local/first-boot"
cert-fingerprint = "AA:E8:CB:95:B1:..."
```

Typical first-boot script for a personal node: switch from the enterprise repo to
`pve-no-subscription`, disable the subscription nag, `apt update && apt full-upgrade`, and append
any additional SSH keys. (If `root-ssh-keys` is set in `[global]`, SSH already works on first boot,
so a first-boot script is optional.)

Forum note: some users hit issues with first-boot script execution/escaping; keep the script simple
and test it.
([Proxmox-auto-install-assistant first boot script issues.](https://forum.proxmox.com/threads/proxmox-auto-install-assistant-first-boot-script-issues.177318/))

---

## 6. Headless verification after install (no screen)

Because `root-ssh-keys` is baked in, the node is reachable the moment it finishes booting:

1. Find/confirm the IP. With `from-dhcp`, check the router's DHCP lease table for the `fqdn`
   hostname, or scan the LAN. With a static `[network]`, you already know the IP.
2. Confirm it is up: `ping <ip-or-hostname>`.
3. SSH in (key auth, no password prompt needed):

```bash
ssh root@<ip-or-hostname>
```

1. Confirm the install and version:

```bash
pveversion # e.g. pve-manager/8.4-1/... (running kernel: ...)
pveversion -v # detailed package versions
systemctl is-system-running
ip a # confirm network/IP
```

1. The web UI is at `https://<ip>:8006` for sighted helpers, but everything above is confirmable
   purely over SSH/CLI, which is the accessible path.

---

## 7. Gotchas and accessibility notes

- **Get the answer file right the FIRST time.** There is no interactive screen to catch a mistake. A
  wrong disk filter could select and ERASE the wrong disk. Identify the target disk by serial/model
  with `device-info -t disk`, confirm with `device-match`, and prefer
  `filter.ID_SERIAL`/`filter.ID_MODEL` over bare `disk-list = ["sda"]` if there is any other disk in
  the machine. Always run `validate-answer` before building.
- **Use a password HASH, not plaintext.** Generate one of:
- yescrypt (modern default): `openssl passwd -6 'YourPassword'` produces a `$6$` SHA-512 hash; for
  yescrypt use `mkpasswd -m yescrypt 'YourPassword'` (from the `whois` package). Put the result in
  `root-password-hashed`. Both `$6$...` and `$y$...` hashes are accepted.
- Avoid `root-password` plaintext sitting in the file/ISO.
- **Always set `root-ssh-keys`.** This is what makes the box reachable headless. Without it a
  screen-reader user cannot easily get in if anything about the network differs from expectations.
  Double-check the key string is the PUBLIC key, one entry per array element.
- **`reboot-on-error = false`.** Prevents a boot loop on a failed install; the machine stops so logs
  in `/tmp/*` can be read (e.g. by booting a live USB). With it `true`, a recurring failure could
  reboot endlessly with no feedback.
- **The tool is Linux-only.** On a Windows-only setup, run it under WSL, a Linux VM, or the
  community Docker container; then write the resulting ISO to USB with Rufus (DD mode) or
  balenaEtcher.
- **`xorriso` is required** for `prepare-iso` to repack the ISO; install it alongside the assistant.
- **DHCP vs static.** `source = "from-dhcp"` is easiest at home, but the IP may change; a DHCP
  reservation on the router (pin the node's MAC to a fixed IP) gives a stable address to SSH to.
  Otherwise use `source = "from-answer"` with a static `cidr`/`gateway`/`dns`.

---

## 8. Version caveats / gaps

- Automated installer introduced in **PVE 8.2**.
- `--partition-label` (custom label; default `PROXMOX-AIS`) available from **PVE 8.3-1** (PBS
  3.3-1).
- Keys: `kebab-case` is the current/preferred form; `snake_case` deprecated as of **PVE 9.0-1** but
  still accepted in 8.x.
- `[network.interface-name-pinning]` added in **PVE 9.1-1** (not needed for a single NIC).
- `subscription-key` in `[global]` added in **PVE 9.2-1** (PBS 4.2-1).
- The PVE 8.x ISO is Debian 12 (bookworm); PVE 9.x ISO is Debian 13 (trixie). The answer schema and
  workflow are the same across both; use the matching repo codename when installing the assistant.
- Gap: the in-manual (admin-guide) section is brief and defers to the wiki; the wiki page (cited
  throughout) is the authoritative, complete reference for the schema and commands.

---

## Citations

- "Automated Installation" wiki - schema, all five example answer.toml blocks, the `PROXMOX-AIS`
  label, the `mkfs.vfat`/`fatlabel` steps, fetch-from commands, `--cert-fingerprint` example, DHCP
  options 250/251, DNS TXT `proxmox-auto-installer.{domain}` records, device-info/device-match:
  [Automated Installation](https://pve.proxmox.com/wiki/Automated_Installation)
- PVE Admin Guide §2.4 "Unattended Installation" (answer file, filter rules, "Automated
  Installation" boot entry):
  [Proxmox VE Administration Guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.html)
- PVE Installation chapter (boot menu "Automated" entry, Debug Mode):
  [Installing Proxmox VE](https://pve.proxmox.com/pve-docs/chapter-pve-installation.html)
- PDM docs (same answer-file engine, HTTP/templating context):
  [Automated Installations](https://pdm.proxmox.com/docs/automated-installations.html)
- Community container with the tool pre-installed:
  [GitHub - jamestalmage/proxmox-auto-install-assistant-container: Docker container to create automated installations of proxmox, test and validate answer files.](https://github.com/jamestalmage/proxmox-auto-install-assistant-container)
