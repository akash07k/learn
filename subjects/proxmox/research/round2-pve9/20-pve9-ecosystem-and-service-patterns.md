# PVE 9 Automation Ecosystem and Per-Service Deployment Patterns

Target: latest Proxmox VE 9.x (9.0/9.1/9.2 on Debian 13 "trixie"), mid-2026. Reader profile: single
node, shell-only, screen-reader user, host root on BTRFS. Accessibility backbone assumed throughout:
serial console, `pct enter`, `pvesh`, SSH.

This document has two parts:

1. The PVE 9 automation / ecosystem catalog.
2. A per-mission-service recommended deployment pattern.

It closes with an overall recommended toolset (use / optional / skip) for a single-node shell-only
screen-reader operator.

---

## Part 1 - PVE 9 Automation and Ecosystem Catalog

### 1.1 Proxmox VE Helper-Scripts (community-scripts, the ex-tteck project)

Current state in 2026:

- The original `tteck/Proxmox` repository was archived. tteck entered hospice care in October 2024
  and the project transitioned to a community team. The canonical home is now
  `community-scripts/ProxmoxVE` (site: community-scripts.org, mirror: community-scripts.github.io).
- It is actively maintained by volunteers, 300+ scripts, funded out of pocket; 30% of donations are
  forwarded to cancer/hospice research per tteck's wishes.
- The project README states support for "Version 8.4, 9.0, 9.1, or 9.2" of Proxmox VE. So PVE 9
  (including 9.2) is a first-class supported target.
- Each script offers a Default mode (sensible resource defaults, minimum prompts) and an Advanced
  mode (full control over container settings, networking, storage backends, app-level config). The
  prompts are plain text-mode whiptail/dialog menus driven from the Proxmox shell - workable, but
  the TUI menus are the least screen-reader-friendly part; the Default mode minimizes how much menu
  navigation is required.

The PVE 9 post-install script:

- Purpose: run once on a fresh node. It fixes APT sources, disables the enterprise repo, enables the
  no-subscription repo, removes the subscription nag, handles the Ceph repo and the
  high-availability packages, and offers optional quality-of-life tweaks. Each step is an individual
  yes/no prompt.
- PVE 9 specifics: it is adapted to the new Debian 13 / PVE 9 deb822 `.sources` format (the
  `/etc/apt/sources.list.d/*.sources` files) instead of the old `.list` files, and it auto-detects
  the PVE version to run the correct routine.
- Command (run in the Proxmox host root shell):

bash -c "$(curl -fsSL
<https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/tools/pve/post-pve-install.sh>)"

The LXC app-installer scripts:

- These live under `ct/` in the repo. Each creates an unprivileged LXC, installs the app natively
  (apt + systemd, not Docker), and prints the URL/credentials.
- Canonical command pattern (host root shell), e.g. Vaultwarden:

bash -c "$(curl -fsSL
<https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/vaultwarden.sh>)"

- The `wget` form is equivalent and also published:

bash -c "$(wget -qLO -
<https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/adguard.sh>)"

- Execution flow internally: `ct/<App>.sh` runs on the host, calls `build_container()`, which does
  `pct exec <CTID> bash -c "$(cat install/<App>-install.sh)"` so the install half runs inside the
  container.
- Known app scripts relevant to this mission (all `ct/<name>.sh`): `adguard`, `pihole`,
  `vaultwarden`, `miniflux`, `paperless-ngx`, `nextcloud` (also a Nextcloud-on-Alpine variant),
  `homeassistant` (HAOS-VM helper plus a HA-Core LXC variant), plus reverse proxies (`caddy`,
  `nginxproxymanager`), databases, and 300+ others. Browse the full list at
  community-scripts.org/scripts.

The honest curl|bash-as-root security caveat:

- The one-liner downloads a script from the internet and pipes it straight into a root shell on your
  hypervisor, with no pause and no review. This is the worst-case trust model: a compromised script
  (malice, a hijacked CDN/repo, or an edge-case bug) runs as root on the host and can take the whole
  node, not just one container. The project README does not carry an explicit "this is dangerous"
  disclaimer - it only lists "root shell access" as a requirement - so the caution is on the
  operator.
- Mitigations (all CLI/screen-reader friendly):
- Read first. Download, then read in `less` before executing:

curl -fsSL <https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/vaultwarden.sh> -o
vaultwarden.sh less vaultwarden.sh

- Snapshot first. On a BTRFS host root, take a BTRFS snapshot (`btrfs subvolume snapshot`) before
  running a host-level script such as post-install; for app scripts, the new CT is disposable, but a
  host snapshot still protects you. (ZFS users use `zfs snapshot`; the principle is identical.)
- Pin a commit. Instead of `main`, substitute a specific reviewed commit hash in the raw URL so the
  code cannot change under you between audit and run:

bash -c "$(curl -fsSL
<https://raw.githubusercontent.com/community-scripts/ProxmoxVE/><COMMIT_SHA>/ct/vaultwarden.sh)"

Even better for repeatability: `git clone` the repo, `git checkout <SHA>`, review, and run the local
copy. You can also self-host the repo (the project ships a local runner, ProxmoxVE-Local) so nothing
is fetched live.

- Grep for `eval`, `base64`, `curl`/`wget` to other hosts before trusting it.

Verdict: excellent for getting a known-good unprivileged LXC up in one minute, and a real time-saver
for the post-install chores. Treat every invocation as "run untrusted root code" and apply
read-first + snapshot + pin every time.

### 1.2 Ansible - the `community.proxmox` collection

- IMPORTANT migration: the Proxmox modules were extracted from `community.general` (v10.6.0,
  May 2025) into a dedicated `community.proxmox` collection (first release 0.1.0). Module
  short-names are unchanged; only the namespace moved:
- `community.general.proxmox_kvm` to `community.proxmox.proxmox_kvm` (VMs)
- `community.general.proxmox` to `community.proxmox.proxmox` (LXC containers)
- likewise `proxmox_nic`, `proxmox_disk`, `proxmox_storage`,
  `proxmox_user`/`proxmox_group`/`proxmox_acl`, the `proxmox` dynamic inventory plugin, etc. The old
  `community.general` names are now redirects and will be removed in `community.general` 15.0.0, so
  write new playbooks against `community.proxmox.*`.
- Install: `ansible-galaxy collection install community.proxmox` (and the `proxmoxer` + `requests`
  Python libs it depends on, on the controller).
- Use case: idempotent provisioning of VMs, LXC containers, users/tokens, ACLs, storage, and an
  inventory plugin to drive further config against the guests. This is the right tool once you have
  more than a handful of guests and want a declarative, re-runnable definition instead of one-shot
  scripts.
- Accessibility: pure YAML + CLI (`ansible-playbook`). Fully screen-reader friendly; no GUI
  anywhere.

### 1.3 OpenTofu / Terraform - the `bpg/proxmox` provider

- Provider source is `bpg/proxmox` in `required_providers` (the maintained successor to the
  abandoned `danitso/proxmox` fork - do not use Telmate's older provider for new work). Works with
  OpenTofu and Terraform identically.
- PVE 9 support: the provider explicitly targets Proxmox VE 9.x; PVE 8.x mostly works but is not
  actively tested, PVE 7.x is unsupported. So PVE 9 is the blessed target.
- Resource naming: newer resources use the short `proxmox_<name>` prefix; legacy ones use
  `proxmox_virtual_environment_<name>`. Both ship in one binary.
- Auth: prefer API token (`api_token = "user@realm!tokenid=secret"`) over user/password. Some
  operations (file uploads, certain VM/LXC ops) also need an `ssh` block on the provider. For
  destroyable running VMs set `stop_on_destroy = true`; for VMs with no guest agent also set it so
  plans can proceed.
- It can download cloud images / LXC templates (`proxmox_virtual_environment_download_file`), create
  VMs with a native cloud-init `initialization` block (IP config, user, SSH keys), and create
  unprivileged LXCs with `unprivileged = true` and a `features { nesting = true }` block.
- The honest single-node verdict: for ONE node, plain `qm`/`pct` shell scripts (or the Ansible
  collection) deliver roughly 90% of the value with far less ceremony. Terraform/OpenTofu shines
  with state, drift detection, and many nodes/teams; on a single homelab node the state file and
  provider quirks are mostly overhead. Recommend it only if you already know IaC or specifically
  want declarative drift control. Accessibility is fine (HCL + CLI, no GUI).

### 1.4 `proxmoxer` - Python wrapper for the PVE API

- A thin Python wrapper over the Proxmox REST API v2 (also covers PMG and PBS).
- Install: `pip install proxmoxer requests` (add `paramiko`/`openssh-wrapper` only for the SSH
  backends).
- Backends: `https` (default, talks to the API over the network), plus `ssh` backends (`openssh`,
  `paramiko`) and `local` execution that shell out to `pvesh`/`qm`/`pct` on the node itself.
- Auth: username+password, or (preferred) an API token; the SSH/local backends authenticate as the
  SSH/host user.
- Usage shape (REST verbs are methods; `create` is an alias for `post`):

```python
from proxmoxer import ProxmoxAPI proxmox = ProxmoxAPI("host", user="root@pam",
token_name="automation", token_value="<secret>", verify_ssl=True) proxmox.nodes("pve").lxc.create(
vmid=120, ostemplate="local-btrfs:vztmpl/debian-13-standard_13_amd64.tar.zst",
hostname="miniflux", cores=1, memory=512, rootfs="local-btrfs:4",
net0="name=eth0,bridge=vmbr0,ip=dhcp", unprivileged=1)
```

- Use case: bespoke scripting/glue, dynamic logic, integrating PVE into other Python automation.
  Best when Ansible/Terraform are too rigid and a shell script is too clumsy. Fully CLI/scriptable
  and screen-reader friendly.

### 1.5 The cloud-init image workflow - the native templating path

This is the built-in, dependency-free way to make golden VM templates; every higher-level tool
(Terraform, Ansible, proxmoxer) ultimately drives this.

Workflow (host root shell), Debian 13 example:

1. Download the cloud image (e.g. `debian-13-genericcloud-amd64.qcow2`).
2. `qm create 9000 --name debian13-tmpl --memory 2048 --cores 2 --net0 virtio,bridge=vmbr0`
3. Import the disk: `qm disk import 9000 debian-13-genericcloud-amd64.qcow2 local-btrfs` (or, in PVE
   9, `qm set 9000 --scsi0 local-btrfs:0,import-from=<path>`).
4. Attach it and a cloud-init drive:
   `qm set 9000 --scsihw virtio-scsi-single --scsi0 local-btrfs:9000/vm-9000-disk-0.raw`
   `qm set 9000 --ide2 local-btrfs:cloudinit`
5. Boot/console: `qm set 9000 --boot order=scsi0 --serial0 socket --vga serial0` (the
   `serial0`/`vga serial0` pair is exactly what makes `qm terminal` serial-console access work -
   important for the screen-reader workflow).
6. Cloud-init params: `qm set 9000 --ciuser debian --sshkeys ~/.ssh/id_ed25519.pub` (plus
   `--ipconfig0 ip=dhcp` or a static address).
7. `qm template 9000`. Then clone per service: `qm clone 9000 130 --name webvm`.

The `--serial0 socket --vga serial0` step is the accessibility linchpin: it gives every cloned VM a
text serial console reachable with `qm terminal <id>`, no GUI/noVNC needed.

---

## Part 2 - Per-Mission-Service Deployment Recommendations

Decision menu used for each service: A) unprivileged LXC (lightest; `pct enter` is the most
accessible path). B) a Helper-Scripts LXC (an unprivileged LXC built for you by 1.1). C) a
Docker-Compose stack inside ONE Debian VM (Proxmox's official line is Docker belongs in a VM, not an
LXC). D) a dedicated VM (full isolation / appliance OS).

General accessibility note: LXC wins on accessibility because `pct enter <id>` drops you straight
into a root shell with zero networking/console setup. VMs are reached via `qm terminal <id>` (serial
console, configured as in 1.5) or SSH.

### Pi-hole or AdGuard Home

- Recommended: unprivileged LXC, via the Helper-Scripts `pihole` or `adguard` script (pattern B). A
  single lightweight LXC is ideal for a DNS sinkhole.
- Why: DNS filtering is a simple native service; no Docker benefit. LXC is the lightest option and
  survives host reboots cleanly. AdGuard Home is the more shell-friendly of the two (single Go
  binary, YAML config, REST API); Pi-hole is also fine. Pick one - running both for the same role is
  redundant.
- Sizing: 1 vCPU, 256-512 MB RAM, 2-4 GB disk.
- Accessibility: `pct enter` for config; both expose CLI/config-file control so the web dashboard is
  optional, not required. Give it a static IP so it can be your LAN resolver.

### Vaultwarden (Bitwarden-compatible server)

- Recommended: unprivileged LXC, via the Helper-Scripts `vaultwarden` script (pattern B). Single
  Rust binary + SQLite; perfect LXC fit.
- Why: lightweight, native, no Docker needed; the helper script wires up the systemd service.
  Security-sensitive, so keep it minimal and snapshot before upgrades.
- Sizing: 1 vCPU, 512 MB RAM, 4-8 GB disk.
- Accessibility: `pct enter` to edit the env/config and read logs (`journalctl -u vaultwarden`).
  Front it with a reverse-proxy LXC (Caddy) for TLS; admin via the API/CLI is possible.

### Miniflux (RSS reader)

- Recommended: unprivileged LXC, via the Helper-Scripts `miniflux` script (pattern B). Single Go
  binary backed by PostgreSQL.
- Why: minimal footprint, native install, no Docker upside. Miniflux has a first-class CLI
  (`miniflux -flush-history`, user creation via flags) and a clean REST API, so it is very
  shell-operable.
- Sizing: 1 vCPU, 512 MB RAM (PostgreSQL included), 4-8 GB disk.
- Accessibility: `pct enter`; manage users and maintenance from the CLI.

### Paperless-ngx (document management)

- Recommended: pragmatic split.
- Cleanest/most-supported: Docker-Compose inside one Debian VM (pattern C). The Paperless-ngx
  developers ship and support docker-compose; the stack is multi-service (web, worker, PostgreSQL,
  Redis, Gotenberg, Tika).
- Lighter alternative: the Helper-Scripts `paperless-ngx` LXC (pattern B), which does a bare-metal
  native install (Debian 13 + PostgreSQL + Redis, no Docker). Excellent on resources; you accept
  that it diverges from the upstream-blessed docker path for upgrades.
- Why: it is the one mission service that is genuinely Docker-first upstream. If you want to track
  upstream exactly, use the VM+Compose; if you want the lightest accessible box and are comfortable
  with the community install, use the LXC.
- Sizing: 2 vCPU, 2-4 GB RAM (OCR is CPU/RAM hungry on big batches), 16+ GB disk plus a bind/NFS
  mount for the document store and consume directory.
- Accessibility: LXC to `pct enter`. VM to SSH in and drive `docker compose`. Both are fully
  shell-operable; mount the consume dir from your NAS.

### Nextcloud

- Recommended: unprivileged LXC, via the Helper-Scripts `nextcloud` script (pattern B); the
  Nextcloud-on-Alpine variant is the lightest.
- Why: a native LXC (Nextcloud + PHP-FPM + a web server + PostgreSQL/MariaDB + Redis) is the common,
  well-trodden homelab path and is fully manageable from the shell via `occ`
  (`php occ maintenance:mode`, `occ user:add`, etc.). Avoid the all-in-one Docker image's
  nested-Docker complications. A dedicated VM (pattern D) is the choice only if you want hard
  isolation for external exposure.
- Sizing: 2 vCPU, 2-4 GB RAM, 10 GB system disk plus a large data volume (bind-mount or NFS from the
  BTRFS host / NAS).
- Accessibility: `pct enter`, then the `occ` CLI does essentially everything the web admin does -
  strong screen-reader story.

### Drupal (personal website / CMS)

- Recommended: unprivileged LXC running the LAMP/LEMP stack natively (pattern A) - Debian 13 +
  PHP-FPM + Apache or Nginx + MariaDB/PostgreSQL + Composer + Drush. (No first-party Drupal helper
  script, so build the LXC yourself or clone your cloud-init template.)
- Why: Drupal is a standard PHP app; an LXC is light and Drush gives a complete CLI (`drush cr`,
  `drush updatedb`, `drush user:create`). Use a dedicated VM only if you must match a Docker-based
  dev/prod parity setup; otherwise LXC.
- Sizing: 1-2 vCPU, 1-2 GB RAM, 8-16 GB disk.
- Accessibility: `pct enter` + Drush is fully scriptable and screen-reader friendly. Front with the
  same Caddy reverse-proxy LXC for TLS.

### Home Assistant

- Recommended: HAOS as a dedicated VM (pattern D) - this is the official, supported install. The
  Helper-Scripts project provides a `homeassistant` VM helper that downloads the HAOS image and
  builds the VM for you.
- Why: HAOS-in-a-VM gives the Supervisor and the Add-on Store (one-click Mosquitto, Zigbee2MQTT,
  ESPHome, backups) and managed OS updates. The alternative - HA Container in an LXC (pattern A/B) -
  is lighter but strips the Supervisor and add-ons, leaving you to install/maintain every dependency
  by hand; it is officially unsupported for the full experience. Choose the LXC only on very
  RAM-constrained hardware.
- Sizing (HAOS VM): 2 vCPU, 2-4 GB RAM, 32 GB disk; pass through any USB Zigbee/Z-Wave stick to the
  VM.
- Accessibility: reach the VM via `qm terminal` serial console or SSH; the bulk of HA configuration
  is YAML files you can edit over SSH, and the HA CLI / API cover most management. (The dashboard
  itself is web-only, but day-to-day config is file-based.)

### Personal website

- Recommended: depends on type.
- Static site (Hugo/Astro/plain HTML): unprivileged LXC running Caddy or Nginx (pattern A). Tiny,
  trivially snapshot-able, auto-HTTPS via Caddy. This is the best default for a personal site.
- Dynamic/CMS (WordPress, Ghost, the Drupal above): unprivileged LXC with the native stack (pattern
  A), same reasoning as Drupal.
- Why: a static site needs almost nothing; an LXC with Caddy is the lightest, most accessible option
  and Caddy handles TLS automatically.
- Sizing: static 1 vCPU / 256-512 MB / 2-4 GB; CMS 1-2 vCPU / 1 GB / 8 GB.
- Accessibility: `pct enter`; deploy via `git pull` + a build step or rsync over SSH. Reuse one
  Caddy reverse-proxy LXC in front of all web services.

### Throwaway dev/test VM

- Recommended: a dedicated VM cloned from your cloud-init template (pattern D), with
  `stop_on_destroy`-style disposability in mind; snapshot, break, roll back, or delete and re-clone.
- Why: a VM gives a full, isolated kernel so you can install Docker, run nested virtualization, test
  other distros, and trash it without risking the host - exactly what an LXC cannot safely give you.
  Cloning from the cloud-init template makes spin-up a one-liner (`qm clone 9000 <newid>`).
- Sizing: 2 vCPU, 2-4 GB RAM, 20 GB disk (linked clone keeps it cheap); scale per experiment.
- Accessibility: `qm terminal` serial console (because the template set
  `--serial0 socket --vga serial0`) plus SSH. Take a BTRFS/qcow snapshot before each risky
  experiment and roll back instantly.

---

## Part 3 - Recommended Overall Toolset (single-node, shell-only, screen-reader)

USE (core):

- Native `qm` / `pct` / `pvesh` / `qm terminal` / `pct enter` - the foundation. For one node these
  cover ~90% of provisioning needs and are the most accessible path.
- The cloud-init template workflow (1.5) with `--serial0 socket --vga serial0` baked into every
  template - your VM golden image and the key to serial-console access.
- Proxmox VE Helper-Scripts (1.1) for the PVE 9 post-install chore and for quick unprivileged-LXC
  app installs (Pi-hole/AdGuard, Vaultwarden, Miniflux, Nextcloud, the Paperless LXC, the HAOS VM
  helper) - always with read-first + snapshot + pin-a-commit.
- One reverse-proxy LXC (Caddy) in front of all web services for automatic TLS.

OPTIONAL (add when scale or preference justifies it):

- Ansible `community.proxmox` collection - once you have many guests and want idempotent,
  declarative, re-runnable provisioning and config. Pure YAML/CLI.
- `proxmoxer` (Python) - for bespoke glue/automation that Ansible/Terraform cannot express cleanly.
- OpenTofu/Terraform `bpg/proxmox` provider - only if you already want IaC with state and drift
  detection; otherwise skip it on a single node (it is mostly overhead here, by its own community's
  admission).

SKIP (low value for this operator):

- Web-dashboard-centric management/orchestration tools that assume mouse-driven GUIs and add no CLI:
  Portainer (Docker GUI - use `docker compose` over SSH instead), Cockpit-as-primary-UI, Proxmox
  Datacenter Manager's web UI as the main workflow, ProxmoxVE-Local's web runner (use the raw
  scripts/CLI), Nginx Proxy Manager's GUI (prefer Caddy's text Caddyfile), and any "single pane of
  glass" homelab dashboard (Homarr/Heimdall/Dashy) - these are visual launchers with no operational
  value for a screen-reader, shell-only operator.

Web dashboards to specifically skip (GUI-only, no CLI parity worth the trouble): Portainer, Nginx
Proxy Manager, Homarr/Heimdall/Dashy, Cockpit. Where a service ships both a CLI and a dashboard
(Nextcloud `occ`, Pi-hole/AdGuard, Miniflux, Home Assistant YAML), drive it from the CLI/config
files and treat the dashboard as optional.

---

## Sources

- community-scripts/ProxmoxVE GitHub and README:
  [GitHub - community-scripts/ProxmoxVE: Proxmox VE Helper-Scripts (Community Edition)](https://github.com/community-scripts/ProxmoxVE)
- PVE post-install script docs:
  [Proxmox VE Scripts](https://community-scripts.org/scripts/post-pve-install)
- Helper-Scripts site (all scripts):
  [All scripts | Proxmox VE Helper Scripts](https://community-scripts.org/scripts)
- tteck project transition / hospice notice:
  [Proxmox VE Helper-Scripts Project Update (EDIT) · tteck Proxmox · Discussion #4009](https://github.com/tteck/Proxmox/discussions/4009)
- curl|bash security caveat:
  [I love Proxmox community scripts, but a single command executes 8 remote scripts as root](https://www.xda-developers.com/love-proxmox-community-scripts-one-commands-scripts-root/)
- Safe-use practices (read-first, snapshot, pin):
  [Proxmox Community Helper Scripts: What They Do and How to Use Them Safely](https://proxmoxr.com/blog/proxmox-helper-scripts)
- Ansible community.proxmox migration:
  [Community.Proxmox](https://docs.ansible.com/projects/ansible/latest/collections/community/proxmox/index.html)
- community.proxmox migration guide:
  [Migration and Upgrade Guide | ansible-collections/community.proxmox](https://deepwiki.com/ansible-collections/community.proxmox/14-migration-and-upgrade-guide)
- bpg/terraform-provider-proxmox (Context7 + docs):
  [GitHub - bpg/terraform-provider-proxmox: Terraform / OpenTofu Provider for Proxmox VE](https://github.com/bpg/terraform-provider-proxmox)
- bpg provider cloud-init guide:
  [terraform-provider-proxmox/docs/guides/cloud-init.md at main · bpg/terraform-provider-proxmox](https://github.com/bpg/terraform-provider-proxmox/blob/main/docs/guides/cloud-init.md)
- proxmoxer library:
  [GitHub - proxmoxer/proxmoxer: python wrapper for Proxmox API v2](https://github.com/proxmoxer/proxmoxer)
  and [Basic Usage - Proxmoxer Documentation](https://proxmoxer.github.io/docs/latest/basic_usage/)
- Proxmox Cloud-Init Support (official wiki):
  [Cloud-Init Support](https://pve.proxmox.com/wiki/Cloud-Init_Support)
- Docker-in-VM official recommendation:
  [Proxmox (7.1) and Docker: LXC vs VM](https://forum.proxmox.com/threads/proxmox-7-1-and-docker-lxc-vs-vm.105140/)
- Home Assistant HAOS-VM vs LXC:
  [Home Assistant Proxmox 9 Install Guide (2026)](https://smarthomescene.com/guides/how-to-install-home-assistant-on-proxmox-the-easy-way/)
- Paperless-ngx LXC vs Docker:
  [\[SOLVED\] - paperless-ngx - LXC oder VM](https://forum.proxmox.com/threads/paperless-ngx-lxc-oder-vm.179263/)
- Nextcloud / Caddy on LXC:
  [Caddy Installation Guide for Proxmox LXC 9 (Debian 13)](https://hakedev.substack.com/p/caddy-installation-guide-for-proxmox)
