# Cheatsheet: networking and firewall

This card covers two related areas on the Proxmox host: host networking (ifupdown2 plus the `vmbr0`
bridge) and the Proxmox firewall (`pve-firewall`; legacy iptables backend by default, with an
optional nftables preview). It is a reminder for after you have learned the concepts in
[10 -- Networking](../10-networking.md) and [11 -- Firewall](../11-firewall.md), not a lesson.
Everything here is plain text you run as root on the host over SSH; no web GUI. Safety lead: a wrong
network or firewall change can lock you out of SSH, and a headless host has no local screen, so
always have a way back in (a second SSH session, the serial console, a known-good snapshot) and test
before you commit.

## Inspect networking (read-only)

- `ip -br link` -- one line per interface: name, state, MAC (how you find or confirm your NIC name;
  reads cleaner than `ip link`).
- `ip -br addr` -- addresses per interface (confirm the management IP sits on `vmbr0`); `ip a` /
  `ip addr` is the long form.
- `ip route` -- the routing table and default gateway.
- `cat /etc/network/interfaces` -- the entire host network config lives in this one file.
- `bridge link` -- which ports belong to which bridge.
- `bridge vlan show` -- VLAN membership per bridge port (confirm a VLAN-aware setup).
- `hostname --ip-address` -- must return the non-loopback management IP (the pmxcfs rule).

## Apply network config (ifupdown2)

The config file is `/etc/network/interfaces`; edit it with an accessible non-interactive form
(here-doc, `tee`, `sed -i`), never a terminal editor.

- `ifreload -a -n` -- DRY RUN: validates the config and shows what would change without touching the
  live network. ALWAYS run this first.
- `ifreload -a` -- apply changes live, no reboot; brings up/down/reconfigures only what changed.
- `ifup <iface>` / `ifdown <iface>` -- bring a single interface up or down (do not use these to
  reconfigure a bridge; `ifreload` reconciles the full config graph).

The SSH-drop caution: `ifreload -a -n` checks syntax only. A whole-file change with a
valid-but-wrong gateway or IP passes the dry run cleanly and then `ifreload -a` still drops your
SSH. Keep a second session open and watch it after the real reload. See guide 10.

## Pin NIC names (trixie rename gotcha)

A kernel upgrade can rename a NIC, so `vmbr0`'s `bridge-ports` line points at an interface that no
longer exists and the host comes up with no network. Pin names proactively.

- `pve-network-interface-pinning generate` -- pin all physical NICs to stable `nicX` names (writes
  systemd `.link` files; reboot required to take effect).
- `pve-network-interface-pinning generate --interface enp1s0` -- pin a single NIC.
- `pve-network-interface-pinning generate --interface enp1s0 --target-name if42` -- pin one NIC to a
  chosen name.

After the reboot, confirm `vmbr0`'s `bridge-ports` still matches the pinned name with `ip -br link`.
See guide 10.

## Firewall config files (.fw)

The firewall is configured by plain-text, INI-style files at three levels; state the path before
editing one, and edit with an accessible non-interactive form. The `.fw` files live on pmxcfs
(`/etc/pve`).

- Datacenter-wide: `/etc/pve/firewall/cluster.fw`.
- Per node: `/etc/pve/nodes/<nodename>/host.fw` (the node name is your `hostname`).
- Per guest, by VMID: `/etc/pve/firewall/<vmid>.fw`.

THE ENABLE GOTCHA: the firewall does NOTHING until `enable: 1` is set in the `[OPTIONS]` section of
the relevant `.fw` file. The cluster switch (`cluster.fw [OPTIONS] enable:`) defaults to `0`;
editing rules while it is `0` is a silent no-op. Note the host switch (`host.fw [OPTIONS] enable:`)
defaults to `1`, so flipping the cluster switch to `1` activates host filtering immediately. Make
the cluster `enable` unmissable; verify with `grep -n '^enable:' /etc/pve/firewall/cluster.fw`.

## pve-firewall commands

- `pve-firewall localnet` -- print the auto-detected local network and IP (the `local_network`
  alias); run first on a remote host to confirm your management subnet is "local".
- `pve-firewall compile` -- compile the rules and PRINT what would apply WITHOUT applying. The safe
  preview: run it before enabling and confirm your SSH and 8006 ACCEPT rules appear and nothing
  drops your source IP earlier.
- `pve-firewall status` -- running state; compiles and validates current rules, so use it as a
  syntax check.
- `pve-firewall restart` -- reload after editing a `.fw` file.
- `pve-firewall start` -- start the service and apply the rules.
- `pve-firewall stop` -- stop the service and flush the PVE-generated rules (your recovery lever:
  restores access if an enable goes wrong while you still have a session).

THE IPv6 LOCKOUT caution: before you set `enable: 1`, make sure an explicit SSH ACCEPT rule covers
your management IP. If you reach the host over IPv6, add an explicit `[RULES]` line
`IN SSH(ACCEPT) -source <your-IPv6>` and confirm it with `pve-firewall compile`; never treat an
already-established SSH session as proof that new IPv6 connections will work. See guide 11 for the
exact rule form.

## Inspect the live firewall ruleset

- `iptables-save` -- the default-backend view on PVE 9, where legacy iptables is still the default;
  narrow it, e.g. `iptables-save | grep -E 'dport (22|8006)|management'`, to confirm your SSH and
  8006 ACCEPT rules and the `management` set.
- `nft list ruleset` -- the nftables backend's actual rules; use this only when you have opted in to
  the nftables technology preview.

Do not mix them: inspecting an nftables setup with `iptables-save` shows little or nothing. Use
`nft list ruleset` for nftables.

## Full treatment

This card is a reminder, not a lesson. For the why and the worked procedures, see:

- [10 -- Networking](../10-networking.md) -- the ifupdown2 model, the default `vmbr0` bridge, the
  NIC-rename gotcha and pinning, VLAN-aware bridges, and the NAT lab.
- [11 -- Firewall](../11-firewall.md) -- the three `.fw` levels, the two master switches, the
  management allow-list trap, the rule syntax, and the full safe-enable checklist.

Term definitions are in the [glossary](../GLOSSARY.md).

---

Back to the [cheatsheets index](README.md). Browse all the [guides](../README.md).
