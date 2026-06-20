# Proxmox VE: Access Control, the API, and the CLI Tool Ecosystem (the Shell Control Plane)

Scope: single PVE node home lab (PVE 8.x on Debian 12; PVE 9.x notes where relevant). Audience: a
shell-only / screen-reader user. Every action below is a command or a named config file. The web GUI
is never required: `pvesh` makes the entire API callable from the shell.

---

## 0. The Big Idea: pvesh Is the Accessibility Superpower

Everything the Proxmox web GUI does is just an HTTP call against the Proxmox REST API. The GUI is a
thin JavaScript client over that API. `pvesh` is a command-line client over the _same_ API, running
locally as root over a private socket (no password, no TLS handshake needed on the node itself).

Consequence: **anything you can do in the GUI, you can do from the shell** by finding the matching
API path and calling it with `pvesh`. The GUI's left-hand tree mirrors the API tree under
`/nodes/<node>/...`, `/access/...`, `/storage/...`, `/cluster/...`, `/pools/...`. Learn to walk that
tree with `pvesh ls` and `pvesh usage` and you never need the GUI.

Three commands to remember:

```bash
pvesh ls <path> # list children of an API node (like cd + ls)
pvesh usage <path> -v # show what GET/POST/PUT/DELETE accept here
pvesh get <path> --output-format json # read a resource as JSON
```

---

## 1. Authentication Realms: root@pam vs a PVE-realm user

A Proxmox user is always `name@realm`. The realm decides _how_ the password is checked. Two realms
exist out of the box and matter for a single node:

- **pam** (`@pam`): Linux/Unix users that exist in `/etc/passwd` on the node. `root@pam` is the
  built-in superuser, authenticated against the node's real Linux root password (`passwd root`). PAM
  users can also log into the node via SSH. You cannot create a `@pam` user purely inside Proxmox -
  the Linux account must exist first (`adduser`), then you register it with `pveum`.
- **pve** (`@pve`): the Proxmox VE built-in authentication server. These users exist _only_ inside
  Proxmox (stored in `/etc/pve/user.cfg`, passwords hashed in `/etc/pve/priv/`). They have no
  Linux/SSH login. This is the realm you create application/automation/limited users in.

When to use which:

- Use **root@pam** for node-level administration, the initial setup, and as the break-glass account.
  It always has full privileges and cannot be locked out by ACLs.
- Create a **`@pve` user** (or a PAM user with a restricted role) when you want a _non-root, scoped_
  identity: automation scripts, a monitoring tool, a backup-only account, or simply to avoid running
  everything as root. Best practice: create API **tokens** under such a user rather than handing out
  the root password.

List configured realms and inspect them:

```bash
pvesh get /access/domains --output-format json # all realms
pveum realm list # same, table form
```

Realms are managed with `pveum realm add|modify|list|delete`. A realm can be set as the login
**default** and can have realm-wide TFA configured:

```bash
pveum realm modify pve --default 1
pveum realm modify pve --tfa type=oath # require TOTP for the whole realm
```

---

## 2. Users, Groups, Roles, ACLs with `pveum`

`pveum` (Proxmox VE User Manager) is the dedicated CLI for the access-control system. Its object
model:

- **User**: an identity `name@realm`.
- **Group**: a named bag of users. Assign permissions to groups, not individuals, to stay sane.
- **Role**: a named set of **privileges** (e.g. `VM.Allocate`, `Datastore.Audit`).
- **ACL**: a binding of (role) to (user/group/token) at a (path), with optional inheritance
  (propagate) down the tree.
- **Pool**: a grouping of VMs/storage so you can ACL them together (`/pool/<name>`).

### 2.1 Users

```bash
# Create a PVE-realm user, prompt for password interactively (-password with no value)
pveum user add automation@pve --comment "automation account" -password

# Create with email + first/last name, no password (token-only user)
pveum user add monitor@pve --email me@example.com --firstname Mon --lastname Itor

# List / inspect / modify / delete
pveum user list
pveum user modify automation@pve --comment "updated"
pveum user delete automation@pve

# Set/disable expiry, enable/disable account
pveum user modify automation@pve --enable 0 # disable
pveum user modify automation@pve --expire 0 # never expires
```

For a `@pam` user you must first create the Linux account, then register it:

```bash
adduser alice # creates the Linux user
pveum user add alice@pam --comment "Linux admin"
```

### 2.2 Groups

```bash
pveum group add developers --comment "Our software developers"
pveum user modify developer1@pve --group developers # add user to group
pveum group list
pveum group delete developers
```

### 2.3 Roles

Built-in roles you will actually use on a single node:

- **Administrator**: all privileges (but NOT equal to root@pam - still bound by the path it is
  granted on).
- **PVEAdmin**: almost everything except some node/system-level settings.
- **PVEAuditor**: read-only. Ideal for monitoring tokens.
- **PVEVMAdmin / PVEVMUser**: manage / use VMs.
- **PVEDatastoreAdmin / PVEDatastoreUser**: manage / use storage.
- **NoAccess**: explicitly deny (overrides inherited grants).

Custom roles:

```bash
pveum role list # show roles + their privileges
pveum role add Monitoring --privs "VM.Audit,Datastore.Audit,Sys.Audit"
pveum role modify Monitoring --privs "VM.Audit,Sys.Audit"
pveum role delete Monitoring
```

### 2.4 ACLs - granting permission

The grammar: assign a **role** to a **user/group/token** at a **path**. Paths are the same tree the
API uses, e.g. `/`, `/vms`, `/vms/100`, `/nodes/<node>`, `/storage/<id>`, `/pool/<name>`, `/access`.

```bash
# Give a group admin over one pool, inherited downward
pveum acl modify /pool/dev-pool/ --group developers --role PVEAdmin

# Give a user read-only over everything
pveum acl modify / --user monitor@pve --role PVEAuditor

# Grant on a single VM
pveum acl modify /vms/100 --user automation@pve --role PVEVMAdmin

# Remove an ACL: same command + --delete 1
pveum acl modify /vms/100 --user automation@pve --role PVEVMAdmin --delete 1

# Inspect all ACLs
pveum acl list
```

`--propagate 1` (default) means the grant inherits to child paths; `--propagate 0` restricts it to
exactly that path.

### 2.5 Worked end-to-end example (department pool)

```bash
pveum group add developers --comment "Our software developers"
pveum user add developer1@pve --group developers -password
pveum pool add dev-pool --comment "IT development pool"
pveum acl modify /pool/dev-pool/ --group developers --role PVEAdmin
```

---

## 3. API Tokens for Automation

API tokens give **stateless** access to the REST API without a username/password login flow -
perfect for scripts, cron jobs, monitoring (Prometheus PVE exporter), Terraform, Ansible, backup
tooling. A token belongs to a user and is named `USER@REALM!TOKENID`.

Key properties:

- The **secret is shown only once** at creation. There is no way to retrieve it later - store it
  immediately. If lost, regenerate.
- **Privilege separation** (`--privsep 1`, the default): the token starts with _no_ permissions; you
  must grant it ACLs separately. Its effective rights are the _intersection_ of the user's rights
  and the token's own ACLs.
- **`--privsep 0`**: the token inherits the _full_ permissions of its user. Use sparingly.
- Tokens can have an **expiry** (`--expire <unix-epoch>`, `0` = never).

### 3.1 Create and scope a monitoring token

```bash
# Create a privilege-separated token (default privsep=1)
pveum user token add monitor@pve readonly --privsep 1
# to prints a table containing the secret value (UUID). COPY IT NOW.

# Grant the token read-only on the whole tree
pveum acl modify / --token 'monitor@pve!readonly' --role PVEAuditor

# Inspect
pveum user token list monitor@pve
pveum user token permissions monitor@pve readonly # effective perms
pveum user token modify monitor@pve readonly --regenerate 1 # new secret
pveum user token delete monitor@pve readonly
```

### 3.2 Using a token from the shell with curl

The full token is `USER@REALM!TOKENID=SECRET`. It goes in an `Authorization` header. With a token
you do **not** need a login ticket or the CSRF token - that is the whole point.

```bash
# Read-only GET (note -k: PVE ships a self-signed cert by default; -k skips
# verification. Drop -k once you install a trusted/ACME cert, see section 7.)
TOKEN='PVEAPIToken=monitor@pve!readonly=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'

curl -k -H "Authorization: $TOKEN" \
 https://localhost:8006/api2/json/version

curl -k -H "Authorization: $TOKEN" \
 https://localhost:8006/api2/json/nodes/$(hostname)/qemu

# A write (POST) - start VM 100, needs a write-capable role on /vms/100:
curl -k -H "Authorization: $TOKEN" -X POST \
 https://localhost:8006/api2/json/nodes/$(hostname)/qemu/100/status/start
```

The literal header value format is: `Authorization: PVEAPIToken=USER@REALM!TOKENID=SECRET`

### 3.3 The older ticket/cookie flow (for comparison)

If you must authenticate with username+password instead of a token (e.g. you want to test the
realm), POST to `/access/ticket`. The response gives a `ticket` (used as cookie `PVEAuthCookie`) and
a `CSRFPreventionToken` (required as a header on every write/POST/PUT/DELETE):

```bash
curl -k -d "username=root@pam" --data-urlencode "password=SECRET" \
 https://localhost:8006/api2/json/access/ticket
# returns JSON: { data: { ticket, CSRFPreventionToken, username } }

# then on writes:
# -b "PVEAuthCookie=<ticket>"
# -H "CSRFPreventionToken: <token>"
```

Tokens are strongly preferred for automation: no CSRF token juggling, no session expiry,
individually revocable, individually scoped.

---

## 4. The REST API and `pvesh` (the universal shell gateway)

### 4.1 What pvesh is

`pvesh` is the shell interface to the Proxmox VE API. Run locally as root it talks to the API over a
private UNIX socket, so it needs no credentials and bypasses TLS. The subcommands map 1:1 to HTTP
verbs:

| pvesh subcommand      | HTTP verb   | Meaning                                |
| --------------------- | ----------- | -------------------------------------- |
| `pvesh get <path>`    | GET         | read a resource                        |
| `pvesh ls <path>`     | GET (index) | list child objects of a path           |
| `pvesh create <path>` | POST        | create / perform an action             |
| `pvesh set <path>`    | PUT         | modify an existing resource            |
| `pvesh delete <path>` | DELETE      | remove a resource                      |
| `pvesh usage <path>`  | -           | print the schema/parameters for a path |

Useful flags: `--output-format json` (or `yaml`, `json-pretty`) for machine/script-friendly output;
`--noproxy` to skip auto-proxying to the right node; `-v` on `usage` for verbose parameter docs;
`--returns` on `usage` to show the return schema.

### 4.2 Discovery pattern (walk the tree like a filesystem)

```bash
pvesh get /version # confirm it works; prints PVE version
pvesh ls / # top-level: access, cluster, nodes, pools, storage
pvesh ls /nodes # your node name appears here
pvesh ls /nodes/$(hostname) # qemu, lxc, storage, tasks, network, ...
pvesh usage /nodes/{node}/qemu -v # what params POST (create VM) accepts
```

### 4.3 Common read examples

```bash
pvesh get /version --output-format json
pvesh get /nodes/$(hostname)/status # CPU/RAM/uptime/load
pvesh get /nodes/$(hostname)/qemu # list QEMU VMs
pvesh get /nodes/$(hostname)/lxc # list containers
pvesh get /cluster/resources --type vm # all guests, one view
pvesh get /nodes/$(hostname)/storage # storages visible to node
pvesh get /access/users --output-format json # users
pvesh get /access/acl # ACL table via API
```

### 4.4 Common write examples

```bash
# Start / stop / reboot a VM via the API
pvesh create /nodes/$(hostname)/qemu/100/status/start
pvesh create /nodes/$(hostname)/qemu/100/status/shutdown
pvesh create /nodes/$(hostname)/qemu/100/status/stop

# Set a VM option (PUT)
pvesh set /nodes/$(hostname)/qemu/100/config --memory 4096 --cores 2

# Create a user through the API instead of pveum (identical effect)
pvesh create /access/users --userid test@pve --password 'secret'

# Modify ACL through the API
pvesh set /access/acl --path /vms/100 --users test@pve --roles PVEVMUser
```

Note: `qm`, `pct`, `pvesm`, `pveum`, `pvenode` are essentially friendly wrappers that hit these same
API paths. `pvesh` is the lowest-common-denominator that reaches paths some wrappers don't expose.
When a how-to says "click X in the GUI," translate it to the matching API path and `pvesh` it.

---

## 5. Inventory of Important PVE CLI Tools

| Tool                     | Purpose (single-node home lab framing)                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `pvesh`                  | Shell client for the whole REST API. The universal gateway; do anything the GUI does.                     |
| `pveum`                  | User/group/role/ACL/token/realm management (access control).                                              |
| `pvesm`                  | Storage manager: add/list storages, list/alloc/free volumes, `pvesm status`.                              |
| `qm`                     | QEMU/KVM VM lifecycle: create, config, start/stop, clone, snapshot, migrate, `qm guest exec`.             |
| `pct`                    | LXC container lifecycle: create, start/stop, enter, exec, snapshot, clone.                                |
| `pvenode`                | Node-level ops: tasks, TLS certs/ACME, node config, wake-on-LAN, reboot/shutdown.                         |
| `pveversion`             | Print PVE package versions (`pveversion -v` for the full component list).                                 |
| `pvereport`              | Dump a full system/diagnostic report (great for troubleshooting/support).                                 |
| `pveperf`                | Quick CPU/disk/fsync benchmark for a path (`pveperf /var/lib/vz`).                                        |
| `pvebanner`              | Regenerates the login console banner (`/etc/issue`) with node IP.                                         |
| `vzdump`                 | Backup engine for VMs and containers (used by scheduled backups).                                         |
| `pve-firewall`           | Control/inspect the Proxmox firewall (`pve-firewall status \| compile \| localnet`).                      |
| `pvescheduler`           | Daemon running scheduled jobs (backups, replication). You query it, not call it directly.                 |
| `pvecm`                  | Cluster manager. On a single node mostly N/A; `pvecm status` still works, but you won't create a cluster. |
| `pvereport`/`journalctl` | (with journald) the troubleshooting pair - see section 8.                                                 |
| `pmxcfs`                 | The Proxmox Cluster File System daemon that backs `/etc/pve` (see section 9). Not called directly.        |
| `ha-manager`             | High-availability manager. **Not used** on a single node (no HA without a cluster/quorum).                |

Single-node caveats: `pvecm`/cluster commands and `ha-manager` are effectively out of scope - no
clustering, no HA. `pvescheduler` and `pmxcfs` are daemons you observe rather than invoke.
Everything else is daily-driver material.

---

## 6. `pvenode`: Node Tasks, Config, Wake-on-LAN

`pvenode` covers node-scoped operations.

```bash
# Node config (description, ACME, wake-on-LAN, ballooning target, boot delay)
pvenode config get
pvenode config set --description "home lab node"
pvenode config set --wakeonlan mac=AA:BB:CC:DD:EE:FF

# Power
pvenode wakeonlan <node> # send a WoL magic packet to another node
pvenode reboot
pvenode shutdown

# Migrate all guests off (cluster feature; N/A single node)
# pvenode migrateall ...
```

### 6.1 Task inspection with pvenode

Every long-running action in PVE is a **task** identified by a UPID. Inspect them:

```bash
pvenode task list # finished tasks (default 50)
pvenode task list --errors 1 # only failed tasks
pvenode task list --typefilter vzdump # only backup tasks
pvenode task list --vmid 100 --since <epoch> # scoped
pvenode task list --source active # currently-running tasks
pvenode task log <UPID> # read a task's log
pvenode task log <UPID> --download 1 > task.log
pvenode task status <UPID> # one task's status
```

Equivalent via the API: `pvesh get /nodes/$(hostname)/tasks`.

---

## 7. TLS Certificates from the Shell

By default PVE generates a **self-signed** certificate, which is why `curl -k` and browser warnings
appear. Two ways to fix from the shell.

### 7.1 ACME / Let's Encrypt with `pvenode acme`

HTTP-01 validation (needs port 80 reachable from the internet to the node):

```bash
# 1. Register an ACME account (interactive: choose endpoint, accept ToS)
pvenode acme account register default mail@example.com

# 2. Tell the node which domain(s) the cert is for
pvenode config set --acme domains=pve.example.com

# 3. Order + install the certificate (auto-restarts pveproxy)
pvenode acme cert order

# Renew / revoke later
pvenode acme cert renew
pvenode acme cert revoke
pvenode acme account list
```

DNS-01 validation (no inbound port 80; needs a DNS provider plugin, good for home labs behind NAT).
Configure a plugin, then attach it to the domain:

```bash
# Register the DNS plugin (example with a provider's API data file)
pvenode acme plugin add dns mydns --api <provider> --data /path/to/credentials

pvenode config set --acmedomain0 pve.example.com,plugin=mydns
pvenode acme cert order
```

`pvenode acme account register default ...` plus `cert order` is the whole happy path; the tool
writes the cert/key under `/etc/pve/local/` and restarts `pveproxy`.

### 7.2 Uploading a custom certificate manually

If you have your own cert/key (e.g. from your own CA or a wildcard), place them as the node-local
override. `/etc/pve/local` is a per-node symlink into pmxcfs:

```bash
# Custom cert + key for the web/API service (pveproxy):
/etc/pve/local/pveproxy-ssl.pem # full chain (cert + intermediates)
/etc/pve/local/pveproxy-ssl.key # private key (keep 0600)

# After placing them, restart the proxy:
systemctl restart pveproxy
```

You can also do it via the API/tool:

```bash
pvenode cert set /path/to/fullchain.pem /path/to/privkey.key --restart 1
pvenode cert info # show current certificate details/fingerprint
pvenode cert delete # drop a custom cert, revert to self-signed
```

(The node's own CA cert/key live at `/etc/pve/pve-root-ca.pem` and `/etc/pve/priv/pve-root-ca.key`;
the auto-generated node cert is `/etc/pve/local/pve-ssl.pem` + `pve-ssl.key`. The `pveproxy-ssl.*`
pair, when present, overrides those for the web/API listener.)

---

## 8. Logs, Tasks, and Troubleshooting (journald + task logs)

### 8.1 Task logs

- API/GUI task logs are stored under **`/var/log/pve/tasks/`** (indexed by UPID, bucketed into
  subdirectories). The active index is `/var/log/pve/tasks/active`.
- Read them through the tool/API rather than hunting files: `pvenode task list`,
  `pvenode task log <UPID>`, `pvesh get /nodes/$(hostname)/tasks`.

### 8.2 systemd / journald for the daemons

Proxmox runs as a set of systemd services; journald is the place to debug them.

```bash
# Core services to know:
# pveproxy - the API/web listener on :8006 (the thing your curl/pvesh hit)
# pvedaemon - the local API worker that actually executes privileged calls
# pve-cluster- runs pmxcfs, mounts /etc/pve (must be healthy or /etc/pve breaks)
# pvestatd - collects node/guest statistics
# pvescheduler - runs scheduled backups/replication
# pvefw-logger - firewall logging

systemctl status pve-cluster pveproxy pvedaemon pvestatd

journalctl -u pveproxy -e # tail one service
journalctl -u pvedaemon --since "1 hour ago"
journalctl -u pve-cluster -b # this boot (debug /etc/pve mount issues)
journalctl -xe # recent errors across the system
journalctl -f # live follow

# Quick whole-system diagnostic bundle:
pvereport > /tmp/pvereport.txt
```

Troubleshooting flow: a failed action, then find its UPID in `pvenode task list --errors 1`, then
run `pvenode task log <UPID>` for the action-specific log, then if the service itself is
misbehaving, check `journalctl -u <pve-service>`.

---

## 9. `/etc/pve` (pmxcfs): the Single Source of Truth

`/etc/pve` is **not an ordinary directory**. It is a FUSE mount provided by the `pmxcfs` daemon
(Proxmox Cluster File System), backed by a SQLite database and (in a cluster) synced via corosync.
On a single node it is still pmxcfs, just without replication. Key facts:

- All Proxmox configuration that the GUI/API manage lives here, so editing these files _is_
  configuring Proxmox. It is the canonical config store.
- It requires the `pve-cluster` service to be running; if that service is down, `/etc/pve` is
  empty/read-only and almost everything breaks. (`journalctl -u pve-cluster` is your first stop
  then.)
- It is size-limited and meant for config text, not blobs.

Important paths inside `/etc/pve`:

```text
/etc/pve/user.cfg # users, groups, roles, ACLs, tokens (access control)
/etc/pve/storage.cfg # storage definitions (what pvesm edits)
/etc/pve/datacenter.cfg # datacenter-wide defaults (keyboard, migration, etc.)
/etc/pve/qemu-server/<vmid>.conf # one file per VM (what qm edits)
/etc/pve/lxc/<vmid>.conf # one file per container (what pct edits)
/etc/pve/nodes/<node>/ # per-node config
/etc/pve/local to /etc/pve/nodes/<thisnode> # symlink to THIS node's dir
/etc/pve/local/pve-ssl.pem # node TLS cert (auto)
/etc/pve/local/pveproxy-ssl.pem # custom web/API cert override (section 7)
/etc/pve/firewall/ # firewall rules (cluster.fw, <vmid>.fw)
/etc/pve/priv/ # secrets: token secrets, shadow, CA key (root-only)
/etc/pve/pve-root-ca.pem # the node's CA certificate
```

Practical takeaway: you can read/back up the entire control-plane state by reading these files, and
`pveum`/`qm`/`pct`/`pvesm` are just safe editors over them. Prefer the tools (they validate and
notify daemons), but knowing the files is invaluable for inspection, backup, and recovery.

---

## 10. Two-Factor Authentication (brief)

PVE supports TFA per-user and per-realm. From the shell:

```bash
pveum user tfa list [userid] # show configured TFA factors
pveum user tfa delete <userid> <id> # remove a factor (e.g. lost device)
pveum realm modify pve --tfa type=oath # require TOTP across a realm
```

TOTP enrollment (scanning a QR / entering a secret) is awkward purely from the shell and
historically GUI-driven; for a single-node home lab, a strong root password plus API tokens for
automation is usually sufficient, and TFA can be added later. Recovery keys exist so you are not
locked out if a device is lost.

---

## 11. Gotchas and Best Practices

- **root@pam always wins.** ACLs never restrict it; it is your break-glass account. Keep its
  password strong and don't lock yourself out by experimenting on it.
- **Token secret is shown once.** Capture it at creation; otherwise
  `pveum user token modify ... --regenerate 1`.
- **Privilege separation (privsep=1) means zero perms until you ACL the token.** A freshly created
  privsep token can authenticate but can do nothing - grant it with
  `pveum acl modify ... --token 'user@realm!id' --role ...`.
- **Token effective rights = intersection** of user rights and token ACLs (when privsep=1). A token
  can never exceed its user.
- **`curl -k` is only for the self-signed default.** Install an ACME/custom cert (section 7) and
  drop `-k` so TLS is actually verified.
- **API tokens beat the ticket flow** for automation: no CSRF header, no session expiry,
  individually revocable. Use `/access/ticket` only for password testing.
- **`@pam` users need a Linux account first** (`adduser`); `@pve` users are internal-only and have
  no SSH login. Choose deliberately.
- **`/etc/pve` depends on `pve-cluster`.** If `/etc/pve` looks empty, check
  `systemctl status pve-cluster` and `journalctl -u pve-cluster` before anything else.
- **Edit config via the tools, not the files,** when possible - the tools validate input and signal
  the daemons. Hand-editing `/etc/pve/*.conf` works but can desync running state.
- **Single-node scope:** ignore `ha-manager` and cluster creation; quorum/HA need multiple nodes.
  `pvecm status` is still a harmless health read.
- **Assign roles to groups, not users**, and ACL **pools** rather than individual VMs where you can
- fewer ACLs to reason about.
- **`pvesh usage <path> -v`** is the self-documenting reference; use it instead of guessing
  parameters. `--returns` shows the response schema.

---

## 12. PVE 9.x Notes

The model above (realms, `pveum`, `pvesh`, API tokens, `/etc/pve`/pmxcfs, ACME via `pvenode`) is
unchanged in PVE 9.x (Debian 13 "trixie" base). Differences are mostly under the hood (newer kernel,
package versions). The commands and API paths in this document apply to both 8.x and 9.x. Confirm
your exact version with `pveversion -v` and `pvesh get /version`.

---

## Citations

- pveum manual: [pveum(1)](https://pve.proxmox.com/pve-docs/pveum.1.html)
- pvesh manual: [pvesh(1)](https://pve.proxmox.com/pve-docs/pvesh.1.html)
- pvenode manual: [pvenode(1)](https://pve.proxmox.com/pve-docs/pvenode.1.html)
- pvesm manual: [pvesm(1)](https://pve.proxmox.com/pve-docs/pvesm.1.html)
- User management chapter (pveum.adoc):
  [Proxmox VE Administration Guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.html)
- Certificate management:
  [Proxmox VE Administration Guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.html)
  (certificate-management.adoc)
- API viewer (every path's schema):
  [Proxmox VE API Documentation](https://pve.proxmox.com/pve-docs/api-viewer/)
- pmxcfs chapter:
  [Proxmox Cluster File System (pmxcfs)](https://pve.proxmox.com/pve-docs/chapter-pmxcfs.html)
- pve-docs GitHub source:
  [GitHub - proxmox/pve-docs: READ ONLY mirror](https://github.com/proxmox/pve-docs)
