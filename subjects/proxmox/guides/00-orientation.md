# Orientation: the map before the hands-on work

## What you'll be able to do

This guide gives you the mental model for everything that follows: what Proxmox VE is, the
difference between a virtual machine and a container, why this corpus runs exactly one node with no
RAID, and the three shell capabilities that make the whole system reachable without ever touching a
graphical screen. There are no setup commands here. This guide is the map; the hands-on work starts
in guide 01.

## What Proxmox VE is

Proxmox VE (Proxmox Virtual Environment) is an open-source virtualization platform built on Debian.
This corpus targets version 9.x, which sits on Debian 13 "trixie". It is a hypervisor: software that
lets one physical machine run many isolated guests at once, each behaving like its own computer.
Proxmox runs two kinds of guest. It runs full virtual machines through KVM/QEMU (the Linux kernel's
virtualization plus the QEMU emulator), and it runs containers through LXC. One installation manages
both kinds side by side.

In this corpus you run exactly one node: a single physical machine, the Proxmox host, on a personal
PC. That is the whole "datacenter" here. Where official documentation assumes a cluster of several
machines, you can read those parts as background; you are operating one host and nothing more.

A defining fact for the way you will work: Proxmox exposes everything it can do through a REST API,
and it also ships a web GUI. The web GUI is just one client of that API; it adds no capability the
API lacks. This corpus does not use the web GUI at all. You drive the host from the shell, over SSH,
because the shell is the accessible path and the GUI is not.

## Virtual machines vs containers

Both a VM and a container are a guest, but they isolate in different ways, and on a single node the
choice usually comes down to weight versus separation.

An LXC container shares the host's Linux kernel and runs only its own isolated userspace: its own
processes, its own filesystem, its own network, but the same kernel as the host underneath. Because
there is no second kernel to boot and no emulated hardware, a container is lighter, starts in a
moment, and uses less memory. The trade-off is that a container must run Linux, and it is less
strongly isolated than a VM because it leans on the shared kernel. Containers are managed with the
`pct` command, and each one has a config file at `/etc/pve/lxc/<vmid>.conf`. For this corpus, an
unprivileged container is the default and the recommended kind: even its root user maps to a
powerless user on the host.

A KVM/QEMU VM is a full virtual machine with its own emulated hardware and, crucially, its own
kernel. It is heavier than a container, but it is fully isolated and can run any operating system,
not just Linux. VMs are managed with the `qm` command, and each has a config file at
`/etc/pve/qemu-server/<vmid>.conf`.

On a single home node, a reasonable rule of thumb is: reach for a container first, because most home
services are ordinary Linux daemons and a container is the lighter, faster home for them. Reach for
a VM when you need full isolation, a non-Linux guest, or something that wants kernel-level control
of its own, such as a different kernel, a self-contained appliance, or a Docker host you want kept
apart from everything else.

## What we deliberately skip, and why

Proxmox is built for fleets of machines. Much of its documentation describes features that only make
sense across several nodes or several disks. On one home node, those features add complexity without
buying you anything, so this corpus leaves them out on purpose.

- RAID: skipped. RAID combines several disks for redundancy or speed. This node has a single NVMe
  disk for its root, so there is nothing to combine. The host root is btrfs, which still gives you
  checksums and compression on that one disk.
- Clustering: skipped. A cluster joins several Proxmox hosts so they share configuration and can
  move guests between each other. You have one host, so there is no cluster to form.
- High availability: skipped. High availability automatically restarts a guest on another node when
  one node fails. It needs a cluster, which you do not have.
- Ceph: skipped. Ceph is distributed storage spread across many nodes and many disks. It is far past
  the scope of one machine; you will see it mentioned only in passing.
- The web GUI: skipped, and this one is the heart of the matter. The web GUI, and the graphical
  consoles it embeds (noVNC and SPICE), are not usable with a screen reader. One documented
  install-time exception exists: an attended install driven by ear over SPICE (guide
  [08 -- Windows guests](08-windows-guests.md)). Rather than fight an inaccessible interface, this
  corpus teaches the shell and the configuration files directly, which read cleanly as linear text.
  You lose nothing by skipping the GUI, because everything it does is reachable another way, as the
  next section explains.

## The three superpowers

This is the most important idea in the whole corpus. The web GUI and the graphical consoles are the
only parts of Proxmox that are not accessible, and three shell capabilities replace all three of
them completely. Once you internalize these, the inaccessible parts of Proxmox simply stop
mattering, because you never need them.

The first superpower is the serial console for virtual machines, reached with `qm terminal`. A
graphical console draws pixels you cannot read. A serial console instead attaches a plain text line
to the VM. When you configure a VM with a serial device and make that serial line its primary
display (set up before you install the guest's operating system), then even the bootloader, the
installer, and early boot all render as text over `qm terminal`. The graphical console becomes
irrelevant: the VM is reachable as text from power-on onward. Exit `qm terminal` with Ctrl-O.

The second superpower is container access with `pct enter` and `pct exec`. `pct enter <vmid>` drops
you into an interactive root shell inside a container; it behaves like any normal SSH session, so
your screen reader reads it exactly as it reads any terminal. `pct exec <vmid> -- <command>` runs a
single command inside the container, which is what you reach for when scripting. Neither needs a
graphical console or the GUI. (One PVE 9 detail to know early: the `--keep-env` default for
`pct enter` and `pct exec` is version-sensitive. The current 9.2 manual still lists it as on, but
warns that the default is changing. Be explicit: pass `--keep-env 0` when you want a clean
environment and `--keep-env 1` when you need inherited variables.)

The third superpower is `pvesh`, the command-line shell over the Proxmox REST API. Run as root on
the host, `pvesh` talks to the API over a local socket with no password or TLS to arrange, and it
can reach every API path as text. Because the web GUI is nothing more than a client of that same
API, `pvesh` can do anything the GUI can do, and it can print the answer as YAML or JSON, which read
far more cleanly than wide, column-aligned tables. This is the universal text gateway: when no
friendlier tool covers what you need, `pvesh` reaches it.

Together these three replace the inaccessible interface entirely. Serial consoles for VMs,
`pct enter` for containers, and `pvesh` for everything else: with those three, the shell is a
complete and comfortable way to run the host, and the GUI is something you can ignore. Alongside
them runs one cross-cutting habit you will meet throughout the corpus: set guests up so they come up
already reachable over SSH (cloud-init for VMs, keys and templates for containers), so that day to
day you live in an ordinary SSH session and fall back to the serial console only for boot problems
and repairs.

## Your setup at a glance

It is worth being precise about which machine is which, because two computers are involved and the
corpus keeps them strictly separate.

- The Proxmox host is the single physical machine that runs Proxmox VE: an AMD Ryzen 6800H personal
  PC with its root filesystem on btrfs. It has no accessible local console, so you never sit at it
  directly. You operate it entirely over the network.
- The control station is your separate everyday computer: a Windows PC with a screen reader. You SSH
  from the control station into the Proxmox host. The control station is never the machine Proxmox
  is installed on; it is where you read and type, and the host is what you are reading and typing
  to.
- A Raspberry Pi 4B is set aside for later. It is reserved as an independent, off-host copy of your
  backups, which you set up once the host and its services are running. You can forget about it
  until then.

So the picture is: you, at the control station, reach across SSH to the Proxmox host, and everything
in this corpus happens on that host through the shell.

## How to use this corpus

The guides are numbered, and they are written to be read in order; each one builds on the mental
model and the work of the ones before it. At the same time, each guide is self-contained enough that
you can navigate straight to a section by its heading when you come back later to look something up.
The headings are the table of contents your screen reader moves through, so they are accurate and
properly nested throughout.

Lean on the glossary. Terms like guest, the Proxmox host, the control station, serial console, and
pmxcfs have one fixed meaning across the whole corpus, defined once in `GLOSSARY.md` and used
consistently everywhere. When a term is unfamiliar, the glossary is the fastest place to settle it.

This guide is the map. The hands-on work begins in guide 01, which walks through installing Proxmox
VE 9 on the host from the shell. Read on when you are ready to start building.

## Sources

- `CONTEXT.md` - the project roles (the Proxmox host, the control station, the guest, the three
  superpowers) and the vocabulary this guide uses.
- `GLOSSARY.md` - the canonical definitions of Proxmox VE, KVM/QEMU VM, LXC container, serial
  console, pvesh, pct, qm, and the other terms used here.
- `AUTHORING-CONVENTIONS.md` and `AUTHORING-NOTES.md` - the accessibility thesis, audience, and
  shell-only operating constraints this guide follows.
- `research/round2-pve9/01-pve9-whats-new-and-deltas.md` - Proxmox VE 9 on Debian 13 "trixie"
  baseline, and the single-node "note-and-skip" framing for clustering, high availability, and Ceph.
- `research/round2-pve9/09-pve9-vms-qm.md` - virtual machines via `qm` and the serial-console-first
  workflow (`qm terminal`).
- `research/round2-pve9/10-pve9-lxc-pct.md` - LXC containers via `pct`, including `pct enter` and
  `pct exec` as the accessible access path and the PVE 9 `--keep-env` default change.
- `research/round2-pve9/19-pve9-hardening-and-monitoring.md` - the accessibility-practices section:
  serial consoles, `pct enter`, and `pvesh` with YAML/JSON output as the screen-reader-friendly
  control surface.
- Proxmox VE documentation: the `qm`, `pct`, and `pvesh` manual pages and the administration guide
  at [Proxmox VE Documentation Index](https://pve.proxmox.com/pve-docs/) .

---

Next: [01 -- Install Proxmox VE 9 unattended](01-install-proxmox-unattended.md)
