# PVE 9 Host and Guest Networking from the Shell

Target: latest Proxmox VE 9.x (built on Debian 13 "trixie"), mid-2026, single wired node, headless,
shell-only, BTRFS root, home services on the LAN + an isolated dev lab. This file covers the
`/etc/network/interfaces` model, live reloads with `ifupdown2`, the default bridged install, static
vs DHCP management IP, predictable NIC names and the PVE 9 renaming gotcha, `/etc/hosts`

- DNS, VLAN-aware bridges, and a NAT/masquerade internal bridge. All examples use plain
  `/etc/network/interfaces` syntax (no GUI required).

## The model: ifupdown2 + /etc/network/interfaces

- The entire host network config lives in one file, `/etc/network/interfaces`. You edit it directly;
  there is no separate per-interface file (unlike NetworkManager / netplan, neither of which PVE
  uses by default).
- PVE 9 uses **ifupdown2** (default since PVE 7.0). Its headline feature: you apply changes **live,
  without a reboot**.
- Apply a manual edit: `ifreload -a` (reload all interfaces; brings up/down/ reconfigures only what
  changed).
- **Dry-run / validate before committing:** `ifreload -a -n` (alias `ifreload -n`) shows what
  _would_ change without touching the live network. Use this every time on a headless box before the
  real `ifreload -a` - a syntax error that takes down `vmbr0` locks you out of SSH.
- The GUI's "Apply Configuration" button does the same thing; CLI users just run `ifreload -a`
  themselves. When you edit via GUI/API, changes are staged in `/etc/network/interfaces.new` until
  applied; a direct hand-edit of `/etc/network/interfaces` followed by `ifreload -a` skips the
  staging file.
- **Do not** use `ifup`/`ifdown` on PVE for bridge reconfiguration - use `ifreload`.
  (`ifup`/`ifdown` still exist but won't reconcile the full config graph the way `ifreload` does.)
- Confirm ifupdown2 is present (it is on a stock PVE 9 ISO install; only matters if you built PVE on
  bare Debian): `apt install ifupdown2`.

### ifupdown2 / trixie gotchas

- **Always keep out-of-band access** for any network change on a headless host: serial console (your
  accessibility backbone), IPMI/iKVM, or physical access. If `ifreload -a` drops the management
  bridge, SSH is gone and only the console saves you. The PVE 8 to 9 upgrade guide explicitly
  recommends this. As a belt- and-suspenders measure you can test with `ifreload -a -n` first.
- Recovery if you do get locked out and the box won't boot networking: boot the PVE installer ISO in
  **Rescue Boot**, then edit `/etc/network/interfaces`.
- A reboot also applies a staged/edited config, but the whole point of ifupdown2 is that you should
  not need one.

## Default bridged install (vmbr0) - the home-services setup

The standard PVE install bridges your one physical NIC into `vmbr0` and puts the host's management
IP on the bridge. The physical NIC itself is `manual` (no IP); it is just a bridge port. Guests
attach to `vmbr0` and sit on the **same L2 segment as your home LAN**, so they pull IPs straight
from your router's DHCP - exactly what you want for home services that should be reachable on the
LAN.

`/etc/network/interfaces` (static host IP, the recommended headless form):

```text
auto lo
iface lo inet loopback

iface eno1 inet manual

auto vmbr0
iface vmbr0 inet static
 address 192.168.10.2/24
 gateway 192.168.10.1
 bridge-ports eno1
 bridge-stp off
 bridge-fd 0
```

The bridge is "a virtual switch which the guests and physical interfaces are connected to"
(pve-docs). `bridge-stp off` and `bridge-fd 0` (forwarding delay 0) are the PVE defaults - STP off
is fine for a single uplink; do not enable it without a reason.

### Attaching guests to vmbr0 (LAN DHCP)

VM (QEMU) - guest gets a virtual NIC on `vmbr0`, OS inside does DHCP:

```bash
qm set 100 -net0 virtio,bridge=vmbr0
```

(`virtio` = paravirtual, fastest. The guest OS then runs DHCP normally and receives a LAN address
from the home router.)

Container (LXC) - DHCP from the router:

```bash
pct set 101 -net0 name=eth0,bridge=vmbr0,ip=dhcp
```

Container with a static LAN IP instead:

```bash
pct set 101 -net0 name=eth0,bridge=vmbr0,ip=192.168.10.50/24,gw=192.168.10.1
```

Full `net[n]` option string (pve-docs `pct`):

```text
net[n]: name=<string> [,bridge=<bridge>] [,firewall=<1|0>] [,gw=<GatewayIPv4>]
 [,hwaddr=<XX:..>] [,ip=<IPv4/CIDR|dhcp|manual>] [,ip6=<...>] [,mtu=<int>]
 [,rate=<mbps>] [,tag=<integer>] [,trunks=<vlanid;...>] [,type=<veth>]
```

Because guests on `vmbr0` are bridged (not NATed), they are first-class LAN hosts: the router sees
their MACs, can hand out DHCP reservations, and other LAN devices reach them directly. This is the
recommended home-services topology.

## Static management IP vs DHCP for the host

- The default install puts a **static** address on `vmbr0` (shown above). For a headless box you SSH
  into, a stable IP is essential.
- **DHCP on the host** is possible (`iface vmbr0 inet dhcp`) but discouraged for the management
  interface: if the lease changes you lose SSH, and worse, PVE/pmxcfs wants the hostname to resolve
  to a **fixed** IP (see /etc/hosts below). If you prefer DHCP convenience, the right answer is a
  **DHCP reservation** on the home router (pin the NIC's MAC to one address) - that gives you a
  stable IP while still letting the router manage it. Either a true static config or a router-side
  reservation is wise; a roaming dynamic address is not.
- DHCP form, for reference only:

```text
auto vmbr0
iface vmbr0 inet dhcp
 bridge-ports eno1
 bridge-stp off
 bridge-fd 0
```

## Predictable interface names + the PVE 9 renaming gotcha

- Debian/PVE use **systemd "predictable" interface names** derived from firmware/PCI(e) topology:
  `eno1` (onboard), `enp3s0` (PCI bus/slot), `ens...` (hotplug slot). Old `eth0` names are not used
  on a fresh PVE 9 install.
- **Find the real name on YOUR hardware before editing anything:**

```bash
ip -br link
```

(`-br` = brief, one line per link: name, state, MAC. Cleaner than `ip link`.) Also useful:
`ip -br addr` (addresses per link), `ip route` (default gateway).

- **PVE 9 / trixie delta - NICs can be renamed by the kernel upgrade.** The 8 to 9 upgrade guide
  warns: "Due to the new kernel recognizing more features of some hardware ... and interface naming
  often derives from the PCI(e) address, some NICs may change their name, in which case the network
  configuration needs to be adapted." If `eno1` becomes `enp1s0f0` after the upgrade, `vmbr0`'s
  `bridge-ports` line is now wrong and the host comes up with no network - this is the single most
  common 8 to 9 networking failure. **Have console/IPMI access during the upgrade.**

### Pinning NIC names with pve-network-interface-pinning (new in PVE 9)

PVE 9 ships a tool that freezes interface names so a future kernel can't rename them. It writes
systemd `.link` files that pin each NIC to a stable `nicX` name.

- Pin all physical NICs to `nic0`, `nic1`, ...:

```text
pve-network-interface-pinning generate
```

- Pin one interface, optionally with a custom name or prefix:

```text
pve-network-interface-pinning generate --interface enp1s0
pve-network-interface-pinning generate --interface enp1s0 --target-name if42
pve-network-interface-pinning generate --interface enp1s0 --prefix net
```

- What it does: creates a `.link` file for every physical NIC that doesn't have one, in
  `/usr/local/lib/systemd/network/`, and rewrites the references in `/etc/network/interfaces.new`,
  `/etc/pve/nodes/<node>/host.fw.new`, and the SDN configs (`controllers.cfg`, `fabrics.cfg`).
- **A reboot is required** for the new `.link` names to take effect (renaming happens at boot).
  After reboot, verify with `ip -br link` and confirm `vmbr0`'s `bridge-ports` matches.
- Doing this proactively (ideally before/right after the 8 to 9 upgrade) is the durable fix for the
  renaming gotcha on a headless single node.

## /etc/hosts - FQDN must map to the management IP (critical for pmxcfs)

PVE's cluster filesystem (`pmxcfs`, mounted at `/etc/pve`) and many node services require the node's
**hostname/FQDN to resolve to a real, non-loopback IP** - the management IP on `vmbr0`. This holds
even for a single node (pmxcfs runs locally). Get this wrong and `/etc/pve` can fail to mount or
services misbehave.

Rules (from the trixie install guide):

- "The hostname of your machine must be resolvable to an IP address. This IP address must **not** be
  a loopback one like `127.0.0.1`."
- Map the FQDN **and** short name to the management IP. Example `/etc/hosts`:

```text
127.0.0.1 localhost
192.168.10.2 prox.home.arpa prox

# IPv6
::1 localhost ip6-localhost ip6-loopback
ff02::1 ip6-allnodes
ff02::2 ip6-allrouters
```

- Do **not** add the hostname to the `127.0.0.1` / `127.0.1.1` line (a common Debian default).
  Remove it if present - pointing the node name at loopback is the classic pmxcfs/cluster breakage.
- Verify:

```bash
hostname --ip-address
```

This "should return at least one non-loopback IP address" - i.e. your `192.168.10.2`, not
`127.0.0.1`.

- If you ever change the management IP, update `/etc/hosts` to match in the same step.

## DNS / /etc/resolv.conf (trixie interplay)

- Host DNS is configured in `/etc/resolv.conf`:

```text
search home.arpa
nameserver 192.168.10.1
nameserver 1.1.1.1
```

(`search` sets the default domain suffix; `nameserver` lines list resolvers - here the home router
first, a public resolver as backup.)

- **PVE 9 delta:** "The Proxmox VE GUI expects to control DNS management and will no longer take its
  DNS settings from `/etc/network/interfaces`." Don't put `dns-nameservers`/`dns-search` in
  `/etc/network/interfaces` and expect PVE to honor them - manage `/etc/resolv.conf` (or via the
  GUI/`pvesh`).

- **trixie gotcha - avoid resolvconf-style auto-generators.** Any package that rewrites
  `/etc/resolv.conf` (`resolvconf` for IPv4, `rdnssd` for IPv6) will fight your static config and
  can break DNS. On a stock PVE 9 host `/etc/resolv.conf` is a normal static file you edit directly
- keep it that way. Do not install `resolvconf`.

- `systemd-resolved` is **not** part of the default PVE host setup. If something pulls it in,
  `/etc/resolv.conf` may become a symlink to `/run/systemd/resolve/resolv.conf` and your hand-edits
  get ignored; for a simple headless node, the path of least surprise is the plain static
  `/etc/resolv.conf` above. (Note: trixie _guest_ templates, e.g. Debian 13 LXC, often DO use
  systemd-resolved internally - a separate concern from the host.)

## VLAN-aware bridge (tag guests onto VLANs)

If your router/switch does VLANs and you want to segment guests (e.g. an IoT VLAN vs a trusted VLAN)
over the one wired uplink, make `vmbr0` VLAN-aware. The bridge then trunks all VLANs and you tag
each guest's NIC.

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

- `bridge-vlan-aware yes` turns on 802.1Q awareness; `bridge-vids 2-4094` is the range of VLAN IDs
  the bridge will pass.
- **Tag a guest** with `tag=N` on its NIC - that guest's traffic is placed on VLAN N, transparently
  to the guest OS:

```bash
qm set 100 -net0 virtio,bridge=vmbr0,tag=20 # VM on VLAN 20
pct set 101 -net0 name=eth0,bridge=vmbr0,ip=dhcp,tag=20 # CT on VLAN 20
```

(Add `trunks=10;20;30` instead of/with `tag=` to pass a guest a trunk of multiple VLANs, e.g. for a
guest that does its own VLAN routing.)

### Host management IP on a VLAN

To put the host's own management IP on a tagged VLAN (e.g. VLAN 5) with a VLAN-aware bridge, add a
VLAN sub-interface of the bridge:

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
 address 10.10.10.2/24
 gateway 10.10.10.1
```

(`vmbr0.5` = VLAN 5 on the bridge; this is the transparent, recommended method per pve-docs.)

## NAT / masquerade internal-only bridge (isolated dev lab)

For a dev lab that should be **isolated from the home LAN** but still reach the internet, create a
second bridge `vmbr1` with **no physical port** (`bridge-ports none`). The host becomes the gateway
for that subnet and masquerades (SNATs) lab traffic out through `vmbr0`/the physical NIC. Guests on
`vmbr1` are invisible to the LAN; the LAN/router never sees them.

```text
auto vmbr1
iface vmbr1 inet static
 address 10.10.10.1/24
 bridge-ports none
 bridge-stp off
 bridge-fd 0

 post-up echo 1 > /proc/sys/net/ipv4/ip_forward
 post-up iptables -t nat -A POSTROUTING -s '10.10.10.0/24' -o vmbr0 -j MASQUERADE
 post-down iptables -t nat -D POSTROUTING -s '10.10.10.0/24' -o vmbr0 -j MASQUERADE
```

- `address 10.10.10.1/24` - the host IS the gateway for the lab subnet; guests set `gw=10.10.10.1`.
- `bridge-ports none` - no physical NIC, so it's an internal-only L2 segment.
- The `post-up`/`post-down` enable IP forwarding and add/remove the SNAT rule. Replace `-o vmbr0`
  with whatever your _uplink_ interface is (the example in pve-docs uses the physical NIC `eno1`
  directly when the host IP is on the NIC; on the default bridged install your uplink is `vmbr0`).

Attach a lab guest with a static IP and the host as gateway:

```bash
pct set 200 -net0 name=eth0,bridge=vmbr1,ip=10.10.10.50/24,gw=10.10.10.1
qm set 201 -net0 virtio,bridge=vmbr1 # then set 10.10.10.x/24 gw 10.10.10.1 inside
```

### Persist ip_forward properly (recommended over the post-up echo)

The `post-up echo 1 > .../ip_forward` works but is fragile. The clean, durable way is a sysctl
drop-in so forwarding is on at boot regardless of bridge order. Create
`/etc/sysctl.d/99-pve-lab.conf`:

```text
net.ipv4.ip_forward=1
# net.ipv6.conf.all.forwarding=1 # uncomment if the lab needs IPv6 routing
```

Apply without reboot:

```bash
sysctl --system
```

Then you can drop the `post-up echo 1 > .../ip_forward` line from `/etc/network/interfaces` and keep
only the MASQUERADE `post-up`/`post-down`.

### PVE 9 firewall delta - iptables vs nftables (read this)

- PVE 9 is still **iptables-based by default** through the classic `pve-firewall` service. It also
  ships `proxmox-firewall`, a Rust nftables implementation, but that backend is opt-in and still
  technology preview. It reads the same config files, so existing rules are honored when you switch
  deliberately.
- The `iptables ... MASQUERADE` `post-up` recipe above **still works** on trixie: `iptables` is
  present as the nft-backed `iptables` compatibility shim (iptables-nft), and rules you add via
  `post-up` land in the kernel correctly. This is the simplest, well-documented NAT recipe and is
  fine for a home lab.
- **Caveat:** if you opt into the nftables backend (`proxmox-firewall`) and rely on its **forward**
  rules, note that "forwarded traffic is currently only possible when using the new nftables-based
  proxmox-firewall" and stock `pve-firewall` forward rules have no effect. For a pure `post-up`
  masquerade as above (not going through the PVE firewall's forward chain), the iptables shim recipe
  is unaffected. If you prefer a fully native rule you can instead use `post-up nft add ...` /
  `post-down nft delete ...`, but the iptables form is the canonical pve-docs example and is the
  safer copy-paste for a beginner.

## Verifying network state from the shell

```bash
ip -br link # interface names + up/down + MACs (find your NIC)
ip -br addr # IPs per interface
ip route # default gateway / routing table
bridge link # which ports belong to which bridge
bridge vlan show # VLAN membership per bridge port (VLAN-aware checks)
cat /sys/class/net/vmbr0/bridge/vlan_filtering # 1 = VLAN-aware on
iptables -t nat -L POSTROUTING -n -v # confirm MASQUERADE rule loaded
sysctl net.ipv4.ip_forward # should be 1 for NAT lab
ifreload -a -n # dry-run validate config
ping -c1 192.168.10.1 # gateway reachable
```

## Wired-vs-WiFi (important constraint)

- **Bridging requires a wired NIC.** The recommended `vmbr0`-bridges-physical-NIC setup, where
  guests get LAN DHCP addresses, only works over Ethernet.
- **WiFi cannot be bridged in practice.** 802.11 station mode disallows a single radio presenting
  multiple MACs on the wireless segment (the AP only accepts the one station MAC), so bridged
  guests' frames get dropped. PVE/Linux bridging over a managed WiFi client interface does not work
  as a normal L2 bridge.
- Since this node is on a **wired LAN**, the default bridged model is exactly right. (If a box were
  WiFi-only, the only option would be a routed/NATed internal bridge like the dev-lab `vmbr1` recipe
  above - guests behind NAT, not on the LAN - which defeats the "reachable on the LAN" goal for home
  services.) Conclusion: keep the home node wired.

## Citations

- Proxmox VE Network Configuration (pve-docs / wiki):
  [Network Configuration](https://pve.proxmox.com/wiki/Network_Configuration)
  [Host System Administration](https://pve.proxmox.com/pve-docs/chapter-sysadmin.html) (default
  vmbr0 bridge, ifupdown2 / `ifreload -a` / `-n`, VLAN-aware bridge with `bridge-vlan-aware yes` +
  `bridge-vids`, `vmbr0.5` VLAN management IP, masquerade/`post-up iptables ... MASQUERADE` +
  `ip_forward`, routed config, interface naming, `ip link`).
- Container / VM network options (`pct`, `qm`):
  [Proxmox Container Toolkit](https://pve.proxmox.com/pve-docs/chapter-pct.html) (`net[n]` syntax
  incl. `bridge=`, `ip=dhcp`, `gw=`, `tag=`, `trunks=`; `pct set ... -net0 ...` examples).
- Install Proxmox VE on Debian 13 Trixie (hostname/FQDN must resolve to a non-loopback IP,
  `/etc/hosts` example, `hostname --ip-address`, GUI controls DNS, avoid resolvconf auto-generators,
  create `vmbr0` bridge):
  [Install Proxmox VE on Debian 13 Trixie](https://pve.proxmox.com/wiki/Install_Proxmox_VE_on_Debian_13_Trixie)
- Upgrade from 8 to 9 (NICs may be renamed by the new kernel; have IPMI/console; Rescue Boot to edit
  `/etc/network/interfaces`; `pve-network-interface-pinning` exists):
  [Upgrade from 8 to 9](https://pve.proxmox.com/wiki/Upgrade_from_8_to_9)
- pve-network-interface-pinning usage (`generate`, `--interface`, `--target-name`, `--prefix`;
  writes `.link` files to `/usr/local/lib/systemd/network/`; reboot required; updates `*.new`
  configs):
  [PVE 9.0 Beta and proxmox-network-interface-pinning](https://forum.proxmox.com/threads/pve-9-0-beta-and-proxmox-network-interface-pinning.168685/)
  [The Proxmox 9 Feature That Finally Fixes NIC Renaming Problems](https://www.virtualizationhowto.com/2026/03/the-proxmox-9-feature-that-finally-fixes-nic-renaming-problems/)
- PVE 9 firewall is iptables-based by default, with an opt-in nftables backend (`proxmox-firewall`);
  forward traffic rules require the nftables backend, and iptables remains as an nft-backed shim:
  [Proxmox VE Firewall](https://pve.proxmox.com/pve-docs/chapter-pve-firewall.html)
- pmxcfs / cluster hostname-IP recommendation:
  [Cluster Manager](https://pve.proxmox.com/pve-docs/chapter-pvecm.html)
- DNS / resolv.conf on trixie (avoid resolvconf/rdnssd overwriting `/etc/resolv.conf`;
  systemd-resolved symlink behavior):
  [Proxmox 9 cloud-init and Debian 13 (Trixie) fails to set DNS](https://forum.proxmox.com/threads/proxmox-9-cloud-init-and-debian-13-trixie-fails-to-set-dns.170804/)
  [resolvconf(1) - systemd-resolved](https://manpages.debian.org/trixie/systemd-resolved/resolvconf.1.en.html)
