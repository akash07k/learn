# Proxmox Zero-to-Hero Guide

The ubiquitous language for an accessible, shell-only Proxmox VE learning corpus, written for a
blind screen-reader user running a single home node. This file is a glossary only - no
implementation details.

## Language

### Topology and roles

**Proxmox host**: The single physical machine that runs Proxmox VE (the hypervisor). Also called
"the node". It has no accessible local console and is operated entirely over the network. _Avoid_:
server, box, "my PC".

**Control station**: The operator's separate everyday computer (Windows with a screen reader) from
which they SSH into the Proxmox host. It is never the machine Proxmox is installed on. _Avoid_:
client, "my PC", workstation.

**Guest**: A workload running on the Proxmox host - either a virtual machine or a container.
_Avoid_: instance, machine (when ambiguous).

**The three superpowers**: The three shell capabilities that replace the inaccessible web GUI and
the graphical consoles the operator would otherwise have to read visually: the serial console
(`qm terminal`) for VMs, `pct enter` for containers, and `pvesh` for everything else (the REST API
as text). They cover day-to-day operation by text. The rare surface they cannot reach - a guest's
own graphical installer with no serial path (notably Windows) - is driven by ear, not by eye,
instead (see **Console-by-ear**).

### Consoles and guest access

**Console-by-ear**: A graphical guest console driven by the guest's OWN speech over audio rather
than read by eye - the in-guest screen reader (Windows Narrator, the Debian installer's espeakup)
heard in remote-viewer, with keystrokes sent back. The accessible way to reach a guest's own
graphical installer when no serial or text path exists (notably Windows). It is the install-time
sibling of RDP with a screen reader in the guest; both are graphical surfaces driven by ear.
_Avoid_: "the SPICE GUI" (it is driven by ear, not read by eye).

**SPICE console**: The graphical guest console that, unlike noVNC, carries the guest's audio to the
client - which is what makes Console-by-ear possible. Used only for the attended install, never for
daily operation. _Avoid_: noVNC (the audio-less VNC console the corpus does not use).

**remote-viewer**: The client program the operator runs on the control station to open a SPICE
console; provided by the `virt-viewer` package. _Avoid_: calling it "virt-viewer" in prose - that is
the package, `remote-viewer` is the command.

**console.vv**: The short-lived SPICE connection file remote-viewer opens, fetched fresh from the
Proxmox API each time because its ticket expires in roughly 30 seconds. _Avoid_: "the SPICE config".

**Attended install** / **Unattended install**: An attended install is the interactive OS installer
driven by ear (Console-by-ear); an unattended install is hands-off via an answer file
(`autounattend.xml` for a Windows guest, `answer.toml` for the Proxmox host). The unattended path is
the default; the attended install is the documented accessible fallback. _Avoid_: "manual install" /
"automated install".

### Naming and addressing

**Proxmox hostname**: `pve` - the short hostname assigned to the Proxmox host during install. It
resolves to the management IP on both the mDNS domain (`pve.local`) and the home-network DNS domain
(`pve.home.arpa`). _Avoid_: renaming the host; every guide assumes `pve`.

**mDNS / Avahi**: Link-local multicast name resolution. On this corpus `avahi-daemon` on the host
publishes the host as `pve.local`, reachable from any device on the same network segment without
configuring anything. Used as an optional convenience for quick ad-hoc lookups; not the network-wide
naming authority. Filed in GLOSSARY.md under "Avahi / mDNS". _Avoid_: relying on it for service
records or cross-VLAN resolution.

**`.local`**: The mDNS domain. `pve.local` resolves on any device with an mDNS resolver (most modern
OS) without any DNS configuration. _Avoid_: confusing it with `.home.arpa`, which is the
home-network DNS domain served by the local sinkhole.

**`.home.arpa`**: The home-network DNS domain (RFC 8375), served by the local DNS sinkhole for the
host and every static-IP guest. All permanent name-to-IP mappings use `*.home.arpa` (for example
`pve.home.arpa`, `adguard.home.arpa`). _Avoid_: `.lan`, `.home`, or any other invented TLD.

**Local DNS record**: A name-to-address mapping the DNS sinkhole answers for `*.home.arpa` names.
Adding one makes a service reachable by name across the home network without editing every client's
hosts file. _Avoid_: calling these "DNS entries" (ambiguous with public DNS).

### Artifacts (the corpus)

**Guide**: A numbered, self-contained Markdown document under `guides/` teaching one area in reading
order (e.g. `09-storage.md`). The backbone of the corpus. _Avoid_: tutorial, chapter, lesson (a
"lesson" is the future `/teach` HTML unit).

**Recipe**: A short, end-to-end cookbook under `guides/recipes/` that stands up one mission service
(e.g. Vaultwarden) by reusing what the guides taught. _Avoid_: tutorial, how-to.

**Cheat-sheet**: A dense quick-reference under `guides/cheatsheets/` for one tool's commands (e.g.
`pct.md`), for lookup after the concepts are learned. _Avoid_: reference card, summary.

**Mission services**: The concrete self-hosted apps the operator wants running (Pi-hole/AdGuard,
Vaultwarden, Miniflux, Paperless-ngx, Nextcloud, Drupal, Home Assistant, a personal website) plus a
dev/test lab. They are the worked examples throughout and the subjects of the recipes.
