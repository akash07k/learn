# PVE 9 cloud-init VM templating (shell-only, serial-enabled, SSH-reachable)

Target: latest Proxmox VE 9.x on Debian 13 "trixie", mid-2026. PVE 9 moved from QEMU 10.x in 9.0 and
9.1 to QEMU 11.0 in current 9.2.

Audience: a blind, screen-reader, **shell-only** operator on a **single node** whose host root is
**BTRFS**, building home services + a dev lab. The noVNC/SPICE graphical console is unusable, so the
entire point of this workflow is to produce VMs that boot **already SSH-reachable and
serial-console-enabled** with **zero installer interaction**. You build one Debian 13 "golden
template" once, then `qm clone` a fresh VM per service and only set its hostname/IP/SSH key. No ISO,
no installer, no novnc.

This document reports what is TRUE in PVE 9 and flags deltas from PVE 8.

Primary citations:

- [Cloud-Init Support](https://pve.proxmox.com/wiki/Cloud-Init_Support)
- [qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html)
- [qm.conf(5)](https://pve.proxmox.com/pve-docs/qm.conf.5.html)
- [QEMU/KVM Virtual Machines](https://pve.proxmox.com/pve-docs/chapter-qm.html) (section "Cloud-Init
  Support")
- [Proxmox VE Storage](https://pve.proxmox.com/pve-docs/chapter-pvesm.html) and
  [Storage: BTRFS](https://pve.proxmox.com/wiki/Storage:_BTRFS)

---

## 1. Why cloud-init is THE accessible path

A normal ISO install forces you through a graphical/curses installer that, on a blind+shell-only
box, you can only drive over serial _if_ you remembered to wire serial into the ISO boot - fiddly
and OS-specific. Cloud images sidestep all of that:

- The vendor ships a pre-installed root filesystem as a `.qcow2`/`.img` disk. There is **no install
  step** - you import the disk and boot it.
- On first boot, **cloud-init** reads a tiny config disk that Proxmox generates and: creates your
  user, injects your SSH public key, sets the hostname, configures the network (DHCP or static),
  sets DNS, optionally runs arbitrary first-boot commands (e.g. `apt install qemu-guest-agent`). The
  box comes up reachable.
- You wire `serial0` + `qm terminal` into the **template**, so every clone has a working serial
  console from the very first boot as a fallback to SSH.

Net result: clone to set IP/key to start to `ssh` in. Never touch a console for setup.

---

## 2. One-time prerequisites on the host

### 2.1 A snippets-enabled storage (needed for custom user-data)

Custom cloud-init user-data lives in **snippets**, a storage _content type_. On this btrfs-root node
the active storage is `local-btrfs`; the plain `local` directory storage is disabled by default. Add
`snippets` to `local-btrfs` once:

```bash
# Inspect current content types
pvesm status --content snippets # lists stores that already allow snippets
grep -A6 '^btrfs: local-btrfs' /etc/pve/storage.cfg

# Enable snippets (plus the types local-btrfs already had). Keep existing ones!
pvesm set local-btrfs --content iso,vztmpl,backup,images,rootdir,snippets
```

Snippet files then live under `/var/lib/pve/local-btrfs/snippets/` and you reference them as
`local-btrfs:snippets/<file>.yaml`. (Content-dir override: `--content-dirs snippets=/path`.)

Gotcha: `pvesm set --content ...` **replaces** the whole list - always re-list the types the storage
already served or you will silently strip `iso`/`backup`.

### 2.2 The qm cloud-init drive needs an `images`-capable storage

The generated cloud-init config disk (a tiny ~4 MB drive) is created on a storage that supports
`images` content. On a single BTRFS-root box that is typically `local-btrfs` (content
`images,rootdir,...`). See the BTRFS note in §9.

---

## 3. Download official cloud images from the shell

All from the command line, no browser.

### 3.1 Debian 13 "trixie" (matches your host generation)

Use the **genericcloud** variant: it is built for virtual machines (reduced driver set, smaller) and
is the right choice for KVM/Proxmox. (`generic` adds bare-metal drivers; `nocloud` has no cloud-init
datasource and a blank root password - do not use it here.)

```bash
cd /var/lib/pve/local-btrfs/template/iso # any scratch dir is fine; this one is handy
wget https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2
# verify
wget https://cloud.debian.org/images/cloud/trixie/latest/SHA512SUMS
sha512sum -c SHA512SUMS 2>/dev/null | grep debian-13-genericcloud-amd64.qcow2
```

### 3.2 Ubuntu 24.04 LTS "noble"

```bash
wget https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
# (the .img file is already qcow2 internally; qemu-img info confirms)
```

Note: Debian/Ubuntu cloud images carry the `cloud-init` package preinstalled. They do **not**
include `qemu-guest-agent` by default - install it via first-boot user-data (§7) so `qm shutdown`/IP
reporting works.

Citations:
[Index of /images/cloud/trixie/latest](https://cloud.debian.org/images/cloud/trixie/latest/) ,
[Ubuntu 24.04 LTS (Noble Numbat) daily \[20260518\]](https://cloud-images.ubuntu.com/noble/current/)
, [Debian -- Debian "trixie" Release Information](https://www.debian.org/releases/trixie/)

---

## 4. Build the template VM (the part you do ONCE)

We use VMID **9000** by convention (templates in the 9000s). Replace `local-btrfs` with your actual
`images`-capable storage everywhere.

### 4.1 Create a bare VM with the accessible defaults baked in

```bash
qm create 9000 \
 --name debian13-tmpl \
 --memory 2048 --cores 2 \
 --net0 virtio,bridge=vmbr0 \
 --scsihw virtio-scsi-single \
 --ostype l26 \
 --serial0 socket --vga serial0 \
 --agent enabled=1
```

Why each accessibility-relevant flag:

- `--scsihw virtio-scsi-single` - modern virtio-scsi controller (per-disk iothread). Cloud images
  expect a virtio-scsi controller; this is the recommended PVE 9 default.
- `--serial0 socket` + `--vga serial0` - **this is the accessibility backbone.** It adds a serial
  port and routes the VM's "display" to that serial line, so `qm terminal 9000` gives you a real
  text console. Debian/Ubuntu cloud images already enable a getty + kernel console on `ttyS0`, so
  this works out of the box with no in-guest edits.
- `--agent enabled=1` - turns on the QEMU guest-agent channel (you still must _install_ the agent
  in-guest via user-data, §7).
- `--ostype l26` - Linux 2.6+/modern; also makes `citype` default to `nocloud`.

### 4.2 Import the cloud image as the VM's disk

Two equivalent spellings in PVE 9 (`qm importdisk` is now an **alias** for `qm disk import`). The
one-liner `--import-from` (in `qm set`/`qm create`) is the slickest:

```bash
# Preferred PVE 9 one-liner: import + attach as scsi0 in one step
qm set 9000 --scsi0 local-btrfs:0,import-from=/var/lib/pve/local-btrfs/template/iso/debian-13-genericcloud-amd64.qcow2,discard=on,ssd=1
```

`local-btrfs:0` means "allocate a new disk on local-btrfs, sized to fit the import".
`discard=on,ssd=1` enables TRIM passthrough (good on SSD/BTRFS).

Equivalent two-step form (if you prefer explicit import then attach):

```bash
qm disk import 9000 /var/lib/pve/local-btrfs/template/iso/debian-13-genericcloud-amd64.qcow2 local-btrfs
# prints e.g. "imported ... as 'local-btrfs:9000/vm-9000-disk-0.raw'"; it lands UNUSED:
qm set 9000 --scsi0 local-btrfs:9000/vm-9000-disk-0.raw,discard=on,ssd=1
```

Optionally grow the (typically small, ~2-3 GB) cloud image to a sane size now or per-clone later:

```bash
qm disk resize 9000 scsi0 +18G # cloud-init/growpart expands the rootfs on boot
```

### 4.3 Add the cloud-init drive

The cloud-init config disk is presented to the guest as a CD-ROM-like drive. Convention is `ide2`:

```bash
qm set 9000 --ide2 local-btrfs:cloudinit
```

`local-btrfs:cloudinit` is special syntax: it tells Proxmox to _generate_ the cloud-init disk on
that storage. (You can use `--scsiN ...:cloudinit` instead, but `ide2` is the documented norm and
avoids occupying a scsi slot.)

### 4.4 Set boot order

```bash
qm set 9000 --boot order=scsi0
```

Boot straight off the imported disk (skips trying the empty cloud-init/net first; faster,
deterministic).

### 4.5 Bake baseline cloud-init values into the template

Put everything that is the SAME for every clone here. Per-clone bits (hostname, IP, maybe a
different key) you set after cloning in §6.

```bash
qm set 9000 \
 --ciuser akash \
 --sshkeys ~/.ssh/id_ed25519.pub \
 --ipconfig0 ip=dhcp \
 --nameserver 192.168.1.1 \
 --searchdomain lan \
 --ciupgrade 1 \
 --citype nocloud
```

- `--sshkeys <file>` - path to a file of OpenSSH public keys, one per line. This is the
  **preferred** auth method; do not use `--cipassword` if you can avoid it. (In `qm.conf` the stored
  key name is `sshkeys`; the CLI also accepts `--sshkey`/`--sshkeys`.)
- `--ciuser` - the login user cloud-init creates (passwordless sudo). If omitted, the image's
  built-in user is used (`debian` on Debian images, `ubuntu` on Ubuntu).
- `--cipassword '<pw>'` - optional console password. Avoid for security; if set, it is stored
  hashed. Needed only if you want serial-console _login_ without a key.
- `--ipconfig0 ip=dhcp` - DHCP on net0. For static, see §5.
- `--nameserver` / `--searchdomain` - DNS. If unset, the guest inherits the **host's** resolver
  settings.
- `--ciupgrade 1` - (PVE 9 default = 1) run a package upgrade on first boot. Set to 0 if you want
  faster, reproducible boots and prefer to patch later.
- `--citype nocloud` - datasource format. `nocloud` is the Linux default and the right choice for
  Debian/Ubuntu. `configdrive2` is for Windows/cloudbase-init or OpenStack images; `opennebula`
  exists too. **Delta to know:** PVE auto-selects `citype` from `ostype` if you do not set it
  (nocloud for Linux), so this line is usually optional.

### 4.6 Convert to a template

```bash
qm template 9000
```

This marks the VM read-only and (on supporting storage) makes its base disk eligible for **linked
clones**. You can no longer start 9000 itself; you only clone from it.

---

## 5. Static IP variants for `--ipconfig0`

```bash
# DHCP (default)
qm set <id> --ipconfig0 ip=dhcp
# IPv4 static
qm set <id> --ipconfig0 ip=192.168.1.50/24,gw=192.168.1.1
# IPv6 static
qm set <id> --ipconfig0 ip6=2001:db8::50/64,gw6=2001:db8::1
# IPv6 SLAAC autoconf (cloud-init 19.4+)
qm set <id> --ipconfig0 ip6=auto
# dual-stack in one line
qm set <id> --ipconfig0 ip=192.168.1.50/24,gw=192.168.1.1,ip6=auto
```

`ipconfig0` maps to `net0`, `ipconfig1` to `net1`, etc. The general grammar is
`[gw=<v4>][,gw6=<v6>][,ip=<v4/CIDR>][,ip6=<v6/CIDR>]`.

---

## 6. Clone a service VM from the template (the part you do PER service)

Linked clone (default for templates) - instant, space-efficient, shares the template's base disk
read-only:

```bash
qm clone 9000 101 --name web01
```

Full clone - independent copy (use if you will delete/replace the template, or need the clone on
different storage):

```bash
qm clone 9000 101 --name web01 --full --storage local-btrfs
```

Then set only the per-clone cloud-init bits and start:

```bash
qm set 101 --ipconfig0 ip=192.168.1.101/24,gw=192.168.1.1
# (optional) per-clone hostname is taken from --name by default; override the SSH key/user if needed
qm start 101
```

First boot now: cloud-init creates user `akash`, installs your key, sets hostname `web01`, applies
the static IP, runs any user-data (§7). Within ~30-60s:

```bash
ssh akash@192.168.1.101 # works, key-based, no password
# or fall back to the serial console any time:
qm terminal 101 # Ctrl-O to detach
```

That is the whole per-service loop: `qm clone` to `qm set --ipconfig0` to `qm start` to `ssh`. No
installer, no novnc, ever.

---

## 7. Custom first-boot setup via snippets (`--cicustom user=...`)

The auto-generated user-data only does user/key/hostname/upgrade. To install packages (critically
**qemu-guest-agent**) and configure the box, supply your own user-data YAML as a snippet. This is
the single most useful customization for this mission.

### 7.1 Write the user-data snippet

`/var/lib/pve/local-btrfs/snippets/debian-base.yaml`:

```yaml
#cloud-config
package_update: true
package_upgrade: true
packages:
 - qemu-guest-agent
 - sudo
 - vim
 - curl
runcmd:
 - systemctl enable --now qemu-guest-agent
 - systemctl enable --now serial-getty@ttyS0.service
```

The leading `#cloud-config` line is mandatory - it is how cloud-init recognizes the format. Enabling
`qemu-guest-agent` here is what makes `qm shutdown`, `qm agent`, and IP reporting work (the image
does not ship it).

### 7.2 Point the VM (or template) at it

```bash
qm set 9000 --cicustom "vendor=local-btrfs:snippets/debian-base.yaml"
```

The `cicustom` grammar allows up to four parts, each a snippet volume:

```text
--cicustom "user=<vol>,network=<vol>,meta=<vol>,vendor=<vol>"
```

Important interaction: when you set `user=`, your file **replaces** Proxmox's generated user-data -
so `--ciuser`/`--sshkeys`/`--cipassword` are NOT auto-merged in. Either put
`users:`/`ssh_authorized_keys:` directly in your YAML, or keep the GUI-managed identity by leaving
`user=` unset and only override `network=`/`meta=`. A common pattern is to put _only_ package/runcmd
logic in a `vendor=` snippet (which DOES merge alongside the generated user-data) if you want both.
For a single-node home lab, the simplest robust choice is: keep `--ciuser`/`--sshkeys` for identity
and put packages in `vendor=` - or fully own `user=` and declare the user yourself:

```yaml
#cloud-config
users:
 - name: akash
 sudo: ALL=(ALL) NOPASSWD:ALL
 shell: /bin/bash
 ssh_authorized_keys:
 - ssh-ed25519 AAAA... akash@host
ssh_pwauth: false
packages: [qemu-guest-agent]
runcmd: [systemctl enable --now qemu-guest-agent]
```

Bake `--cicustom` into the template (set it on 9000 before `qm template`) so every clone inherits
it.

Citation: [Cloud-Init Support](https://pve.proxmox.com/wiki/Cloud-Init_Support) (section "Custom
Cloud-Init Configuration"); [qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html) (cicustom).

---

## 8. Inspect & regenerate: `qm cloudinit dump` / `qm cloudinit update`

These two commands are how you debug cloud-init without booting.

```bash
# Print the EXACT generated config Proxmox will hand the guest (great for verifying)
qm cloudinit dump 101 user # user-data it would generate
qm cloudinit dump 101 network # network-data (renders your ipconfig0 into NoCloud)
qm cloudinit dump 101 meta # meta-data (instance-id, etc.)
```

`qm cloudinit dump ... user` is also the best way to **bootstrap a custom snippet**: dump the
generated user-data, save it as a snippet, edit, then point `--cicustom user=` at it.

### 8.1 THE big gotcha: regenerate the disk after changing cloud-init options

The cloud-init drive is generated **once** and cached. If you change any `ci*` option (`--ciuser`,
`--sshkeys`, `--ipconfig0`, `--cicustom`, edit the snippet file, etc.) on a VM whose cloud-init disk
already exists, the change is NOT applied until the disk is regenerated. Two ways:

```bash
qm cloudinit update 101 # regenerate the cloud-init disk in place (explicit)
```

or simply **stop and start** the VM (a full reboot from `stop` regenerates it; a soft `reboot` may
not). Note cloud-init's `instance-id` stays the same across regenerations, so the guest treats it as
the _same_ instance - meaning **`runcmd`/per-instance modules do NOT re-run** on a mere config
change. To force a true first-boot again, you must change the instance-id (or `cloud-init clean`
inside the guest). For the normal clone-and-deploy flow this is a non-issue because each clone is a
brand-new instance.

Citation: [qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html) (`qm cloudinit`),
[Cloud-Init Support](https://pve.proxmox.com/wiki/Cloud-Init_Support) .

---

## 9. BTRFS host-root gotchas (specific to this box)

Your host root is BTRFS, so the `images`-capable storage you import onto is most likely a
**`btrfs:`** storage. Two things to know:

1. **BTRFS storage stores VM disks as `raw`, placed inside a per-disk subvolume** (so it can
   snapshot them and preserve snapshots across offline migration). It does **not** serve `qcow2` as
   the on-disk VM format. This is fine: when you `qm disk import` / `--import-from` a `.qcow2` cloud
   image onto a BTRFS storage, Proxmox **converts it to raw** automatically during import. You do
   not need `--format`; do NOT try to force `--format qcow2` onto BTRFS storage - it will be
   rejected.
2. If you instead want qcow2-on-disk (thin files, reflink snapshots) you would configure the same
   BTRFS mount as a plain **`dir:`** storage with `--content images` and default `--format qcow2`,
   trading away PVE-managed BTRFS subvolume snapshots. For this mission, stick with the native
   `btrfs:` storage + raw + subvolume snapshots; it is the intended path and `qm snapshot` works.

Either way the import "just works" - the only practical effect is that the cloud image lands as a
raw disk inside a subvolume on BTRFS. (`qm disk import` shows the resulting volid; `qemu-img info`
on the underlying file will report `raw`.)

Citations: [Storage: BTRFS](https://pve.proxmox.com/wiki/Storage:_BTRFS) ,
[Proxmox VE Storage](https://pve.proxmox.com/pve-docs/chapter-pvesm.html) .

---

## 10. PVE 9 deltas & gotchas (quick reference)

- **`qm importdisk` to `qm disk import`**: the modern spelling is `qm disk import`; `importdisk`
  still works as an alias. `--import-from` in `qm set`/`qm create` does import+attach in one line
  and is the cleanest PVE 8/9 path.
- **`--ciupgrade` default = 1**: clones run an `apt upgrade` on first boot unless you set
  `--ciupgrade 0`. Set 0 for fast, reproducible, offline-friendly boots.
- **`citype` auto-selected from `ostype`**: nocloud for Linux, configdrive2 for Windows; you rarely
  need to set it explicitly.
- **`scsihw virtio-scsi-single`** is the recommended controller; cloud images need a virtio-scsi
  controller present.
- **Cloud-init disk is cached** - change any `ci*` option (or edit a snippet) then run
  `qm cloudinit update <id>` (or stop+start). Soft reboot is not guaranteed to refresh.
- **`--cicustom user=` replaces, `vendor=` merges**: setting `user=` drops the GUI identity merge;
  declare your user in the YAML or use `vendor=` for additive logic.
- **Cloud images lack `qemu-guest-agent`** - install it via user-data (`packages:` +
  `systemctl enable --now qemu-guest-agent`) and set `--agent enabled=1` on the VM.
- **BTRFS**: imports convert qcow2 to raw into a subvolume; do not force qcow2 format on a `btrfs:`
  storage.
- **Snippets storage must be enabled** (`pvesm set local-btrfs --content ...,snippets`) before
  `--cicustom` paths resolve; re-list existing content types to avoid stripping them.
- **Serial is the accessibility win**: `--serial0 socket --vga serial0` on the _template_ means
  every clone has `qm terminal` working from first boot - your fallback when SSH is not yet up.

---

## 11. Complete end-to-end recipe (copy/paste skeleton)

```bash
### ----- ONE TIME: host prep -----
pvesm set local-btrfs --content iso,vztmpl,backup,images,rootdir,snippets
mkdir -p /var/lib/pve/local-btrfs/snippets
cat >/var/lib/pve/local-btrfs/snippets/debian-base.yaml <<'EOF'
#cloud-config
package_upgrade: true
packages: [qemu-guest-agent, sudo, vim, curl]
runcmd:
 - systemctl enable --now qemu-guest-agent
EOF

### ----- ONE TIME: build the Debian 13 golden template (VMID 9000) -----
cd /var/lib/pve/local-btrfs/template/iso
wget https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2

qm create 9000 --name debian13-tmpl --memory 2048 --cores 2 \
 --net0 virtio,bridge=vmbr0 --scsihw virtio-scsi-single --ostype l26 \
 --serial0 socket --vga serial0 --agent enabled=1
qm set 9000 --scsi0 local-btrfs:0,import-from=/var/lib/pve/local-btrfs/template/iso/debian-13-genericcloud-amd64.qcow2,discard=on,ssd=1
qm disk resize 9000 scsi0 +18G
qm set 9000 --ide2 local-btrfs:cloudinit
qm set 9000 --boot order=scsi0
qm set 9000 --ciuser akash --sshkeys ~/.ssh/id_ed25519.pub \
 --ipconfig0 ip=dhcp --nameserver 192.168.1.1 --searchdomain lan \
 --cicustom "vendor=local-btrfs:snippets/debian-base.yaml"
qm template 9000

### ----- PER SERVICE: clone, set IP, boot, ssh -----
qm clone 9000 101 --name web01
qm set 101 --ipconfig0 ip=192.168.1.101/24,gw=192.168.1.1
qm start 101
# verify before connecting (no console needed):
qm cloudinit dump 101 user
ssh akash@192.168.1.101 # serial fallback: qm terminal 101 (Ctrl-O to exit)
```

For Ubuntu 24.04, swap the image URL/file (`noble-server-cloudimg-amd64.img`) and adjust the snippet
user (`ubuntu`) - everything else is identical.

---

## 12. Sources

- Proxmox VE Wiki - Cloud-Init Support:
  [Cloud-Init Support](https://pve.proxmox.com/wiki/Cloud-Init_Support)
- qm(1) manual (qm set / clone / template / disk import / cloudinit):
  [qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html)
- qm.conf(5) (ciuser/cipassword/sshkeys/ipconfig/citype/cicustom):
  [qm.conf(5)](https://pve.proxmox.com/pve-docs/qm.conf.5.html)
- Admin guide, Qemu/KVM chapter (Cloud-Init Support section):
  [QEMU/KVM Virtual Machines](https://pve.proxmox.com/pve-docs/chapter-qm.html)
- Storage / pvesm (snippets content type, BTRFS):
  [Proxmox VE Storage](https://pve.proxmox.com/pve-docs/chapter-pvesm.html) ,
  [Storage: BTRFS](https://pve.proxmox.com/wiki/Storage:_BTRFS)
- Debian 13 trixie cloud images:
  [Index of /images/cloud/trixie/latest](https://cloud.debian.org/images/cloud/trixie/latest/)
- Ubuntu 24.04 noble cloud images:
  [Ubuntu 24.04 LTS (Noble Numbat) daily \[20260518\]](https://cloud-images.ubuntu.com/noble/current/)
