# Applied recipes: standing up the mission services

## What you'll be able to do

This guide is the map for Part G, the applied layer where the foundations you built in guides 00
through 18 become running services. Each recipe that follows is a self-contained cookbook for one
service, and each can be done on its own without working through the others first. By the end of
Part G you will have stood up the services you actually came for, from a shared reverse proxy to a
password manager, a document archive, a home-automation appliance, and more.

## How to use these recipes

The recipes are numbered, but unlike the earlier guides they have no required read order. Pick the
service you want and go straight to its recipe. Each recipe states its own prerequisites by
cross-reference, so if it needs something from an earlier recipe (most often the shared reverse
proxy in recipe 00) or a foundation guide, it says so at the top.

What every recipe assumes is the foundation already in place from guides 00 through 18: the node
installed, networking and a bridge configured (guide 10), the host firewall set up safely (guide
11), storage ready (guide 09), remote access working over SSH (guide 12), and a backup plan written
and ready to enable once the backup disk is connected (guides 17 and 18, which are written now to be
implemented later). The recipes do not re-teach those; they build on them. These are do-it-now
cookbooks, not deferred reading. When you open one, you are installing the service.

## The four deployment patterns

Every recipe deploys its service using one of exactly four patterns. Knowing the four up front means
each recipe can name its pattern in a word and you already know what shape the work will take. The
patterns come from the per-service analysis in the research brief.

- Pattern A: a hand-built unprivileged [LXC container](GLOSSARY.md). This is the lightest option and
  the most accessible, because once the container exists you reach it with `pct enter <vmid>`, which
  drops you straight into a root shell with no console or networking setup. You build the container
  yourself (or clone it), then install the service natively inside it.
- Pattern B: a Helper-Scripts LXC. This is still an unprivileged [LXC container](GLOSSARY.md), but a
  community [Helper-Scripts](GLOSSARY.md) one-liner builds it for you and installs the app natively
  (apt plus systemd, not Docker). You reach it the same way, with `pct enter`.
- Pattern C: a Docker-Compose stack inside one Debian [KVM/QEMU VM](GLOSSARY.md). Proxmox's official
  line is that Docker belongs in a VM, not in an LXC, so when a service is genuinely Docker-first
  upstream you run one Debian VM and drive `docker compose` inside it.
- Pattern D: a dedicated [KVM/QEMU VM](GLOSSARY.md). You reach for a whole VM when the service needs
  full isolation or ships as an appliance operating system, such as Home Assistant OS, or when you
  want a throwaway machine you can break and roll back without risking the host.

The accessibility note that runs through all four: an [LXC container](GLOSSARY.md) (patterns A and
B) is reached with `pct enter`; a [KVM/QEMU VM](GLOSSARY.md) (patterns C and D) is reached with
`qm terminal <vmid>`, the serial console wired into every template back in guide 07, or over SSH
once the guest is up. Both paths are plain linear text; neither needs the web GUI or a graphical
console.

## Two ways to install, both first-class

For many of these services a community [Helper-Scripts](GLOSSARY.md) script already exists. Where it
does, the recipe shows you both the Helper-Scripts one-liner (pattern B) and the hand-built path
(pattern A) as co-equal peers. Neither is the fallback. The one-liner is faster; the hand-built path
teaches you what the script does and leaves nothing you do not understand running on your node.
Choose whichever fits your mood and your appetite for control that day.

There is one honest caveat on the one-liner, and it is the same one guide 16 makes in full: the
Helper-Scripts command pipes code fetched from the internet straight into a root shell on the
hypervisor, with no pause and no review. A compromised script runs as root on the host and can take
the whole node, not just one container. So treat every invocation as running untrusted root code:
read the script first, snapshot before you run it, and pin a specific reviewed commit instead of
`main`. Guide [16 -- Automation and the ecosystem](16-automation-and-the-ecosystem.md) covers that
curl-pipe-to-root risk and its mitigations in detail, so the recipes reference it rather than
restating it each time.

Where no official script exists, the recipe is hand-built only. That is the case for the shared
reverse proxy, Drupal, the personal static website, the throwaway dev-lab VM, and the Hermes Agent;
each of those is built by hand from the foundations you already have.

## Shared building blocks

Several recipes lean on the same pieces, so they are worth naming once here.

- The shared reverse proxy. Recipe 00 builds one [Caddy](GLOSSARY.md) LXC that fronts all your web
  services and handles TLS automatically. The web-facing recipes (Vaultwarden, Miniflux, Nextcloud,
  Drupal, the personal website) build on it rather than each running their own
  [reverse proxy](GLOSSARY.md), so do recipe 00 first if you are standing up anything web-facing.
- The cloud-init golden template. The VM recipes clone the [cloud-init](GLOSSARY.md) template you
  built in guide 07, the one with `--serial0 socket --vga serial0` baked in so every clone has a
  serial console reachable with `qm terminal`. Cloning is a one-liner, which is what makes the VM
  patterns quick to spin up.
- Static IPs. A service that other machines depend on (the reverse proxy, the DNS sinkhole) needs a
  fixed address. Giving a guest a static IP is taught in guide [10 -- Networking](10-networking.md),
  and the recipes that need one point back to it.
- Every service is a guest you must back up. A running service is only as safe as its last backup.
  Each new guest is something to add to the backup schedule from guides
  [17 -- Backups with Proxmox Backup Server](17-backups-with-pbs.md) and
  [18 -- The independent copy and restore](18-the-independent-copy-and-restore.md). Treat finishing
  a recipe and backing the guest up as one task, not two.

## The recipes

The eleven recipes, in order, each with its deployment pattern. They live in the `recipes/`
subfolder.

- [00 -- The shared reverse proxy](recipes/00-reverse-proxy.md) -- pattern A (hand-built Caddy LXC).
- [01 -- DNS sinkhole](recipes/01-dns-sinkhole.md) -- pattern A or B (Pi-hole or AdGuard Home,
  optional Unbound).
- [02 -- Vaultwarden](recipes/02-vaultwarden.md) -- pattern A or B.
- [03 -- Miniflux](recipes/03-miniflux.md) -- pattern A or B.
- [04 -- Paperless-ngx](recipes/04-paperless-ngx.md) -- pattern C (Docker-Compose VM) or B
  (Helper-Scripts LXC).
- [05 -- Nextcloud](recipes/05-nextcloud.md) -- pattern A or B.
- [06 -- Drupal](recipes/06-drupal.md) -- pattern A.
- [07 -- Home Assistant (HAOS VM)](recipes/07-home-assistant-haos-vm.md) -- pattern D.
- [08 -- Personal website via Cloudflare Tunnel](recipes/08-personal-website-cloudflare-tunnel.md)
  -- pattern A.
- [09 -- Throwaway dev-lab VM](recipes/09-dev-lab-vm.md) -- pattern D.
- [10 -- Hermes Agent](recipes/10-hermes-agent.md) -- pattern A (hand-built LXC), with a pattern D
  (VM) variant.

## Sources

- `research/round2-pve9/20-pve9-ecosystem-and-service-patterns.md` -- the primary source for Part G.
  Part 1 is the Helper-Scripts catalog and the curl-pipe-to-root caveat; Part 2 is the per-service
  deployment recommendations and the four-pattern decision menu (A, B, C, D) that this overview
  defines; Part 3 is the recommended use/optional/skip toolset.
- `GLOSSARY.md` -- the canonical definitions reused here of [LXC container](GLOSSARY.md),
  [KVM/QEMU VM](GLOSSARY.md), [Helper-Scripts](GLOSSARY.md), [cloud-init](GLOSSARY.md),
  [Caddy](GLOSSARY.md), [reverse proxy](GLOSSARY.md), and [Cloudflare Tunnel](GLOSSARY.md), plus the
  cross-references to guides [07 -- Cloud-init templates](07-cloud-init-templates.md),
  [10 -- Networking](10-networking.md),
  [16 -- Automation and the ecosystem](16-automation-and-the-ecosystem.md),
  [17 -- Backups with Proxmox Backup Server](17-backups-with-pbs.md), and
  [18 -- The independent copy and restore](18-the-independent-copy-and-restore.md).
- [community-scripts/ProxmoxVE](https://github.com/community-scripts/ProxmoxVE) and the script
  catalog at [community-scripts.org/scripts](https://community-scripts.org/scripts) -- the
  Helper-Scripts that the pattern-B recipes use.

---

Previous: [18 -- The independent copy and restore](18-the-independent-copy-and-restore.md) | Next:
[00 -- The shared reverse proxy](recipes/00-reverse-proxy.md)
