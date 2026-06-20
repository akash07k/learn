# Proxmox VE Zero-to-Hero: An Accessible, Shell-Only Guide Corpus

This is a learning corpus for running Proxmox VE entirely from the shell, written for a blind
screen-reader operator managing a single home node. It targets the latest Proxmox VE 9.x on Debian
13 "trixie", on one machine with no RAID and no cluster, with the host root on btrfs. Every concept
is taught through commands and configuration files; the web GUI and the graphical consoles are never
required.

## How to use these guides

- Read the numbered guides in order. They build on each other, and the early ones establish
  vocabulary and the accessible-access foundation the rest assume.
- Each guide is self-contained: it states what you will be able to do, teaches it with exact
  commands and file paths, gives a "Verify it worked" check, and ends with its sources. You can
  return to any guide on its own later.
- The corpus rests on three shell capabilities, "the three superpowers", that replace the
  inaccessible GUI and graphical consoles entirely:
  - the serial console (`qm terminal`) to reach a virtual machine as plain text, including its
    installer and early boot;
  - `pct enter` (and `pct exec`) to get a shell inside a container;
  - `pvesh` to drive everything else, since the REST API is the one source of truth and the GUI is
    just a client of it.
- The host you operate is a separate machine from the control station you read and type on; you
  reach it over SSH. The guides assume that topology throughout.

## Reading order

Part A - Foundations and accessible access:

- [Orientation: the map before the hands-on work](00-orientation.md) - what Proxmox is, VMs versus
  containers, the single-node mental model, what is skipped (RAID, cluster, HA) and why, the three
  superpowers, and the control-station and host topology.
- [Install Proxmox VE 9 unattended with answer.toml](01-install-proxmox-unattended.md) - the
  unattended `answer.toml` install (btrfs, Proxmox VE 9), preparing the ISO, the one-time BIOS step,
  and headless verification.
- [The shell and the API: living in the control plane](02-the-shell-and-the-api.md) - SSHing in, the
  pmxcfs config filesystem at `/etc/pve`, `pveversion` and `pvenode`, and `pvesh` as the universal
  text gateway.
- [Repositories, updates, and the host](03-repositories-updates-and-the-host.md) - deb822 `.sources`
  repositories, the no-subscription repo, `apt full-upgrade`, the core daemons, GRUB and boot on
  btrfs, AMD microcode, and host identity and time.

Part B - Running workloads:

- [Talking to guests without a GUI](04-talking-to-guests-without-a-gui.md) - the three accessible
  doors into a guest: the VM serial console (`qm terminal`), the container access verbs (`pct enter`
  / `pct exec` / `pct console`), and SSH into either once it is reachable.
- [Containers with LXC and pct](05-containers-with-lxc-and-pct.md) - OS templates with `pveam`,
  creating an unprivileged Debian container, the config file, bind versus volume mounts, the idmap
  permission fix, and snapshots.
- [Virtual machines with qm](06-virtual-machines-with-qm.md) - the `qm` surface, wiring the serial
  console first, the config for a headless btrfs node, the serial-aware ISO install, the guest
  agent, and snapshots and clones.
- [Cloud-init templates](07-cloud-init-templates.md) - build one Debian 13 golden template, then
  clone an already-SSH-reachable VM per service with no installer; custom first-boot via snippets.
- [Windows guests](08-windows-guests.md) - a Windows 11 VM installed hands-off via
  `autounattend.xml`, reached over RDP with a screen reader inside the guest, with the EMS/SAC
  serial console wired for boot and recovery diagnosis.

Part C - Storage and networking:

- [Storage](09-storage.md) - the btrfs root (subvolumes, compression, scrub, the single-disk caveat,
  and reading real usage), the `pvesm` storage model, and adding an external USB disk as a
  directory, btrfs, or ZFS pool.
- [Networking](10-networking.md) - the `ifupdown2` model and live `ifreload`, the `vmbr0` bridge and
  a static management IP, the trixie NIC-rename pinning, attaching guests, VLANs, and a NAT dev-lab
  bridge.
- [Firewall](11-firewall.md) - the three `.fw` levels and the default-deny model, and the
  safe-enable checklist that keeps a headless host reachable over SSH.

Part D - Remote access and the control plane:

- [Remote access](12-remote-access.md) - move DNS to Cloudflare, a `cloudflared` tunnel in an LXC
  for public web (gated by Cloudflare Access), Tailscale for SSH/admin and crown-jewel services, and
  a Caddy reverse proxy with DNS-01 certs.
- [Users, permissions, and API tokens](13-users-permissions-and-api-tokens.md) - realms and the
  `root@pam` break-glass account, a dedicated admin, roles and ACLs, privilege-separated API tokens,
  a trusted host certificate via ACME, and the authorized_keys2 safeguard.

Part E - Operate like a pro:

- [Best practices and hardening](14-best-practices-and-hardening.md) - key-only SSH, fail2ban, a
  firewall baseline, ZFS-ARC and swap tuning, security-only unattended upgrades, the
  authorized_keys2 safeguard, and a day-1/day-2/ongoing checklist that never locks you out.
- [Monitoring, maintenance, and notifications](15-monitoring-maintenance-and-notifications.md) -
  text monitoring with `pvesh`, `pvereport`, and `glances --stdout`, SMART and `smartd` on the NVMe,
  scheduled btrfs and zpool scrubs, persistent journald, and the PVE 9 notification system (email
  now, ntfy later).
- [Automation and the ecosystem](16-automation-and-the-ecosystem.md) - the community Helper-Scripts
  (with the curl-pipe-to-root caveat), Ansible `community.proxmox`, OpenTofu/Terraform
  `bpg/proxmox`, `proxmoxer`, and an honest use/optional/skip verdict for one node.

Part F - Data safety (written now, implemented later):

- [Backups with Proxmox Backup Server](17-backups-with-pbs.md) - PBS as a VM on the node with its
  datastore on an external USB HDD, incremental and deduplicated guest backups with fleecing,
  client-side encryption with off-box key custody, the host config backed up with
  `proxmox-backup-client`, and the verify/prune/garbage-collect cycle. (vzdump appears here only as
  a one-off tool.)
- [The independent copy and restore](18-the-independent-copy-and-restore.md) - the Raspberry Pi
  off-box copy (a community arm64 PBS fed by a sync job, or a supported `zfs send`/rsync cold copy),
  an off-site third copy for a real 3-2-1, non-destructive restore drills, and configuration
  disaster recovery into a staging directory.

Part G - Applied: end-to-end recipes (the mission):

- [Applied recipes overview](19-recipes-overview.md) - the recipes map and the four deployment
  patterns.
- [The shared reverse proxy (Caddy)](recipes/00-reverse-proxy.md) - one Caddy LXC fronting all web
  services.
- [A DNS sinkhole](recipes/01-dns-sinkhole.md) - Pi-hole or AdGuard Home, optionally with Unbound.
- [Vaultwarden](recipes/02-vaultwarden.md) - a self-hosted password manager.
- [Miniflux](recipes/03-miniflux.md) - a minimal RSS reader.
- [Paperless-ngx](recipes/04-paperless-ngx.md) - document management with OCR.
- [Nextcloud](recipes/05-nextcloud.md) - files, calendar, and contacts, managed via occ.
- [Drupal](recipes/06-drupal.md) - a PHP CMS managed via Drush.
- [Home Assistant (HAOS VM)](recipes/07-home-assistant-haos-vm.md) - home automation as a dedicated
  VM.
- [A personal website via Cloudflare Tunnel](recipes/08-personal-website-cloudflare-tunnel.md) - a
  static site public with no inbound ports.
- [A throwaway dev-lab VM](recipes/09-dev-lab-vm.md) - a disposable VM cloned from the template.
- [Hermes Agent (a self-hosted AI agent)](recipes/10-hermes-agent.md) - an autonomous AI agent in an
  LXC, driven from the shell and from Telegram, calling a bring-your-own-key model.

Part H - Rebuilding the host (advanced disaster recovery):

- [Reinstalling the host remotely with no physical access](20-reinstalling-the-host-remotely.md) -
  reinstall the host over SSH with the `answer.toml` automated installer, by either of two routes: a
  one-time UEFI USB boot set with `efibootmgr` (recommended, when you can plug in a stick) or
  `kexec` for the truly no-media case (with its Secure Boot and brick-risk gates and a mandatory
  nested-VM rehearsal). Plus a permanent reinstall "escape hatch" and a golden-image alternative.

Part I - Passing host hardware to guests:

- [Passing host hardware to guests](21-passing-host-hardware-to-guests.md) - give a VM or container
  access to a physical device: USB storage (flash drives, USB HDD/SSD, card readers), USB audio DACs
  and amplifiers, USB-serial microcontrollers and a Pi, and PCI/PCIe cards. Covers choosing the
  right mechanism per device (USB passthrough, disk-by-id passthrough, a container bind mount or
  `dev0`, and IOMMU/`vfio-pci` PCI passthrough), with the blind-operator framing throughout. Pairs
  with guides 05, 06, and 09.

Part J - When things break (troubleshooting):

- [When things break: a troubleshooting runbook](22-when-things-break.md) - diagnose and recover the
  common failures of a single node entirely as text over SSH: read what happened (the journal, the
  task system by `UPID`, `pvereport`), a guest that will not start (`qm`/`pct`), a stuck task or a
  locked guest, a full root filesystem (and why `df` lies on btrfs), a read-only or empty `/etc/pve`
  (pmxcfs and quorum), a failed upgrade or an unbootable kernel (`proxmox-boot-tool` kernel
  pinning), a network or firewall lockout, and a core daemon or storage backend that has fallen
  over. Consolidates the diagnostics the earlier guides introduced in passing and leans on the three
  lifelines (a second SSH session, `authorized_keys2`, and the serial/Rescue-Boot route). Pairs with
  guides 03, 09, 10, 11, and 20.

## Building the HTML

The guides are also published as accessible standalone HTML via pandoc, so the heading hierarchy
becomes a navigable table of contents. This subject is part of the `learn` monorepo; from the
repository root, build every subject with:

```bash
bun run build
```

The output is written to `html/` at the repository root (which is gitignored). Each subject builds
into its own `html/<subject>/` tree mirroring the source layout, so this subject's guides land under
`html/proxmox/guides/` and its architecture decision records under `html/proxmox/docs/adr/`.
Mirroring the tree is what keeps the cross-links working, so a guide that links
`../docs/adr/0002-...` resolves to the built ADR page. The build rewrites every internal `.md` link
to its `.html` target as it renders. The build script and its accessibility CSS are committed; the
generated HTML is not.

To run the full local quality gate (build, plus a banned-glyph scan, an internal-link check, and a
convention lint), use:

```bash
bun run check
```

It fails if any guide contains a glyph a screen reader cannot read cleanly, if any internal link or
`#fragment` does not resolve in the built HTML, or if a convention check trips (a wrong storage id,
a broken Previous/Next footer chain, or an ascii `->` arrow). The build and the three checks are
TypeScript run on Bun (in `tools/`); pandoc is the only external tool.

## Where else to look

- [GLOSSARY.md](GLOSSARY.md) - the canonical definition of every Proxmox term used here. The guides
  use these terms consistently, so this is the place to settle what a word means.
- `AUTHORING-CONVENTIONS.md` at the repository root - the subject-agnostic conventions every guide
  in the corpus follows (audience and voice, accessible formatting, sourcing, and the structure of a
  guide). The Proxmox-specific authoring notes (storage ids, safety callouts, and version facts)
  live in `AUTHORING-NOTES.md` at this subject's root. Read both first if you are contributing.
- [LAB-PLAN.md](LAB-PLAN.md) - the single reference for the conventions the corpus uses: the IP
  address plan, the VMID scheme, host and service names, the storage ids, and which service answers
  on which port. Settle any "what address or id does X use" question here.
- [`cheatsheets/`](cheatsheets/README.md) - dense per-tool quick references for lookup once the
  concepts are learned: `qm`, `pct`, `pvesh`, `pvesm`, `pbs`, `pveum`, networking and firewall,
  `btrfs`, and `zfs`. Each card groups a tool's everyday commands by task and points back to the
  guide that teaches it. Start at the cheatsheets index.
- [`recipes/`](19-recipes-overview.md) - short end-to-end cookbooks that stand up one mission
  service each by reusing what the guides taught, fronted by a shared Caddy reverse proxy. Start at
  the recipes overview.
- The architecture decision records (ADRs) - the "why" behind the big design choices, each a short
  standalone record you can read on its own:
  [host filesystem (btrfs)](../docs/adr/0001-host-root-filesystem-btrfs.md),
  [backup architecture](../docs/adr/0002-backup-architecture.md),
  [remote access](../docs/adr/0003-remote-access-cloudflare-tunnel-plus-tailscale.md), and
  [Windows guest access](../docs/adr/0004-windows-guest-access-rdp-plus-ems-sac.md).

The subject's authoring contract lives in `subjects/proxmox/AUTHORING-NOTES.md`, layered on the
repository-root `AUTHORING-CONVENTIONS.md`. The ADRs linked above live under this subject's
`docs/adr/` (i.e. `subjects/proxmox/docs/adr/`, reached from a guide as `../docs/adr/`).
