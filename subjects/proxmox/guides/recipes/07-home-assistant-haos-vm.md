# Recipe: Home Assistant (a HAOS virtual machine)

## What you'll be able to do

You will run Home Assistant Operating System as a dedicated [KVM/QEMU VM](../GLOSSARY.md), which is
the official supported install and the one that gives you the Supervisor and the Add-on Store. You
create the first owner account through Home Assistant's own web onboarding at `http://<ha-ip>:8123`,
reached in your normal browser with your screen reader, and from then on you manage it day to day
over SSH: editing the YAML configuration files and driving the `ha` command-line tool. The
Proxmox-side serial console (`qm terminal`) is there to watch the VM boot and diagnose it as plain
text: you see HAOS boot messages and then a plain `login:` prompt, not the Home Assistant UI.

## Before you start

This recipe reuses foundations rather than re-teaching them. You need:

- A [KVM/QEMU VM](../GLOSSARY.md) with a [serial console](../GLOSSARY.md). Adding a serial port
  (`--serial0 socket`) and pointing the display at it (`--vga serial0`) so `qm terminal` works is
  taught in guide [06 -- Virtual machines with qm](../06-virtual-machines-with-qm.md), and the
  cloud-init/template mechanics in guide
  [07 -- Cloud-init templates](../07-cloud-init-templates.md). As guide 06's lesson goes, host-side
  serial wiring alone is not enough for a generic guest; the guest's own kernel must drive the
  serial port. HAOS does: its image ships a kernel cmdline with `console=ttyS0`, so its boot
  messages reach `qm terminal` regardless. This recipe shows only the VM-creation lines specific to
  HAOS and points you there for the rest. Throughout, substitute the VM's own static address
  wherever you see `<ha-ip>`.
- A static IP for the VM, or a DHCP reservation, so you always reach the dashboard at the same
  `http://<ha-ip>:8123`. Giving a guest a static address is taught in guide
  [10 -- Networking](../10-networking.md).
- Optionally, the shared [Caddy](../GLOSSARY.md) box from recipe
  [00 -- The shared reverse proxy](00-reverse-proxy.md) if you want TLS in front of it. Do recipe 00
  first if so.

One accessibility point to settle up front, because Home Assistant is the one mission service whose
own setup is dashboard-oriented. The corpus's "no web GUI, no noVNC, no SPICE" rule is about the
Proxmox web interface and the graphical guest consoles (noVNC and SPICE), which you never use for
daily operation (the one documented SPICE exception is the attended install in guide
[08 -- Windows guests](../08-windows-guests.md)). It does not forbid a guest application's own web
UI reached in your everyday browser with your screen reader. Home Assistant's web onboarding and
dashboard at `http://<ha-ip>:8123` are exactly that: the guest app's own web interface, and they are
fine to use. There is no documented command-line path for creating the very first owner account, so
you do create that account through the onboarding form. After that, the bulk of configuration is
YAML files over SSH and the `ha` CLI. This recipe is honest about that split rather than pretending
Home Assistant is fully shell-driven.

## Pick the pattern and size it

This recipe is pattern D: a dedicated VM. Run Home Assistant as Home Assistant OS (HAOS) in its own
VM, because that is the install the Home Assistant project officially supports and the only one that
gives you the full experience.

Why HAOS in a VM rather than Home Assistant Container in an LXC:

- HAOS in a VM ships the Supervisor and the Add-on Store. The Supervisor manages the Home Assistant
  core, the add-ons (one-step installs of Mosquitto, Zigbee2MQTT, ESPHome, the SSH add-on you will
  use below, and more), and the managed OS updates. This is the supported, batteries-included path.
- Home Assistant Container in an LXC is lighter, but it strips the Supervisor and the Add-on Store,
  leaving you to install and maintain every dependency by hand. It is officially unsupported for the
  full experience. Choose the LXC only on very RAM-constrained hardware where you cannot spare a VM.

Size it at about 2 vCPU, 2 to 4 GB of RAM, and a 32 GB disk, which is the project's guidance for a
HAOS VM. If you drive Zigbee or Z-Wave devices, you pass the USB radio stick through to this VM
(shown in "Manage it from the shell" below), so plan to keep the stick attached to the Proxmox host.

How you reach it, by role:

- `qm terminal <vmid>` attaches to the VM's serial line and shows the HAOS boot messages followed by
  a plain `login:` prompt as plain text. The `ha >` console prompt is bound to the VGA console
  (tty1), which this corpus does not use, so you will not see it on serial; that is expected, not a
  fault. This is for watching the boot and diagnosing a VM that will not come up; it is not the Home
  Assistant UI.
- The web onboarding at `http://<ha-ip>:8123` in your browser is how you create the owner account
  and reach the dashboard.
- SSH and the `ha` CLI become available once you install the Advanced SSH & Web Terminal add-on from
  the dashboard (below); that is the day-to-day management surface.

### Path 1 -- the Helper-Scripts HAOS VM script

The community Helper-Scripts project publishes a Home Assistant OS VM helper at `vm/haos-vm.sh`.
Unlike the `ct/` scripts used by the other recipes, this one builds a VM rather than an LXC: it
downloads the official HAOS `qcow2.xz` image, validates and extracts it, runs `qm create` with
`-machine q35 -bios ovmf`, imports the disk, and sets `--serial0 socket` so the VM is reachable with
`qm terminal`. (The helper leaves the default VGA and does not add `--vga serial0`; serial output
still works because the HAOS image's kernel cmdline already includes `console=ttyS0`.) Run it in the
Proxmox host root shell:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/vm/haos-vm.sh)"
```

The `wget` form is equivalent:

```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/vm/haos-vm.sh)"
```

That one-liner pipes code fetched from the internet straight into a root shell on the host. Treat it
as untrusted root code: read it first, snapshot the host, and pin a reviewed commit instead of
`main`, exactly as guide [16 -- Automation and the ecosystem](../16-automation-and-the-ecosystem.md)
teaches. The pinned-commit form substitutes a specific commit hash for `main` in the URL so the code
cannot change between your audit and your run:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/<COMMIT_SHA>/vm/haos-vm.sh)"
```

The script's prompts are the same plain-text whiptail menus guide 16 describes; prefer its Default
mode to minimize menu navigation. When it finishes it prints the VMID it created. Reach the VM with
`qm terminal <vmid>` to watch HAOS finish its first boot, then continue at "First-run onboarding"
below. If you would rather build the VM yourself line by line, use Path 2 instead; the two paths
produce the same kind of HAOS VM. (Path 2 additionally sets `--vga serial0` while the helper leaves
the default VGA, but for the operator's purposes the serial output is the same either way, because
HAOS drives `console=ttyS0` itself.)

### Path 2 -- hand-built

This path does by hand what the helper automates, so you own every step. The HAOS image for
Proxmox/KVM is the generic x86-64 OVA image, distributed as a compressed
`haos_ova-<version>.qcow2.xz`. Confirm the current version on the Home Assistant install page cited
in Sources; the steps below use `17.3` as the concrete example, so substitute the version you
downloaded.

On the Proxmox host, fetch the image into a working directory and decompress it (HAOS ships it
`xz`-compressed):

```bash
cd /var/lib/pve/local-btrfs/template/iso
wget https://github.com/home-assistant/operating-system/releases/download/17.3/haos_ova-17.3.qcow2.xz
unxz haos_ova-17.3.qcow2.xz
```

That leaves `haos_ova-17.3.qcow2` in place. Now create the VM. HAOS needs UEFI firmware (OVMF) with
a non-Secure-Boot setup, the modern `q35` machine type, and the serial-first display so
`qm terminal` can read the boot. Create the VM shell first, with the guest agent enabled and the
serial console wired exactly as guide 06 teaches (substitute your own VMID, here `132`):

```bash
qm create 132 \
  --name homeassistant --ostype l26 \
  --machine q35 --bios ovmf \
  --cores 2 --memory 4096 \
  --scsihw virtio-scsi-single \
  --net0 virtio,bridge=vmbr0 \
  --agent enabled=1 \
  --serial0 socket --vga serial0
```

Add the EFI variables disk that OVMF requires. HAOS does not use Secure Boot, so create the EFI disk
without pre-enrolled keys:

```bash
qm set 132 --efidisk0 local-btrfs:1,efitype=4m
```

Import the decompressed HAOS image as the VM's disk. The Proxmox VE 9 one-shot `import-from` form
imports and attaches in a single step (the same machinery guide 06 covers under "Importing a disk"):

```bash
qm set 132 --scsi0 local-btrfs:0,import-from=/var/lib/pve/local-btrfs/template/iso/haos_ova-17.3.qcow2,discard=on,ssd=1
```

Set the boot order to the imported disk, then start the VM and attach to the serial line to watch
HAOS boot:

```bash
qm set 132 --boot order=scsi0
qm start 132
qm terminal 132
```

Press Enter once or twice to wake the output. HAOS prints its boot messages over serial and settles
at a plain `login:` prompt. That confirms the VM is alive and the serial wiring took; the `ha >`
banner belongs to the VGA console, so not seeing it here is expected, not a failure. Exit the
terminal with Ctrl-O (the letter O). Home Assistant itself is now coming up on the network at port
8123, which you reach from your browser next, not over this serial line.

## First-run onboarding

With the VM booted (either path), open `http://<ha-ip>:8123` in your normal browser with your screen
reader, substituting the VM's static address. The first time, Home Assistant takes a few minutes to
download and start its core, then presents the onboarding form. Create the owner account here: this
is the one step with no documented command-line equivalent, and it is the guest application's own
web UI in your browser, not a Proxmox graphical console. Work through the onboarding form to set the
account name, username, and password, confirm the location and unit preferences, and finish.

Once the owner account exists, the dashboard at the same address is your entry point for the few
things that are genuinely dashboard-driven (installing add-ons, most notably the SSH add-on below).
Everything else moves to the shell.

## Manage it from the shell

To get SSH and the `ha` command-line tool, install the Advanced SSH & Web Terminal add-on once, from
the dashboard: in Settings, open the Add-on Store, install "Advanced SSH & Web Terminal", add your
SSH public key (or a password) in its configuration, and start it. This is a one-time dashboard
step; it is what turns the VM into something you administer over SSH like every other guest. After
it is running, SSH into HAOS as the `root` user on the add-on's port and you land at the `ha` CLI.

From that SSH session, the `ha` CLI and the YAML files cover the bulk of management:

- Check the core, run a config check before a restart, and read the Supervisor state:

```bash
ha core info
ha core check
ha supervisor info
```

`ha core check` validates `configuration.yaml` and the files it includes before you restart, so you
catch a YAML error without taking the instance down. `ha core info` returns the running core version
(used in "Verify it worked" below).

- Edit the configuration the shell-only way. Home Assistant's configuration lives in YAML under
  `/config` (for example `/config/configuration.yaml`). Edit it with the accessible, non-interactive
  methods in guide [02 -- The shell and the API](../02-the-shell-and-the-api.md) (a here-doc, `tee`,
  or VS Code Remote-SSH), never a terminal editor, then apply it. File `/config/configuration.yaml`
  is the main file; after a change, validate and reload:

```bash
ha core check
ha core restart
```

- Home Assistant also exposes a full REST API (and a long-lived-token-authenticated interface) for
  scripted management, which reads cleanly as JSON; the `ha` CLI covers most day-to-day needs
  without it.

- Take Home Assistant's own backups, which capture the configuration, the add-ons, and their data in
  a Home Assistant-native archive (these are separate from, and complementary to, the whole-VM
  Proxmox backup in "Back it up"). From the dashboard these live under Settings, System, Backups;
  from the shell:

```bash
ha backups new
ha backups
```

Pass a USB Zigbee or Z-Wave radio through to the VM so Home Assistant can talk to it. This is done
on the Proxmox host with `qm set` adding a USB device, the passthrough mechanics guide
[21 -- Passing host hardware to guests](../21-passing-host-hardware-to-guests.md) covers (guide 21
comes after the recipes in the reading order, but the inline command below is enough to get
started). Identify the stick's bus/port (or its vendor:product id) on the host, then map it into the
VM and power-cycle the VM so it appears:

```bash
qm set 132 -usb0 host=10c4:ea60
qm stop 132
qm start 132
```

Here `10c4:ea60` is an example vendor:product id (a common Silicon Labs adapter); substitute your
own from the host, and for a device you depend on prefer the physical-port form
(`host=<bus>-<port>`) that guide
[21 -- Passing host hardware to guests](../21-passing-host-hardware-to-guests.md) teaches, which
pins to the port rather than the device id. After the VM restarts, the radio appears inside Home
Assistant for ZHA or Zigbee2MQTT to use.

The dashboard remains the place for a handful of tasks (installing add-ons, browsing integrations),
but day-to-day configuration is the file-based, `ha`-CLI workflow above.

## Put it behind TLS (optional)

Home Assistant listens on plain HTTP at port 8123; TLS is the shared Caddy container's job. Do not
give Home Assistant its own certificate. Add one site block to the Caddyfile on the Caddy container
from recipe [00 -- The shared reverse proxy](00-reverse-proxy.md), pointing at the VM's address and
port 8123.

On the Caddy container (after `pct enter` into it), append the Home Assistant block to the shared
Caddyfile, then reload, using the `tee -a` then reload pattern recipe 00 established. Substitute
your hostname and the VM's `<ha-ip>`. File `/etc/caddy/Caddyfile`:

```bash
tee -a /etc/caddy/Caddyfile >/dev/null <<'EOF'

home.example.com {
	reverse_proxy <ha-ip>:8123
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
}
EOF
caddy reload --config /etc/caddy/Caddyfile
```

The `tls { dns cloudflare ... }` block is the DNS-01 form recipe 00 and guide 12 cover; omit it only
if your Caddy container is not using DNS-01.

Home Assistant must be told to trust the proxy, or it rejects the forwarded requests. Add an `http:`
block to the configuration so it honours the forwarded headers and trusts only the Caddy container's
address. Edit the file the accessible way (guide 02), substituting the Caddy container's address for
`<caddy-ip>`. File `/config/configuration.yaml`:

```yaml
http:
  use_x_forwarded_for: true
  trusted_proxies:
    - <caddy-ip>
```

`use_x_forwarded_for: true` makes Home Assistant honour the proxy's forwarded client address, and
`trusted_proxies` lists the only host whose forwarded headers it trusts, which is the Caddy
container. Run `ha core check` then `ha core restart` to apply it.

## Verify it worked

Three checks confirm Home Assistant is up the accessible way.

First and most important, the web interface answers over plain HTTP at the VM's address. This is the
primary proof of a healthy boot, because a serving front end means the VM, the OS, and the Home
Assistant core are all up. Run it from the host or the Caddy container, which can reach `<ha-ip>`:

```bash
curl -I http://<ha-ip>:8123
```

The expected key line is an `HTTP/1.1 200 OK` status (a redirect to the onboarding or login is also
a healthy answer), which proves the Home Assistant front end is serving; the onboarding page then
loads in your browser at `http://<ha-ip>:8123`. If you fronted it with Caddy, the same check over
HTTPS at your real hostname confirms the certificate and proxy:

```bash
curl -I https://home.example.com
```

Second, as a secondary signal, the serial console shows the VM booting. On the Proxmox host:

```bash
qm terminal 132
```

Press Enter once or twice if the screen looks idle (Proxmox does not buffer serial, so a late attach
can look blank until a keypress); you should see kernel boot messages and then a plain `login:`
prompt, which proves the VM is alive and the serial wiring took. You will not see an `ha >` prompt
here, and that is expected, not a failure: the `ha >` console is bound to the VGA console, which
this corpus does not use. Exit with Ctrl-O.

Third, once the SSH add-on is installed, the `ha` CLI returns the core version over SSH:

```bash
ha core info
```

The expected key line is the `version:` field naming the running Home Assistant core release, which
proves the Supervisor and core are healthy and reachable from the shell.

## Back it up

This VM holds your whole home-automation brain: the configuration, the automations, the add-ons, and
their data. Two complementary backups cover it.

It is a guest like any other: add the VM by its VMID to the Proxmox Backup Server backup job from
guide [17 -- Backups with Proxmox Backup Server](../17-backups-with-pbs.md) so the whole VM is
captured on the regular schedule, and from there it rides along into the off-box copy described in
guide [18 -- The independent copy and restore](../18-the-independent-copy-and-restore.md). That is
your disaster-recovery copy of the entire machine.

Complement it with Home Assistant's own backups (Settings, System, Backups in the dashboard, or
`ha backups new` over SSH), which produce a Home Assistant-native archive of the configuration and
add-ons that you can restore into a fresh HAOS install or download off the VM. The whole-VM backup
restores the machine; the HA-native backup is the portable, application-level snapshot.

One caveat specific to this VM: a USB device passed through with `qm set ... -usbN host=...` is the
physical radio on the host, not data on the VM's disk, so it is not captured by a VM backup. A
restored VM expects the same stick mapped through again; re-add the `-usbN` line on the restored VM
and the radio reappears.

## Sources

- `research/round2-pve9/20-pve9-ecosystem-and-service-patterns.md` -- the Home Assistant per-service
  pattern (HAOS as a dedicated VM is the official supported install, pattern D; the Helper-Scripts
  HAOS VM helper that downloads the image and builds the VM; HAOS-in-a-VM gives the Supervisor and
  the Add-on Store and managed OS updates, while HA Container in an LXC strips the Supervisor and is
  officially unsupported for the full experience, chosen only on very RAM-constrained hardware;
  sized 2 vCPU / 2-4 GB RAM / 32 GB disk; pass a USB Zigbee/Z-Wave stick through to the VM; reach
  via `qm terminal` serial console or SSH; the bulk of config is YAML over SSH and the `ha` CLI/API
  cover most management, with the dashboard web-only but day-to-day config file-based).
- Guide [06 -- Virtual machines with qm](../06-virtual-machines-with-qm.md) and guide
  [07 -- Cloud-init templates](../07-cloud-init-templates.md) -- the `qm create` / OVMF-UEFI /
  `efidisk0` / `q35` VM mechanics, the `--serial0 socket --vga serial0` serial console and
  `qm terminal`, and the `import-from` disk import.
- Guide [21 -- Passing host hardware to guests](../21-passing-host-hardware-to-guests.md) -- USB
  passthrough with `qm set <vmid> -usbN host=...`, including the physical-port form
  `host=<bus>-<port>` for a device you depend on.
- Guide [16 -- Automation and the ecosystem](../16-automation-and-the-ecosystem.md) -- the
  Helper-Scripts curl-pipe-to-root caution (read first, snapshot, pin a commit) that `vm/haos-vm.sh`
  inherits, and its Default-mode whiptail-menu guidance.
- Home Assistant official docs: the
  [alternative/generic x86-64 install](https://www.home-assistant.io/installation/alternative/) (the
  `haos_ova-<version>.qcow2.xz` KVM image and its GitHub release URL, the non-Secure-Boot OVMF/UEFI
  requirement, the web onboarding that creates the owner account, and the 8123 port), the
  [Advanced SSH & Web Terminal add-on](https://github.com/hassio-addons/addon-ssh) (which provides
  SSH and the `ha` CLI), the
  [`ha` command-line reference](https://www.home-assistant.io/common-tasks/os/) (`ha core info`,
  `ha core check`, `ha supervisor info`, `ha backups`), and the
  [`http` integration reverse-proxy settings](https://www.home-assistant.io/integrations/http/)
  (`use_x_forwarded_for`, `trusted_proxies`).
- The community Helper-Scripts Home Assistant OS VM helper at `vm/haos-vm.sh` in
  `community-scripts/ProxmoxVE` (the script confirmed to download and validate the
  `haos_ova-*.qcow2.xz` image, extract it, and build the VM with
  `qm create -machine q35 -bios ovmf`, `qm importdisk`, and `--serial0 socket`).

---

Previous: [06 -- Drupal](06-drupal.md) | Next:
[08 -- Personal website via Cloudflare Tunnel](08-personal-website-cloudflare-tunnel.md)
