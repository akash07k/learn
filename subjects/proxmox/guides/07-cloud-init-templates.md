# Cloud-init templates

## What you'll be able to do

By the end of this guide you will have built one Debian 13 "trixie" golden template once, with the
serial console and the guest agent baked in, and you will clone a fresh, already-SSH-reachable VM
from it per service with zero installer interaction. The per-service loop becomes: `qm clone`, set
the IP and key, `qm start`, then `ssh` in within a minute. You will also know how to download cloud
images from the shell, supply custom first-boot logic through a snippet, inspect and regenerate the
cloud-init disk before you ever boot, and the btrfs raw-conversion detail that makes the import
"just work" on this node. This is the smoothest accessible way to stand up a VM, and the path guide
06 pointed you to.

## Before you start

Some of what follows is specific to Proxmox VE 9, so confirm your version first:

```bash
pveversion
```

You should see a `9.x` release. Several details below changed between Proxmox VE 8 and 9 (the
`--ciupgrade` default is now 1, `citype` is auto-selected from `ostype`, and `qm importdisk` is now
an alias of `qm disk import`), so run this and confirm 9.x before relying on the 9.x form. This
guide builds directly on guide 06: it reuses the same `qm` machinery (`--scsihw virtio-scsi-single`,
the `--serial0 socket --vga serial0` pair, `--agent enabled=1`, `import-from`, and `qm template` /
`qm clone`), so it points back to guide 06 for those rather than re-teaching them.

## Why cloud-init is the accessible path

Guide 06 taught the ISO-installer path and was honest about its hardest moment: a generic graphical
installer renders to a screen you cannot see, and you have to coax its kernel onto the serial line
by hand at the boot menu. Cloud-init removes that fight entirely, because there is no installer at
all.

- The vendor ships a **cloud image**: a pre-installed root filesystem as a `.qcow2` or `.img` that
  boots with no install step. You import the disk and boot it.
- On first boot, **cloud-init** reads a tiny config disk that Proxmox generates for the VM and does
  the setup for you: it creates your user, injects your SSH public key, sets the hostname,
  configures the network (DHCP or static), sets DNS, and can run arbitrary first-boot commands (for
  example installing `qemu-guest-agent`). The VM comes up already reachable.
- You wire the **serial console** into the _template_ once, so every clone has a working
  `qm terminal` from its very first boot, with no guest-side getty setup. Cloud images already
  enable a getty and kernel console on `ttyS0`, so the serial door works on every clone out of the
  box (guide 04 is the full reference for that door).

The result is that the loop becomes clone, set the IP and key, start, and `ssh` in. You never touch
a console for setup. This is exactly the path guide 06 recommended when an ISO installer will not
render to serial: a cloud image has no interactive installer to render, so the accessibility problem
disappears.

## One-time host prerequisites

Two storage facts have to be true before the rest works, and you set them up once.

### A snippets-enabled storage

Custom cloud-init user-data lives in a **snippet**, which is a storage **content type**. On this
btrfs-root node the active storage is `local-btrfs` (the plain `local` directory storage is
disabled, per guide [09 -- Storage](09-storage.md)), and `local-btrfs` does not have `snippets` in
its content list by default, so add it.

The critical gotcha: `pvesm set --content` **replaces** the whole content-type list, it does not
append. If you pass only `snippets`, you silently strip the other content types from `local-btrfs`.
Always re-list the types the storage already served plus `snippets`. So first see what `local-btrfs`
carries today before you change it:

```bash
grep -A6 '^btrfs: local-btrfs' /etc/pve/storage.cfg
```

Then re-list those existing types plus `snippets`:

```bash
pvesm set local-btrfs --content iso,vztmpl,backup,images,rootdir,snippets
```

With `snippets` enabled on `local-btrfs`, snippet files live under
`/var/lib/pve/local-btrfs/snippets/` and you reference them as `local-btrfs:snippets/<file>.yaml`.

### An images-capable storage for the cloud-init drive

The cloud-init config disk is a tiny (about 4 MB) generated drive, and it has to live on a storage
that carries the `images` content type. On this single btrfs node that is `local-btrfs`, which
carries every content type. Substitute your own `images`-capable storage for `local-btrfs`
everywhere below if yours differs.

## Download a cloud image

Everything here is from the shell, no browser. A scratch directory that already exists and is handy
is the iso directory, `/var/lib/pve/local-btrfs/template/iso/`; any directory on the host filesystem
works.

### Debian 13 "trixie"

Use the **genericcloud** variant. It is built for virtual machines (a reduced driver set, smaller
image) and is the right choice for KVM/Proxmox. The `generic` variant adds bare-metal drivers you do
not need; the `nocloud` variant has no cloud-init datasource and a blank root password, so do not
use it here. Fetch the image and verify it against the published checksums:

```bash
cd /var/lib/pve/local-btrfs/template/iso
wget https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2
wget https://cloud.debian.org/images/cloud/trixie/latest/SHA512SUMS
sha512sum -c SHA512SUMS 2>/dev/null | grep debian-13-genericcloud-amd64.qcow2
```

The last line should print the image filename followed by `OK`. The `grep` keeps the output to the
one image you care about, which reads cleanly.

### Ubuntu 24.04 LTS "noble"

If you prefer Ubuntu, the equivalent image is `noble-server-cloudimg-amd64.img`:

```bash
wget https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
```

The `.img` file is already qcow2 internally (`qemu-img info` confirms). Everything else in this
guide is identical; only the image URL and the built-in user differ (`debian` on Debian images,
`ubuntu` on Ubuntu).

Either way, note one thing: Debian and Ubuntu cloud images carry the `cloud-init` package
preinstalled, but they do **not** include `qemu-guest-agent`. You install that through first-boot
user-data (covered below), so `qm shutdown`, `qm agent`, and IP reporting work.

## Build the golden template (VMID 9000), once

By convention templates live in the 9000s; this one is VMID 9000. Do this part once. Each step is a
single command, in order.

First create the bare VM with the accessible defaults baked in:

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

These are the same flags guide 06 explains in full; the ones that carry the accessibility weight
here are:

- `--serial0 socket --vga serial0` is the accessibility backbone. It adds a serial port and routes
  the VM's display to it, so `qm terminal` gives a real text console. Because you set this on the
  _template_, every clone inherits it and has a working serial console from its first boot. Cloud
  images already run a getty on `ttyS0`, so no guest-side edit is needed (unlike the ISO path in
  guide 06).
- `--agent enabled=1` turns on the guest-agent channel. You still install the agent inside the guest
  through user-data below.
- `--scsihw virtio-scsi-single` is the recommended controller, and cloud images expect a virtio-scsi
  controller to be present.
- `--ostype l26` marks the guest as modern Linux, which also makes `citype` default correctly.

Next import the cloud image as the VM's disk. The Proxmox VE 9 one-shot `import-from` form imports
and attaches in a single step (this is the same machinery as guide 06's disk import):

```bash
qm set 9000 --scsi0 local-btrfs:0,import-from=/var/lib/pve/local-btrfs/template/iso/debian-13-genericcloud-amd64.qcow2,discard=on,ssd=1
```

`local-btrfs:0` means "allocate a new disk on `local-btrfs`, sized to fit the import".
`discard=on,ssd=1` enables TRIM passthrough, which is right on a btrfs-backed SSD. Cloud images are
small (a few GB), so grow the disk now; cloud-init's growpart expands the root filesystem on first
boot:

```bash
qm disk resize 9000 scsi0 +18G
```

Add the cloud-init drive. The special `:cloudinit` syntax tells Proxmox to generate the config disk
on that storage; `ide2` is the documented convention and keeps a scsi slot free:

```bash
qm set 9000 --ide2 local-btrfs:cloudinit
```

Set the boot order to boot straight off the imported disk, which is faster and deterministic:

```bash
qm set 9000 --boot order=scsi0
```

Now bake in the baseline cloud-init values, the settings that are the same for every clone.
Per-clone bits (hostname and IP) you set after cloning:

```bash
qm set 9000 \
 --ciuser akash \
 --sshkeys ~/.ssh/id_ed25519.pub \
 --ipconfig0 ip=dhcp \
 --nameserver 192.168.1.1 \
 --searchdomain home.arpa \
 --ciupgrade 1 \
 --citype nocloud
```

- `--ciuser` is the login user cloud-init creates, with passwordless sudo. If omitted, the image's
  built-in user is used (`debian` or `ubuntu`).
- `--sshkeys <file>` is a path to a file of OpenSSH public keys, one per line. This is the preferred
  auth method; avoid `--cipassword`. Because this bakes your key into every clone, keep the lockout
  safeguard from guide 02 in mind: keep an independent copy of that same public key in
  `~/.ssh/authorized_keys2`, a real file outside `/etc/pve`, so a pmxcfs problem cannot lock you
  out, and remember the serial console (guide 04) is the always-available fallback if SSH ever
  fails.
- `--ipconfig0 ip=dhcp` is only a placeholder on the template itself; each clone overrides it with
  its own static address (this corpus's default) in the per-clone step below, so the template never
  needs a fixed IP. The static variants are in the next section.
- `--nameserver` and `--searchdomain` set DNS; if unset, the guest inherits the host's resolver.
- `--ciupgrade 1` runs a package upgrade on first boot. In Proxmox VE 9 the default is already 1;
  set it to 0 if you want faster, reproducible, offline-friendly boots and prefer to patch later.
- `--citype nocloud` is the datasource format, the right choice for Debian and Ubuntu. We set it
  explicitly so the template is self-documenting; on 9.x it would default to `nocloud` from
  `--ostype l26` anyway, so you can omit it and get the same result.

Finally convert the VM to a template:

```bash
qm template 9000
```

This marks VM 9000 read-only and makes its base disk eligible for linked clones. You can no longer
start 9000 itself; you only clone from it.

## Static IP variants for ipconfig0

`ipconfig0` maps to `net0` (and `ipconfig1` to `net1`, and so on). The general grammar is
`[gw=<v4>][,gw6=<v6>][,ip=<v4/CIDR>][,ip6=<v6/CIDR>]`. The forms you will reach for:

```bash
# IPv4 static (this corpus's default: a fixed address per service guest)
qm set <id> --ipconfig0 ip=192.168.1.101/24,gw=192.168.1.1
# dual-stack in one line
qm set <id> --ipconfig0 ip=192.168.1.101/24,gw=192.168.1.1,ip6=auto
# IPv6 static
qm set <id> --ipconfig0 ip6=2001:db8::50/64,gw6=2001:db8::1
# IPv6 SLAAC autoconfiguration
qm set <id> --ipconfig0 ip6=auto
# DHCP (reasonable only for a throwaway; a service wants a fixed address)
qm set <id> --ipconfig0 ip=dhcp
```

`ipconfig0` is cloud-init's mechanism, so it applies to a Linux VM built from a cloud image. Other
guest types pin an address differently: a Windows VM has no `ipconfig0`, so you set a fixed address
inside the guest or with a DHCP reservation (guide [08 -- Windows guests](08-windows-guests.md),
"Give the guest a fixed address"), and an LXC container sets its address inline on
`pct create --net0 ...,ip=...` (guide
[05 -- Containers with LXC and pct](05-containers-with-lxc-and-pct.md)).

## Clone a service VM (per service)

This is the part you repeat per service. Cloning a template defaults to a **linked clone**: instant,
space-efficient, sharing the template's base disk via copy-on-write. Because a linked clone depends
on that base, do not delete the template while linked clones exist.

```bash
qm clone 9000 101 --name web01
```

For an independent copy (one that does not depend on the template, or one on different storage),
pass `--full`:

```bash
qm clone 9000 101 --name web01 --full --storage local-btrfs
```

Then set only the per-clone cloud-init bits and start. The hostname comes from `--name`
automatically, so usually you only set the IP:

```bash
qm set 101 --ipconfig0 ip=192.168.1.101/24,gw=192.168.1.1
qm start 101
```

On first boot cloud-init creates user `akash`, installs your key, sets the hostname `web01`, applies
the static IP, and runs any user-data. Within about 30 to 60 seconds you can SSH in with your key,
no password:

```bash
ssh akash@192.168.1.101
```

If SSH is not up yet, or you need to look at boot output, the serial console is always there:

```bash
qm terminal 101
```

Press Enter once or twice to wake it; exit with Ctrl-O (the letter O, not zero). That is the whole
per-service loop: `qm clone`, `qm set --ipconfig0`, `qm start`, `ssh`. No installer, no graphical
console, ever.

## Custom first-boot with snippets

The auto-generated user-data only handles the user, key, hostname, and upgrade. To install packages
(most importantly `qemu-guest-agent`) and run first-boot commands, supply your own user-data YAML as
a snippet. Write the whole file in one shot with a here-doc, with no terminal editor (this is the
shell-only method from guide 02's "Editing files accessibly"; VS Code Remote-SSH also works for a
longer file):

```bash
cat > /var/lib/pve/local-btrfs/snippets/debian-base.yaml <<'EOF'
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
EOF
```

Quoting the marker as `'EOF'` keeps the YAML literal (no `$` expansion). Read it back with
`cat /var/lib/pve/local-btrfs/snippets/debian-base.yaml` to confirm it landed exactly as intended.

The leading `#cloud-config` line is mandatory and must stay exactly as written; it is how cloud-init
recognizes the format. Enabling `qemu-guest-agent` here is what makes `qm shutdown`, `qm agent`, and
IP reporting work, since the image does not ship it. The `serial-getty@ttyS0` line is
belt-and-suspenders: Debian and Ubuntu cloud images already enable it, so it is a safe no-op if it
is already on.

Point the template at the snippet, and do this before `qm template 9000` so every clone inherits it:

```bash
qm set 9000 --cicustom "vendor=local-btrfs:snippets/debian-base.yaml"
```

If you already ran `qm template 9000` earlier, you have not missed your chance: config edits are
allowed on a template, so `qm set --cicustom` still applies to the existing template, and clones
made afterward will pick it up once you run `qm cloudinit update` on them. The instruction works
either way -- before templating for a clean inherit, or after, with the `cloudinit update`
follow-up.

The `cicustom` grammar allows up to four parts, each a snippet volume:
`user=<vol>,network=<vol>,meta=<vol>,vendor=<vol>`. The crucial interaction to understand:

- `user=` **replaces** Proxmox's generated user-data. When you set it, your file is the whole
  user-data, so `--ciuser` and `--sshkeys` are **not** merged in.
- `vendor=` **merges** alongside the generated user-data.

So you have a clean choice, and either is robust:

- Keep `--ciuser` and `--sshkeys` for identity, and put only your packages and `runcmd` logic in a
  `vendor=` snippet (which merges). This keeps the identity that Proxmox manages and adds your
  first-boot logic on top. This is the safer path, because it cannot strip your key. Point the
  template at the snippet in the `vendor=` slot instead of `user=`:

```bash
qm set 9000 --cicustom "vendor=local-btrfs:snippets/debian-base.yaml"
```

The `debian-base.yaml` shown above (which has no `users:` block) is exactly the right file for the
`vendor=` slot: it adds packages and `runcmd` and leaves Proxmox's generated identity untouched.

- Or fully own `user=` and declare the user, key, and packages yourself in the YAML:

```yaml
#cloud-config
users:
  - name: akash
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - ssh-ed25519 AAAA... akash@host
ssh_pwauth: false
packages:
  - qemu-guest-agent
runcmd:
  - systemctl enable --now qemu-guest-agent
```

What you must not do is set `user=` and still expect `--ciuser` / `--sshkeys` to apply; they will be
ignored, and a clone with no declared user and no merged key locks you out of SSH.

## Inspect and regenerate the cloud-init disk

Two commands let you see and refresh exactly what the guest will get, without booting it.

Dump the generated config Proxmox would hand the guest. This is the best way to verify a clone
before you start it, and to bootstrap a snippet (dump the user-data, save it, edit it, then point
`--cicustom user=` at it):

```bash
qm cloudinit dump 101 user # the user-data it would generate
qm cloudinit dump 101 network # the network-data (your ipconfig0, rendered)
qm cloudinit dump 101 meta # the meta-data (instance-id, and so on)
```

The big gotcha: the cloud-init disk is generated **once and cached**. If you change any `ci*` option
(`--ciuser`, `--sshkeys`, `--ipconfig0`, `--cicustom`) or edit a snippet file on a VM whose
cloud-init disk already exists, the change is not applied until the disk is regenerated:

```bash
qm cloudinit update 101
```

Stopping and starting the VM (a full `qm stop` then `qm start`) also regenerates it; a soft reboot
from inside the guest may not. One subtlety: cloud-init's `instance-id` stays the same across a
regeneration, so the guest treats it as the same instance, and `runcmd` and other per-instance
modules do **not** re-run on a mere config change. This does not affect the normal flow, because
each fresh clone is a brand-new instance and runs its first-boot logic once as expected.

## A note on btrfs storage

Because this host's root is btrfs, the `images`-capable storage you import onto is a `btrfs:`
storage, and that storage stores VM disks as **raw** files inside a per-disk subvolume (which is
what lets `qm snapshot` use native btrfs snapshots). When you import a `.qcow2` cloud image onto it,
Proxmox **converts it to raw automatically** during the import. You do not pass `--format`, and you
must not try to force `--format qcow2` onto a `btrfs:` storage, because it is rejected. This is the
intended path on this node: the image lands as a raw disk inside a subvolume, and `qm snapshot`
works. (`qemu-img info` on the underlying file reports `raw`, which is expected, not a problem.)

## Verify it worked

Confirm everything from the shell, with no graphical console in the loop.

The template is a template with serial wired in:

```bash
qm config 9000
```

The output should include `template: 1`, `serial0: socket`, and `vga: serial0`. Those three lines
confirm 9000 is read-only and that every clone inherits the serial console.

A clone will get your user and key, checked before you even start it:

```bash
qm cloudinit dump 101 user
```

The dumped user-data should show your user (`akash`) and your SSH public key. If it does not,
revisit the `--cicustom user=` versus `vendor=` interaction above.

The clone is reachable by key once it has booted:

```bash
ssh akash@192.168.1.101
```

You should land in a shell with no password prompt. Once the guest agent is up, the host can read
the clone's IP from inside it:

```bash
qm agent 101 network-get-interfaces
```

That returns the guest's interfaces and addresses as JSON, which reads cleanly with a screen reader.
If it errors with an agent-not-running message, the agent is not installed or started yet; check
that the snippet ran (`qm terminal 101`, then look for the service). The serial console is the
always-available proof and fallback:

```bash
qm terminal 101
```

Press Enter once or twice; you should reach a login prompt or a live shell. Exit with Ctrl-O.
Reaching this is the proof that the serial wiring on the template took, independent of SSH and the
network.

## Sources

- `research/round2-pve9/11-pve9-cloudinit-templating.md` - the whole cloud-init templating workflow
  grounded here: why cloud-init is the accessible path (no installer, the generated config disk,
  serial baked into the template); the one-time host prerequisites
  (`pvesm set local-btrfs --content iso,vztmpl,backup,images,rootdir,snippets` and the
  replace-not-append gotcha, the `images`-capable storage for the cloud-init drive); downloading the
  Debian 13 genericcloud image (and why genericcloud over generic/nocloud) with `SHA512SUMS`
  verification, the Ubuntu noble alternative, and the missing `qemu-guest-agent`; building the
  golden template VMID 9000 (`qm create` with
  `--scsihw virtio-scsi-single --ostype l26 --serial0 socket --vga serial0 --agent enabled=1`, the
  `import-from` one-shot, `qm disk resize`, the `:cloudinit` drive on `ide2`, `--boot order=scsi0`,
  the baseline
  `--ciuser`/`--sshkeys`/`--ipconfig0`/`--nameserver`/`--searchdomain`/`--ciupgrade`/`--citype`
  values, then `qm template`); the `ipconfig0` static-IP variants; the per-service clone loop
  (`qm clone` linked vs `--full`, `qm set --ipconfig0`, `qm start`, `ssh`, `qm terminal` fallback);
  custom first-boot snippets and the crucial `--cicustom user=` replaces versus `vendor=` merges
  interaction; `qm cloudinit dump`/`update` and the cached-disk regenerate gotcha; and the btrfs
  qcow2-to-raw conversion note.
- `GLOSSARY.md` and `CONTEXT.md` - the canonical definitions of cloud image, cloud-init, snippet,
  content type, template / linked clone, `virtio-scsi-single`, qemu-guest-agent, serial console,
  `qm`, and `local-btrfs` reused here, and the role names (Proxmox host, control station, guest, the
  three superpowers).
- Proxmox VE documentation: the
  [Cloud-Init Support wiki](https://pve.proxmox.com/wiki/Cloud-Init_Support),
  [qm.1](https://pve.proxmox.com/pve-docs/qm.1.html),
  [qm.conf.5](https://pve.proxmox.com/pve-docs/qm.conf.5.html),
  [the Qemu/KVM chapter](https://pve.proxmox.com/pve-docs/chapter-qm.html), and the
  [BTRFS storage wiki](https://pve.proxmox.com/wiki/Storage:_BTRFS).
- Cloud images:
  [Debian 13 trixie cloud images](https://cloud.debian.org/images/cloud/trixie/latest/) and
  [Ubuntu 24.04 noble cloud images](https://cloud-images.ubuntu.com/noble/current/).

---

Previous: [06 -- Virtual machines with qm](06-virtual-machines-with-qm.md) | Next:
[08 -- Windows guests](08-windows-guests.md)
