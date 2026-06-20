# Proxmox VE Ecosystem: Tools, Add-ons, and Automation (Single-Node, Shell-Only)

Audience: a blind screen-reader user running a single Proxmox VE node entirely from the CLI. The web
GUI is inaccessible, so every tool below is flagged CLI / API / GUI, and rated **use / optional /
skip** for this specific setup. Target: PVE 8.x on Debian 12 (notes for 9.x where relevant).

Quick legend for each entry: what it does, install/use command, interface (CLI / API / GUI-only),
recommendation.

---

## 1. Proxmox VE Helper-Scripts (community-scripts, formerly tteck)

### What it is

A community-driven collection of Bash scripts that automate Proxmox host setup and "one-command"
deployment of hundreds of self-hosted apps as LXC containers (and some VMs). Originally written by
`@tteck`, who has since passed away; the project is now maintained by community volunteers under the
`community-scripts` GitHub org. Website: **community-scripts.org** (formerly
community-scripts.github.io/ProxmoxVE). Repo: `github.com/community-scripts/ProxmoxVE`.

The model: browse the website, copy a one-line `bash -c "$(curl ...)"` command, paste it into the
Proxmox shell, answer a few prompts. Two modes: **Default** (sensible defaults, install in under ~5
min) and **Advanced** (full control over cores, RAM, disk, network, storage). Each app container
also ships a small update/management helper script inside it.

Interface: **CLI** (runs in the PVE shell). This is one of the most shell-friendly,
screen-reader-friendly parts of the whole ecosystem, since it is text prompts, not a web UI. Note:
the interactive prompts use `whiptail`/`dialog` TUI menus, which are mostly navigable but can be
fiddly with a screen reader; Default mode minimizes the number of prompts.

### Most useful scripts

**PVE Post Install** - the single most important one. Run on a fresh install:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/tools/pve/post-pve-install.sh)"
```

What it does (you are prompted yes/no for each):

- Disables the **Enterprise** APT repo and enables the free **no-subscription** repo (so
  `apt update` works without a paid subscription).
- Adds/enables the Ceph no-subscription repo entry (you can decline on a single node).
- Removes the **"No valid subscription"** nag popup in the web GUI (irrelevant to a CLI user, but
  harmless).
- Offers to **disable HA services** (`pve-ha-lrm`, `pve-ha-crm`, `corosync`) - exactly what you want
  on a single node: frees RAM and stops pointless background activity.
- Runs `apt update && apt dist-upgrade`. Verify: cross-check `/etc/apt/sources.list.d/` afterward
  (PVE 8.x moved to `.sources` deb822 files on recent point releases / PVE 9.x).

**LXC app installers** - hundreds of one-liners (Home Assistant, Jellyfin/Plex, AdGuard Home,
Pi-hole, Nginx Proxy Manager, Paperless-ngx, Gotify, Grafana, Prometheus, InfluxDB, Uptime Kuma,
Docker, etc.). Each creates a Debian/Alpine LXC, installs the app, and prints the container IP.
Useful here because you get a working service without touching the GUI.

**Update scripts** - most app containers include an `update` helper; re-running the same install
command on an existing container typically offers to update it. There are also maintenance scripts
(e.g., "Proxmox VE Processor Microcode", "Kernel Clean" to remove old kernels, "Netdata", "CPU
Scaling Governor", LXC filesystem trim).

### Security / trust caveat (important - be honest)

`curl | bash` runs **unreviewed code from the internet as root on your hypervisor**. The
post-install one-liner in turn pulls and runs several more remote scripts. Risks:

- A compromised repo, CDN, or a malicious PR merged by a volunteer maintainer would execute with
  full root on the host.
- After tteck's death, several maintainers reportedly resigned over governance/direction concerns,
  so review rigor is community-dependent, not guaranteed.

Mitigations for a careful single-node user:

1. **Download then read before running**, do not pipe blindly:

```bash
curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/tools/pve/post-pve-install.sh -o post.sh
less post.sh # review
bash post.sh
```

(Scripts are short Bash; a screen reader can read them in `less`/editor.) 2. Take a **ZFS/LVM
snapshot or a config backup** of the host before running host-level scripts. 3. Prefer the **PVE
Post Install** and a few well-known app scripts; avoid obscure ones. 4. Pin to a known commit if you
want reproducibility (replace `main` with a commit SHA).

**Recommendation: USE - for PVE Post Install (high value), OPTIONAL for app installers (review
first). The post-install script is the fastest way to fix repos + disable HA on a single node.**
Caveat: always review before running as root.

Sources:

- [GitHub - community-scripts/ProxmoxVE: Proxmox VE Helper-Scripts (Community Edition)](https://github.com/community-scripts/ProxmoxVE)
- [Proxmox VE Helper-Scripts](https://community-scripts.org/)
- [Proxmox VE Scripts](https://community-scripts.org/scripts/post-pve-install)
- [I love Proxmox community scripts, but a single command executes 8 remote scripts as root](https://www.xda-developers.com/love-proxmox-community-scripts-one-commands-scripts-root/)
- [Proxmox Community Helper Scripts: What They Do and How to Use Them Safely](https://proxmoxr.com/blog/proxmox-helper-scripts)

---

## 2. Infrastructure-as-Code (IaC) for a single node

### Is IaC worth it for ONE node?

Short answer: **mostly optional, leaning skip for VMs/LXC churn, but worthwhile if you value
reproducibility / want to rebuild the node from scratch deterministically.** For a single home node,
plain `qm`/`pct` shell scripts + cloud-init templates (section 5) give 90% of the benefit with far
less moving machinery. IaC pays off when you (a) frequently create/destroy guests, (b) want
everything in git, or (c) plan to migrate hosts. All IaC options below are fully CLI/text-driven,
which suits a screen-reader user well.

### 2a. Ansible (community.proxmox collection)

**What:** Agentless automation. The Proxmox modules moved out of `community.general` into a
dedicated **`community.proxmox`** collection (the old `community.general.proxmox` / `proxmox_kvm`
names are deprecated and redirect there). Key modules: `proxmox` (LXC lifecycle), `proxmox_kvm`
(VMs), `proxmox_disk`, `proxmox_template`, `proxmox_storage`, plus a `proxmox` dynamic inventory
plugin and `proxmox_pct_remote` connection plugin.

**Install/use (CLI):**

```bash
ansible-galaxy collection install community.proxmox
pip install proxmoxer requests # modules use proxmoxer under the hood
```

Then a playbook task uses `community.proxmox.proxmox_kvm` / `.proxmox` with an API token.

**Recommendation: OPTIONAL.** Best IaC fit for one node if you already know Ansible -
imperative-ish, no state file to babysit, reads cleanly as YAML in a screen reader. Good for
"configure the host + provision a few guests" combined workflows.

Sources:

- [Community.Proxmox](https://docs.ansible.com/projects/ansible/latest/collections/community/proxmox/index.html)
- [LXC Containers | ansible-collections/community.proxmox](https://deepwiki.com/ansible-collections/community.proxmox/4.2-lxc-containers)

### 2b. Terraform / OpenTofu - bpg/terraform-provider-proxmox

**What:** The actively maintained Proxmox provider (fork of the dead `danitso`/`Telmate` providers).
Provider source: **`bpg/proxmox`**. Compatible with PVE **9.x** (tested) and 8.x (mostly works).
Manages VMs, LXC, cloud images, cloud-init, files/snippets, storage, users, etc. OpenTofu is the
FOSS drop-in for Terraform and works identically here.

**Minimal single-node config (text/CLI):**

```hcl
terraform {
 required_providers {
 proxmox = { source = "bpg/proxmox" }
 }
}

provider "proxmox" {
 endpoint = "https://192.168.1.10:8006/"
 api_token = "terraform@pve!provider=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
 insecure = true
 ssh { agent = true; username = "terraform" } # needed for file uploads / some ops
}
```

A VM-from-cloud-image example (download_file + vm resource with `initialization` and
`disk { import_from = ... }`, `stop_on_destroy = true`) is in the provider's cloud-init guide.
Default single-node assumptions: node named **`pve`**, storages `local` and `local-lvm`; override
node via `virtual_environment_node_name`. Prefer **API token** auth over username/password; note a
few operations still require password auth.

Run with: `tofu init && tofu plan && tofu apply` (or `terraform ...`).

**Recommendation: OPTIONAL (skip unless you want git-tracked, reproducible guests).** For a single
home node the state-file overhead rarely pays off; if you do adopt IaC, this provider + OpenTofu is
the right choice. CLI/text-only - screen-reader friendly.

Sources:

- [GitHub - bpg/terraform-provider-proxmox: Terraform / OpenTofu Provider for Proxmox VE](https://github.com/bpg/terraform-provider-proxmox)
- [Provider: Proxmox Virtual Environment - Terraform Provider for Proxmox VE](https://bpg.sh/docs/)
- [Terraform Registry](https://registry.terraform.io/providers/bpg/proxmox/latest/docs)
- (Context7 `/bpg/terraform-provider-proxmox` cloud-init + index guides)

---

## 3. API client libraries (for scripting)

### 3a. proxmoxer (Python) - RECOMMENDED for scripting

**What:** A thin Python wrapper over the Proxmox REST API v2 (PVE, PBS, PMG). Lets you script VM/LXC
create, clone, cloud-init config, backups, status polling, etc. Used internally by the Ansible
modules.

**Install/use (CLI/library):**

```bash
pip install proxmoxer requests
```

```python
from proxmoxer import ProxmoxAPI
prox = ProxmoxAPI("192.168.1.10", user="root@pam",
 token_name="auto", token_value="xxxx", verify_ssl=False)
print(prox.nodes("pve").status.get()) # node status as a dict
prox.nodes("pve").qemu(9000).clone.post(newid=101, name="web")
prox.nodes("pve").qemu(101).config.set(ciuser="admin", sshkeys="...", ipconfig0="ip=dhcp")
```

The official docs include a dedicated cloud-init example (set `ciuser`, `cipassword`, `sshkeys`,
`ipconfig0`, `nameserver` on a cloned template).

**Recommendation: USE (if you script at all).** Best balance of power and simplicity for a shell
user who wants to automate beyond one-off `qm`/`pct` commands. Pure text.

Sources:

- [GitHub - proxmoxer/proxmoxer: python wrapper for Proxmox API v2](https://github.com/proxmoxer/proxmoxer)
- [Cloud-init - Proxmoxer Documentation](https://proxmoxer.github.io/docs/latest/examples/cloud-init/)
- [proxmoxer](https://pypi.org/project/proxmoxer/)

### 3b. go-proxmox (luthermonson) - for Go users

**What:** Typed Go client wrapping the full `/api2/json` surface for PVE 8.x/9.x. Supports API-token
and credential auth. `go get github.com/luthermonson/go-proxmox`. **Recommendation: OPTIONAL** -
only if you prefer Go. proxmoxer covers most home needs. Sources:
[GitHub - luthermonson/go-proxmox: Go client with types and tests for the Proxmox-VE REST API](https://github.com/luthermonson/go-proxmox)
, [proxmox package](https://pkg.go.dev/github.com/luthermonson/go-proxmox)

---

## 4. Cloud-init image workflow (fast VM provisioning) - RECOMMENDED

### What it does

Instead of installing an OS from an ISO each time, download a vendor **cloud image**, turn it into a
Proxmox **template** once, then `qm clone` for instant VMs. Cloud-init injects user, SSH key, and
network on first boot. This is the single most useful shell-native VM workflow and needs **no GUI**.

### Commands (all CLI)

```bash
# 1. Download a cloud image
wget https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2
# or Ubuntu: https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img

# 2. Create the template VM shell
qm create 9000 --name debian12-tmpl --memory 2048 --cores 2 --net0 virtio,bridge=vmbr0

# 3. Import the disk and attach
qm importdisk 9000 debian-12-genericcloud-amd64.qcow2 local-lvm
qm set 9000 --scsihw virtio-scsi-pci --scsi0 local-lvm:vm-9000-disk-0
qm set 9000 --boot order=scsi0 --serial0 socket --vga serial0

# 4. Add a cloud-init drive + defaults
qm set 9000 --ide2 local-lvm:cloudinit
qm set 9000 --ciuser admin --sshkeys ~/.ssh/authorized_keys --ipconfig0 ip=dhcp
qm disk resize 9000 scsi0 20G # grow before templating; FS auto-expands on boot

# 5. Convert to template, then clone
qm template 9000
qm clone 9000 101 --name web01 --full
qm set 101 --ipconfig0 ip=192.168.1.50/24,gw=192.168.1.1
qm start 101
```

Tip: `--serial0 socket --vga serial0` gives a text serial console (`qm terminal 101`), which is far
more screen-reader friendly than the GUI noVNC console.

**Recommendation: USE.** Core shell workflow; pairs well with proxmoxer/Ansible/Terraform for full
automation.

Sources:

- [Cloud-Init Support](https://pve.proxmox.com/wiki/Cloud-Init_Support)
- [Cloud Init Templates in Proxmox VE - Quickstart - Thomas-Krenn-Wiki-en](https://www.thomas-krenn.com/en/wiki/Cloud_Init_Templates_in_Proxmox_VE_-_Quickstart)
- [GitHub - UntouchedWagons/Ubuntu-CloudInit-Docs: A short guide for setting up a Ubuntu VM template in proxmox using CloudInit](https://github.com/UntouchedWagons/Ubuntu-CloudInit-Docs)

---

## 5. Monitoring & metrics

### 5a. Built-in External Metric Server (InfluxDB / Graphite / OpenTelemetry)

**What:** PVE can push host/guest/storage metrics to an external time-series DB. Defined in
**`/etc/pve/status.cfg`**, or via the API/`pvesh`. Supported types: **Graphite** (default UDP 2003),
**InfluxDB** (UDP 8089, or HTTP/HTTPS for v2/v1.8+), and **OpenTelemetry** (PVE 8.2+). Interface:
**CLI/API + file** (the GUI editor under Datacenter to Metric Server is inaccessible, but you do not
need it).

**Configure via file (`/etc/pve/status.cfg`):**

```text
influxdb: mydb
 server 192.168.1.20
 port 8086
 influxdbproto http
 organization proxmox
 bucket proxmox
 token <influx-api-token>

graphite: mygraphite
 server 192.168.1.21
 port 2003
 proto udp
```

**Configure via CLI (`pvesh`):**

```bash
pvesh create /cluster/metrics/server/mydb \
 --type influxdb --server 192.168.1.20 --port 8086 \
 --influxdbproto http --organization proxmox --bucket proxmox --token <token>

pvesh get /cluster/metrics/server # list
pvesh delete /cluster/metrics/server/mydb # remove
```

**Recommendation: OPTIONAL.** Great if you already run InfluxDB+Grafana; the push model is reliable.
But Grafana itself is a web UI (see caveat in 5b).

Sources:

- [External Metric Server](https://pve.proxmox.com/wiki/External_Metric_Server)
- [Configure External Metric Server via cli](https://forum.proxmox.com/threads/configure-external-metric-server-via-cli.147956/)
- [InfluxDB2 + Grafana Configuration of a metric server for Proxmox VE - Thomas-Krenn-Wiki-en](https://www.thomas-krenn.com/en/wiki/InfluxDB2_+_Grafana_Configuration_of_a_metric_server_for_Proxmox_VE)

### 5b. prometheus-pve-exporter + Prometheus + Grafana

**What:** A Python exporter that scrapes the PVE API and exposes Prometheus metrics at `/pve`;
Prometheus stores them; a prebuilt Grafana dashboard (ID **10347**) visualizes them. Requires Python
3.9+ and a PVE API token.

```bash
pip install prometheus-pve-exporter # or run the official Docker image
# /etc/prometheus/pve.yml holds the API token; pve_exporter then serves :9221/pve
```

Prometheus `scrape_config` targets the exporter with `metrics_path: /pve` and params
`module=[default]`. **Accessibility caveat:** Grafana is **GUI-only** for dashboards (no real CLI
view). Prometheus has a CLI-ish HTTP API (`curl 'localhost:9090/api/v1/query?query=...'`) and the
exporter output is plain text, but the intended consumption is a web UI. **Recommendation: OPTIONAL
/ lean SKIP for a screen-reader user** - heavy stack whose payoff is visual dashboards. Prefer CLI
dashboards (5e) instead, or use it headless only if you query Prometheus via its HTTP API.

Sources:

- [GitHub - prometheus-pve/prometheus-pve-exporter: Exposes information gathered from Proxmox VE cluster for use by the Prometheus monitoring system](https://github.com/prometheus-pve/prometheus-pve-exporter)
- [Proxmox via Prometheus](https://grafana.com/grafana/dashboards/10347-proxmox-via-prometheus/)

### 5c. Netdata

**What:** Per-host metrics agent with auto-discovery (incl. a Proxmox/cgroups + SMART collector).
One-line install:

```bash
bash <(curl -Ss https://my-netdata.io/kickstart.sh)
```

**Accessibility caveat:** primary interface is a **web dashboard** (`:19999`). It does expose a
`/api/v1/...` JSON API and the data is queryable from CLI, but day-to-day use is visual.
**Recommendation: OPTIONAL / SKIP** for a screen-reader-first user; the live TUIs below are more
usable. (Helper-Scripts has a Netdata installer if wanted.) Source:
[Proxmox VE](https://www.netdata.cloud/integrations/data-collection/containers-and-vms/proxmox-ve/)

### 5d. smartmontools / smartd (disk health) - RECOMMENDED

**What:** SMART monitoring. **Already installed and `smartd` enabled by default on PVE** (since
4.3). Pure CLI; perfect for a shell user.

```bash
smartctl -a /dev/sda # full SMART report (text)
smartctl -H /dev/sda # quick health: PASSED / FAILED
smartctl -t short /dev/sda # run a self-test
```

Configure email alerts in `/etc/smartd.conf` (works with the PVE notification system in section 6).
**Recommendation: USE** - zero-cost, text-only early warning of disk failure. Sources:

- [Disk Health Monitoring](https://pve.proxmox.com/wiki/Disk_Health_Monitoring)
- [S.m.a.r.t (learn.netdata.cloud)](https://learn.netdata.cloud/docs/collecting-metrics/hardware-devices-and-sensors/s.m.a.r.t).

### 5e. CLI/TUI dashboards (best path for a screen-reader user) - RECOMMENDED

The most accessible monitoring is text on demand, not live-redrawing TUIs or web dashes.

**Native PVE API via pvesh (text, on demand - best for screen readers):**

```bash
pvesh get /nodes/<node>/status # CPU, RAM, load, uptime, kernel
pvesh get /nodes/<node>/status --output-format yaml
pvesh get /cluster/resources --type vm # all guests, status, RAM, CPU
pvesh get /nodes/<node>/qemu/<vmid>/status/current
pvenode status # node summary
pvereport # full system report (host, storage, net)
pveperf # quick CPU/disk benchmark
qm list ; pct list # guests at a glance
qm status <vmid> ; pct status <ctid>
```

These print a static block of text you can read top-to-bottom - ideal. `--output-format yaml`/`json`
makes them script- and reader-friendly.

**Interactive monitors (CLI, run over SSH):**

- **htop** (`apt install htop`) - process/CPU/RAM; reasonably screen-reader navigable.
- **btop** (`apt install btop`) - prettier graphs but heavily visual; less reader-friendly.
- **glances** (`apt install glances` or `pip install glances`) - `glances` for TUI, but notably
  `glances --stdout cpu,mem,load` prints **plain non-redrawing lines**, and `glances -w` exposes a
  JSON/REST API and an optional web mode. The `--stdout` mode is a good accessible middle ground.
- **iostat / vmstat / free -h / df -h** - classic one-shot text stats.

**Recommendation: USE - `pvesh get .../status`, `pvereport`, `qm/pct list`, plus htop or
`glances --stdout` are the recommended monitoring path for this user.** Skip the web/TUI-graph tools
as primary interfaces.

Sources:

- [Command Line Tools](https://pve.proxmox.com/wiki/Command_Line_Tools)
- [Btop, Glances, or Netdata? The Best Ways to Monitor Your Proxmox Server | by Mr.PlanB](https://medium.com/@PlanB./btop-glances-or-netdata-the-best-ways-to-monitor-your-proxmox-server-e98e1cddc223)

---

## 6. Notifications (PVE notification system) - RECOMMENDED

### What it does

Since PVE 8.1 there is a unified notification system with **targets** (where alerts go) and
**matchers** (which events route where). Used for backup results, replication, disk (SMART)
failures, certificate expiry, etc. Config files live in `/etc/pve/notifications.cfg` and
`/etc/pve/priv/notifications.cfg` (secrets); manageable via the GUI **or** the API/ `pvesh`.
Interface: **CLI/API + file** (GUI optional, inaccessible - not required).

### Supported target types

- **sendmail** - uses the host MTA to email configured users/addresses.
- **smtp** - talks directly to an SMTP relay (no local MTA needed). Good for Gmail/relay.
- **gotify** - self-hosted push server; needs server URL + app token.
- **webhook** - arbitrary HTTP POST with templating; **this is how you integrate ntfy.sh** (ntfy has
  no built-in target type - wire it through a webhook target).

### Configure via CLI (examples)

```bash
# SMTP email target
pvesh create /cluster/notifications/endpoints/smtp/mail \
 --server smtp.example.com --port 587 --mode starttls \
 --from-address pve@example.com --mailto you@example.com \
 --username pve@example.com --password '****'

# Gotify target
pvesh create /cluster/notifications/endpoints/gotify/push \
 --server https://gotify.example.com --token <app-token>

# ntfy via webhook target
pvesh create /cluster/notifications/endpoints/webhook/ntfy \
 --url "https://ntfy.sh/my-proxmox-topic" --method post \
 --body '{{ "{{ message }}" }}'
```

(Exact field names: check `pvesh usage /cluster/notifications/endpoints/...`.)

**Recommendation: USE** - set up at least an email (smtp/sendmail) target so backup and SMART
failures reach you. Gotify/ntfy optional for push. Fully scriptable, no GUI needed.

Sources:

- [Notifications](https://pve.proxmox.com/pve-docs/chapter-notifications.html)
- [Notifications](https://pve.proxmox.com/wiki/Notifications)
- [Proxmox Notification System: Matchers, Targets, SMTP, Gotify, and Webhooks](https://datazone.de/en/aktuelles/proxmox-notifications-alerting/)

---

## 7. Backup add-on: Proxmox Backup Server (PBS) + client

### What it does

PBS is Proxmox's dedicated, deduplicating, incremental backup server. Two relevant uses on a single
node:

1. **Full PBS server** (separate install/VM) as a backup datastore for VM/LXC backups, integrated
   into PVE as a storage target - but its admin UI is a **web GUI**.
2. **`proxmox-backup-client`** (CLI only) to back up the **host filesystem itself** (`/etc`,
   `/root`, configs) - which `vzdump` does not cover.

### Install / use

```bash
# Add the client repo, then:
apt update && apt install proxmox-backup-client # or -client-static (portable)

# Back up host config dirs to a PBS datastore (CLI, scriptable)
export PBS_REPOSITORY='user@pbs@192.168.1.30:mydatastore'
proxmox-backup-client backup etc.pxar:/etc root.pxar:/root --backup-type host
```

For guest backups without a full PBS you can also use built-in **`vzdump`** (pure CLI):
`vzdump 101 --storage local --mode snapshot --compress zstd`, scheduled via `/etc/pve/jobs.cfg` or
cron.

**Accessibility note:** PBS server administration (datastores, prune/GC, verify schedules) is
GUI-centric, though much is reachable via `proxmox-backup-manager` CLI on the PBS host and the PBS
API. The **client** is fully CLI. **Recommendation:** `proxmox-backup-client` + `vzdump` = **USE**
(essential backups, all CLI). A full PBS server = **OPTIONAL** for one node (nice dedup, but extra
GUI-bound component; `vzdump` to local/USB/NFS may suffice).

Sources:

- [Installation](https://pbs.proxmox.com/docs/installation.html)
- [Backup Client Usage](https://pbs.proxmox.com/docs/backup-client.html)
- [Proxmox VE Integration](https://pbs.proxmox.com/docs/pve-integration.html)

---

## 8. Templates / appliances (LXC images)

### What it does

PVE ships an appliance manager, **`pveam`**, to download ready-made LXC templates: standard distro
images (Debian, Ubuntu, Alpine, etc.) from LinuxContainers, plus **TurnKey Linux** pre-built app
appliances. All CLI.

```bash
pveam update # refresh template catalog
pveam available # list downloadable templates (incl. turnkey-*)
pveam available --section turnkeylinux
pveam download local debian-12-standard_12.7-1_amd64.tar.zst
pct create 200 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
 --hostname web --memory 1024 --net0 name=eth0,bridge=vmbr0,ip=dhcp
pct start 200 ; pct enter 200
```

**Recommendation: USE** - `pveam` + `pct` is the fastest accessible way to stand up LXC containers.
TurnKey appliances are **OPTIONAL** (handy pre-baked apps, but the Helper-Scripts LXC installers are
often more current). Distro templates: definitely use. Source:
[Command Line Tools](https://pve.proxmox.com/wiki/Command_Line_Tools)

---

## 9. Helper CLIs / built-in tooling recap (all CLI - USE)

- **qm** - manage KVM VMs (create/clone/set/start/stop/terminal/migrate).
- **pct** - manage LXC containers (mirror of `qm` syntax).
- **pvesh** - REST API shell; the universal accessible "do anything" + read-status tool.
- **pvenode** - node-level tasks (status, certs, tasks, wakeonlan).
- **pveum** - users, API tokens, roles (set up tokens for proxmoxer/Ansible/Terraform).
- **pveam** - appliance/template manager (section 8).
- **vzdump** - built-in backup (section 7).
- **pvereport** - one-shot full system report (host, storage, network, guests) - great accessible
  "dump everything" command.
- **pveperf** - quick CPU/disk/fsync benchmark.
- **pvecm** - cluster manager (not needed on a single node - **skip**).
- **ha-manager** - HA config (not needed on a single node - **skip**; the post-install script even
  disables HA services).

---

## Summary table (recommendation by tool)

USE (core for a single-node shell/screen-reader user):

- Helper-Scripts **PVE Post Install** (review first),
  `qm`/`pct`/`pvesh`/`pveam`/`pveum`/`vzdump`/`pvereport`
- Cloud-init template workflow (`qm` clone)
- proxmoxer (if scripting)
- smartmontools/smartd
- PVE notification system (email target at minimum)
- proxmox-backup-client + vzdump
- CLI monitoring: `pvesh get /nodes/<node>/status`, `pvereport`, htop / `glances --stdout`

OPTIONAL (situational):

- Ansible (community.proxmox) or OpenTofu+bpg provider - only if you want git-tracked IaC
- External metric server (InfluxDB) - if you already run a TSDB
- go-proxmox - Go users
- Full PBS server, TurnKey appliances, Netdata

SKIP / lean-skip for this user:

- Grafana + prometheus-pve-exporter as a primary view (GUI-bound, visual payoff)
- btop as a primary monitor (very visual)
- `pvecm`, `ha-manager`, clustering/HA (single node)

Overarching accessibility note: nearly the entire Proxmox management surface is reachable via CLI
(`qm`/`pct`/`pvesh`/`pveam`) and the REST API, so the inaccessible web GUI can be avoided
end-to-end. The main GUI-bound gaps are third-party visual monitors (Grafana, Netdata, btop) and PBS
server administration - for which `pvesh`/`pvereport`/CLI tools are the accessible substitute.
