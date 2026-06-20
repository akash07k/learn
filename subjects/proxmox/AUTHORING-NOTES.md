# Proxmox authoring notes

These are the Proxmox-specific authoring rules. They sit on top of the subject-agnostic
`AUTHORING-CONVENTIONS.md` at the repository root: read that first for audience, formatting,
sourcing, glossary discipline, and the structure of a guide. This file records the safety callouts,
version facts, storage convention, and wiring details that only make sense for Proxmox.

## The topology this subject assumes

The reader is a single operator who is blind and uses a screen reader, working entirely from the
shell. They sit at the control station (a Windows machine with a screen reader) and SSH into the
Proxmox host (a separate, headless machine). They never see the host's local screen and never use
the web GUI.

- Never reference the web GUI, noVNC, SPICE, or any graphical-console step. If the official docs
  only describe a GUI path, teach the shell or config-file equivalent instead.
- Use the role names from `CONTEXT.md` consistently: the Proxmox host (the single physical machine
  running Proxmox VE, also "the node"); the control station (the operator's separate everyday
  computer they SSH from); a guest (a VM or container); and the three superpowers (the serial
  console for VMs, `pct enter` for containers, and `pvesh` for everything else). Avoid "server",
  "box", "client", "workstation", and "instance" where a precise role name exists.
- The authoring sources live under `research/` (`research/round1-general/` and
  `research/round2-pve9/`). Each round-2 file is a researched, citation-bearing brief on one topic;
  treat those as the primary source for PVE 9 specifics. When a guide tells the reader to edit a
  file, show the shell-only form and point to the "Editing files accessibly" section of guide 02
  (`02-the-shell-and-the-api.md`) for the full menu. Files under `/etc/pve` (pmxcfs) are written
  through their CLI tool (`pveum`, `pvesm`, the firewall tooling), not editor methods.

## Storage convention

Use the active `local-btrfs` storage for every guest disk, container rootfs, template (`vztmpl`),
ISO, and snippet. The plain `local` directory storage is disabled on a btrfs-root node; never write
`local:` or `--rootfs local:`. The convention linter enforces this through the `storage-id` rule
declared in `subject.toml`, so a wrong storage id fails the gate.

## Safety callouts

Any step that can lock the operator out of the headless host, or destroy data, must state the safe
procedure before the dangerous command. The reader has no local console to recover from.

- Network and SSH changes: before editing `/etc/network/interfaces`, the firewall, or `sshd`, tell
  the reader to keep a second SSH session open to the host. If the change drops their connection,
  the second session is still live to undo it.
- Firewall: never present an "enable the firewall" step without the safe sequence. Compile and
  preview the ruleset first (`pve-firewall compile`), keep a second SSH session open, and confirm a
  rule that allows SSH (TCP 22) from the control station before enabling. The host firewall is
  active as soon as the datacenter switch is on, so this is a real lockout risk.
- The authorized_keys trap: `/root/.ssh/authorized_keys` is a symlink into the pmxcfs filesystem
  mounted at `/etc/pve`. If `pve-cluster` (pmxcfs) fails to start, that file disappears and
  key-based SSH login breaks. Tell the reader to keep an independent copy of their public key in
  `~/.ssh/authorized_keys2` (a real file on the root disk, outside `/etc/pve`), so login still works
  if pmxcfs is down.
- Disk and filesystem operations: `zpool create`, `mkfs`, and similar are destructive. Show how to
  identify the right disk first (prefer stable `/dev/disk/by-id/` names over `/dev/sdX`) and state
  plainly that the command erases the target.
- For any reload that could cut the connection (for example a network reload), show the dry-run or
  preview form first (`ifreload -a -n` before `ifreload -a`).

## Version awareness

The corpus targets the latest Proxmox VE 9.x on Debian 13 "trixie". Write for 9.x as the default.

- Show "if you are on 8.x" notes only where 9.x genuinely differs (for example deb822 `.sources`
  repositories replacing one-line `.list` files, or the `pct enter` clean-environment default). Keep
  such notes short and clearly marked as the 8.x case.
- For any version-sensitive step, tell the reader to run `pveversion` (or `pveversion -v`) first and
  confirm the version before proceeding.
- State PVE 9.2 facts consistently (kernel 7.0, QEMU 11.x, ZFS 2.4); mark anything older clearly as
  the 8.x or earlier-point-release case. Do not present a deprecated path as current; teach the 9.x
  form and mention the old one only as a migration note.

## Wiring a new guide or recipe

The repository-root `AUTHORING-CONVENTIONS.md` has the general wiring checklist. For Proxmox, also
do these in the same change:

- Footer chain: the spine runs guides 00 to 19, then the recipes (recipe 00 to 10), then guides 20
  to 22. A new file inserted anywhere must keep that forward and back chain intact. The endpoints
  (`guides/00-orientation.md` with no Previous, `guides/22-when-things-break.md` with no Next) are
  declared in `subject.toml`.
- The recipes overview: a new recipe goes into both lists in `19-recipes-overview.md` (the
  per-recipe list and the "hand-built only" or pattern prose), and its count.
- `LAB-PLAN.md`: if the guest takes a VMID, IP, hostname, or port, add its row, keeping the
  VMID-last-octet equals IP-last-octet convention and noting whether it sits behind Caddy.

## Sources

- `CONTEXT.md` - the project glossary of roles (Proxmox host, control station, guest, the three
  superpowers) and artifact vocabulary.
- `GLOSSARY.md` (under `guides/`) - the canonical term definitions every guide reuses.
- `AUTHORING-CONVENTIONS.md` at the repository root - the subject-agnostic accessibility,
  formatting, sourcing, and safety contract these notes specialize for Proxmox.
