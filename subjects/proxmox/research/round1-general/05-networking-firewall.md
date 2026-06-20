# Proxmox VE Networking and Firewall - From the Shell

Audience: a blind screen-reader user running a single Proxmox VE node (PVE 8.x on Debian 12; PVE 9.x
notes where relevant) on a home PC. Every step here is a shell command or a named config-file edit
with full path. No GUI is referenced. The web GUI listens on port 8006; we keep SSH (22) and 8006
open at all times so you are never locked out.

---

## 1. How PVE networking is structured

Proxmox VE networking is plain Debian networking. There is no special PVE network daemon - PVE just
writes the standard Debian config file and uses **ifupdown2** to apply it.

Key facts:

- The single source of truth is **`/etc/network/interfaces`**. You edit this file directly. (PVE GUI
  users get changes staged in `/etc/network/interfaces.new`, but when you edit by hand you write
  `interfaces` directly and apply it yourself.)
- PVE installs **ifupdown2**, which lets you apply changes live with `ifreload -a` (no reboot, no
  full network restart). This is the single most important command in this whole document.
- Guests (VMs and containers) are NOT given physical NICs. They are attached to a **Linux bridge**
  (named `vmbrN`, e.g. `vmbr0`). A bridge is a virtual switch in software. The host's real NIC is
  enslaved into the bridge, and every VM/CT gets a virtual tap/veth port on that same bridge. So
  host and guests share one L2 segment.

### Interface naming

Modern Debian uses "predictable" NIC names like `eno1`, `enp3s0`, `ens18` - NOT `eth0`. Find yours:

```bash
ip -br link # brief list of links and state
ip -br addr # brief list of addresses
ls /sys/class/net # raw kernel interface names
```

The physical NIC (e.g. `eno1`) is usually set to `manual` (no IP of its own); the IP lives on the
bridge.

---

## 2. The default bridged setup created at install

A fresh single-NIC install produces roughly this `/etc/network/interfaces`:

```bash
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

What each line means:

- `auto lo` / `iface lo inet loopback` - loopback, always present.
- `iface eno1 inet manual` - the physical NIC is brought up but gets no IP; it is just a bridge
  member.
- `auto vmbr0` - bring the bridge up at boot.
- `iface vmbr0 inet static` - the host's management IP lives on the bridge.
- `address 192.168.10.2/24` - host IP in CIDR form. This is the address you SSH to and reach
  `https://<ip>:8006` on.
- `gateway 192.168.10.1` - default route (your home router).
- `bridge-ports eno1` - enslave the physical NIC into the bridge. (`none` means an internal-only
  bridge with no uplink - see NAT section.)
- `bridge-stp off` - spanning tree off (fine for a home lab; avoids loops you don't have).
- `bridge-fd 0` - bridge forwarding delay 0 (ports forward immediately).

This default gives guests on `vmbr0` direct access to your home LAN, where they can get their own
DHCP lease from your router and appear as normal devices.

---

## 3. Editing and applying network changes safely

The danger: a bad edit to `/etc/network/interfaces` can drop your SSH session and lock you out of a
headless box. Mitigations:

1. **Back up first**: `cp /etc/network/interfaces /etc/network/interfaces.bak`
2. Edit with a CLI editor: `nano /etc/network/interfaces` (or vim).
3. **Dry-run the parse**: `ifreload -a -n` (the `-n`/`--no-act` flag shows what would happen without
   applying - use it to catch syntax errors).
4. Apply: `ifreload -a`
5. If you lose connectivity and have physical/console access, restore the backup and `ifreload -a`
   again.

Why `ifreload -a` and not `systemctl restart networking`? ifupdown2's `ifreload` computes a diff and
only touches what changed - it does NOT tear the whole stack down, so an unchanged management IP
usually keeps working across the reload. It is the supported PVE way to apply interface changes.

Verify after applying:

```bash
ip -br addr # confirm the IP landed on vmbr0
ip route # confirm default route via gateway
bridge link # show bridge member ports
brctl show # legacy view of bridges and their ports (bridge-utils)
```

---

## 4. Assigning a static IP, gateway, DNS

### Static IP and gateway

Set them on the **bridge** stanza (`vmbr0`), as shown in Section 2: `address` (CIDR) and `gateway`.
Apply with `ifreload -a`.

Only ONE `gateway` line should exist across the whole file (one default route).

### DNS resolvers - `/etc/resolv.conf`

PVE does NOT use the `dns-nameservers` line from `/etc/network/interfaces` for the host itself; the
host resolver is the classic `/etc/resolv.conf`:

```bash
# /etc/resolv.conf
search lan
nameserver 192.168.10.1
nameserver 1.1.1.1
```

- `search lan` - default search domain appended to unqualified names.
- `nameserver` - one per line, queried in order.

Caveat: if `resolvconf` or `systemd-resolved` is installed they may rewrite this file. On a stock
PVE host neither is active by default, so editing `/etc/resolv.conf` directly is reliable. Test with
`getent hosts proxmox.com` or `dig proxmox.com @192.168.10.1` (install `dnsutils` for `dig`).

### Hostname and `/etc/hosts`

PVE requires the node's hostname to resolve to its **management IP** (NOT to 127.0.0.1) - this is
critical because pveproxy and the cluster filesystem bind to that resolved address. A correct
`/etc/hosts`:

```bash
# /etc/hosts
127.0.0.1 localhost.localdomain localhost
192.168.10.2 pve.lan pve

# IPv6 loopback
::1 localhost ip6-localhost ip6-loopback
```

Replace `192.168.10.2` with your host IP and `pve` with your node name (`hostname` shows it; the
node directory is `/etc/pve/nodes/<nodename>/`). If the hostname maps to 127.0.0.1 you can get a
broken web UI / pveproxy. Check with:

```bash
hostname --ip-address # must print your LAN IP, not 127.0.0.1
```

---

## 5. VLAN-aware bridges and tagged interfaces

Two ways to do VLANs.

### A. VLAN-aware bridge (recommended, flexible)

Mark the bridge VLAN-aware; then you set the VLAN tag per-guest on the NIC (e.g.
`qm set <vmid> -net0 virtio,bridge=vmbr0,tag=20`). The host management IP can also live on a tagged
sub-interface:

```bash
auto lo
iface lo inet loopback

iface eno1 inet manual

auto vmbr0.5
iface vmbr0.5 inet static
 address 10.10.10.2/24
 gateway 10.10.10.1

auto vmbr0
iface vmbr0 inet manual
 bridge-ports eno1
 bridge-stp off
 bridge-fd 0
 bridge-vlan-aware yes
 bridge-vids 2-4094
```

- `bridge-vlan-aware yes` - turn the bridge into a VLAN-aware switch.
- `bridge-vids 2-4094` - the range of VLAN IDs the bridge accepts.
- `vmbr0.5` - host management on VLAN 5 (the `.5` suffix is the tag).

### B. Traditional VLAN bridge (one bridge per VLAN)

Without VLAN-awareness you build a `vmbrXvY` bridge whose port is a tagged sub-interface like
`eno1.5`. More bridges to manage; the VLAN-aware approach is simpler for most. Requires `vlan`
package / 8021q kernel module (loaded automatically by ifupdown2 when it sees `iface eno1.5`).

Your upstream switch port must be a trunk carrying those VLANs for tagging to mean anything. On a
flat home LAN with a dumb switch, VLANs do nothing - skip them.

---

## 6. Bonding (brief - likely skip on single NIC)

Bonding aggregates multiple NICs for bandwidth or failover. This is NOT RAID and is unrelated to
storage. With a single NIC it is impossible/pointless - skip it.

If you ever add a second NIC, the pattern is a `bond0` interface with `bond-slaves`, then make
`bond0` the `bridge-ports` of `vmbr0`:

```bash
auto bond0
iface bond0 inet manual
 bond-slaves eno1 eno2
 bond-miimon 100
 bond-mode 802.3ad # LACP; needs a switch that supports it
 bond-xmit-hash-policy layer2+3

auto vmbr0
iface vmbr0 inet static
 address 10.10.10.2/24
 gateway 10.10.10.1
 bridge-ports bond0
 bridge-stp off
 bridge-fd 0
```

For a home lab without a managed switch, `bond-mode active-backup` (failover only, no switch config
needed) is the safe choice instead of `802.3ad`. Requires the `ifenslave` package.

---

## 7. NAT / masquerading for an internal-only bridge (the key home-lab recipe)

Goal: a private bridge `vmbr0` (or a second bridge `vmbr1`) with NO physical port, where VMs get
private IPs and reach the internet **through the host's IP** via NAT. Useful when you do not want
guests visible on your home LAN, or when you only have one public IP.

In this recipe the **host** holds the real LAN/WAN IP on the physical NIC, and the internal bridge
is the VMs' gateway:

```bash
auto lo
iface lo inet loopback

auto eno1
# real IP address (host's LAN/WAN connection)
iface eno1 inet static
 address 198.51.100.5/24
 gateway 198.51.100.1

auto vmbr0
# private sub network for the VMs
iface vmbr0 inet static
 address 10.10.10.1/24
 bridge-ports none
 bridge-stp off
 bridge-fd 0

 post-up echo 1 > /proc/sys/net/ipv4/ip_forward
 post-up iptables -t nat -A POSTROUTING -s '10.10.10.0/24' -o eno1 -j MASQUERADE
 post-down iptables -t nat -D POSTROUTING -s '10.10.10.0/24' -o eno1 -j MASQUERADE
```

Explanation:

- `bridge-ports none` - internal-only bridge, no uplink NIC. Traffic out reaches the host's IP stack
  and is routed.
- `vmbr0` address `10.10.10.1/24` - the host is the **gateway** for the VMs. Each VM is configured
  with a static IP in `10.10.10.0/24`, gateway `10.10.10.1`, and a DNS server (e.g. `1.1.1.1`).
- `post-up echo 1 > /proc/sys/net/ipv4/ip_forward` - enable IP forwarding so the host routes between
  the private subnet and `eno1`. (Better/persistent: set `net.ipv4.ip_forward=1` in
  `/etc/sysctl.conf` or a file in `/etc/sysctl.d/` and run `sysctl -p`.)
- `post-up iptables -t nat -A POSTROUTING ... -j MASQUERADE` - rewrite the source of outbound
  packets from the private subnet to the host's IP. `post-down` removes the rule on interface-down
  so it does not accumulate.
- `-o eno1` - masquerade only traffic leaving via the real uplink.

### Conntrack-zone fix when the PVE firewall is also enabled

If you enable the pve-firewall AND use masquerading, outgoing VM connections can break because the
firewall's bridge POSTROUTING can win over MASQUERADE. Add conntrack zones to the bridge stanza:

```bash
 post-up iptables -t raw -I PREROUTING -i fwbr+ -j CT --zone 1
 post-down iptables -t raw -D PREROUTING -i fwbr+ -j CT --zone 1
```

(`fwbr+` matches the firewall bridge interfaces PVE creates per-VM when the firewall is on.)

### Verify NAT

```bash
sysctl net.ipv4.ip_forward # should be 1
iptables -t nat -L POSTROUTING -n -v # should show the MASQUERADE rule
iptables -t nat -L POSTROUTING -n -v | grep MASQUERADE
```

From a VM: `ping 1.1.1.1` (tests NAT/routing), then `ping proxmox.com` (tests DNS).

PVE 9 note: PVE 9.x is moving toward an **nftables**-based firewall; the classic iptables MASQUERADE
rule still works, but on a pure-nftables host you may prefer an `nft` masquerade rule or - cleaner -
an SDN "simple zone" with SNAT (Section 10).

---

## 8. The Proxmox firewall (pve-firewall) - concepts and config files

The PVE firewall is a wrapper that compiles your high-level rules into iptables (nftables in
tech-preview / PVE 9) rules on the node. It has **three levels**:

1. **Cluster / datacenter** level - `/etc/pve/firewall/cluster.fw`. Master on/off switch and default
   policies, plus shared security groups, IP sets, and aliases.
2. **Host** level - `/etc/pve/nodes/<nodename>/host.fw`. Rules and options for the PVE host itself
   (your management box).
3. **Guest (VM/CT)** level - `/etc/pve/firewall/<VMID>.fw`. Rules for one VM or container.

`/etc/pve` is the cluster filesystem (pmxcfs); files written there are config-tracked. On a single
node it is just a special mountpoint - edit the files normally with `nano`.

### Master switches (this trips everyone up)

The firewall only filters when BOTH switches are on:

- The cluster-level `enable: 1` in `cluster.fw [OPTIONS]` - the global master switch.
- The per-object enable (host `host.fw [OPTIONS] enable: 1`, or each guest's
  `<VMID>.fw [OPTIONS] enable: 1`, and the guest NIC's `firewall=1` flag).

If the cluster master is `enable: 0`, NOTHING is filtered regardless of host/VM settings. This is
the safety default on a fresh install.

### Default policies and the all-important built-in management exceptions

In `cluster.fw [OPTIONS]` you set `policy_in` and `policy_out` (default ACCEPT). The recommended
hardening is `policy_in: DROP`. **The safety net:** when input policy is DROP/REJECT, PVE STILL
auto-allows traffic from hosts in the **`management` IP set** to:

- port 22 (SSH),
- port 8006 (PVE web UI / pveproxy),
- ports 5900-5999 (VNC) and 3128 (SPICE proxy).

The local network is auto-added to `management` (alias `local_network` / `cluster_network`). This is
why a correctly-set-up host does not lock you out when you flip `policy_in: DROP` - but ONLY for IPs
in `management`, and ONLY for IPv4 (IPv6 needs explicit rules).

### Config-file syntax

Each `.fw` file uses INI-like sections: `[OPTIONS]`, `[RULES]`, `[IPSET <name>]`, `[ALIASES]`, and
(cluster only) `[group <name>]` for security groups.

Example rule lines (from `[RULES]`):

```text
[RULES]
IN SSH(ACCEPT) -i net0
IN SSH(ACCEPT) -i net0 -source 192.168.2.192 # only allow SSH from that host
IN SSH(ACCEPT) -i net0 -source 10.0.0.1-10.0.0.10 # an IP range
IN SSH(ACCEPT) -i net0 -source 10.0.0.1,10.0.0.2,10.0.0.3 # an IP list
IN SSH(ACCEPT) -i net0 -source +mynetgroup # an ipset (+name)
IN SSH(ACCEPT) -i net0 -source myserveralias # an alias (bare name)
|IN SSH(ACCEPT) -i net0 # leading | = disabled rule
IN DROP # drop all other incoming
OUT ACCEPT # accept all outgoing
```

- Direction: `IN` / `OUT`.
- `SSH(ACCEPT)` is a **macro** `SSH` with action `ACCEPT`. Other macros: `HTTP`, `HTTPS`, `DNS`,
  `Ping`, etc. (`pve-firewall` ships many; see `iptables`-style macro list in the docs.) You can
  also write raw `-p tcp -dport 8006 -j ACCEPT` style rules.
- `+name` references an IP set; a bare name references an alias.
- A leading `|` disables a rule (keeps it in the file but inactive).

---

## 9. Enabling the firewall SAFELY (do not lock yourself out)

This is the critical workflow for a REMOTE screen-reader user. Follow it in order.

### Step 0 - keep a second way in

Open a SECOND SSH session and leave it connected while you work, so if the active session drops you
still have a live shell. If you have console/IPMI access, even better.

### Step 1 - define the management IP set so your admin IP is always allowed

Edit `/etc/pve/firewall/cluster.fw`:

```text
[OPTIONS]
enable: 1
policy_in: DROP
policy_out: ACCEPT

[IPSET management] # hosts allowed full management access (SSH/8006/VNC/SPICE)
192.168.10.0/24 # your whole LAN, or
# 192.168.10.50 # just your admin workstation, tighter

[ALIASES]
admin_pc 192.168.10.50

[RULES]
# Belt-and-suspenders explicit allows (the built-in management exceptions also cover these):
IN SSH(ACCEPT) -source +management
IN ACCEPT -p tcp -dport 8006 -source +management # PVE web UI
IN Ping(ACCEPT)
```

Notes:

- Put your admin/LAN IPs in `[IPSET management]` BEFORE setting `policy_in: DROP`. The built-in
  exceptions for 22/8006/5900-5999/3128 apply to exactly these IPs.
- Keep `policy_out: ACCEPT` so the host can still reach the internet (updates, DNS).
- The explicit SSH/8006 rules are redundant with the built-in exceptions but make your intent
  obvious and survive future option changes.

### Step 2 - test-compile BEFORE applying

```bash
pve-firewall compile # dump the iptables rules that WOULD be generated; no apply
```

Read the output and confirm ACCEPT rules for dport 22 and 8006 from your IP exist before they hit
any DROP. If `compile` errors, fix the file first.

### Step 3 - confirm what the firewall thinks your local net is

```bash
pve-firewall localnet # shows detected local_network/management set + which IPs get the auto-allow
```

Make sure YOUR IP appears here. If it does not, fix the `management` IPSet.

### Step 4 - turn it on and check

The firewall service is `pve-firewall` (a daemon that re-applies on config change):

```bash
pve-firewall status # is it running? is it enabled?
pve-firewall start # start the service
pve-firewall restart # reload after edits (also auto-reloads on .fw change)
```

You normally do NOT need to start/stop manually - the daemon watches the `.fw` files and recompiles
automatically. The real "switch" is `enable: 1` in `cluster.fw`.

### Step 5 - verify the live ruleset and your access

```bash
pve-firewall status # PVE view
iptables-save # full live iptables ruleset
iptables -L -n -v # human-readable, with packet counters
nft list ruleset # nftables view (PVE 9 / nftables backend)
```

Confirm from another machine that `ssh` and `https://<ip>:8006` still work. Only THEN consider
tightening further.

### Emergency un-lock (if you DID lock yourself out but still have a shell)

```bash
pve-firewall stop # stop applying rules (rules flushed)
# or set enable: 0 in /etc/pve/firewall/cluster.fw, then:
pve-firewall compile # sanity
```

If you have no shell at all, you need console/physical access: boot, mount, edit `cluster.fw` to
`enable: 0`. There is no remote escape once SSH is blocked - which is exactly why Steps 1-3 matter.

### IPv6 warning

Current Proxmox docs say the firewall supports both IPv4 and IPv6, but a headless remote host should
not rely on implicit management access. If your host has a routable IPv6 address and you set
`policy_in: DROP`, add explicit IPv6 ACCEPT rules for 22/8006 from your IPv6 admin range, compile
the rules, and test a brand-new IPv6 SSH session before closing your recovery shell.

---

## 10. Security groups, IP sets, aliases

These live mainly in `cluster.fw` and are reusable across host and guests.

### Aliases - name a single IP or network

```text
[ALIASES]
home_router 192.168.10.1
admin_pc 192.168.10.50
work_net 203.0.113.0/24
```

Reference a bare alias name as a `-source` / `-dest`.

### IP sets - a named group of IPs/networks

```text
[IPSET management] # special name: grants the built-in mgmt exceptions
192.168.10.0/24

[IPSET blacklist]
1.2.3.0/24
5.6.7.8
```

Reference with a leading `+`, e.g. `-source +blacklist`. Special built-in-meaning sets: `management`
(admin access), `blacklist` (dropped early everywhere). Per-guest you can define
`[IPSET ipfilter-net0]` to restrict which source IPs a VM may use (anti-spoof).

### Security groups - a named bundle of rules

Defined only in `cluster.fw`, then referenced from any level:

```text
[group webserver]
IN HTTP(ACCEPT)
IN HTTPS(ACCEPT)

[group admin-access]
IN SSH(ACCEPT) -source +management
```

Reference from a `[RULES]` section:

```text
[RULES]
GROUP webserver
GROUP admin-access
```

Great for applying the same policy to many VMs (define once, attach by name).

---

## 11. Per-VM / per-container firewall

Two requirements to filter a guest:

1. The guest's NIC must have the firewall flag set. From the host:

```bash
qm set <vmid> -net0 virtio,bridge=vmbr0,firewall=1 # VM
pct set <ctid> -net0 name=eth0,bridge=vmbr0,firewall=1 # container
```

(Or set `firewall=1` on the netN line in `/etc/pve/qemu-server/<vmid>.conf` /
`/etc/pve/lxc/<ctid>.conf`.) 2. Enable the firewall in the guest's `.fw`:

```text
# /etc/pve/firewall/<VMID>.fw
[OPTIONS]
enable: 1
policy_in: DROP
policy_out: ACCEPT
ipfilter: 1 # optional anti-IP-spoofing (uses ipfilter-netX ipsets)

[RULES]
IN SSH(ACCEPT)
IN HTTP(ACCEPT)
IN HTTPS(ACCEPT)
IN Ping(ACCEPT)
```

The guest-level firewall is applied on the host's `fwbr*`/`tap*`/`veth*` bridge interfaces that PVE
inserts in front of each guest NIC - that is why enabling the firewall changes the bridge topology
(and why the conntrack-zone NAT fix exists).

---

## 12. SDN (Software-Defined Networking) - light overview

SDN is an optional layer for managing zones, VNets, and subnets declaratively, with config in
`/etc/pve/sdn/`. For a single node it is usually overkill - the manual `/etc/network/interfaces`
bridge + NAT recipe (Section 7) does the same job with less moving parts. But SDN's **simple zone**
is a genuinely nice single-node feature: it creates an isolated, optionally-NATed network with a
built-in DHCP server, so VMs auto- get IPs without you hand-assigning them.

Concepts:

- **Zone** - a virtually separated network area (type controls behavior; `simple` = standalone local
  zone).
- **VNet** - a virtual network (becomes a bridge guests attach to) inside a zone.
- **Subnet** - an IP range on a VNet, with a gateway and optional DHCP range and SNAT.

Config files and apply:

```text
# /etc/pve/sdn/zones.cfg
simple: mysimple

# /etc/pve/sdn/vnets.cfg
vnet: vnet0
 zone mysimple

# /etc/pve/sdn/subnets.cfg
subnet: mysimple-10.0.1.0-24
 vnet vnet0
 gateway 10.0.1.1
 snat 1
 dhcp-range start-address=10.0.1.100,end-address=10.0.1.200
```

```bash
pvesh set /cluster/sdn # apply SDN config (generates the bridges/rules)
# or, equivalently in newer PVE:
pvesh create /cluster/sdn/... # to build objects via API instead of files
```

After applying, attach a guest NIC to the VNet bridge (`bridge=vnet0`). With `snat 1` +
`dhcp-range`, guests get an IP automatically and reach the internet via the host - the SDN
equivalent of the manual NAT bridge, but with DHCP handled for you. The `dnsmasq` DHCP plugin must
be installed for DHCP ranges to work (`apt install dnsmasq` then disable its global service; PVE
manages per-VNet instances).

When to use on a single node: if you want several isolated guest networks each with auto-DHCP and
NAT, SDN simple zones are cleaner than maintaining many manual bridges. For one or two bridges,
stick with `/etc/network/interfaces`.

---

## 13. DNS resolution and qemu-guest-agent IP reporting

### Host DNS

Covered in Section 4: `/etc/resolv.conf` for resolvers, `/etc/hosts` for the node's own name. Test
with `getent hosts <name>` and `dig <name>`.

### Knowing a guest's IP from the host - the qemu-guest-agent

By default PVE/QEMU cannot see inside a VM, so it does not know the VM's IP. Install the
**qemu-guest-agent** inside each VM to expose IPs and allow clean shutdown/freeze.

1. Enable the agent in the VM's PVE config (host side):

```bash
qm config <vmid> | grep -i agent # check current setting
qm set <vmid> --agent enabled=1 # enable; then reboot the VM once
```

1. Install + enable the agent INSIDE the guest:

```bash
# Debian/Ubuntu guest:
apt install qemu-guest-agent
systemctl enable --now qemu-guest-agent
# RHEL/Fedora guest:
dnf install qemu-guest-agent && systemctl enable --now qemu-guest-agent
```

1. Query the guest's interfaces/IPs from the HOST:

```bash
qm agent <vmid> network-get-interfaces # JSON list of NICs + IPv4/IPv6
qm agent <vmid> ping # confirm agent is responding
```

Without the agent, `qm agent ... network-get-interfaces` fails and the host has no IP info. For
containers (LXC), no agent is needed - the host can read the CT's config/IP directly:
`pct config <ctid>` and `pct exec <ctid> -- ip -br addr`.

This is especially valuable for a screen-reader user: `qm agent <vmid> network-get-interfaces` is a
clean, scriptable way to discover a freshly-booted VM's IP without any GUI or console poking.

---

## 14. Quick command reference

Networking:

```bash
ip -br addr ; ip -br link ; ip route # inspect addresses, links, routes
bridge link ; brctl show # inspect bridge membership
nano /etc/network/interfaces # edit interfaces
ifreload -a -n # dry-run apply (syntax check)
ifreload -a # apply changes (ifupdown2)
sysctl net.ipv4.ip_forward # check IP forwarding (NAT)
iptables -t nat -L POSTROUTING -n -v # check MASQUERADE rule
```

Firewall:

```bash
nano /etc/pve/firewall/cluster.fw # cluster options/policy/ipsets/groups
nano /etc/pve/nodes/<node>/host.fw # host rules
nano /etc/pve/firewall/<vmid>.fw # per-guest rules
pve-firewall compile # preview generated rules (no apply)
pve-firewall localnet # show detected mgmt/local network
pve-firewall status # running/enabled state
pve-firewall start | stop | restart # control the daemon
iptables-save ; iptables -L -n -v # live ruleset (iptables backend)
nft list ruleset # live ruleset (nftables / PVE 9)
```

Guest IP discovery:

```bash
qm set <vmid> --agent enabled=1 # enable agent (then reboot VM)
qm agent <vmid> network-get-interfaces # get VM IPs (agent must be installed)
pct exec <ctid> -- ip -br addr # container IPs (no agent needed)
```

---

## 15. Gotchas and best practices

- **Always `cp` the file before editing**, and use `ifreload -a -n` to syntax-check before applying.
  A bad `interfaces` edit on a headless box = lockout.
- **One `gateway` line only** across the whole `interfaces` file.
- **Predictable NIC names** (`eno1`, `enp3s0`) - never assume `eth0`. Confirm with `ip -br link`.
- **Host hostname must resolve to the LAN IP, not 127.0.0.1** (`hostname --ip-address`) or
  pveproxy/web UI break.
- **`/etc/resolv.conf` is the host resolver**, not `dns-nameservers` in `interfaces`. Watch for
  `systemd-resolved`/`resolvconf` overwriting it (not active by default).
- **Firewall has TWO master switches**: cluster `enable: 1` AND the per-object enable; nothing
  filters until both are on. Default install = off (safe).
- **Before `policy_in: DROP`**: put your admin/LAN IP in `[IPSET management]`, then
  `pve-firewall compile` and `pve-firewall localnet` to confirm 22/8006 stay open for your IP. Keep
  a second SSH session live.
- **Do not rely on implicit management access for IPv6** - add explicit IPv6 rules if you use IPv6.
- **NAT + firewall conflict**: add the `iptables -t raw ... CT --zone 1` conntrack-zone lines to the
  NAT bridge if outgoing VM connections break with the firewall on.
- **Make IP forwarding persistent** via `/etc/sysctl.d/` (not only the `post-up echo`) so it
  survives a reload cleanly: `net.ipv4.ip_forward=1`.
- **VLAN tags need a trunk** upstream - pointless on a flat home LAN with a dumb switch.
- **Bonding needs 2+ NICs** and is not RAID; skip on single NIC. If added, use `active-backup`
  unless you have a managed switch for LACP.
- **PVE 9 / nftables**: the firewall is moving to nftables (`ftables` tech-preview option today).
  iptables rules still work in 8.x; verify with `nft list ruleset` on 9.x. The high-level `.fw`
  files and `pve-firewall` CLI are unchanged.
- **qemu-guest-agent must be installed inside each VM** for the host to learn its IP
  (`qm agent <vmid> network-get-interfaces`); LXC needs no agent.

---

## Citations

- Network config, default bridge, VLAN-aware bridge, bonding, masquerading, conntrack zones,
  `ifreload -a`:
  [Host System Administration](https://pve.proxmox.com/pve-docs/chapter-sysadmin.html) (Proxmox VE
  Network Configuration chapter)
- Firewall config files (`cluster.fw`, `host.fw`, `<VMID>.fw`), `[OPTIONS]`, rules syntax, security
  groups, IP sets, aliases, host/VM options, management exceptions:
  [Proxmox VE Firewall](https://pve.proxmox.com/pve-docs/chapter-pve-firewall.html)
- `pve-firewall` CLI (compile/localnet/status/start/stop/restart/simulate):
  [pve-firewall(8)](https://pve.proxmox.com/pve-docs/pve-firewall.8.html)
- Firewall wiki (safe enable, management ipset, default DROP exceptions, IPv6 note):
  [Firewall](https://pve.proxmox.com/wiki/Firewall)
- SDN simple zone, VNets, subnets, SNAT, DHCP range, `pvesh`:
  [Software-Defined Network](https://pve.proxmox.com/pve-docs/chapter-pvesdn.html)
- qemu-guest-agent install, `qm set --agent`, `qm agent network-get-interfaces`:
  [Qemu-guest-agent](https://pve.proxmox.com/wiki/Qemu-guest-agent)
