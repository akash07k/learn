# The lab plan: addresses, VMIDs, names, ports, and storage

This is the single reference for the conventions the rest of the corpus follows: the IP address
plan, the VMID scheme, the host and service names, the storage ids, and which service answers on
which port. The guides and recipes use these values consistently, so settle any "what address or id
does X use" question here. Replace the example values (the `192.168.1.0/24` subnet, the placeholder
public domain) with your own where they differ; the structure is the point, not the literal numbers.

## The network address plan

One flat home LAN, `192.168.1.0/24`, with a single gateway. The reserved addresses:

- `192.168.1.1` -- your home router and the default gateway off the LAN.
- `192.168.1.10` -- the Proxmox host's management IP, the address you SSH to (guides 03 and 10).
- `192.168.1.50` -- the Proxmox Backup Server, a VM on the node (guide 17).
- `192.168.1.100` through `192.168.1.119` -- generic and throwaway guests, and the examples in the
  teaching guides.
- `192.168.1.120` through `192.168.1.128` -- the mission service containers from the Part G recipes.
- `192.168.1.130` and up -- the mission service VMs (Paperless, Home Assistant).

Every service guest gets a static address (guide [10 -- Networking](10-networking.md)), not a DHCP
lease, so it is always reachable at the same place. Pick addresses outside your router's DHCP pool
so nothing else leases them. The host itself uses either a true static config or a router-side DHCP
reservation, both covered in guide 10.

## The VMID scheme

Proxmox identifies every guest by a numeric VMID. This corpus uses:

- `100` through `119` -- example and throwaway guests in the teaching guides.
- `120` through `128` -- the mission service containers (Part G recipes).
- `130` and `132` -- the mission service VMs (Paperless and Home Assistant).
- `150` -- the throwaway dev-lab VM (recipe 09).
- `9000` -- the cloud-init golden template (guide 07), cloned to make the service VMs.

A convention the recipes follow to keep ids and addresses easy to match: the VMID's last octet
equals the IP's last octet. The Caddy container is VMID `120` at `192.168.1.120`, Vaultwarden is
VMID `123` at `192.168.1.123`, and so on.

## The services (Part G recipes)

Each mission service, its VMID, address, kind, and the port it answers on. The web services sit
behind the shared Caddy reverse proxy (recipe 00), which terminates TLS and forwards to each by its
internal address and port; you reach them by name through Caddy rather than hitting these ports
directly.

- VMID `120`, `caddy`, `192.168.1.120` -- the shared reverse proxy (LXC); fronts all web services on
  80/443. (recipe 00)
- VMID `121`, `adguard`, `192.168.1.121` -- DNS sinkhole, AdGuard Home (LXC); DNS on 53, admin UI on
  80 (after first-run setup; :3000 is only the transient install listener). (recipe 01)
- VMID `122`, `pihole`, `192.168.1.122` -- DNS sinkhole, the Pi-hole alternative (LXC); DNS on 53,
  admin UI on 80. (recipe 01)
- VMID `123`, `vaultwarden`, `192.168.1.123` -- password manager (LXC); HTTP on 8080, fronted by
  Caddy. (recipe 02)
- VMID `124`, `miniflux`, `192.168.1.124` -- RSS reader (LXC); HTTP on 8080, fronted by Caddy.
  (recipe 03)
- VMID `125`, `nextcloud`, `192.168.1.125` -- files, calendar, contacts (LXC); HTTP on 80, fronted
  by Caddy. (recipe 05)
- VMID `126`, `drupal`, `192.168.1.126` -- PHP CMS (LXC); HTTP on 80, fronted by Caddy. (recipe 06)
- VMID `127`, `hermes`, `192.168.1.127` -- Hermes Agent, a self-hosted AI agent (LXC); no inbound
  port (outbound only, to the model provider and Telegram), so not fronted by Caddy. (recipe 10)
- VMID `128`, `website`, `192.168.1.128` -- static personal website (LXC); HTTP on 80, published
  through a Cloudflare tunnel rather than Caddy. (recipe 08)
- VMID `130`, `paperless`, `192.168.1.130` -- document management with OCR (VM, cloned from 9000);
  HTTP on 8000, fronted by Caddy. (recipe 04)
- VMID `132`, `home-assistant`, `192.168.1.132` -- home automation (HAOS VM); dashboard on 8123,
  fronted by Caddy. (recipe 07)

Two notes. AdGuard (`121`) and Pi-hole (`122`) are two choices for the same DNS-sinkhole role; you
run one, not both. Paperless (`130`) and Home Assistant (`132`) are VMs, so their address is set
through cloud-init or the installer rather than a `pct` network line; the addresses above follow the
VMID-matches-octet convention, but those two recipes leave the exact value for you to set.

## The host and service names

- Host FQDN `pve.home.arpa`, short name `pve`, set at install and reaffirmed in `/etc/hosts` (guides
  01 and 03).
- DNS search domain `home.arpa` (guide 10).
- Public web services use a domain you control; the recipes write it as a placeholder, so substitute
  your real domain. Internal-only access uses the LAN address or the host's resolver.
- Service hostnames match the list above (`caddy`, `vaultwarden`, and so on).
- The host and every static-IP guest are reachable by name via two layers: `pve.local` (mDNS, guide
  [10 -- Networking](10-networking.md)) and `*.home.arpa` (the sinkhole's local DNS records, recipe
  [01 -- DNS sinkhole](recipes/01-dns-sinkhole.md)).

## The storage ids

On this single btrfs-root node:

- `local-btrfs` -- the active storage created by the btrfs-root install: a btrfs store that holds VM
  disks, container rootfs, ISO images, container templates, and backups (guide 09).
- `local` -- the plain directory storage on the same root filesystem; on a btrfs-root install it
  sits disabled, so `local-btrfs` is the one you use for guest disks.
- There is no `local-lvm`. That id exists only on an LVM-thin install, not a btrfs one.
- The Proxmox Backup Server's datastore lives on an external USB disk attached to the PBS VM, never
  on the internal NVMe (guides 17 and 18).

## Where each convention is established

- The IP plan and attaching guests: guide [10 -- Networking](10-networking.md).
- VMIDs and the golden template: guides
  [06 -- Virtual machines with qm](06-virtual-machines-with-qm.md) and
  [07 -- Cloud-init templates](07-cloud-init-templates.md), and the recipes.
- The storage model: guide [09 -- Storage](09-storage.md).
- Host identity (FQDN and `/etc/hosts`): guides [01](01-install-proxmox-unattended.md) and
  [03](03-repositories-updates-and-the-host.md).
- The services themselves: the Part G recipes, mapped in guide
  [19 -- Applied recipes overview](19-recipes-overview.md).
