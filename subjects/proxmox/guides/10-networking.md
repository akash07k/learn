# Networking

## What you'll be able to do

By the end of this guide you will understand how a single wired Proxmox host does networking from
the shell: the `ifupdown2` model where the whole host config is one file you reload live, the
default `vmbr0` bridged install that makes guests first-class hosts on your home LAN, and how to
give the host a stable management IP. You will be able to attach VMs and containers to the network
(LAN DHCP, a static IP, or a tagged VLAN), make `vmbr0` VLAN-aware, and stand up a NAT bridge for an
isolated dev lab. Throughout, you will do this without ever cutting off your own SSH, and you will
keep `/etc/hosts` and DNS in the shape pmxcfs needs. The firewall itself is guide 11; this guide
forward-references it.

## Before you start, and the lifeline rule

Some of what follows is specific to Proxmox VE 9, so confirm your version first:

```bash
pveversion
```

You should see a `9.x` release. You do this work over SSH as root on the Proxmox host.

Now the single most important point in this guide. Any network change on a headless host can drop
your SSH connection, and there is no local screen to recover from. So before you change anything,
set up your lifeline:

- Keep a second SSH session open to the host the whole time. If a change cuts the session you typed
  it in, the second one is still live to undo the edit and reload.
- Do not count on a guest console as the way back in. The `qm terminal` and `pct enter` consoles
  from guide [04 -- Talking to guests without a GUI](04-talking-to-guests-without-a-gui.md) reach
  guests and are run from a working host shell, so they cannot recover the host's own
  `/etc/network/interfaces` when host SSH is gone. On this headless node the real out-of-band
  recovery is the second SSH session above, and, if networking will not come up at all, the Proxmox
  installer ISO in Rescue Boot (below). A host serial console (guide
  [03 -- Repositories, updates, and the host](03-repositories-updates-and-the-host.md)) helps only
  if the node actually has a serial port or IPMI Serial-over-LAN that you wired up beforehand.
- Always dry-run first. Before the real `ifreload -a`, run `ifreload -a -n`, which validates the
  config and shows what would change without touching the live network. A syntax error that takes
  down `vmbr0` is the classic SSH lockout, and the dry-run catches it.

One more safety thread that runs through the whole corpus: keep an independent copy of your control
station's public key in `~/.ssh/authorized_keys2` (a real file on the root disk, outside
`/etc/pve`), as covered in guide [02 -- The shell and the API](02-the-shell-and-the-api.md), so
key-based login still works even if pmxcfs is down. And if networking will not come up at all after
a change, the last resort is to boot the Proxmox installer ISO in Rescue Boot and edit
`/etc/network/interfaces` from there.

## The model: ifupdown2 and /etc/network/interfaces

The entire host network configuration lives in one file, `/etc/network/interfaces`. There is no
separate per-interface file the way NetworkManager or netplan use; you edit this one file directly.
Proxmox VE uses ifupdown2 (the default since PVE 7), and its headline feature is that it applies
changes live, without a reboot.

The workflow is two commands. To validate an edit without touching the live network, dry-run it:

```bash
ifreload -a -n
```

When the dry-run is clean, apply for real. This brings up, takes down, or reconfigures only what
actually changed:

```bash
ifreload -a
```

On a headless host, run the dry-run every time before the real reload, because a bad edit here is
the classic lockout. Do not use `ifup`/`ifdown` to reconfigure a bridge on Proxmox; they still exist
but do not reconcile the full config graph the way `ifreload` does. (When you edit through the GUI
or API, changes are staged in `/etc/network/interfaces.new` until applied; a direct hand-edit of
`/etc/network/interfaces` followed by `ifreload -a` skips that staging file, which is exactly what
you want from the shell.)

ifupdown2 is present on a stock PVE 9 ISO install. It only matters if you built Proxmox on bare
Debian, in which case `apt install ifupdown2` adds it.

To edit `/etc/network/interfaces`, use the accessible, shell-only form (a here-doc, `tee`, or
`sed -i`), never a terminal editor like vim or nano. The full menu, including VS Code Remote-SSH, is
in the "Editing files accessibly" section of guide
[02 -- The shell and the API](02-the-shell-and-the-api.md). For example, to write a fresh config you
can use a here-doc:

```bash
cat > /etc/network/interfaces <<'EOF'
auto lo
iface lo inet loopback

iface eno1 inet manual

auto vmbr0
iface vmbr0 inet static
 address 192.168.1.10/24
 gateway 192.168.1.1
 bridge-ports eno1
 bridge-stp off
 bridge-fd 0
EOF
```

Every value in that block is an example, not a default to keep: the address, the gateway, and the
NIC name `eno1` must all be replaced with your own before you write the file, and you should confirm
the NIC name with `ip -br link` first. Note too that the here-doc OVERWRITES the entire file, so a
verbatim paste wipes your working config. The real trap is that the dry-run will not save you here:
`ifreload -a -n` validates syntax only, so a syntactically valid config aimed at the wrong network
passes the dry-run cleanly and then `ifreload -a` drops your SSH.

Then always `ifreload -a -n` before `ifreload -a`, with your second SSH session still open so you
can undo a change that drops you.

## The default bridged install (vmbr0)

The standard Proxmox install bridges your one physical NIC into vmbr0 (the default Linux bridge) and
puts the host's management IP on the bridge. The physical NIC itself carries no IP; it is set
`manual` and serves only as a bridge port. Guests attach to vmbr0 and sit on the same layer-2
segment as your home LAN, so they are first-class LAN hosts reachable directly by your other
devices. This corpus gives each service guest a static address on that LAN (see "Attach guests to
the network" below) rather than a DHCP lease, so a service is always at the same place.

This is the full static-host-IP form, the recommended shape for a headless host. Write it with the
accessible here-doc shown above.

File `/etc/network/interfaces` (the default bridged install with a static host IP):

```text
auto lo
iface lo inet loopback

iface eno1 inet manual

auto vmbr0
iface vmbr0 inet static
 address 192.168.1.10/24
 gateway 192.168.1.1
 bridge-ports eno1
 bridge-stp off
 bridge-fd 0
```

Treat every value here as an example: the address, the gateway, and the NIC name `eno1` are all
placeholders you must replace with your own before writing the file, and you should confirm the NIC
name with `ip -br link` first. Remember that `ifreload -a -n` checks syntax only, so a valid config
for the wrong network passes the dry-run and then the real `ifreload -a` still drops your SSH.

Reading each line:

- `auto lo` and `iface lo inet loopback` bring up the loopback interface at boot. This is standard
  and you leave it alone.
- `iface eno1 inet manual` declares your physical NIC (here named `eno1`, but check yours, see the
  next section) with no IP of its own. It exists only to be a port on the bridge.
- `auto vmbr0` brings the bridge up automatically at boot.
- `iface vmbr0 inet static` says the bridge has a static IPv4 address (the management IP), as
  opposed to `dhcp`.
- `address 192.168.1.10/24` is the management IP itself, in CIDR form. This is the address you SSH
  to.
- `gateway 192.168.1.1` is your home router, the default route off the LAN.
- `bridge-ports eno1` attaches the physical NIC as the bridge's uplink port. This is the line that
  breaks if the NIC gets renamed (next section).
- `bridge-stp off` disables the spanning tree protocol. With a single uplink there is no loop to
  prevent, so STP off is the Proxmox default; do not enable it without a reason.
- `bridge-fd 0` sets the forwarding delay to zero, also the Proxmox default, so the bridge starts
  forwarding immediately rather than pausing.

A bridge is, in the Proxmox docs' words, a virtual switch that the guests and physical interfaces
are connected to. Because guests on vmbr0 are bridged and not NATed, they are first-class LAN hosts:
the router sees their MAC addresses, can hand out DHCP reservations for them, and other LAN devices
reach them directly. This is the recommended home-services topology.

## Static management IP vs DHCP for the host

For a headless host you SSH into, a stable management IP is essential, and the default install gives
you one: a static address on vmbr0, as shown above. If the address ever roams, you lose SSH, and
worse, pmxcfs wants the hostname to resolve to a fixed IP (the next section but one).

Running the host on DHCP is possible but discouraged for the management interface. If you want DHCP
convenience, the right answer is not a roaming dynamic address; it is a DHCP reservation on your
home router that pins the NIC's MAC to one fixed address. That keeps the IP stable while still
letting the router manage it. Either a true static config or a router-side reservation is wise.

The DHCP form is shown here for reference only:

File `/etc/network/interfaces` (host on DHCP, for reference only):

```text
auto vmbr0
iface vmbr0 inet dhcp
 bridge-ports eno1
 bridge-stp off
 bridge-fd 0
```

Whichever you choose, pmxcfs wants the hostname to resolve to a fixed management IP, which is the
`/etc/hosts` rule covered below.

## Find your NIC name, and the PVE 9 rename gotcha

Before you edit anything, find the real name of your physical NIC on your own hardware. These
commands change nothing:

```bash
ip -br link
ip -br addr
ip route
```

`ip -br link` is the brief form, one line per link showing the name, state, and MAC, which reads far
more cleanly than plain `ip link`. `ip -br addr` shows the addresses per link, and `ip route` shows
the default gateway and routing table.

Debian and Proxmox use systemd "predictable" interface names derived from the firmware and PCI(e)
topology: `eno1` for an onboard NIC, `enp3s0` for a PCI bus-and-slot NIC, `ens...` for a hotplug
slot. The old `eth0` name is not used on a fresh PVE 9 install.

Here is the PVE 9 and trixie delta to watch for, and it is the single most common 8-to-9 networking
failure. A kernel upgrade can rename a NIC. The 8-to-9 upgrade guide warns that because the new
kernel recognises more hardware features, and interface naming often derives from the PCI(e)
address, some NICs may change name. If `eno1` becomes, say, `enp1s0f0` after the upgrade, then
vmbr0's `bridge-ports eno1` line now points at a NIC that no longer exists, and the host comes up
with no network at all. Before any kernel upgrade, set up the same lifeline as the start of this
guide so you can fix the `bridge-ports` line if this happens: keep a live second SSH session open,
and have a host serial console or IPMI Serial-over-LAN ready if your hardware has one (guide
[03 -- Repositories, updates, and the host](03-repositories-updates-and-the-host.md)), with the
Proxmox installer ISO in Rescue Boot as the last resort to edit `/etc/network/interfaces`. (Guide
04's `qm terminal` and `pct enter` are guest consoles run from a working host shell, so they cannot
repair the host's own networking.) The next section is how to prevent it entirely.

## Pin NIC names so a kernel can't rename them

PVE 9 ships a tool that freezes interface names so a future kernel cannot rename them. It writes
systemd `.link` files that pin each physical NIC to a stable `nicX` name. Doing this proactively on
a fresh single node is the durable fix for the rename gotcha.

Pin all physical NICs to `nic0`, `nic1`, and so on:

```bash
pve-network-interface-pinning generate
```

There are per-interface and custom-name variants if you want to pin just one NIC or choose the name:

```bash
pve-network-interface-pinning generate --interface enp1s0
pve-network-interface-pinning generate --interface enp1s0 --target-name if42
pve-network-interface-pinning generate --interface enp1s0 --prefix net
```

What it does: it creates a `.link` file for every physical NIC that does not already have one, in
`/usr/local/lib/systemd/network/`, and rewrites the references in `/etc/network/interfaces.new`, in
the per-node `host.fw.new`, and in the SDN configs. A reboot is required for the new `.link` names
to take effect, because the renaming happens at boot. After the reboot, verify with `ip -br link`
and confirm that vmbr0's `bridge-ports` line still matches the (now pinned) NIC name. If you pin the
NICs and then update `bridge-ports` to the pinned name in the same maintenance window, a later
kernel upgrade can no longer move the name out from under you.

## /etc/hosts - the FQDN rule pmxcfs depends on

pmxcfs (the `/etc/pve` filesystem) and many node services require the node's hostname and fully
qualified domain name (FQDN) to resolve to a real, non-loopback IP, namely the management IP on
vmbr0. This holds even on a single node, because pmxcfs runs locally. Get this wrong and `/etc/pve`
can fail to mount.

The rule, from the trixie install guide: the hostname of your machine must be resolvable to an IP
address, and that IP address must not be a loopback one like `127.0.0.1`. So map the FQDN and the
short name to the management IP, and do not put the hostname on the loopback line.

Edit `/etc/hosts` with the accessible, shell-only form from guide
[02 -- The shell and the API](02-the-shell-and-the-api.md), never a terminal editor.

File `/etc/hosts`:

```text
127.0.0.1 localhost
192.168.1.10 pve.home.arpa pve

# IPv6
::1 localhost ip6-localhost ip6-loopback
ff02::1 ip6-allnodes
ff02::2 ip6-allrouters
```

The load-bearing line is `192.168.1.10 pve.home.arpa pve`, which maps both the FQDN and the short
name to the management IP. Do not add the hostname to the `127.0.0.1` or `127.0.1.1` line; that
loopback-hostname pattern is a common Debian default and is the classic pmxcfs breakage, so remove
the hostname from it if it is present.

Verify the resolution returns the real IP, not a loopback:

```bash
hostname --ip-address
```

This should return at least one non-loopback IP address, that is, your `192.168.1.10`, not
`127.0.0.1`. If you ever change the management IP, update `/etc/hosts` to match in the same step.

## DNS on trixie

Host DNS lives in `/etc/resolv.conf`. Edit it with the accessible, shell-only form from guide
[02 -- The shell and the API](02-the-shell-and-the-api.md).

File `/etc/resolv.conf`:

```text
search home.arpa
nameserver 192.168.1.1
nameserver 1.1.1.1
```

The `search` line sets the default domain suffix, and the `nameserver` lines list resolvers in
order, here the home router first with a public resolver as a backup.

There is a PVE 9 delta to know: Proxmox now expects to control DNS management and no longer takes
its DNS settings from `/etc/network/interfaces`. Do not put `dns-nameservers` or `dns-search` lines
in `/etc/network/interfaces` and expect Proxmox to honour them; manage `/etc/resolv.conf` instead.

There is also a trixie gotcha. Avoid resolvconf-style auto-generators: any package that rewrites
`/etc/resolv.conf` (the `resolvconf` package for IPv4, or `rdnssd` for IPv6) will fight your static
config and can break DNS, so do not install `resolvconf`. And `systemd-resolved` is not part of the
default Proxmox host. If something pulls it in, `/etc/resolv.conf` can become a symlink to
`/run/systemd/resolve/resolv.conf` and your hand-edits get ignored. For a simple headless node, keep
`/etc/resolv.conf` a plain static file you edit accessibly, and do not let `systemd-resolved` take
it over.

After any DNS edit, test resolution before you run package updates or close your spare SSH session:

```bash
getent hosts proxmox.com
```

You should get an address back promptly. If it hangs or returns nothing, undo the `/etc/resolv.conf`
change before running `apt update`; a broken resolver can make updates and certificate checks fail
in confusing ways.

## Reaching machines by name (mDNS now, DNS later)

A fresh Proxmox install gives you three naming milestones, in order. Right after install you reach
the host only by its static IP `192.168.1.10`. After this section installs `avahi-daemon`, the host
also answers to `pve.local` over multicast DNS on the local network segment. After the DNS sinkhole
(recipe [01 -- DNS sinkhole](recipes/01-dns-sinkhole.md)) is up and the LAN points its DNS at it,
every machine resolves as `*.home.arpa` network-wide. The two names are complementary, not
competing: `pve.local` is mDNS, link-local only; `pve.home.arpa` is served by a DNS server. Both
point at the same `192.168.1.10`.

A stock Proxmox host runs no mDNS at all, so this adds one small service. If you are taking a
minimal-host approach and the sinkhole is close behind, you can skip avahi entirely and reach the
host by IP (or a `hosts`-file entry on the control station) until `*.home.arpa` is live. Install
avahi only if you want a zero-config `pve.local` in the gap before the sinkhole exists.

### Install avahi-daemon

```bash
apt install -y avahi-daemon avahi-utils
systemctl enable --now avahi-daemon
```

`avahi-utils` is the second package here; it provides the `avahi-resolve` verification tool used
below. If your host has more than one bridge, scope avahi to the management interface now (see
"Scope avahi to the management interface" below) before it starts answering on guest bridges. To
remove the service later:
`systemctl disable --now avahi-daemon && apt purge -y avahi-daemon avahi-utils`.

`avahi-daemon` reads the system hostname and publishes this host as `<hostname>.local` automatically
with no configuration needed. With hostname `pve` the published name is `pve.local` (substitute your
own hostname if you chose a different one). The separate `libnss-mdns` package is what lets standard
tools on this host (`ping`, `ssh`, and anything else that goes through the OS name-service path)
resolve `.local` names at all, including the host's own. Without it, `ping pve.local` from the host
fails even though `avahi-resolve -n pve.local` (which queries avahi directly) still works. It is not
needed to publish this host's own name, and the Windows control station never needs it.

### Verify mDNS (on the host)

Run this as root, the same shell you use for all host work in this guide:

```bash
avahi-resolve -n pve.local
```

The response should show `pve.local` resolving to `192.168.1.10`. The two fields are separated by a
tab, which usually renders as a gap on screen.

### From the Windows control station

Modern Windows 10 (build 1803 and later) and Windows 11 resolve `.local` names natively over
multicast DNS, so the name works with no extra software installed. From PowerShell or cmd on the
control station:

```text
ping pve.local
```

### Scope avahi to the management interface (hardening)

`avahi-daemon` listens on UDP 5353 (link-local multicast) and, on a host with bridges, it will
answer on every interface it sees. To keep it on the management LAN only, set the allow-interfaces
option in the existing `[server]` section of `/etc/avahi/avahi-daemon.conf`. A stock file already
has a `[server]` section with the other options commented out, so this adds one line under that
header rather than replacing the file. The accessible way to add the line is from the shell, without
opening an editor. This form is safe to re-run: it rewrites the value if `allow-interfaces` is
already present and otherwise inserts it under the `[server]` header, so re-running never leaves a
duplicate line:

```bash
grep -q '^allow-interfaces=' /etc/avahi/avahi-daemon.conf \
 && sed -i 's/^allow-interfaces=.*/allow-interfaces=vmbr0/' /etc/avahi/avahi-daemon.conf \
 || sed -i '/^\[server\]/a allow-interfaces=vmbr0' /etc/avahi/avahi-daemon.conf
```

That leaves the rest of the file untouched. Do not rewrite the whole file with a here-doc here: that
would drop every other default `avahi-daemon.conf` setting.

Then restart the service:

```bash
systemctl restart avahi-daemon
```

If you run a host firewall (guide [11 -- Firewall](11-firewall.md)), allow inbound UDP 5353 on the
management interface. The PVE rule, in the same style as the baseline ruleset in guide
[14 -- Best practices and hardening](14-best-practices-and-hardening.md), is:

```text
IN ACCEPT -p udp -dport 5353 -log nolog # mDNS (avahi)
```

### The two naming systems side by side

`avahi-daemon` publishes the host as `pve.local` over multicast DNS. This does NOT make
`pve.home.arpa` resolve: that name is served by a DNS server (the sinkhole, recipe 01) and requires
that the LAN point its DNS at the sinkhole. Both names end up pointing at `192.168.1.10`; you just
reach them through different mechanisms.

For network-wide `*.home.arpa` names covering the host and every static-IP guest, see the "Local DNS
names" section of recipe [01 -- DNS sinkhole](recipes/01-dns-sinkhole.md).

## Attach guests to the network

With vmbr0 in place, attaching a guest is one command. This corpus gives each VM and container a
fixed (static) LAN address rather than a DHCP lease, so a service is always reachable at the same
place. The address plan it uses: gateway `192.168.1.1`, the host at `192.168.1.10`, the Proxmox
Backup Server at `192.168.1.50`, the mission service containers at `192.168.1.120` through
`192.168.1.128`, and other guests from `192.168.1.100` up. Pick an address outside your router's
DHCP pool so nothing else leases it.

For a VM, attach a virtio NIC (the paravirtual model and the fastest) on the bridge. A VM takes its
address either from cloud-init at clone time (guide
[07 -- Cloud-init templates](07-cloud-init-templates.md)) or configured inside the guest OS; the NIC
itself is attached with:

```bash
qm set 100 -net0 virtio,bridge=vmbr0
```

For a container, set the static address and gateway directly in the `net0` string:

```bash
pct set 101 -net0 name=eth0,bridge=vmbr0,ip=192.168.1.110/24,gw=192.168.1.1
```

If you would rather let the router assign the address by DHCP (reasonable only for a throwaway
guest, not a service other machines point at), use `ip=dhcp` for a container, or for a VM simply let
the guest OS run DHCP normally:

```bash
pct set 101 -net0 name=eth0,bridge=vmbr0,ip=dhcp
```

The full `net[n]` option string for a container, as a readable list of the keys it accepts:

- `name=<string>` - the interface name inside the container (for example `eth0`).
- `bridge=<bridge>` - which host bridge to attach to (for example `vmbr0`).
- `firewall=<1|0>` - enable the per-NIC firewall (guide 11).
- `gw=<GatewayIPv4>` - the IPv4 default gateway.
- `hwaddr=<XX:..>` - a fixed MAC address, if you want one.
- `ip=<IPv4/CIDR|dhcp|manual>` - a static address, `dhcp`, or `manual`.
- `ip6=<...>` - the IPv6 equivalent.
- `mtu=<int>` - the link MTU.
- `rate=<mbps>` - a rate limit in megabits per second.
- `tag=<integer>` - place this NIC on a VLAN (see the VLAN section).
- `trunks=<vlanid;...>` - pass a trunk of several VLANs to the guest.
- `type=<veth>` - the NIC type.

The full guest lifecycle, including how to add and edit NICs, is in guides
[05 -- Containers with LXC and pct](05-containers-with-lxc-and-pct.md) and
[06 -- Virtual machines with qm](06-virtual-machines-with-qm.md).

## VLAN-aware bridge (segment guests)

If your router or switch does VLANs and you want to segment guests (an IoT VLAN apart from a trusted
VLAN, say) over the one wired uplink, make vmbr0 a VLAN-aware bridge. The bridge then trunks all
VLANs and you tag each guest's NIC; the tagging is transparent to the guest OS.

File `/etc/network/interfaces` (vmbr0 made VLAN-aware):

```text
auto lo
iface lo inet loopback

iface eno1 inet manual

auto vmbr0
iface vmbr0 inet manual
 bridge-ports eno1
 bridge-stp off
 bridge-fd 0
 bridge-vlan-aware yes
 bridge-vids 2-4094
```

`bridge-vlan-aware yes` turns on 802.1Q awareness, and `bridge-vids 2-4094` is the range of VLAN IDs
the bridge will pass. Tag a guest's NIC with `tag=N` to place its traffic on VLAN N:

```bash
qm set 100 -net0 virtio,bridge=vmbr0,tag=20
pct set 101 -net0 name=eth0,bridge=vmbr0,ip=<addr>/24,gw=<gw>,tag=20
```

(Use `trunks=10;20;30` instead of or alongside `tag=` to pass a guest a trunk of several VLANs, for
a guest that does its own VLAN routing.)

### Host management IP on a VLAN

To put the host's own management IP on a tagged VLAN (say VLAN 5) with a VLAN-aware bridge, add a
VLAN sub-interface of the bridge named `vmbr0.<vid>`. The static address moves onto the
sub-interface; the bridge itself stays `manual`.

File `/etc/network/interfaces` (management IP on VLAN 5):

```text
auto vmbr0
iface vmbr0 inet manual
 bridge-ports eno1
 bridge-stp off
 bridge-fd 0
 bridge-vlan-aware yes
 bridge-vids 2-4094

auto vmbr0.5
iface vmbr0.5 inet static
 address 10.20.5.2/24
 gateway 10.20.5.1
```

`vmbr0.5` is VLAN 5 on the bridge; this sub-interface approach is the transparent, recommended
method per the Proxmox docs. As always, dry-run with `ifreload -a -n` before `ifreload -a`, and
watch your second SSH session, because moving the management IP onto a VLAN is exactly the kind of
change that can drop you.

## A NAT bridge for an isolated dev lab

For a dev lab that should be isolated from the home LAN but still reach the internet, create a NAT
bridge (masquerade): a second bridge vmbr1 with no physical port, where the host is the gateway and
masquerades (SNATs) lab traffic out through the uplink. Guests on vmbr1 are invisible to the LAN;
the router never sees them.

First, enable IP forwarding the durable way, with a sysctl drop-in rather than the fragile
`post-up echo` line. Write the drop-in with the accessible, shell-only form from guide
[02 -- The shell and the API](02-the-shell-and-the-api.md).

File `/etc/sysctl.d/99-pve-lab.conf`:

```text
net.ipv4.ip_forward=1
# net.ipv6.conf.all.forwarding=1 # uncomment if the lab needs IPv6 routing
```

Apply it without a reboot:

```bash
sysctl --system
```

Now add the bridge. The host takes the gateway address for the lab subnet, the bridge has no
physical port, and a MASQUERADE rule on `post-up`/`post-down` SNATs the lab subnet out through the
uplink (here vmbr0; replace `-o vmbr0` with whatever your real uplink interface is).

File `/etc/network/interfaces` (the NAT bridge vmbr1, added to your existing config):

```text
auto vmbr1
iface vmbr1 inet static
 address 10.10.10.1/24
 bridge-ports none
 bridge-stp off
 bridge-fd 0

 post-up iptables -t nat -A POSTROUTING -s '10.10.10.0/24' -o vmbr0 -j MASQUERADE
 post-down iptables -t nat -D POSTROUTING -s '10.10.10.0/24' -o vmbr0 -j MASQUERADE
```

Reading the lab-specific lines:

- `address 10.10.10.1/24` makes the host itself the gateway for the lab subnet; lab guests set
  `gw=10.10.10.1`.
- `bridge-ports none` means no physical NIC, so this is an internal-only layer-2 segment.
- The `post-up` rule adds the SNAT (masquerade) when the bridge comes up, and `post-down` removes it
  when the bridge goes down. Because forwarding is already on from the sysctl drop-in, you do not
  need a `post-up echo 1 > .../ip_forward` line.

Attach a lab guest with a static IP and the host as gateway:

```bash
pct set 200 -net0 name=eth0,bridge=vmbr1,ip=10.10.10.50/24,gw=10.10.10.1
qm set 201 -net0 virtio,bridge=vmbr1
```

(For the VM, set `10.10.10.x/24` with gateway `10.10.10.1` inside the guest OS. Note that vmbr1 is
isolated with no DHCP server, so unlike a guest on vmbr0 that picks up a LAN DHCP lease, a guest on
vmbr1 has no network at all until you configure it statically inside the guest OS with the host as
its gateway.)

A note on the firewall backend: the `iptables ... MASQUERADE` recipe still works on trixie, because
`iptables` is present as the nft-backed compatibility shim (iptables-nft), and rules you add via
`post-up` land in the kernel correctly. This is the simplest, well-documented NAT recipe and is fine
for a home lab. The broader question of the Proxmox firewall backend is deferred to guide
[11 -- Firewall](11-firewall.md).

## Verify network state from the shell

This doubles as the "Verify it worked" section. Every command here is read-only and reads cleanly
with a screen reader.

Interface names, states, and addresses:

```bash
ip -br link
ip -br addr
ip route
```

`ip -br link` shows each interface with its up/down state and MAC (this is how you find or confirm
your NIC name); `ip -br addr` shows the IPs per interface, where you confirm the management IP sits
on vmbr0; `ip route` shows the default gateway.

Bridge membership and VLANs:

```bash
bridge link
bridge vlan show
cat /sys/class/net/vmbr0/bridge/vlan_filtering
```

`bridge link` shows which ports belong to which bridge; `bridge vlan show` shows the VLAN membership
per bridge port (use this to confirm a VLAN-aware setup); and
`cat /sys/class/net/vmbr0/bridge/vlan_filtering` returns `1` when VLAN awareness is on.

The NAT lab:

```bash
iptables -t nat -L POSTROUTING -n -v
sysctl net.ipv4.ip_forward
```

`iptables -t nat -L POSTROUTING -n -v` should list your MASQUERADE rule, and
`sysctl net.ipv4.ip_forward` should report `1`.

Config validity and reachability:

```bash
ifreload -a -n
ping -c1 192.168.1.1
hostname --ip-address
```

`ifreload -a -n` dry-run-validates the config without touching the live network;
`ping -c1 192.168.1.1` confirms the gateway is reachable; and `hostname --ip-address` must return
the non-loopback management IP (the pmxcfs rule above).

## Wired only - why WiFi can't bridge

Bridging requires a wired NIC. The recommended vmbr0-bridges-the-physical-NIC setup, where guests
get LAN DHCP addresses, only works over Ethernet. WiFi cannot be bridged in practice: 802.11 station
mode does not let a single radio present multiple MAC addresses on the wireless segment (the access
point only accepts the one station MAC), so bridged guests' frames are dropped. A WiFi-only box
would force the NAT model for every guest, with all guests behind NAT rather than on the LAN, which
defeats the "reachable on the LAN" goal for home services. So keep the home node wired; on a wired
LAN the default bridged model is exactly right.

## Sources

- `research/round2-pve9/12-pve9-networking.md` - the whole guide is grounded here: the ifupdown2 +
  single-`/etc/network/interfaces` model with live `ifreload -a` and the `ifreload -a -n` dry-run,
  the `ifup`/`ifdown` caveat and the `interfaces.new` staging behaviour; the default bridged vmbr0
  config (physical NIC `manual`, `bridge-ports`, `bridge-stp off`, `bridge-fd 0`, management IP on
  the bridge) and that bridged guests are first-class LAN hosts; static-vs-DHCP management IP and
  the router-reservation recommendation; `ip -br link`/`-br addr`/`ip route`, predictable interface
  names, and the PVE 9 / trixie NIC-rename gotcha with console access during the kernel upgrade;
  `pve-network-interface-pinning generate` (and `--interface`/`--target-name`/`--prefix`), the
  `.link` files in `/usr/local/lib/systemd/network/`, and the reboot requirement; the `/etc/hosts`
  FQDN-to-management-IP rule (not loopback) with `hostname --ip-address`; the trixie DNS story
  (`/etc/resolv.conf`, PVE controls DNS and ignores `dns-nameservers` in interfaces, avoid
  `resolvconf`/`rdnssd` and `systemd-resolved` symlinking); attaching guests with
  `qm set ... -net0 virtio,bridge=vmbr0` and `pct set ... -net0 ...` (DHCP, static, the full
  `net[n]` string); the VLAN-aware bridge (`bridge-vlan-aware yes`, `bridge-vids 2-4094`, `tag=`,
  `trunks=`, the `vmbr0.5` management VLAN); the NAT vmbr1 recipe (`bridge-ports none`,
  host-as-gateway, the `/etc/sysctl.d/99-pve-lab.conf` `ip_forward` drop-in with `sysctl --system`,
  and the MASQUERADE `post-up`/`post-down`) with the iptables-nft shim note; the shell verification
  commands; and the wired-only / WiFi-cannot-bridge constraint.
- `GLOSSARY.md` and `CONTEXT.md` - the canonical definitions of ifupdown2, vmbr0 (Linux bridge), the
  Management IP, the VLAN-aware bridge, the NAT bridge (masquerade), and pmxcfs (`/etc/pve`) reused
  here, plus the role names (the Proxmox host, the control station, the guest).
- Proxmox VE documentation:
  [Network Configuration](https://pve.proxmox.com/wiki/Network_Configuration) and
  [the sysadmin chapter](https://pve.proxmox.com/pve-docs/chapter-sysadmin.html) (the default vmbr0
  bridge, ifupdown2 with `ifreload -a` and `-n`, the VLAN-aware bridge with `bridge-vlan-aware yes`
  and `bridge-vids`, the `vmbr0.5` VLAN management IP, and the masquerade
  `post-up iptables ... MASQUERADE` with `ip_forward`); and the
  [container and VM network options](https://pve.proxmox.com/pve-docs/chapter-pct.html) (`pct`/`qm`
  `net[n]` syntax including `bridge=`, `ip=dhcp`, `gw=`, `tag=`, `trunks=`).
- [Install Proxmox VE on Debian 13 Trixie](https://pve.proxmox.com/wiki/Install_Proxmox_VE_on_Debian_13_Trixie) -
  the `/etc/hosts` rule that the hostname/FQDN must resolve to a non-loopback IP, the
  `hostname --ip-address` check, that Proxmox controls DNS, and the advice to avoid resolvconf-style
  auto-generators rewriting `/etc/resolv.conf`.
- [Upgrade from 8 to 9](https://pve.proxmox.com/wiki/Upgrade_from_8_to_9) - the warning that the new
  kernel may rename NICs (so adapt the network config and keep console access), Rescue Boot to edit
  `/etc/network/interfaces`, and that `pve-network-interface-pinning` exists.
- The pve-network-interface-pinning reference: the
  [PVE 9 network interface pinning forum thread](https://forum.proxmox.com/threads/pve-9-0-beta-and-proxmox-network-interface-pinning.168685/)
  and
  [a write-up of the feature](https://www.virtualizationhowto.com/2026/03/the-proxmox-9-feature-that-finally-fixes-nic-renaming-problems/)
  (`generate`, the `--interface`/`--target-name`/`--prefix` variants, the `.link` files in
  `/usr/local/lib/systemd/network/`, and the reboot requirement).
- [the Proxmox firewall chapter](https://pve.proxmox.com/pve-docs/chapter-pve-firewall.html) -
  context for the iptables-nft shim note (the firewall backend itself is guide 11).

---

Previous: [09 -- Storage](09-storage.md) | Next: [11 -- Firewall](11-firewall.md)
