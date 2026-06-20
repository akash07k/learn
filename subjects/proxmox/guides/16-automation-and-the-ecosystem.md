# Automation and the ecosystem

## What you'll be able to do

By the end of this guide you will be able to choose the right automation tool for a single node,
from the native shell up through community [Helper-Scripts](GLOSSARY.md), Ansible, and full
[Infrastructure as Code (IaC)](GLOSSARY.md). You will understand the trust and accessibility
trade-offs of each, including the curl-pipe-to-root risk that every Helper-Script one-liner carries,
and which popular tools to skip outright as a shell-only screen-reader operator.

## The honest baseline: native shell first

Before reaching for any framework, take the honest measure of what one node needs. For a single
Proxmox host, the native commands you already know cover roughly 90% of all provisioning: `qm` for
virtual machines, `pct` for containers, and `pvesh` for everything else the API exposes. Layered on
top of those is the cloud-init template workflow, which turns a downloaded cloud image into a golden
VM template you clone per service in one line. Together these are not just sufficient, they are the
most accessible path: every step is a single command with linear text output, and there is no extra
state file, daemon, or web console to manage.

That cloud-init template workflow is taught in full in guide
[07 -- Cloud-init templates](07-cloud-init-templates.md), including the
`--serial0 socket --vga serial0` step that gives every cloned VM a text serial console reachable
with `qm terminal`. This guide does not re-teach it. The point to carry forward is that it is the
native path every higher-level tool ultimately drives: Ansible, Terraform, and proxmoxer all end up
calling the same `qm`/`pct`/`pvesh` operations underneath. So reach for a heavier tool only when
scale or personal preference genuinely justifies the added ceremony, not by default.

## Proxmox VE Helper-Scripts

The [Helper-Scripts](GLOSSARY.md) collection is the fastest way to stand up a known-good container
or run the post-install chores. Its current state matters, because the project changed hands. The
original `tteck/Proxmox` repository was archived after tteck entered hospice care in October 2024,
and the project transitioned to a community team. The canonical home is now
`community-scripts/ProxmoxVE`. It is actively maintained by volunteers, carries 300-plus scripts,
and its README states support for Proxmox VE versions 8.4, 9.0, 9.1, and 9.2, so PVE 9 is a
first-class target.

Each script offers two modes. Default mode applies sensible resource defaults with the minimum
number of prompts. Advanced mode gives full control over container settings, networking, storage
backend, and app-level config. The prompts are plain text-mode whiptail/dialog menus driven from the
host shell. They are workable, but those TUI menus are the least screen-reader-friendly part of the
whole ecosystem, so prefer Default mode wherever you can: it minimizes how much menu navigation you
have to do.

### The PVE 9 post-install script

The post-install script is meant to run once on a fresh node. It fixes the APT sources, disables the
enterprise repository, enables the no-subscription repository, removes the subscription nag, handles
the Ceph repository and the high-availability packages, and offers optional quality-of-life tweaks.
Each step is an individual yes/no prompt, so nothing happens without your say-so. For PVE 9 it is
adapted to the new Debian 13 deb822 `.sources` format (the `/etc/apt/sources.list.d/*.sources`
files) rather than the old one-line `.list` files, and it auto-detects the PVE version to run the
correct routine.

The command, run in the Proxmox host root shell:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/tools/pve/post-pve-install.sh)"
```

That command pipes internet code straight into your root shell. Do not run it before reading the
curl-pipe-to-root caveat below and applying its mitigations.

### LXC app-installer scripts

The app-installer scripts live under `ct/` in the repository. Each one creates an unprivileged
[LXC container](GLOSSARY.md), installs the app natively (apt plus systemd, not Docker), and prints
the resulting URL and credentials. The canonical pattern is a single `curl`-piped line per app.
Using Vaultwarden as the example shape:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/vaultwarden.sh)"
```

A `wget` form is published and equivalent:

```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/vaultwarden.sh)"
```

Internally the flow is two-stage: `ct/<app>.sh` runs on the host and calls `build_container()`,
which in turn does a `pct exec` into the new container so the install half runs inside the guest. As
with the post-install script, do not run any of these one-liners before reading the caveat that
follows.

The per-mission-service deployment recipes (which app belongs in an LXC versus a VM, sizing, and the
accessibility notes for Pi-hole, Vaultwarden, Nextcloud, Home Assistant, and the rest) are coming in
Part G. This guide stops at the tooling.

### The curl-pipe-to-root caveat (read this)

Every one-liner above downloads a script from the internet and pipes it straight into a root shell
on your hypervisor, with no pause and no review. This is the worst-case trust model. A compromised
script, whether through malice, a hijacked CDN or repository, or an edge-case bug, runs as root on
the host and can take the whole node, not just one container. The project README does not carry an
explicit "this is dangerous" warning; it only lists root shell access as a requirement, so the
caution is on you. Never run a bare one-liner without applying the mitigations below. All of them
are CLI-only and screen-reader friendly.

Read first. Download the script, then read it in `less` before executing anything:

```bash
curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/vaultwarden.sh -o vaultwarden.sh
less vaultwarden.sh
```

Snapshot first. Before running a host-level script such as the post-install one, take a filesystem
snapshot of the host root so you can roll back. On this btrfs-root host that is a btrfs subvolume
snapshot; see guide [09 -- Storage](09-storage.md) for the snapshot mechanics. For app scripts the
new container is disposable, but a host snapshot still protects you against a script that misbehaves
at the host level. ZFS users take a `zfs snapshot` instead; the principle is identical.

Pin a commit. Instead of `main` in the raw URL, substitute a specific reviewed commit hash so the
code cannot change under you between the moment you audit it and the moment you run it:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/<COMMIT_SHA>/ct/vaultwarden.sh)"
```

Even better for repeatability, `git clone` the repository, `git checkout <SHA>`, review the local
copy, and run that local copy rather than fetching live.

Grep before trusting. Scan the downloaded script for the patterns that hide intent or pull in
further code: `eval`, `base64`, and any `curl` or `wget` that reaches out to a host other than the
project's own:

```bash
grep -nE 'eval|base64|curl|wget' vaultwarden.sh
```

The script's own `curl`/`wget` calls fetching from the project's GitHub raw URLs will match and are
expected; what you are hunting for is any fetch to an unfamiliar host.

Verdict: Helper-Scripts are excellent for getting a known-good unprivileged LXC up in about a
minute, and a real time-saver for the post-install chores. Treat every invocation as running
untrusted root code, and apply read-first, snapshot-first, and pin-a-commit every single time.

## Ansible (community.proxmox)

Ansible is the first useful step up from one-shot scripts once you have more than a handful of
guests. There is an important namespace migration to get right first. The Proxmox modules were
extracted from the `community.general` collection into a dedicated `community.proxmox` collection.
The module short-names did not change; only the namespace moved. So `community.general.proxmox_kvm`
becomes `community.proxmox.proxmox_kvm` (for VMs), `community.general.proxmox` becomes
`community.proxmox.proxmox` (for LXC containers), and the same applies to `proxmox_nic`,
`proxmox_disk`, `proxmox_storage`, `proxmox_user`, `proxmox_group`, `proxmox_acl`, and the dynamic
inventory plugin. The old `community.general` names are now redirects that will be removed in
`community.general` 15.0.0, so write all new playbooks against `community.proxmox.*`.

Install the collection (plus the Python libraries it depends on) on your controller, which can be
the control station or any machine that can reach the host's API:

```bash
ansible-galaxy collection install community.proxmox
pip install proxmoxer requests
```

The use case is idempotent, declarative provisioning: VMs, LXC containers, users,
[API tokens](GLOSSARY.md), ACLs, and storage, defined once in version-controlled YAML and re-run
safely. The bundled inventory plugin then lets you drive further configuration against the guests
themselves. Authenticate with an API token rather than a password; tokens are covered in guide
[13 -- Users, permissions, and API tokens](13-users-permissions-and-api-tokens.md). Accessibility is
excellent: Ansible is pure YAML files plus the `ansible-playbook` CLI, with no GUI anywhere.

## OpenTofu / Terraform (bpg/proxmox)

If you want full [Infrastructure as Code (IaC)](GLOSSARY.md) with a state file and drift detection,
the maintained provider is `bpg/proxmox`. Declare it in your `required_providers` block. It is the
successor to the abandoned danitso fork; do not use Telmate's older provider for new work. It works
with OpenTofu and Terraform identically, and it explicitly targets Proxmox VE 9.x.

For authentication, prefer an API token over a username and password:

```hcl
api_token = "user@realm!tokenid=secret"
```

A real token secret written into a `.tf` file or a `*.tfvars` file is plaintext on disk and will
leak into version control if you are not careful -- keep it out of git by passing it as an
environment variable (`TF_VAR_api_token`) or by writing it into a `*.auto.tfvars` file that you add
to `.gitignore`. See guide
[13 -- Users, permissions, and API tokens](13-users-permissions-and-api-tokens.md) for how to create
and rotate tokens.

Some operations (file uploads and certain VM and LXC operations) additionally need an `ssh` block
configured on the provider. For disposable running VMs, set `stop_on_destroy = true` so a plan can
tear them down cleanly. The provider can download cloud images and LXC templates, create cloud-init
VMs through a native `initialization` block (IP config, user, SSH keys), and create unprivileged
containers with `unprivileged = true` and a `features { nesting = true }` block.

The honest single-node verdict: state, drift detection, and many nodes or teams are exactly where
Terraform and OpenTofu shine. On one homelab node, the state file and the provider's quirks are
mostly overhead; plain `qm`/`pct` scripts or the Ansible collection deliver roughly 90% of the value
with far less ceremony. Use it only if you already work in IaC or specifically want declarative
drift control. Accessibility itself is fine: it is HCL text files plus a CLI, with no GUI.

## proxmoxer (Python)

[proxmoxer](GLOSSARY.md) is a thin Python wrapper over the Proxmox REST API (it also covers Proxmox
Mail Gateway and Proxmox Backup Server). Install it with:

```bash
pip install proxmoxer requests
```

Add `paramiko` or `openssh-wrapper` only if you need the SSH backends. It offers three backends:
`https` (the default, talking to the API over the network), `ssh` (`openssh` or `paramiko`), and
`local`, which shells out to `pvesh`/`qm`/`pct` on the node itself. Authenticate with an API token
where you can; the SSH and local backends authenticate as the SSH or host user.

REST verbs are methods on the object, and `create` is an alias for `post`. A short usage shape that
creates an unprivileged container:

```python
from proxmoxer import ProxmoxAPI
proxmox = ProxmoxAPI("host", user="root@pam",
                     token_name="automation", token_value="<secret>",  # keep out of version control -- pass via env var instead
                     verify_ssl=True)
proxmox.nodes("pve").lxc.create(
    vmid=120, ostemplate="local-btrfs:vztmpl/debian-13-standard_*_amd64.tar.zst",
    hostname="miniflux", cores=1, memory=512, rootfs="local-btrfs:4",
    net0="name=eth0,bridge=vmbr0,ip=192.168.1.112/24,gw=192.168.1.1", unprivileged=1)
```

The use case is bespoke Python glue: dynamic logic or integration into other automation, for when
Ansible and Terraform are too rigid but a shell script would be too clumsy. It is fully scriptable
and screen-reader friendly.

## What to use, what to skip

The following is the recommended toolset for a single-node, shell-only, screen-reader operator.

Use (the core):

- Native `qm`, `pct`, and `pvesh`, plus the cloud-init template workflow from guide 07. For one node
  these cover roughly 90% of provisioning and are the most accessible path.
- [Helper-Scripts](GLOSSARY.md) for the PVE 9 post-install chore and for quick unprivileged-LXC app
  installs, always with read-first, snapshot-first, and pin-a-commit applied.
- One [Caddy](GLOSSARY.md) reverse-proxy LXC in front of all web services for automatic TLS. The
  certificate mechanics are taught in guide [12 -- Remote access](12-remote-access.md), and the
  shared-proxy box with its per-site-block pattern is built in recipe
  [00 -- The shared reverse proxy](recipes/00-reverse-proxy.md).

Optional (add when scale or preference justifies it):

- Ansible `community.proxmox` once you have many guests and want idempotent, declarative,
  re-runnable provisioning. Pure YAML and CLI.
- [proxmoxer](GLOSSARY.md) for bespoke Python glue that Ansible or Terraform cannot express cleanly.
- OpenTofu or Terraform with the `bpg/proxmox` provider only if you already want IaC with state and
  drift detection; otherwise it is mostly overhead on a single node.

Skip (low value, and often inaccessible, for this operator). These are GUI-only with no real CLI
parity, so drive the underlying service from its own CLI or config files instead:

- Web-dashboard orchestrators with no command-line equivalent: Portainer (use `docker compose` over
  SSH), Nginx Proxy Manager (prefer Caddy's text Caddyfile), and Cockpit used as the primary UI.
- Single-pane-of-glass homelab dashboards: Homarr, Heimdall, and Dashy are visual launchers with no
  operational value for a shell-only operator.
- The ProxmoxVE-Local web runner; use the raw scripts and CLI instead.
- Where a service ships both a CLI and a dashboard, drive it from the CLI and treat the dashboard as
  optional: Nextcloud `occ`, Pi-hole or AdGuard, Miniflux, and Home Assistant's YAML config.

The per-mission-service deployment recipes (which of these belongs in an LXC versus a VM, with
sizing and per-service accessibility notes) are coming in Part G.

## Sources

- `research/round2-pve9/20-pve9-ecosystem-and-service-patterns.md` -- this guide draws on Part 1
  (the PVE 9 automation and ecosystem catalog) and Part 3 (the recommended use/optional/skip
  toolset) of that brief. Part 2, the per-mission-service deployment patterns, is deferred to Part G
  and is not taught here.
- `GLOSSARY.md` -- the canonical definitions reused here of [Helper-Scripts](GLOSSARY.md),
  [Infrastructure as Code (IaC)](GLOSSARY.md), [proxmoxer](GLOSSARY.md), [API token](GLOSSARY.md),
  [Caddy](GLOSSARY.md), [LXC container](GLOSSARY.md), and the `root@pam` role, plus the
  cross-references to guides [07 -- Cloud-init templates](07-cloud-init-templates.md),
  [09 -- Storage](09-storage.md), [12 -- Remote access](12-remote-access.md), and
  [13 -- Users, permissions, and API tokens](13-users-permissions-and-api-tokens.md).
- [community-scripts/ProxmoxVE](https://github.com/community-scripts/ProxmoxVE) -- the
  Helper-Scripts repository, README, and the `ct/` and `tools/pve/` script paths.
- [PVE post-install script docs](https://community-scripts.org/scripts/post-pve-install) -- what the
  post-install routine does and the deb822 adaptation.
- [Ansible community.proxmox collection](https://docs.ansible.com/projects/ansible/latest/collections/community/proxmox/index.html)
  -- the modules, the inventory plugin, and the namespace migration out of `community.general`.
- [bpg/terraform-provider-proxmox](https://github.com/bpg/terraform-provider-proxmox) -- the
  maintained provider, its API-token and `ssh` auth, the `initialization` block, and
  unprivileged-LXC support.
- [proxmoxer](https://github.com/proxmoxer/proxmoxer) -- the Python wrapper, its backends, and the
  `ProxmoxAPI` usage shape.
- [Proxmox Cloud-Init Support wiki](https://pve.proxmox.com/wiki/Cloud-Init_Support) -- the native
  templating path that guide 07 teaches and that every higher-level tool drives.

---

Previous:
[15 -- Monitoring, maintenance, and notifications](15-monitoring-maintenance-and-notifications.md) |
Next: [17 -- Backups with Proxmox Backup Server](17-backups-with-pbs.md)
