# PVE 9 Firewall from the Shell, Including the nftables Backend

Target: latest Proxmox VE 9.x (Debian 13 "trixie"), single node, shell-only, remote over SSH, host
root on BTRFS. Everything below is doable with no GUI: edit the `.fw` files with your editor of
choice, then drive `pve-firewall` and `nft`/`iptables-save` to apply and inspect.

## TL;DR accuracy note on the backend

In PVE 9 the firewall is **still iptables-based by default**. The classic `pve-firewall` service
(which compiles your `.fw` rules into iptables/ipset) remains the shipped, supported, default
backend. The nftables backend (`proxmox-firewall`, written in Rust) is **opt-in and a technology
preview** - you must install a package AND set `nftables: 1` in `host.fw`. Do not treat nftables as
the default. See "nftables backend" below for exact opt-in steps.

## The three configuration levels and their files

The firewall is configured by plain-text INI-style files stored on the `pmxcfs` cluster filesystem
(`/etc/pve`), so they are replicated and permission-controlled. The three levels are:

1. Datacenter / cluster-wide: `/etc/pve/firewall/cluster.fw`
2. Host / node: `/etc/pve/nodes/<nodename>/host.fw`
3. Guest (per VM or container, by VMID): `/etc/pve/firewall/<VMID>.fw`

A single node still uses all three levels - "cluster" here just means the datacenter-wide layer; it
applies even with one node. The node name is your hostname (check with `hostname` or
`ls /etc/pve/nodes/`).

Section types available per level:

- `cluster.fw`: `[OPTIONS]`, `[RULES]`, `[IPSET <name>]`, `[GROUP <name>]` (security groups, defined
  ONLY here), `[ALIASES]`.
- `host.fw`: `[OPTIONS]`, `[RULES]`.
- `<VMID>.fw`: `[OPTIONS]`, `[RULES]`, `[IPSET <name>]`, `[ALIASES]`.

## The two master switches and default-deny behavior

There are two independent enable switches; BOTH must be on for traffic to a given object to actually
be filtered.

1. Cluster master switch - in `cluster.fw [OPTIONS]`: `enable: 1`. Default is `0` (the whole
   firewall is OFF datacenter-wide). Setting `0` here disables the firewall everywhere regardless of
   other files.

2. Per-object switch:

- Host: `host.fw [OPTIONS] enable:` - **default is `1`**. So once you turn on the cluster switch,
  the host firewall is automatically active. This is the main lockout risk for a remote shell user
  (see checklist).
- Guest: `<VMID>.fw [OPTIONS] enable:` - default `0`; each VM/CT must be enabled individually.
  (Note: a VM also needs `firewall=1` on its NIC, e.g. `qm set <id> -net0 ...,firewall=1`, for guest
  rules to take effect.)

Default policies once enabled:

- `policy_in: DROP` (default) - inbound to the object is **dropped** unless a rule or an automatic
  allow permits it. Default-deny inbound.
- `policy_out: ACCEPT` (default) - outbound is **allowed** unless you restrict it. Allow-outbound.
- `policy_forward: ACCEPT` (default) for cluster/host forwarded traffic.

Even with `policy_in: DROP`, the firewall AUTOMATICALLY allows (so you are not instantly locked out
at the host level):

- loopback traffic, already-established/related connections, IGMP;
- from "management" hosts: TCP 8006 (web UI), TCP 5900-5999 (VNC console), TCP 3128 (SPICE proxy),
  TCP 22 (SSH);
- corosync/cluster traffic on the local cluster network.

CRITICAL nuance - current Proxmox docs say the firewall supports IPv4 and IPv6, and that the
standard `management` IPSET is used for normal management access to the host. Still, do not rely on
implicit or auto-detected management access as your only protection on a remote headless host.
Always add an explicit rule for your real control-station address, and if it is IPv6, test a fresh
IPv6 SSH session before closing your recovery shell.

## Full example config file contents

### cluster.fw (datacenter level)

```ini
# /etc/pve/firewall/cluster.fw

[OPTIONS]
enable: 1
policy_in: DROP
policy_out: ACCEPT
log_ratelimit: enable=1,rate=10/second,burst=50

[ALIASES]
# Override auto-detected local network on a single public-IP host (see gotchas)
local_network 203.0.113.10 # the host's own single IP

[IPSET management]
# Your control station(s) - allowed to reach 8006/22/5900-5999/3128
198.51.100.5
198.51.100.0/24

[IPSET blacklist]
10.66.0.0/16

[GROUP webserver] # a reusable security group
IN HTTP(ACCEPT)
IN HTTPS(ACCEPT)

[RULES]
IN SSH(ACCEPT) -source +management -log nolog # SSH from management IPSET
IN DROP -source +blacklist # drop blacklisted sources
```

Notes:

- `+name` references an IPSET; a bare word references an ALIAS.
- `SSH`, `HTTP`, `HTTPS` are built-in macros (predefined service/port sets).
- `GROUP` (security group) is a named bundle of rules defined only in `cluster.fw`; you apply it
  elsewhere with `GROUP <name>` in a `[RULES]` section.
- The local cluster network is auto-added to the `management` IPSET as alias `cluster_network`.

### host.fw (node level)

```ini
# /etc/pve/nodes/<nodename>/host.fw

[OPTIONS]
enable: 1
nftables: 0 # 0 = legacy iptables backend (default). 1 = nftables (opt-in)
log_level_in: info
protection_synflood: 1
nosmurfs: 1
tcpflags: 1

[RULES]
GROUP webserver # apply a security group
IN SSH(ACCEPT) -source +management # belt-and-braces SSH allow
IN ACCEPT -p tcp -dport 8006 -source +management # web UI explicitly
```

Host-level `[OPTIONS]` of interest (defaults in parentheses): `enable` (1), `nftables` (0), `ndp`
(1), `log_nf_conntrack` (0), `nf_conntrack_max` (262144), `protection_synflood` (0),
`protection_synflood_rate` (200), `protection_synflood_burst` (1000), `nosmurfs`, `tcpflags` (0),
`tcp_flags_log_level`, `smurf_log_level`, `nf_conntrack_helpers` ("").

### \<VMID\>.fw (guest level)

```ini
# /etc/pve/firewall/<VMID>.fw

[OPTIONS]
enable: 1
policy_in: DROP
policy_out: ACCEPT
ipfilter: 1 # anti-IP-spoofing: restrict to the guest's configured IPs
macfilter: 1 # default on; restrict to the configured MAC

[ALIASES]
dbserver 10.10.0.50

[IPSET allowedclients]
10.10.0.0/24

[RULES]
IN SSH(ACCEPT) -source +allowedclients
IN ACCEPT -p tcp -dport 443
OUT ACCEPT -dest dbserver -p tcp -dport 5432
```

`ipfilter: 1` implicitly creates an `ipfilter-net<n>` IPSET per NIC containing the guest's
configured IPs (and MAC-derived IPv6 link-local), preventing the guest from spoofing other source
addresses.

### Rule syntax cheat-sheet (from the docs)

```text
[RULES]
IN SSH(ACCEPT) -i net0
IN SSH(ACCEPT) -i net0 -source 192.168.2.192 # single source IP
IN SSH(ACCEPT) -i net0 -source 10.0.0.1-10.0.0.10 # range
IN SSH(ACCEPT) -i net0 -source 10.0.0.1,10.0.0.2 # list
IN SSH(ACCEPT) -i net0 -source +mynetgroup # IPSET (leading +)
IN SSH(ACCEPT) -i net0 -source myserveralias # ALIAS (bare word)
|IN SSH(ACCEPT) -i net0 # leading | = disabled rule
IN DROP # drop all remaining inbound
OUT ACCEPT # accept all outbound
```

Direction is `IN`, `OUT`, or `GROUP <name>`. Action is `ACCEPT`, `DROP`, or `REJECT` (note: REJECT
is unavailable for guest traffic on the nftables backend - it drops instead).

## The nftables backend in PVE 9 (opt-in, technology preview)

Status: technology preview since PVE 8.2, introduced for general opt-in in PVE 9.0, improved in 9.1
(ipset atomicity fixes, EVPN support, legacy ipset/alias-name compatibility, overlapping-ipset
auto-merge). It is NOT the default and is not yet declared production-ready by Proxmox.

How to opt in (two steps, both required):

1. Install the package (it provides the Rust nftables service that takes over when enabled):

```bash
apt update
apt install proxmox-firewall
```

1. Per host, enable it in `host.fw`:

```ini
# /etc/pve/nodes/<nodename>/host.fw
[OPTIONS]
nftables: 1
```

Then restart guests so their interfaces are reconfigured under the new backend. The current PVE docs
explicitly require this after enabling or disabling `proxmox-firewall`. Check the nftables backend
with `systemctl status proxmox-firewall`; restart the active nftables backend with
`systemctl restart proxmox-firewall`, not `pve-firewall restart`.

Key reasons it matters / what differs from the legacy iptables backend:

- Same config files and format - `cluster.fw`, `host.fw`, `<VMID>.fw` are reused unchanged, so you
  can switch back and forth by toggling `nftables`.
- For Linux bridges, NO extra firewall bridges (`fwbrX`) are created (the legacy backend inserts
  `fwbr*`/`fwln*`/`fwpr*` veth plumbing per guest NIC). Guests on OVS bridges still get firewall
  bridges.
- REJECT is not possible for guest traffic - such rules drop instead.
- NDP / Router Advertisement options always generate rules regardless of policy; guest rules are
  evaluated even when a conntrack entry exists.
- It uses nftables tables instead of the legacy iptables/ipset view; inspect it with
  `nft list ruleset` and test both IPv4 and IPv6 management paths if you use both families.

Inspecting the live ruleset:

- Legacy iptables backend: `iptables-save` (and `ip6tables-save`, `ipset list`).
- nftables backend: `nft list ruleset` (everything lives in nftables tables; you will NOT see the
  rules via `iptables-save` when nftables is active).
- Debug the compiler directly:
  `PVE_LOG=trace /usr/libexec/proxmox/proxmox-firewall compile > firewall.json`

## The pve-firewall CLI (and previewing before you enable)

`pve-firewall` is the legacy-backend service controller and the tool you use to compile/preview and
to read the detected local network. Subcommands:

- `pve-firewall start` - start the firewall service / apply rules.
- `pve-firewall stop` - stop it and flush the PVE-generated rules.
- `pve-firewall restart` - reload after editing `.fw` files.
- `pve-firewall status` - show running state; it compiles and validates the current rules and
  reports problems (use this as a syntax check).
- `pve-firewall compile` - **compile the rules and print what WOULD be applied without applying
  them.** This is the safe preview: run it after editing your `.fw` files and BEFORE enabling, to
  confirm your SSH/8006 allows are present.
- `pve-firewall localnet` - print the auto-detected local network/IP and the `local_network` alias
  value. Run this first on a remote host to confirm the firewall considers your management subnet
  "local"; if your single public IP is not what you expect, override `local_network` in
  `cluster.fw [ALIASES]`.

`pve-firewall localnet` example intent: verify the detected management network matches where your
SSH session originates before flipping `enable: 1`.

## SAFE-ENABLE CHECKLIST (remote, shell-only, must not get locked out)

Do this in order on a single remote node:

1. Open a SECOND independent SSH session to the host and leave it connected the whole time. If you
   lock yourself out, this session is your lifeline; if you also have serial/IPMI console access,
   even better (a blind-friendly fallback is `pct enter <ctid>` from console, but the host itself
   you reach via serial).
2. Add your control-station IP to an IPSET in `cluster.fw`:

```ini
[IPSET management]
<your-control-station-IP-or-CIDR>
```

The `management` IPSET auto-creates the rules needed to reach 22/8006/etc. If you connect over IPv6,
also add an explicit SSH rule for that IPv6 address and verify a fresh IPv6 session before closing
your recovery shell. 3. Add explicit belt-and-braces rules so 22 and 8006 are unambiguously allowed
from your IP, e.g. in `cluster.fw [RULES]`:

```ini
IN SSH(ACCEPT) -source +management
IN ACCEPT -p tcp -dport 8006 -source +management
```

1. Run `pve-firewall localnet` and confirm the detected local network includes your management
   source. On a single host with one public IP, override:

```ini
[ALIASES]
local_network <your-host-public-IP>
```

1. PREVIEW before enabling: `pve-firewall compile`. Read the compiled output and confirm your SSH
   and 8006 ACCEPT rules appear and that nothing drops your source IP earlier. Also run
   `pve-firewall status` to catch syntax errors.
2. Only now set `enable: 1` in `cluster.fw [OPTIONS]`. Remember `host.fw` `enable` defaults to 1, so
   the host becomes protected immediately.
3. Apply on the default legacy backend: `pve-firewall restart` (or `start`).
4. RE-TEST from a THIRD/new connection: open a brand-new SSH session from your control station (do
   not reuse an established connection - established connections are auto-allowed and will mislead
   you). Confirm a fresh SSH handshake succeeds. Verify the live ruleset: `iptables-save` (or
   `nft list ruleset` if you opted into nftables).
5. Only after a NEW session connects cleanly, close the spare sessions.
6. If something is wrong and you still have a session: `pve-firewall stop` flushes the rules and
   restores access; then fix and re-preview.

For nftables specifically, get the iptables backend working and safe FIRST, then set `nftables: 1`
in `host.fw`, restart guests, check `systemctl status proxmox-firewall`, and re-run the same re-test
(step 8) using `nft list ruleset` to inspect.

## Per-guest firewall basics

- Enable per guest in `<VMID>.fw [OPTIONS] enable: 1` AND set the NIC firewall flag (`firewall=1` on
  the VM/CT net device).
- Default guest policy is also `policy_in: DROP` / `policy_out: ACCEPT` once enabled; define inbound
  ACCEPT rules for the services the guest offers.
- Use `ipfilter: 1` to stop the guest spoofing source IPs; `macfilter` is on by default.
- Guests can have their own `[IPSET]` and `[ALIASES]`; security `[GROUP]`s are defined in
  `cluster.fw` and applied in the guest's `[RULES]` via `GROUP <name>`.
- For containers you administer via `pct enter <ctid>` from the host; the guest firewall is still
  configured from the host side in `/etc/pve/firewall/`.

## Common lockout pitfalls

- Relying on implicit management access while connecting over IPv6 - add an explicit IPv6 SSH rule
  and test from a brand-new session.
- Testing only over an already-established SSH session (auto-allowed as "established/related") and
  concluding you are fine - always test a NEW connection.
- Forgetting that `host.fw enable` defaults to 1: flipping the cluster switch alone activates host
  filtering immediately.
- `pve-firewall localnet` not matching your real management subnet on a single public-IP host -
  override `local_network` in `[ALIASES]`.
- Mixing backends: if you set `nftables: 1` but inspect with `iptables-save` you will see
  little/nothing - use `nft list ruleset`. Conversely, hand-rolled nftables/iptables rules outside
  PVE can conflict with the PVE chains.
- Editing `.fw` on the legacy backend but not running `pve-firewall restart` (or not previewing with
  `pve-firewall compile` first to catch a syntax error that leaves rules in an unexpected state).
  When `nftables: 1` is active, verify and control `proxmox-firewall` through systemd instead.
- `policy_out: DROP` set without outbound allows can break SSH return traffic / package updates;
  keep outbound ACCEPT unless you have a clear reason.

## Citations

- Proxmox VE Firewall chapter (official docs):
  [Proxmox VE Firewall](https://pve.proxmox.com/pve-docs/chapter-pve-firewall.html)
- pve-firewall(8) man page (CLI subcommands, localnet, enable):
  [pve-firewall(8)](https://pve.proxmox.com/pve-docs/pve-firewall.8.html)
- Proxmox VE Admin Guide (firewall section, rule examples, local_network):
  [Proxmox VE Administration Guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.html)
- Proxmox VE Wiki, Firewall: [Firewall](https://pve.proxmox.com/wiki/Firewall)
- Proxmox VE Roadmap / release notes (nftables tech-preview status, 9.0/9.1):
  [Roadmap](https://pve.proxmox.com/wiki/Roadmap)
- proxmox-firewall (nftables backend, Rust) source repo:
  [GitHub - proxmox/proxmox-firewall: nftables based implementation of the Proxmox VE firewall, written in rust](https://github.com/proxmox/proxmox-firewall)
