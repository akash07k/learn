# Firewall

## What you'll be able to do

By the end of this guide you will be able to turn on the Proxmox firewall on a remote, headless,
single node without ever locking yourself out of SSH. You will understand the three configuration
levels and their `.fw` files, the two master switches and the default-deny behaviour, the management
allow-list trap, the rule, IPSET, alias, and security-group syntax, and a complete safe-enable
checklist built around a second SSH session and `pve-firewall compile`. You will also be able to
filter individual guests, and to opt into the nftables backend as an explicit choice rather than a
default.

## Read this first: the lockout risk

This is the most dangerous guide in the corpus. Enabling the firewall on a remote, headless, single
node can cut off your SSH connection, and there is no local screen to recover from. The host
firewall becomes active the moment the datacenter switch turns on (the per-host switch defaults to
on, the trap explained below), so an enable is a real lockout event, not a quiet one. Before you
touch anything, set up your lifeline and treat these as non-negotiable:

- Keep a second, independent SSH session open to the host the whole time. If the change you make in
  one session drops that session, the second one is still live to undo it with `pve-firewall stop`.
- Do not count on a guest console as the way back in. The `qm terminal` and `pct enter` consoles
  from guide [04 -- Talking to guests without a GUI](04-talking-to-guests-without-a-gui.md) reach
  guests and are run from a working host shell, so they cannot help when host SSH is gone. If SSH is
  cut entirely, the real fallbacks are the second SSH session above (run `pve-firewall stop` from
  it) and, as a physical last resort, booting the Proxmox installer ISO in Rescue Boot to reach a
  local root shell and stop the firewall. A host serial console (guide
  [03 -- Repositories, updates, and the host](03-repositories-updates-and-the-host.md)) helps only
  if the node actually has a serial port or IPMI Serial-over-LAN that you wired up beforehand.
- Always preview with `pve-firewall compile` before you enable. This compiles your rules and prints
  what would apply without applying anything, so you can confirm your SSH allow is present before it
  can hurt you.
- Always test from a brand-new SSH connection, never an already-established one. An established
  connection is auto-allowed as "related/established" and will keep working even when new
  connections are being dropped, so it will lie to you about whether you are safe.

One more thread that runs through the whole corpus: keep an independent copy of your control
station's public key in `~/.ssh/authorized_keys2` (a real file on the root disk, outside
`/etc/pve`), as covered in guide [02 -- The shell and the API](02-the-shell-and-the-api.md), so
key-based login still works even if pmxcfs is down; and remember the true last resort if the
firewall ever shuts you out completely is physical access to the box: boot the Proxmox installer ISO
in Rescue Boot to reach a local root shell and run `pve-firewall stop`.

## Before you start

Some of what follows is specific to Proxmox VE 9, so confirm your version first:

```bash
pveversion
```

You should see a `9.x` release. You do this work over SSH as root on the Proxmox host.

The accuracy point that governs this whole guide: in Proxmox VE 9 the firewall is iptables-based by
default. The classic [pve-firewall](GLOSSARY.md) service compiles your rules into iptables and
ipset, and it is the shipped, supported, default backend. The
[nftables backend (opt-in)](GLOSSARY.md) (the Rust `proxmox-firewall`) is a technology preview that
you must turn on deliberately, by installing a package and setting `nftables: 1`. It is not the
default, and the rest of this guide assumes the iptables backend unless a section says otherwise.
The opt-in steps are in "The nftables backend" near the end.

The `.fw` rule files live on [pmxcfs (/etc/pve)](GLOSSARY.md), the database-backed cluster
filesystem mounted at `/etc/pve`. They are plain text, but pmxcfs is not an ordinary directory, so
edit these files with care and always with the accessible, non-interactive shell form (a here-doc,
`tee`, `sed`, or appending a block), never a terminal editor like vim or nano. The full menu,
including VS Code Remote-SSH, is in the "Editing files accessibly" section of guide
[02 -- The shell and the API](02-the-shell-and-the-api.md). Where a dedicated CLI exists, prefer it;
the `.fw` files have no single CLI of their own and are commonly hand-edited, so this guide shows
the accessible non-interactive form for every edit.

## The three levels and their files

The firewall is configured by plain-text, INI-style files at three levels. All three exist and apply
even on a single node:

- Datacenter or cluster-wide: `/etc/pve/firewall/cluster.fw`. "Cluster" here just means the
  datacenter-wide layer; it applies even with one node.
- The host or node: `/etc/pve/nodes/<nodename>/host.fw`. The node name is your hostname. Find it
  with `hostname`, or list the directory with `ls /etc/pve/nodes/`.
- Per guest, by VMID: `/etc/pve/firewall/<VMID>.fw`, one file per VM or container.

Each level allows a different set of section types:

- `cluster.fw` allows `[OPTIONS]`, `[RULES]`, `[IPSET <name>]`, `[GROUP <name>]`, and `[ALIASES]`. A
  security group (`[GROUP <name>]`) is defined only here.
- `host.fw` allows `[OPTIONS]` and `[RULES]`.
- `<VMID>.fw` allows `[OPTIONS]`, `[RULES]`, `[IPSET <name>]`, and `[ALIASES]`.

## The two master switches and default-deny

There are two independent enable switches, and both must be on for traffic to a given object to
actually be filtered.

The cluster master switch lives in `cluster.fw [OPTIONS]` as `enable: 1`. Its default is `0`,
meaning the whole firewall is off datacenter-wide. Setting it back to `0` disables the firewall
everywhere, regardless of any other file.

The per-object switch is the second one, and it behaves differently for the host and for guests:

- Host: `host.fw [OPTIONS] enable:` defaults to `1`. This is the key trap. Because the host switch
  is already on by default, flipping the cluster switch to `1` activates host filtering immediately.
  You do not get a second chance to enable the host firewall separately; it is on the moment the
  cluster switch goes on.
- Guest: `<VMID>.fw [OPTIONS] enable:` defaults to `0`, so each VM or container must be enabled
  individually. A VM also needs `firewall=1` on its NIC (for example
  `qm set <id> -net0 ...,firewall=1`) before guest rules take effect.

Once the firewall is enabled, the default policies are:

- `policy_in: DROP` (the default): inbound traffic to the object is dropped unless a rule or an
  automatic allow permits it. This is default-deny inbound.
- `policy_out: ACCEPT` (the default): outbound traffic is allowed unless you restrict it.
- `policy_forward: ACCEPT` (the default) for forwarded traffic at the cluster and host levels.

Even with `policy_in: DROP`, the firewall automatically allows some traffic so you are not instantly
cut off at the host level:

- loopback traffic, already-established and related connections, and IGMP;
- from "management" hosts: TCP 22 (SSH), TCP 8006 (the management API), TCP 5900-5999 (the VNC
  console range), and TCP 3128 (the SPICE proxy);
- corosync and cluster traffic on the local cluster network.

The management auto-allow is the safety net that is supposed to keep SSH working through an enable,
but it has a sharp edge, which is the next section.

## The Management Allow-List Trap

Proxmox's current firewall docs say IPv4 and IPv6 are both supported, and that adding remote
administration addresses to the standard `management` IPSET creates the required access rules for
SSH, the API, VNC, and SPICE. The lockout risk is not that IPv6 is unsupported; it is that a remote,
headless host should never rely on an implicit or auto-detected management set as its only proof of
access.

So add both the `management` IPSET entry and an explicit rule for the real address your control
station uses. If you connect over IPv6, write the IPv6 address explicitly in `[IPSET management]`
and in `[RULES]`, then confirm the compiled rules before enabling. Concretely, in
`/etc/pve/firewall/cluster.fw` (IPv6 shown):

```text
[IPSET management]
2001:db8::5

[RULES]
IN SSH(ACCEPT) -source 2001:db8::5
```

`2001:db8::5` is only an example from the documentation IPv6 range; substitute your real
control-station IPv6 address (the address your SSH client connects from, which you can confirm with
`who` or `ss -tn`). The rule is deliberately redundant with the standard management IPSET:
redundancy is the point before enabling a lockout-capable firewall on a headless host.

## Rule, IPSET, alias, and security-group syntax

A rule line starts with a direction, then an action and optional matchers. The direction is `IN`,
`OUT`, or `GROUP <name>`. The action is `ACCEPT`, `DROP`, or `REJECT`. Note that `REJECT` is
unavailable for guest traffic on the nftables backend, where such rules drop instead.

The `-source` matcher accepts several forms, and three of them lean on named objects:

- a single IP, for example `-source 192.168.2.192`;
- a range, for example `-source 10.0.0.1-10.0.0.10`;
- a comma-separated list, for example `-source 10.0.0.1,10.0.0.2`;
- an [IPSET](GLOSSARY.md) by name with a leading `+`, for example `-source +management`;
- an alias by bare word, for example `-source myserveralias`.

A leading `|` on a rule line disables that rule without deleting it. Built-in macros name a service
and its ports, so `SSH`, `HTTP`, and `HTTPS` expand to the right ports for you. The three named
objects, as defined in [GLOSSARY.md](GLOSSARY.md): an IPSET is a named set of addresses or CIDR
ranges referenced with a leading `+`; an alias is a bare-word name for a single address or network;
and a [security group](GLOSSARY.md) is a reusable named bundle of rules defined only in `cluster.fw`
and applied elsewhere with `GROUP <name>`.

Here is a small `cluster.fw` putting these together: an `[IPSET management]` for your control
station, a reusable `[GROUP webserver]`, and a `[RULES]` section. State the full path in prose, then
write the block.

File `/etc/pve/firewall/cluster.fw`:

```ini
[OPTIONS]
enable: 1
policy_in: DROP
policy_out: ACCEPT

[ALIASES]
local_network 203.0.113.10

[IPSET management]
198.51.100.5
198.51.100.0/24

[GROUP webserver]
IN HTTP(ACCEPT)
IN HTTPS(ACCEPT)

[RULES]
IN SSH(ACCEPT) -source +management
IN ACCEPT -p tcp -dport 8006 -source +management
```

In that file, `+management` references the IPSET, the bare word `local_network` is an alias, `SSH`,
`HTTP`, and `HTTPS` are built-in macros, and `webserver` is a security group you can attach to a
guest later with `GROUP webserver`. The local cluster network is auto-added to the `management`
IPSET as the alias `cluster_network`.

## The pve-firewall CLI

`pve-firewall` is the legacy-backend service controller and the tool you use to read the detected
local network and to preview before you enable. Its subcommands:

- `pve-firewall localnet` prints the auto-detected local network and IP, the value behind the
  `local_network` alias. Run this first on a remote host to confirm the firewall considers your
  management subnet "local". If your single public IP is not what you expect, override
  `local_network` in `cluster.fw [ALIASES]`.
- `pve-firewall compile` compiles the rules and prints what would be applied, without applying them.
  This is the safe preview. Run it after editing your `.fw` files and before enabling, and read the
  output to confirm your SSH and 8006 ACCEPT rules appear and that nothing drops your source IP
  earlier.
- `pve-firewall status` shows the running state; it compiles and validates the current rules and
  reports problems, so use it as a syntax check.
- `pve-firewall start` starts the firewall service and applies the rules; `pve-firewall restart`
  reloads after you edit a `.fw` file; and `pve-firewall stop` stops the service and flushes the
  PVE-generated rules, which restores access. That `stop` behaviour is your recovery lever if an
  enable goes wrong while you still have a session.

Together, `pve-firewall compile` and `pve-firewall status` are how you confirm your SSH and 8006
allows are present and correct before you ever set `enable: 1`.

## The SAFE-ENABLE checklist

Do this in order, on a single remote node, with your second SSH session already open. Every `.fw`
edit below uses the accessible, non-interactive shell form. These steps assume a fresh `cluster.fw`
and are meant to be run once: each step appends a section, so re-running them after a recovery
accumulates duplicate `[OPTIONS]`, `[IPSET]`, and `[RULES]` sections and conflicting `enable:`
lines. Same-named sections merge harmlessly, but a second `enable:` line is a real conflict, so on a
retry first inspect the file (`grep -n '^\[' /etc/pve/firewall/cluster.fw` and read it back) and
delete any duplicate sections before relying on the step-6 compile preview.

- **Step 1:** Open a second, independent SSH session to the host and leave it connected the whole
  time. If you lock yourself out, this session is your lifeline (and your physical last resort is
  the Proxmox installer ISO in Rescue Boot, as noted above).

- **Step 2:** Assemble `cluster.fw` fully configured but still OFF, then add your control-station IP
  (or CIDR) to the `[IPSET management]`. Write the `[OPTIONS]` block first, with `enable: 0`, so the
  file is complete-but-disabled and step 7 has a real `enable:` line to flip. The `management` IPSET
  auto-creates the rules needed to reach 22, 8006, and the rest. Append the blocks accessibly:

```bash
printf '%s\n' '' '[OPTIONS]' 'enable: 0' 'policy_in: DROP' 'policy_out: ACCEPT' '' '[IPSET management]' '198.51.100.5' >> /etc/pve/firewall/cluster.fw
```

Replace `198.51.100.5` with your real control-station address. Keep `enable: 0` for now; you flip it
to `1` only in step 7, after the preview is clean.

- **Step 3:** If you reach the host over IPv6, add both the IPSET entry and an explicit SSH rule for
  that IPv6 address before enabling. Do not trust an already-established session as proof that new
  IPv6 SSH connections will work; compile the rules and open a brand-new session. File
  `/etc/pve/firewall/cluster.fw` (add your control station, IPv6 shown):

```text
[IPSET management]
2001:db8::5

[RULES]
IN SSH(ACCEPT) -source 2001:db8::5
```

`2001:db8::5` is only an example from the documentation IPv6 range; substitute your real
control-station IPv6 address (the one your SSH client connects from, which you can confirm with
`who` or `ss -tn` while connected). Append it accessibly the same way:

```bash
printf '%s\n' '' '[IPSET management]' '2001:db8::5' '' '[RULES]' 'IN SSH(ACCEPT) -source 2001:db8::5' >> /etc/pve/firewall/cluster.fw
```

This adds a second `[IPSET management]` and a second `[RULES]` section to the file (step 2 wrote the
first IPSET, and step 3 adds another `[RULES]`). That is fine: the parser merges repeated same-named
sections, so duplicate `[IPSET management]` and `[RULES]` headers are harmless and the entries
simply accumulate under one logical section.

- **Step 4:** Add belt-and-braces explicit `ACCEPT` rules for SSH and 8006 from `+management`, so
  those ports are unambiguously allowed from your IP:

```bash
printf '%s\n' '' '[RULES]' 'IN SSH(ACCEPT) -source +management' 'IN ACCEPT -p tcp -dport 8006 -source +management' >> /etc/pve/firewall/cluster.fw
```

- **Step 5:** Run `pve-firewall localnet` and confirm the detected local network includes your
  management source:

```bash
pve-firewall localnet
```

On a single host with one public IP, override the alias if the detected value is not what you
expect:

```bash
printf '%s\n' '' '[ALIASES]' 'local_network 203.0.113.10' >> /etc/pve/firewall/cluster.fw
```

Replace `203.0.113.10` with your host's own IP.

- **Step 6:** PREVIEW before enabling. Compile the rules and read the output, then run the
  validating status check:

```bash
pve-firewall compile
pve-firewall status
grep -n '^\[' /etc/pve/firewall/cluster.fw
```

Confirm your SSH and 8006 ACCEPT rules appear in the compiled output and that nothing drops your
source IP earlier. `pve-firewall status` catches syntax errors. The `grep -n '^\['` read-back lists
every section header with its line number, so you can see the sections you appended (it is normal to
see `[IPSET management]` and `[RULES]` more than once, since the parser merges repeated same-named
sections). Do not proceed until both are clean and your allows are visible.

- **Step 7:** Only now set the cluster master switch. Edit `cluster.fw [OPTIONS]` to `enable: 1`.
  Remember that `host.fw enable` defaults to `1`, so the host becomes protected the instant you do
  this:

```bash
sed -i 's/^enable: 0/enable: 1/' /etc/pve/firewall/cluster.fw
```

Then confirm the flip actually happened before you apply anything. The `sed` exits `0` and prints
nothing even when it matched no line, so verify by reading the result back:

```bash
grep -n '^enable:' /etc/pve/firewall/cluster.fw # must show: enable: 1
```

This must show `enable: 1`. If it still shows `enable: 0`, or shows nothing at all (no `enable:`
line was written under `[OPTIONS]` in step 2), the cluster switch did NOT flip and the firewall is
still off - do not be fooled into thinking it is on. Set `enable: 1` under `[OPTIONS]` accessibly
(re-run the `sed`, or append an `[OPTIONS]` block with `enable: 1` via here-doc/`tee`), then run the
`grep` again and confirm it reads `enable: 1` BEFORE you run `pve-firewall restart` in the next
step.

- **Step 8:** Apply the rules:

```bash
pve-firewall restart
```

- **Step 9:** RE-TEST from a brand-new SSH session. Open a fresh connection from your control
  station; do not reuse an established one, because established connections are auto-allowed and
  will mislead you. Confirm the new SSH handshake succeeds. Then inspect the live ruleset. A full
  `iptables-save` dump is hard to scan by ear, so narrow it to the rules that matter - the SSH and
  8006 ACCEPT rules and the `management` set - so the confirmation is a short, linear result:

```bash
iptables-save | grep -E 'dport (22|8006)|management'
```

You should see ACCEPT rules for ports 22 and 8006 and references to the `management` set; run a bare
`iptables-save` if you want the whole picture. (If you have opted into nftables, inspect with
`nft list ruleset | grep -E '22|8006|management'` instead; see the nftables section.)

- **Step 10:** Only after a new session connects cleanly, close the spare sessions.

- **Step 11:** If anything is wrong and you still have a session, flush the rules to restore access,
  then fix and re-preview:

```bash
pve-firewall stop
```

`pve-firewall stop` flushes the PVE-generated rules, so access comes back. Fix the `.fw` files, run
`pve-firewall compile` again, and only re-enable once the preview is clean.

## Per-guest firewall basics

Filtering a guest takes two switches of its own, mirroring the host. First, enable the guest
firewall in `<VMID>.fw [OPTIONS] enable: 1`. Second, set the NIC firewall flag, `firewall=1`, on the
guest's net device (for example `qm set <id> -net0 ...,firewall=1` for a VM, or the `firewall=1` key
in a `pct set ... -net0 ...` string for a container). Both are required for guest rules to take
effect.

The guest default policy, once enabled, is also `policy_in: DROP` and `policy_out: ACCEPT`, so
define inbound `ACCEPT` rules for the services the guest actually offers. Two anti-spoofing options
are worth knowing: `ipfilter: 1` restricts the guest to its configured IPs (it implicitly builds an
`ipfilter-net<n>` IPSET per NIC), and `macfilter` restricts it to its configured MAC and is on by
default. A guest can carry its own `[IPSET]` and `[ALIASES]`; security groups are still defined in
`cluster.fw` and attached here with `GROUP <name>`.

For containers, you administer the inside via `pct enter <ctid>` from the host, but you configure
the guest firewall from the host side in `/etc/pve/firewall/<VMID>.fw`, the same as for a VM.

A short guest example. File `/etc/pve/firewall/<VMID>.fw`:

```ini
[OPTIONS]
enable: 1
policy_in: DROP
policy_out: ACCEPT
ipfilter: 1
macfilter: 1

[RULES]
GROUP webserver
IN SSH(ACCEPT) -source +management
IN ACCEPT -p tcp -dport 443
```

Write or edit this file with the accessible, non-interactive form, the same here-doc or `tee`
approach used in the checklist above, never a terminal editor.

## The nftables backend (opt-in, technology preview)

The nftables backend is explicitly not the default. It is a technology preview (a preview since PVE
8.2, opened for general opt-in in 9.0, improved in 9.1) and is not yet declared production-ready by
Proxmox. Turn it on only after the iptables backend is working and safe.

Opting in takes two steps, both required. First, install the package, which provides the Rust
nftables service that takes over after you set the host option:

```bash
apt update
apt install proxmox-firewall
```

Second, enable it per host by setting `nftables: 1` in `host.fw [OPTIONS]`. The parser merges
repeated same-named sections, so appending an `[OPTIONS]` block is safe even when `host.fw` already
has one -- only a duplicate of the same key (not a duplicate header) conflicts, so just make sure
`nftables:` is not already set elsewhere in the file. State the path, then append accessibly. File
`/etc/pve/nodes/<nodename>/host.fw`:

```bash
cat >> /etc/pve/nodes/$(hostname)/host.fw <<'EOF'

[OPTIONS]
nftables: 1
EOF
```

After setting the option, restart every running VM and container whose interfaces should be filtered
by the new backend; the Proxmox docs call this out because the old and new backend set up guest
interfaces differently. Then check the new service, not the legacy command:

```bash
systemctl status proxmox-firewall
```

Use `systemctl restart proxmox-firewall` if you need to restart the nftables service while this
backend is active. `pve-firewall restart` is the legacy iptables-backend reload command; do not use
it as proof that the nftables backend is live.

What differs from the legacy iptables backend:

- The same config files and format are reused unchanged. `cluster.fw`, `host.fw`, and `<VMID>.fw`
  work either way, so you can switch back and forth by toggling `nftables`.
- On Linux bridges, no extra firewall bridges (`fwbr*`/`fwln*`/`fwpr*` veth plumbing) are created
  per guest NIC. (Guests on OVS bridges still get firewall bridges.)
- `REJECT` becomes `DROP` for guest traffic.
- It uses nftables tables instead of the legacy iptables/ipset view; inspect it with
  `nft list ruleset` and test both IPv4 and IPv6 management paths if you use both families.

Critically, inspect the live ruleset with `nft list ruleset` when nftables is active:

```bash
nft list ruleset
```

Do not use `iptables-save` to check an nftables setup; everything lives in nftables tables and
`iptables-save` will show little or nothing while nftables is active.

The safe order is the one that matters most: get the iptables backend working and verified safe
first, using the full SAFE-ENABLE checklist above, and only then opt into nftables. After opting in,
re-run the re-test (step 9 of the checklist) from a brand-new SSH session, this time inspecting with
`nft list ruleset`.

Rollback is just as explicit. If the nftables backend behaves badly and you still have a shell, turn
the host option off, restart the nftables service, restart the guests whose interfaces were moved to
the new backend, and verify with the legacy view again:

```bash
sed -i 's/^nftables: 1$/nftables: 0/' /etc/pve/nodes/$(hostname)/host.fw
systemctl restart proxmox-firewall
# restart affected guests after a backend change, then verify the legacy backend view:
iptables-save | grep -E 'dport (22|8006)|management'
```

If `host.fw` has multiple `[OPTIONS]` blocks or no `nftables:` line, edit the file accessibly and
make the single effective value `nftables: 0`; then re-test from a brand-new SSH session before
closing your spare one.

## Common lockout pitfalls

A short list of the ways this goes wrong, drawn straight from the research:

- Relying on implicit management access while connecting over IPv6. Add an explicit IPv6 SSH rule
  and test a brand-new IPv6 session.
- Testing only over an already-established SSH session, which is auto-allowed as
  related/established, and concluding you are fine. Always test a new connection.
- Forgetting that `host.fw enable` defaults to `1`, so flipping the cluster switch alone activates
  host filtering immediately.
- `pve-firewall localnet` not matching your real management subnet on a single public-IP host.
  Override `local_network` in `[ALIASES]`.
- Mixing backends: setting `nftables: 1` but inspecting with `iptables-save` (you will see little or
  nothing). Use `nft list ruleset` for nftables. Hand-rolled iptables or nftables rules outside PVE
  can also conflict with the PVE chains.
- Editing a `.fw` file but not running `pve-firewall restart`, or not previewing with
  `pve-firewall compile` first to catch a syntax error.
- Setting `policy_out: DROP` without outbound allows, which can break SSH return traffic and package
  updates. Keep outbound `ACCEPT` unless you have a clear reason not to.

## Verify it worked

The real proof is a successful brand-new SSH connection, not an existing session. From your control
station, open a fresh SSH session to the host and confirm the handshake succeeds; an already-open
session would keep working even if new connections were being dropped, so it proves nothing.

Then confirm from the shell:

```bash
pve-firewall status
iptables-save | grep -E 'dport (22|8006)|management'
pve-firewall localnet
```

`pve-firewall status` should report the firewall running with no errors. The narrowed
`iptables-save | grep -E 'dport (22|8006)|management'` should show your SSH and 8006 `ACCEPT` rules
and the `management` set as a short result rather than a wall of chains; run a bare `iptables-save`
if you want the full ruleset (use `nft list ruleset | grep -E '22|8006|management'` instead if you
have opted into the nftables backend). `pve-firewall localnet` should report a local network that
matches your management subnet.

## Sources

- `research/round2-pve9/13-pve9-firewall-nftables.md` - the authoritative source for this entire
  guide: the iptables-default and nftables-opt-in accuracy note; the three configuration levels and
  their files (`cluster.fw`, `host.fw` at `/etc/pve/nodes/<nodename>/host.fw`, `<VMID>.fw`) and the
  section types allowed at each; the two master switches with `cluster.fw enable` defaulting to `0`
  and `host.fw enable` defaulting to `1`, plus guest `enable` defaulting to `0` and the NIC
  `firewall=1` requirement; the default policies (`policy_in: DROP`, `policy_out: ACCEPT`,
  `policy_forward: ACCEPT`) and the automatic allows for loopback, established/related, and
  management hosts on 22/8006/5900-5999/3128; the management allow-list trap; the rule, IPSET,
  alias, and security-group syntax (direction, actions including REJECT-drops-on-nftables, the
  `-source` forms, the leading `|` disable, and the `SSH`/`HTTP`/`HTTPS` macros) with the example
  `cluster.fw`; the `pve-firewall` subcommands (`localnet`, `compile`, `status`,
  `start`/`stop`/`restart`); the full SAFE-ENABLE checklist; the per-guest basics (`enable: 1` plus
  NIC `firewall=1`, `ipfilter`/`macfilter`, security groups via `GROUP`, containers configured
  host-side); the nftables opt-in steps (`apt install proxmox-firewall`, `nftables: 1`, restart
  guests, reload), what differs, and `nft list ruleset` inspection; and the common-lockout-pitfalls
  list.
- `GLOSSARY.md` - the canonical definitions reused here of [pve-firewall](GLOSSARY.md), the
  [nftables backend (opt-in)](GLOSSARY.md), [IPSET](GLOSSARY.md), [security group](GLOSSARY.md), and
  [pmxcfs (/etc/pve)](GLOSSARY.md), plus the role names (the Proxmox host, the control station, the
  guest).
- Proxmox VE documentation:
  [the Proxmox VE Firewall chapter](https://pve.proxmox.com/pve-docs/chapter-pve-firewall.html) (the
  configuration levels and files, section types, the two enable switches and default policies, the
  management auto-allow, and the rule, IPSET, alias, and security-group syntax);
  [the pve-firewall(8) man page](https://pve.proxmox.com/pve-docs/pve-firewall.8.html) (the
  `localnet`, `compile`, `status`, and `start`/`stop`/`restart` subcommands); and
  [the Proxmox VE Admin Guide firewall section](https://pve.proxmox.com/pve-docs/pve-admin-guide.html)
  (rule examples and `local_network`).
- [the Proxmox VE Firewall wiki](https://pve.proxmox.com/wiki/Firewall) - background on the firewall
  model and configuration.
- [the proxmox-firewall source repository](https://github.com/proxmox/proxmox-firewall) - the
  nftables backend (the Rust `proxmox-firewall`), its opt-in nature, and the IPv4-and-IPv6
  management sets.

---

Previous: [10 -- Networking](10-networking.md) | Next: [12 -- Remote access](12-remote-access.md)
