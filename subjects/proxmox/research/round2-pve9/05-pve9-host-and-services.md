# PVE 9 Host System Internals (Shell Admin View)

Target: latest Proxmox VE 9.x on Debian 13 "trixie", mid-2026. Single node, no cluster/HA/RAID, host
root on BTRFS, shell-only (serial console / `pct enter` / `pvesh`), blind screen-reader admin. This
document covers the host internals a shell admin must understand: the pmxcfs `/etc/pve` filesystem,
the core daemons, node identity, time sync, host health tooling, and single-node service caveats.
Deltas from PVE 8 are flagged inline.

Primary sources: pmxcfs chapter and `pveproxy`/`pvenode`/`pmxcfs` man pages on pve.proxmox.com
(queried via Context7 `/websites/pve_proxmox_pve-docs` and WebFetch of the live docs), the Proxmox
wiki Service_daemons and Time_Synchronization pages, and the PVE Roadmap. Citations are inline per
section.

---

## 1. pmxcfs: the `/etc/pve` cluster filesystem

### 1.1 What it is

`/etc/pve` is NOT an ordinary directory on the root (BTRFS) filesystem. It is a **mount point** for
**pmxcfs**, the Proxmox Cluster File System: a small, database-backed, **FUSE** filesystem
implemented in user space. It is provided by the `pve-cluster` service (daemon binary `pmxcfs`). It
exists and is mounted **even on a single standalone node** - there is no such thing as "not using
pmxcfs"; every PVE install stores its config here.

Key facts (source:
[Proxmox Cluster File System (pmxcfs)](https://pve.proxmox.com/pve-docs/chapter-pmxcfs.html)):

- **Backing store**: a single **SQLite** database at `/var/lib/pve-cluster/config.db` (plus WAL/shm
  siblings). The live tree is held in RAM and persisted to this DB.
- **Mount point**: `/etc/pve`.
- **Size cap**: max **128 MiB** (it is for config text, not data - do not dump large files here).
- **Replication**: in a cluster it replicates in real time to all nodes via **corosync**. On a
  single node there are no peers, so this is moot - but the machinery is still present.
- **Consistency**: enforces unique VM/CT IDs cluster-wide, provides a distributed locking mechanism
  (`priv/lock/`), and goes **read-only when the node loses quorum** (see 1.4).

### 1.2 POSIX caveats (matters when scripting)

pmxcfs is FUSE and intentionally NOT a full POSIX filesystem
([Proxmox Cluster File System (pmxcfs)](https://pve.proxmox.com/pve-docs/chapter-pmxcfs.html)):

- **No symlinks** (you cannot create your own symlinks inside `/etc/pve`; the `local`,
  `qemu-server`, `lxc` entries are special pmxcfs-provided shortcuts, not real symlinks).
- **Cannot rename a non-empty directory** (protects VMID uniqueness).
- **File permissions cannot be changed** - access is **path-based**, not chmod-based. Ownership is
  `root:www-data`; most files are group-readable; `priv/` and `nodes/<NAME>/priv/` are root-only.
- `O_EXCL` and `O_TRUNC` are **non-atomic** (NFS-like). Do not rely on them for locking; use the
  documented lock paths instead.

These limitations are why scripts that "just write a file" sometimes behave oddly under `/etc/pve` -
treat it as a config API surface, not a scratch disk.

### 1.3 File system layout under `/etc/pve`

(source:
[Proxmox Cluster File System (pmxcfs)](https://pve.proxmox.com/pve-docs/chapter-pmxcfs.html) - "File
System Layout")

Cluster-/datacenter-wide files (top level of `/etc/pve`):

- `datacenter.cfg` - datacenter-wide options (keyboard layout, console, default migration, HA
  defaults, etc.). Edited directly or via `pvesh`/GUI.
- `storage.cfg` - **storage configuration** (all storages: dir, lvmthin, zfs, btrfs, nfs, cifs,
  pbs...). Central file the shell admin edits most.
- `user.cfg` - access control: users, groups, roles, ACL assignments.
- `domains.cfg` - authentication realms/domains (PAM, PVE, LDAP, OIDC...).
- `notifications.cfg` - **notification targets and matchers** (the PVE 8+ notification system:
  endpoints like smtp/gotify/webhook + matchers). Present in PVE 9.
- `jobs.cfg` - scheduled jobs (e.g. backup jobs in the modern scheduler). In PVE 9 backup schedules
  live here / are driven by `pvescheduler`; legacy `vzdump.cron` may still exist for cron-style
  entries.
- `vzdump.cron` - legacy cluster-wide backup cron schedule (still readable; new jobs use
  `jobs.cfg` + `pvescheduler`).
- `status.cfg` - external metric server config (InfluxDB/Graphite).
- `authkey.pub` - public key of the ticket (auth) system.
- `pve-www.key` - private key used for CSRF token generation.
- `pve-root-ca.pem` - cluster CA public certificate.
- `ceph.conf` - Ceph config (absent/irrelevant on a single node without Ceph).
- `corosync.conf` - corosync cluster config. **On a standalone (never-clustered) node this file does
  NOT exist** - its absence is exactly what keeps corosync from starting (see 6).
- `virtual-guest/cpu-models.conf` - custom CPU model definitions.

Firewall (`firewall/`):

- `firewall/cluster.fw` - cluster-wide firewall rules (applies to the whole datacenter).
- `firewall/<NODENAME>.fw` - host/node-level firewall rules.
- `firewall/<VMID>.fw` - per-guest (VM/CT) firewall rules.

SDN (`sdn/`):

- `sdn/*` - Software-Defined Networking config (zones, vnets, subnets, controllers). Even on a
  single node SDN can be used for simple vnets; files live here.

HA (`ha/`) - present but unused on a single node with HA disabled:

- `ha/resources.cfg` - HA-managed resources and desired state.
- `ha/rules.cfg` - HA scheduling constraints/rules. (In PVE 9 the HA rule model was reworked;
  `rules.cfg` is the modern constraints file - see Roadmap.)
- `ha/manager_status` - JSON status from the HA manager (CRM).
- `ha/crm_commands` - pending HA operations.

Node-specific (`nodes/<NODENAME>/`) - on a single node there is exactly **one** such dir, named
after the host's hostname:

- `nodes/<NAME>/config` - node-specific settings (what `pvenode config` reads/writes: description,
  ballooning-target, wakeonlan, startall-onboot-delay, ACME).
- `nodes/<NAME>/qemu-server/<VMID>.conf` - KVM/QEMU **VM config files**.
- `nodes/<NAME>/lxc/<VMID>.conf` - **LXC container config files**.
- `nodes/<NAME>/pve-ssl.pem` / `pve-ssl.key` - node's API/web TLS cert + key (signed by the cluster
  CA).
- `nodes/<NAME>/pveproxy-ssl.pem` / `pveproxy-ssl.key` - OPTIONAL override cert/key to serve a
  custom (e.g. ACME/Let's Encrypt) cert on the web UI instead of the self-signed one.
- `nodes/<NAME>/openvz/` - deprecated (pre-4.0), ignore.

Private, root-only (`priv/`):

- `priv/shadow.cfg` - password hashes for the PVE-realm users.
- `priv/tfa.cfg` - two-factor auth config (base64).
- `priv/token.cfg` - API token secrets.
- `priv/authkey.key` - private ticket-system key.
- `priv/pve-root-ca.key` - cluster CA **private** key.
- `priv/authorized_keys`, `priv/known_hosts` - SSH keys/host verification for cluster mesh.
- `priv/storage/<STORAGE-ID>.pw` - plaintext storage passwords (e.g. PBS, CIFS).
- `priv/ceph*` - Ceph auth keyrings.
- `priv/lock/*` - cluster-wide operation lock directories.

Convenience shortcuts (pmxcfs-provided, behave like symlinks but are special):

- `local` to `nodes/<LOCAL_HOSTNAME>` (always points at _this_ node's dir).
- `qemu-server` to `nodes/<LOCAL_HOSTNAME>/qemu-server/`.
- `lxc` to `nodes/<LOCAL_HOSTNAME>/lxc/`.
- `openvz` to `nodes/<LOCAL_HOSTNAME>/openvz/` (deprecated).

So on a single node you can edit a VM config as either `/etc/pve/qemu-server/100.conf` or
`/etc/pve/nodes/<host>/qemu-server/100.conf` - same file.

Hidden status/debug files (read-only JSON views maintained by pmxcfs):

- `.version` - change/version counter (used to detect modifications).
- `.members` - cluster member info (on a single node: just this node).
- `.vmlist` - all guests across the cluster (here: all local guests).
- `.clusterlog` - last ~50 cluster log entries.
- `.rrd` - recent RRD performance data.
- `.debug` - write `1`/`0` to toggle verbose pmxcfs logging: `echo 1 > /etc/pve/.debug` (on),
  `echo 0 > /etc/pve/.debug` (off).

### 1.4 Read-only-when-quorum-lost behavior on a SINGLE node

This is the single most important pmxcfs gotcha for a standalone admin.

pmxcfs makes `/etc/pve` **read-only whenever the node does not have quorum**
([Proxmox Cluster File System (pmxcfs)](https://pve.proxmox.com/pve-docs/chapter-pmxcfs.html)). On a
true standalone node that was **never joined to a cluster** (no `corosync.conf`), the node is always
"quorate by default" (expected votes effectively 1), so `/etc/pve` is normally writable - you
generally never see this. The danger appears if:

- the node was once part of a cluster and corosync config lingers, or
- someone configured corosync/expected votes such that a single node can't reach quorum.

Symptom: you try to start a VM, edit `storage.cfg`, or run almost any config-changing command and it
fails with **"permission denied"** / cluster not ready / unable to write to `/etc/pve`, even as
root. `touch /etc/pve/test` fails read-only.

Recovery on a single node:

1. Regain quorum by lowering expected votes to 1 (immediate, non-destructive):

```bash
pvecm expected 1
```

(source: [pvecm(1)](https://pve.proxmox.com/pve-docs/pvecm.1.html) - "Force quorum when not
quorate". This only works if corosync/pve-cluster is otherwise up.)

1. If pmxcfs/corosync is broken enough that even that fails, start pmxcfs in **local mode** (no
   cluster consensus required):

```bash
systemctl stop pve-cluster
pmxcfs -l # mount /etc/pve in local (forced-local) mode
```

(source:
[Proxmox Cluster File System (pmxcfs)](https://pve.proxmox.com/pve-docs/chapter-pmxcfs.html) -
"Recovery" / local mode.) Use this to fix config, then stop it and start the normal service again:
`killall pmxcfs; systemctl start pve-cluster`.

1. For a node that should be permanently standalone, the clean fix is to remove leftover cluster
   config so the node stops expecting peers (delete/disable `corosync.conf`, see Section 6) - then
   `/etc/pve` is writable without `expected 1`.

DB recovery / move to new hardware (source: pmxcfs "Recovery"): stop `pve-cluster`, copy
`/var/lib/pve-cluster/config.db` to the new host (mode `0600`), and include any current
`config.db-wal`/`config.db-shm` SQLite sidecars if they exist in the source backup. Fix
`/etc/hostname` + `/etc/hosts` to match the original node name, reboot. The node dir name must
match.

Move a guest config off a dead node (cluster only, not relevant single-node but documented):
`mv /etc/pve/nodes/node1/qemu-server/100.conf /etc/pve/nodes/node2/qemu-server/` - ONLY after the
source node is confirmed powered off/fenced.

---

## 2. Core daemons in PVE 9

(sources: [Service daemons](https://pve.proxmox.com/wiki/Service_daemons) and
[Proxmox VE Administration Guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.html);
pvescheduler/spiceproxy confirmed via admin guide + Roadmap.)

The systemd unit names are unchanged from PVE 8. The essential daemons:

- **`pve-cluster.service`** (binary `pmxcfs`) - "the heart of any Proxmox VE installation." Provides
  the pmxcfs `/etc/pve` filesystem and the distributed config/lock layer. **Must run even on a
  standalone node** - if it is down, `/etc/pve` is unavailable and almost nothing else works. Do NOT
  disable it.
- **`pvedaemon.service`** - the local **REST API server**, listens on **127.0.0.1:85** as **root**.
  All API calls that need root privileges go through it. Not reachable from the network directly.
- **`pveproxy.service`** - the **REST API proxy / web server**, listens on **port 8006** (HTTPS) as
  user **`www-data`**. Serves the web UI and `pvesh`/API to the outside, and forwards privileged
  calls to `pvedaemon` (or other nodes in a cluster). If the web UI is down but the box is up, this
  is usually the service to restart.
- **`pvestatd.service`** - the **status daemon**. Polls status/metrics of all VMs, containers and
  storages and publishes them (to cluster members / for the GUI graphs). If resource graphs or
  status are stale, restart this.
- **`pvescheduler.service`** - the **scheduler daemon**. Runs scheduled jobs: backup jobs
  (`jobs.cfg`), storage **replication**, and other periodic tasks. Introduced in PVE 7.x; it took
  over scheduling duties that older versions ran from cron. Present and central in PVE 9.
- **`spiceproxy.service`** - proxy for **SPICE** remote-display connections (port 3128). Only
  relevant if you use SPICE consoles. A blind shell-only admin can typically ignore SPICE entirely;
  the service can stay at defaults (harmless) or be disabled if unused.

Firewall-related (active if you use the PVE firewall - see networking topic):

- **`pve-firewall.service`** - applies the nftables/iptables ruleset cluster-wide.
- **`pvefw-logger.service`** - logs firewall events.

HA + cluster transport (NOT needed on a standalone node - see Section 6):

- **`pve-ha-lrm.service`** - HA Local Resource Manager (executes HA actions on this node).
- **`pve-ha-crm.service`** - HA Cluster Resource Manager (master election/coordination).
- **`corosync.service`** - cluster group-communication/quorum engine. Only starts if
  `/etc/corosync/corosync.conf` exists (its unit has a `ConditionPathExists`), so on a
  never-clustered node it is effectively inert already.

### 2.1 Inspecting and restarting

```bash
# Status / health of a service
systemctl status pve-cluster.service
systemctl status pveproxy.service pvedaemon.service pvestatd.service pvescheduler.service

# Restart (note restart ORDER matters after upgrades / cert changes):
systemctl restart pve-cluster # first: pmxcfs must be healthy
systemctl restart pvedaemon # then the privileged API
systemctl restart pveproxy spiceproxy # then the front proxy
systemctl restart pvestatd pvescheduler

# Per-daemon CLI wrappers also exist (equivalent to systemctl for that unit):
pvedaemon restart
pveproxy restart
pvestatd restart
pvescheduler restart # also: pvescheduler status | start | stop

# Logs for one daemon:
journalctl -u pveproxy -b --no-pager
journalctl --since -1h -u pve-cluster
```

Restart-order note (community-documented, matters after `apt dist-upgrade` or TLS cert renewal):
bring up `pve-cluster` first, then `pvedaemon`, then `pveproxy`/`spiceproxy`, then
`pvestatd`/`pvescheduler`. Restarting `pveproxy` before pmxcfs is healthy can leave the web UI
failing to serve HTTPS.

### 2.2 PVE 9 service-layer deltas

- **No systemd unit renames** for the core daemons (same names as PVE 8/7).
- **`pveproxy` socket hardening (PVE 9)**: the unit's `ListenStream` now uses a socket under `/run`
  to avoid a systemd deprecation warning, and startup was changed so pveproxy fails fast instead of
  starting but silently not serving HTTPS (which previously surfaced as "broken pipe" errors).
  Practical impact: clearer failures, same commands. (source:
  [Roadmap](https://pve.proxmox.com/wiki/Roadmap))
- **`pvereport` / ZFS**: `pvereport` now calls `zarcstat` instead of the deprecated `arcstat`,
  tracking the ZFS 2.4 rename, and gained extra status (e.g. replication job config). Irrelevant
  detail on a BTRFS-root host, but noted. (source: Roadmap)
- **pmxcfs layout**: unchanged in structure for PVE 9 - same files/paths as above. The notification
  system (`notifications.cfg`) and the modern scheduler (`jobs.cfg` + `pvescheduler`) that matured
  across PVE 8 are the current model in PVE 9; legacy `vzdump.cron` still recognized for backward
  compatibility.

---

## 3. Node identity (hostname + `/etc/hosts` to management IP)

This is **critical** and a classic single-node footgun. PVE derives the **node name** from the
system **hostname**, and **requires** that hostname to resolve to the node's real (non-loopback)
**management IP** via `/etc/hosts`. (Corroborated by round1 notes and the PVE host-system docs.)

Files:

- `/etc/hostname` - the short hostname (e.g. `pve`). The pmxcfs node dir (`/etc/pve/nodes/<NAME>/`)
  is named after this. Because guests live under that dir, **renaming the host after creating guests
  is disruptive** - decide the name first.
- `/etc/hosts` - MUST contain a line mapping the **management IP** to FQDN + short name, e.g.:

```text
192.168.1.10 pve.example.com pve
```

The FQDN must map to the **real IP**, not `127.0.0.1`/`127.0.1.1`. If the hostname only resolves to
loopback, pmxcfs/pveproxy and (in clusters) corosync misbehave: the web UI may bind wrong, certs may
be wrong, and clustering would break.

Set/inspect identity:

```bash
hostnamectl # show current hostname / FQDN
hostnamectl set-hostname pve # set short hostname (BEFORE creating guests!)
hostname --fqdn # verify FQDN resolves
getent hosts $(hostname) # confirm it maps to the management IP, not 127.x
```

After a rename you must also update `/etc/hosts`, `/etc/postfix/main.cf` (mail hostname), and
reboot. Treat the hostname as effectively immutable once guests exist.

---

## 4. Timezone and time synchronization (chrony)

(source: [Time Synchronization](https://pve.proxmox.com/wiki/Time_Synchronization))

- **Default NTP daemon since PVE 7 (so also PVE 8 and PVE 9): `chrony`.** (PVE 6 used
  `systemd-timesyncd`.) A fresh PVE 9 install ships chrony preconfigured with public NTP servers.
- Configure servers in **`/etc/chrony/chrony.conf`**:

```text
server ntp1.example.com iburst
server ntp2.example.com iburst
```

Then:

```bash
systemctl restart chronyd
```

- Check sync:

```bash
chronyc tracking # offset, stratum, reference clock
chronyc sources -v # list of sources and their state
journalctl --since -1h -u chrony
timedatectl # shows clock, timezone, NTP "System clock synchronized: yes"
```

(`timedatectl status` reporting `NTP service: active` + `System clock synchronized: yes` is the
quick health check.)

- **Timezone** (set via systemd, not chrony):

```bash
timedatectl list-timezones
timedatectl set-timezone America/New_York
```

Underlying file: `/etc/localtime` (symlink to the zoneinfo file); `timedatectl set-timezone` manages
it for you.

Even on a single node, accurate time matters for TLS cert validity, backup/scheduler timing, and log
correlation. (Cluster/Ceph time-sync requirements don't apply here.)

---

## 5. Basic host health (shell-only)

Useful, accessible (text-only) health commands:

```bash
# Overall systemd health - "running" is good; "degraded" means some unit failed.
systemctl is-system-running
systemctl --failed # list failed units to investigate

# Journal: recent boot, errors, follow:
journalctl -b --no-pager # current boot
journalctl -b -p err --no-pager # errors+ this boot
journalctl -fu pveproxy # follow one service

# Full system report (hardware, storage, network, versions, service state) - great for
# a screen-reader admin to read one big text blob instead of poking the GUI:
pvereport # prints a full text report to stdout

# Node config (the nodes/<NAME>/config values):
pvenode config get # all node options
pvenode config get --property description
pvenode config set --description "single-node btrfs host"
pvenode config set --ballooning-target 80
pvenode config set --wakeonlan mac=aa:bb:cc:dd:ee:ff

# Versions / package state:
pveversion -v # PVE component versions (kernel, qemu, pve-manager...)
proxmox-boot-tool status # bootloader/ESP state (relevant on BTRFS/UEFI hosts)

# pmxcfs / quorum sanity on a single node:
systemctl status pve-cluster
pvecm status # on a standalone node: shows single-node/no-cluster
cat /etc/pve/.members # JSON: who pmxcfs thinks is in the "cluster"
```

(`pvenode config` parameters from [pvenode(1)](https://pve.proxmox.com/pve-docs/pvenode.1.html);
`pvereport` from the admin guide / Roadmap.)

Note on `pvecm` standalone: on a never-clustered node, `pvecm status` reports that there is no
cluster configured - that is normal and healthy. You do NOT need a cluster for a single node.

---

## 6. Single-node caveats: corosync and HA services

On a standalone node with **no cluster, no HA, no RAID**:

- **corosync is not needed.** `corosync.service` only starts if `/etc/corosync/corosync.conf` exists
  (its unit carries a `ConditionPathExists`), and a never-clustered PVE install has no such file -
  so corosync is already effectively inert. There is little point masking it. (source:
  [Slim down Promxmox? Disable corosync, pve-ha services?](https://forum.proxmox.com/threads/slim-down-promxmox-disable-corosync-pve-ha-services.55938/))
- **`pve-cluster` (pmxcfs) is still REQUIRED.** Do not disable it. It is what provides `/etc/pve`.
  This is the most common dangerous mistake - disabling pmxcfs bricks config access. (source: same
  forum thread + free-pmx HA-disable guide.)
- **HA services CAN be safely disabled on a single node.** `pve-ha-lrm` and `pve-ha-crm` serve no
  purpose without a cluster and occasionally write their "last active" timestamp to disk (minor SSD
  wear). Safe to stop+disable, or mask for permanence:

```bash
systemctl disable --now pve-ha-lrm pve-ha-crm
# optional, more permanent (prevents any auto-start, e.g. by upgrades):
systemctl mask pve-ha-lrm pve-ha-crm
```

(sources: [How to disable HA permanently - free-pmx](https://free-pmx.org/guides/ha-disable/) and
the forum thread above.)

Caveat: **masking PVE services can cause noisy errors during `apt`/`dpkg` upgrades**, because PVE
postinst scripts try to restart units they expect to exist. These errors are generally cosmetic (the
upgrade still completes), but they are confusing. A screen-reader admin may prefer `disable --now`
over `mask` to keep upgrades quiet, since disabled units still won't auto-start on boot.

- Before disabling HA, make sure **no guest is HA-managed** (it never will be on a true single node,
  but check): `ha-manager status` should show no resources, and `/etc/pve/ha/resources.cfg` should
  be empty/absent.

- **Do not** try to "save resources" by disabling `pvestatd`, `pvescheduler`, `pvedaemon`, or
  `pveproxy` - these are functional, not cluster overhead. Disabling them breaks status, scheduled
  backups, the API, and the web UI respectively.

Net recommendation for this single-node BTRFS host: leave `pve-cluster`, `pvedaemon`, `pveproxy`,
`pvestatd`, `pvescheduler` running; optionally `disable --now pve-ha-lrm pve-ha-crm`; leave corosync
alone (it won't start without a config). Keep chrony running.

---

## 7. Citations

- pmxcfs chapter (layout, FUSE/SQLite, config.db, quorum read-only, recovery, local mode):
  [Proxmox Cluster File System (pmxcfs)](https://pve.proxmox.com/pve-docs/chapter-pmxcfs.html)
- `pmxcfs(8)` man page: [pmxcfs(8)](https://pve.proxmox.com/pve-docs/pmxcfs.8.html)
- `pvecm(1)` ("pvecm expected 1"): [pvecm(1)](https://pve.proxmox.com/pve-docs/pvecm.1.html)
- Service daemons (pve-cluster, pvedaemon, pveproxy, pvestatd, HA, corosync, firewall):
  [Service daemons](https://pve.proxmox.com/wiki/Service_daemons)
- `pveproxy(8)` (port 8006, www-data, restart):
  [pveproxy(8)](https://pve.proxmox.com/pve-docs/pveproxy.8.html)
- `pvenode(1)` (`pvenode config get/set`):
  [pvenode(1)](https://pve.proxmox.com/pve-docs/pvenode.1.html)
- Admin guide (pvedaemon/pvestatd/pvescheduler, pvereport):
  [Proxmox VE Administration Guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.html)
- Time synchronization (chrony default since PVE 7):
  [Time Synchronization](https://pve.proxmox.com/wiki/Time_Synchronization)
- Roadmap (PVE 9 pveproxy socket hardening, pvereport zarcstat, HA rule rework):
  [Roadmap](https://pve.proxmox.com/wiki/Roadmap)
- Disabling HA/corosync on a standalone node:
  [How to disable HA permanently - free-pmx](https://free-pmx.org/guides/ha-disable/) and
  [Slim down Promxmox? Disable corosync, pve-ha services?](https://forum.proxmox.com/threads/slim-down-promxmox-disable-corosync-pve-ha-services.55938/)
