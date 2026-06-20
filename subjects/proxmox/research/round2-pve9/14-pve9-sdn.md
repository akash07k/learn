# Software-Defined Networking (SDN) on PVE 9 - Single-Node Home Use

Scope: latest Proxmox VE 9.x (Debian 13 "trixie"), mid-2026. Reader is a blind, shell-only,
single-node home user (host root on BTRFS) running home services plus an isolated dev lab. This file
focuses on the _one_ SDN feature that is genuinely useful on a single node - the **Simple zone**
with built-in NAT and DHCP/IPAM - and is honest about when to skip SDN entirely.

## TL;DR / Recommendation

- For "services on the LAN" (your home services that should get IPs from your home router): **do not
  use SDN at all.** Use a plain Linux bridge (`vmbr0`) attached to your NIC. This is the basic,
  boring, correct answer and is covered in the bridge/networking topic.
- For an **isolated dev lab** that needs its own private subnet, internet access via NAT, and
  _automatic IP assignment_ so you do not hand-configure every guest: the SDN **Simple zone** is the
  right tool. It gives you a NAT'd bridge **plus** managed DHCP/IPAM in a few config-file lines,
  instead of hand-rolling `iptables`/`dnsmasq`.
- If you would otherwise hand-configure static IPs on a handful of lab guests, a plain NAT bridge is
  still simpler. Reach for the Simple zone specifically when you want **managed DHCP/IPAM** (guests
  just set `ip=dhcp` and get addresses + internet automatically).
- **Fabrics** (new in PVE 9) are for multi-node routed underlays (Ceph mesh, EVPN). A single-node
  home user can and should **ignore them entirely.**

## What changed from PVE 8 (deltas)

- **SDN core is first-class, but DHCP/IPAM is still tech preview in current docs.** The current PVE
  9.2.2 SDN chapter says core SDN and VNet management are fully supported, while IPAM including DHCP
  management for guests is still marked technology preview. For this single-node corpus, the
  Simple-zone + DHCP/IPAM path remains useful as an optional lab convenience, not as the default
  production network for home services.
- **Fabrics are new in PVE 9** (OpenFabric and OSPF at 9.0; WireGuard fabric, BGP route maps/prefix
  lists, and IPv6 EVPN underlay added by 9.2). These build routed spine-leaf / full-mesh underlays
  from config instead of hand-edited FRR. **Not relevant to a single node** - see the Fabrics
  section below.
- `dnsmasq` is still the DHCP/DNS backend for SDN, and it is still a **manual dependency** you must
  install yourself (see Gotchas).

## SDN concepts (the three you need)

SDN layers a logical network model on top of the host's real networking. Three objects matter for
the single-node case:

- **Zone**: the network's "mode" / scope. The relevant type here is the **Simple** zone. A Simple
  zone creates an **isolated VNet bridge that is not attached to any physical NIC** - guests on it
  can talk to each other (on this host only) and, if you enable SNAT, reach the internet through the
  host. Other zone types (VLAN, QinQ, VXLAN, EVPN) solve multi-node / overlay problems you do not
  have.
- **VNet**: the virtual network itself. On a Simple zone, each VNet becomes a real Linux bridge on
  the host (named after the VNet, e.g. `vnet0`). Guests attach their NIC to this bridge. This is the
  thing you put in `bridge=<vnet>` on a guest's `net0`.
- **Subnet**: the IP configuration layered on a VNet - the CIDR, the **gateway** IP (the host's
  address on that bridge), the **SNAT** toggle (NAT to the internet), and the **dhcp-range** (which
  turns on managed DHCP/IPAM for that subnet).

A VNet can have several subnets (e.g. one IPv4, one IPv6). IPAM ("pve" is the built-in default)
tracks which IPs are allocated so DHCP can hand out leases without collisions.

## The config files under /etc/pve/sdn/

SDN config lives in `/etc/pve/sdn/` (this is on the `pmxcfs` cluster filesystem, so it is the same
across nodes - irrelevant for you but explains why it is not a normal disk path). The three files
you edit:

- `/etc/pve/sdn/zones.cfg` - zone definitions
- `/etc/pve/sdn/vnets.cfg` - VNet (bridge) definitions
- `/etc/pve/sdn/subnets.cfg` - subnet / IP / DHCP / SNAT definitions

The system also maintains, in the same directory, a `.running-config` and a `.version` file that
track applied (running) vs pending (staged) state. **Do not edit those.**

Important model detail: **edits are staged ("pending"), not live.** When you change a `.cfg` file
(or use the API to change config), nothing takes effect until you **apply** (reload) the SDN config.
This is the two-stage "pending vs running" system. See "Applying".

## Worked example - Simple zone + VNet + subnet with DHCP, entirely from the shell

Goal: an isolated dev-lab network `10.0.0.0/24`, host/gateway at `10.0.0.1`, NAT to the internet,
DHCP handing out `10.0.0.50` - `10.0.0.200`.

### Step 0 - install the DHCP backend (one-time, mandatory for DHCP)

```bash
apt update
apt install dnsmasq
systemctl disable --now dnsmasq
```

You install `dnsmasq` but **disable the system service** - Proxmox runs its _own_ per-zone dnsmasq
instances (`dnsmasq@<zone>`) and the global service would conflict. If you skip this package, the
SDN reload still configures the bridge and SNAT, but **no guest will get a DHCP lease.**

### Step 1 - write the three config files

You can either hand-write the `.cfg` files or use `pvesh` (both end up in the same files).

Config-file form:

```text
# /etc/pve/sdn/zones.cfg
simple: lab
	ipam pve
	dhcp dnsmasq
```

```text
# /etc/pve/sdn/vnets.cfg
vnet: vnet0
	zone lab
```

```text
# /etc/pve/sdn/subnets.cfg
subnet: lab-10.0.0.0-24
	vnet vnet0
	gateway 10.0.0.1
	snat 1
	dhcp-range start-address=10.0.0.50,end-address=10.0.0.200
```

Notes on the keys:

- `simple: lab` declares a Simple zone with ID `lab`.
- `ipam pve` selects the built-in IPAM (the default; you can omit it and get pve anyway).
- `dhcp dnsmasq` on the zone enables the automatic DHCP server for the zone (this is the "automatic
  DHCP" advanced option in the GUI). Required for leases to be served.
- The subnet **section name encodes the CIDR** with dashes: `<zone>-<network>-<prefix>`, e.g.
  `lab-10.0.0.0-24`. Follow that convention.
- `gateway 10.0.0.1` - the host takes this IP on the `vnet0` bridge and acts as the guests' default
  gateway. **DHCP will not work without a gateway set.**
- `snat 1` - turns on Source NAT so guests reach the internet through the host.
- `dhcp-range start-address=...,end-address=...` - the lease pool; its presence is what switches
  managed DHCP on for this subnet.
- Optional: `dhcp-dns-server x.x.x.x` to override the DNS server handed to guests (otherwise dnsmasq
  serves DNS using the host's resolver).

Equivalent CLI (`pvesh`) instead of hand-editing - same result:

```bash
# zone
pvesh create /cluster/sdn/zones --type simple --zone lab --ipam pve --dhcp dnsmasq
# vnet
pvesh create /cluster/sdn/vnets --vnet vnet0 --zone lab
# subnet with gateway, SNAT and DHCP range
pvesh create /cluster/sdn/vnets/vnet0/subnets \
	--subnet 10.0.0.0/24 --type subnet \
	--gateway 10.0.0.1 --snat 1 \
	--dhcp-range start-address=10.0.0.50,end-address=10.0.0.200
```

(To later change just the DHCP range:
`pvesh set /cluster/sdn/vnets/vnet0/subnets/lab-10.0.0.0-24 -dhcp-range start-address=...,end-address=...`)

### Step 2 - apply (reload) the SDN config

Staged changes only go live when you apply. From the shell:

```bash
pvesh set /cluster/sdn
```

This is the API equivalent of the GUI "Apply" button - it pushes pending config to running, creates
the `vnet0` bridge, assigns `10.0.0.1` to it, installs the SNAT `iptables` rules, and starts the
`dnsmasq@lab` instance. (`pvesh set /cluster/sdn` is the canonical apply;
`systemctl reload pvenetcommit` / `ifreload -a` are internal mechanics you should not need.) **Watch
the task output - confirm it finishes without errors**, since a failed reload can leave config
half-applied.

You can sanity-check from the shell:

```bash
ip addr show vnet0 # should show 10.0.0.1/24
ip -br link show vnet0 # bridge should be UP
systemctl status dnsmasq@lab
iptables -t nat -S | grep 10.0.0 # SNAT/MASQUERADE rule present
```

### Step 3 - attach a guest to the VNet bridge

For a **container** (`pct`), set the network interface to use the VNet bridge and DHCP:

```bash
pct set <CTID> -net0 name=eth0,bridge=vnet0,ip=dhcp
```

For a **VM** (`qm`):

```bash
qm set <VMID> -net0 virtio,bridge=vnet0
```

…and configure the guest OS to use DHCP on that interface. The guest then receives an address from
`10.0.0.50` - `10.0.0.200`, gateway `10.0.0.1`, and reaches the internet via the host's NAT. This is
fully accessible from the shell / serial console / `pct enter`.

## SDN Simple zone vs a plain Linux NAT bridge - when is SDN worth it?

A plain NAT bridge (a `vmbrX` with a private subnet on the host, a static `post-up`/`iptables`
MASQUERADE rule, and either static guest IPs or your own `dnsmasq`) does the same NAT job. The
trade-off:

- **Plain NAT bridge - prefer this when**: you have a few lab guests, you are fine setting static
  IPs (or running one dnsmasq config yourself), and you want the fewest moving parts. No extra
  packages beyond what you choose; everything is in `/etc/network/interfaces`. Simplest to reason
  about and to recover on a single node.
- **SDN Simple zone - prefer this when**: you want **managed DHCP and IPAM** without writing a
  dnsmasq config by hand - guests just say `ip=dhcp` and the host tracks allocations. You also get a
  clean, declarative model in `/etc/pve/sdn/*.cfg` and a single `pvesh set /cluster/sdn` to apply,
  instead of hand-maintained `iptables` lines. The cost is the `dnsmasq` dependency, the
  staging/apply step, and a firewall caveat (below).

Honest summary: on a single node, SDN's multi-node strengths are wasted. Its one real win for you is
**turnkey DHCP/IPAM + NAT** for the dev lab. If you do not want DHCP, a plain NAT bridge is the
lower-complexity choice.

## Fabrics (new in PVE 9) - and why you can skip them

**Fabrics** build automatically-routed underlay networks **between cluster nodes** from the web UI /
config instead of hand-edited FRR (`frr.conf`). They run a routing protocol (**OpenFabric** or
**OSPF** at 9.0; **WireGuard** fabric, BGP route-maps/prefix-lists, and IPv6 EVPN underlay added by
**9.2**) across the physical NICs so every node can reach every other node, with multiple paths and
automatic NIC failover. Typical uses: a full-mesh underlay for **Ceph**, or the **underlay for an
EVPN** overlay across a cluster.

Why a single-node home user skips them: fabrics exist to route traffic **among multiple nodes**.
With one node there is nothing to route between - no peers, no mesh, no failover to gain. They also
pull in FRR and add real complexity. **Ignore fabrics entirely.**

## Gotchas

- **`dnsmasq` is a manual dependency.** It is not pulled in automatically for the DHCP feature.
  `apt install dnsmasq` then `systemctl disable --now dnsmasq` (Proxmox runs per-zone
  `dnsmasq@<zone>` instances; the global service would conflict). Without it, the bridge/SNAT come
  up but **no DHCP leases are served.**
- **Changes are staged, not live.** Editing `.cfg` files or using the API does nothing until you
  **apply** with `pvesh set /cluster/sdn` (GUI "Apply"). Forgetting this is the most common "I
  configured it but nothing works" cause. Watch the apply task for errors - a failed reload can
  leave a partial state.
- **A subnet gateway is mandatory for DHCP.** No `gateway` line means no working DHCP.
- **PVE firewall + SDN DHCP/DNS.** If you enable the Proxmox firewall, you must explicitly allow
  DHCP and DNS _on the VNet interface_, or guests cannot reach the host's dnsmasq. Add datacenter
  rules on interface `vnet0` using the **`DHCPfwd`** macro (DHCP forwarding) and the **`DNS`**
  macro. (If your firewall is off, no action needed.)
- **SNAT only NATs; it does not expose guests inbound.** Guests on a Simple zone are reachable only
  from the host (single node). To reach a lab service from your LAN you port -forward on the host
  yourself, or use the host as a jump box / `pct enter`.
- **SDN is overkill for "services on the LAN."** If a guest should appear on your home network and
  get an IP from your router, attach it to the plain `vmbr0` bridge - do **not** build an SDN zone
  for that. SDN's value here is purely the isolated, NAT'd, DHCP-managed lab network.
- **Path is on pmxcfs.** `/etc/pve/sdn/` lives on the Proxmox cluster filesystem, not a normal
  directory on your BTRFS root. It is editable as a normal file but is managed by `pmxcfs`; back it
  up by backing up `/etc/pve`.

## Sources / citations

- Proxmox VE SDN docs chapter (zones, vnets, subnets, Simple zone, DHCP/IPAM, SNAT, config files,
  apply model, fabrics):
  [Software-Defined Network](https://pve.proxmox.com/pve-docs/chapter-pvesdn.html)
- Proxmox VE admin guide, "12.16.1 Simple Zone Example":
  [Proxmox VE Administration Guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.html)
- Proxmox wiki, "Setup Simple Zone With SNAT and DHCP" (exact `subnets.cfg`, dnsmasq
  install+disable, firewall macros, guest attach):
  [Setup Simple Zone With SNAT and DHCP](https://pve.proxmox.com/wiki/Setup_Simple_Zone_With_SNAT_and_DHCP)
- Proxmox wiki, "Software-Defined Network":
  [Software-Defined Network](https://pve.proxmox.com/wiki/Software-Defined_Network)
- Proxmox VE 9.0 release (SDN integrated; Fabrics with OpenFabric/OSPF introduced):
  [Proxmox Virtual Environment 9.0 with Debian 13 released](https://www.proxmox.com/en/about/company-details/press-releases/proxmox-virtual-environment-9-0)
- ServeTheHome, "Proxmox VE 9 Add SDN Fabric OpenFabric Or OSPF":
  [Proxmox VE 9 Add SDN Fabric OpenFabric Or OSPF](https://www.servethehome.com/proxmox-ve-9-is-out-with-big-new-features/proxmox-ve-9-add-sdn-fabric-openfabric-or-ospf/)
- PVE 9.2 fabric additions (WireGuard fabric, BGP route-maps/prefix-lists, IPv6 EVPN underlay):
  [Proxmox VE 9.2 - Dynamic Load Balancer, WireGuard SDN & Kernel 7.0](https://datazone.de/en/aktuelles/proxmox-ve-9-2-release/)
- `pvesh` CLI usage for zones/vnets/subnets and `pvesh set /cluster/sdn` apply (community references
  corroborating the API paths):
  [Proxmox SDN: Configure Zones, VNets, and Subnets](https://proxmoxpulse.com/articles/proxmox-sdn-configure-zones-vnets-subnets/)
