# PVE 9: Access Control, the REST API, and pvesh (the accessibility superpower)

Target: latest Proxmox VE 9.x (9.1 / 9.2, Debian 13 "trixie", mid-2026). Reader: a blind,
shell-only, single-node admin whose host root filesystem is BTRFS and who wants automation via API
tokens. The GUI is inaccessible, so this chapter is the most important one in the whole guide:
**everything the web GUI does is just a thin client over the REST API, and `pvesh` is that same API
rendered as text.** Nothing here requires the GUI.

## The one framing that matters: GUI = thin client over the API

Proxmox VE has exactly one source of truth for "what can be done": a versioned REST API served by
`pveproxy` on `https://HOST:8006/api2/json/...`. The Vue/ExtJS web GUI is a JavaScript client that
makes the _same_ HTTPS calls you can make yourself. There is no hidden "GUI-only" capability - if a
button exists, there is an API path behind it.

Three equivalent ways to call that one API, all text:

1. **`pvesh`** - a CLI shell over the API. As local root it talks to the API over a local UNIX
   socket, so **no credentials, no TLS, no token** are needed. This is your primary accessible
   cockpit.
2. **`curl` + an API token** - the stateless, scriptable way to hit the HTTPS endpoint from anywhere
   (header `Authorization: PVEAPIToken=USER@REALM!TOKENID=SECRET`). Best for automation.
3. **`curl` + a login ticket + CSRF token** - the older session flow the GUI itself uses (cookie
   `PVEAuthCookie` + `CSRFPreventionToken` header). Useful to understand, rarely what you want for
   scripts.

Because the API is self-describing, you can _discover_ the entire system as text with `pvesh ls` and
`pvesh usage` (below). For a screen-reader user this is decisive: the API viewer/help is navigable
prose, not a mouse-driven tree.

## Realms: where passwords live, and the break-glass account

A **realm** (authentication domain) decides _how_ a user proves identity. A full user id is always
`name@realm`. PVE 9 ships these realm types:

- **`pam`** - Linux PAM. The user must be a real Unix account on the host (`/etc/passwd`,
  `useradd`). Authentication uses the host's password/PAM stack. `root@pam` is the one that matters.
- **`pve`** - the Proxmox VE built-in authentication server. Users exist only inside Proxmox;
  passwords are hashed and stored at `/etc/pve/priv/shadow.cfg`. You create these purely with
  `pveum` - no Unix account needed. This is the right realm for dedicated admin/automation users.
- **`ldap`**, **`ad`** - LDAP / Microsoft Active Directory, with `pveum realm sync` to pull users
  and groups. (Overkill for a single node.)
- **`openid`** - OpenID Connect (SSO), auto-create users, claim-to-group mapping. (Overkill for a
  single node.)

### `root@pam` is the break-glass superuser

`root@pam` "can always log in via the Linux PAM realm and is an unconfined administrator." It
**cannot be deleted** and it **bypasses all ACLs** - no role assignment can constrain it. That makes
it your guaranteed recovery path: if you lock yourself out of a `pve`-realm admin user, you log in
as `root@pam` and fix it.

Single-node recommendation: keep `root@pam` with a strong password as the break-glass account, do
day-to-day automation through a dedicated **`pve`-realm** user + **API tokens** (so a leaked token
never exposes the root password), and add TFA later once you have a reliable enrollment path (see
the TFA section - enrollment is awkward without the GUI).

User records (everything except passwords) live in `/etc/pve/user.cfg`; ACLs live in the same
cluster filesystem (pmxcfs). Even on a single node these are "cluster" files under `/etc/pve`, which
is a FUSE mount backed by a SQLite DB and synced via corosync in a real cluster - edit them with
`pveum`, not a text editor.

## The `pveum` surface (users, groups, roles, ACLs, tokens, pools, realms, TFA)

`pveum` is the user-management CLI. Every subcommand below is also reachable as a `pvesh` call under
`/access/...` - `pveum` is just a friendlier front end.

### Users

```bash
pveum user add joe@pve --email joe@example.com --comment "admin"
pveum passwd joe@pve # prompts interactively; do not pass the password on the command line
pveum user modify joe@pve --email new@example.com
pveum user modify joe@pve --groups admins # set group membership
pveum user list
pveum user delete joe@pve
pveum passwd joe@pve # interactive password change
pveum user permissions joe@pve # effective permissions, all paths
```

`user add` options:
`--comment --email --enable (default 1) --expire --firstname --lastname --groups --keys (TFA/SSH) --password`.

### Groups

```bash
pveum group add admins --comment "VE administrators"
pveum group modify admins --comment "..."
pveum group list
pveum group delete admins
```

### Roles (a named set of privileges)

```bash
pveum role list # show all roles + their privs
pveum role add Operator --privs "VM.PowerMgmt,VM.Console,VM.Audit"
pveum role modify Operator --privs "VM.Backup" --append 1
pveum role delete Operator
```

### ACLs (bind a subject to a role on a path)

An ACL = (path) + (subject: user | group | token) + (role) + propagate flag. This is the whole
permission model.

```bash
# give a user a role on a path
pveum acl modify /vms/100 --users joe@pve --roles PVEVMUser
# give a group a role cluster-wide
pveum acl modify / --groups admins --roles Administrator
# give an API TOKEN its own rights (see token section)
pveum acl modify /vms --tokens 'joe@pve!monitoring' --roles PVEAuditor
pveum acl list # dump every ACL entry
pveum acl delete /vms/100 --users joe@pve --roles PVEVMUser
```

`--propagate` (default 1) makes the permission inherit to deeper paths. Inheritance rules: user
perms override group perms; deeper paths override shallower; the special role **`NoAccess`** cancels
every other role on that path.

Delegation guard: a user **without** `Permissions.Modify` on a path can only grant subsets of
privileges they already hold there (a `PVEVMAdmin` can hand out `PVEVMUser`, not `PVEAdmin`).

### Resource pools (group VMs/storage for bulk ACLs)

```bash
pveum pool add prod --comment "production guests"
pveum pool modify prod --vms 100,101 --storage local-zfs
pveum pool modify prod --vms 102 --allow-move 1 # move a VM already in another pool
pveum pool list
pveum pool delete prod
# then ACL the whole pool at once:
pveum acl modify /pool/prod --groups ops --roles PVEPoolUser
```

### Realms

```bash
pveum realm list
pveum realm add corp --type ldap ... # ldap/ad/openid options vary
pveum realm modify pve --default 1 # set the default login realm
pveum realm sync corp --scope both --remove-vanished entry;acl;properties
pveum realm delete corp
```

## Built-in roles in PVE 9 (use these before writing custom ones)

PVE 9 ships these predefined roles (run `pveum role list` to see the exact privilege set on your
build). The mapping/SDN ones are the notable PVE 8 to 9 area of growth.

| Role                | What it grants                                                                     |
| ------------------- | ---------------------------------------------------------------------------------- |
| `Administrator`     | All privileges (still constrained by path; unlike `root@pam` which ignores ACLs)   |
| `NoAccess`          | Explicit deny - cancels every other role on the path                               |
| `PVEAdmin`          | Almost everything except permission/realm management and dangerous system settings |
| `PVEAuditor`        | Read-only across the system (ideal for monitoring tokens)                          |
| `PVEVMAdmin`        | Full VM/container administration                                                   |
| `PVEVMUser`         | View, backup, configure CD-ROM, console, power management of guests                |
| `PVETemplateUser`   | View and clone templates                                                           |
| `PVEDatastoreAdmin` | Create/allocate backup space and templates on storage                              |
| `PVEDatastoreUser`  | Allocate backup space + audit storage                                              |
| `PVEPoolAdmin`      | Allocate/manage pools                                                              |
| `PVEPoolUser`       | View pools                                                                         |
| `PVESysAdmin`       | Sys.Audit, Sys.Console, Sys.Syslog (node audit, console, and logs)                 |
| `PVEUserAdmin`      | Manage users/groups/tokens                                                         |
| `PVESDNAdmin`       | Manage SDN configuration                                                           |
| `PVESDNUser`        | Use bridges / virtual networks                                                     |
| `PVEMappingAdmin`   | Manage resource mappings (PCI/USB device mapping)                                  |
| `PVEMappingUser`    | View/use resource mappings                                                         |

### Privilege categories (the atoms roles are built from)

- **System/node**: `Sys.Audit, Sys.Console, Sys.Syslog, Sys.Modify, Sys.PowerMgmt, Sys.Incoming`,
  `Permissions.Modify`, `Group.Allocate`, `Pool.Allocate, Pool.Audit`,
  `Realm.Allocate, Realm.AllocateUser`, `User.Modify`.
- **VM/guest**:

```text
VM.Allocate, VM.Audit, VM.Backup, VM.Clone, VM.Console, VM.Migrate, VM.PowerMgmt, VM.Snapshot, VM.Snapshot.Rollback, VM.Replicate
```

...plus the `VM.Config.*` family (CDROM, CPU, Cloudinit, Disk, HWType, Memory, Network, Options),
and `VM.GuestAgent.*` (refined in PVE 9 into per-action guest-agent privileges).

- **Storage**:
  `Datastore.Allocate, Datastore.AllocateSpace, Datastore.AllocateTemplate, Datastore.Audit`.
- **SDN**: `SDN.Allocate, SDN.Audit, SDN.Use` (the `SDN.Use` split - using a vnet vs. administering
  SDN - is a PVE 8.x/9 refinement).
- **Mapping**: `Mapping.Audit, Mapping.Modify, Mapping.Use`.

### Permission paths (where ACLs attach)

`/` (cluster root) · `/access` (user/permission admin) · `/access/realm/{realm}` · `/nodes/{node}` ·
`/vms` and `/vms/{vmid}` · `/storage/{storeid}` · `/pool/{poolname}` · `/sdn`. Paths are templated
with `{param}` segments.

## Dedicated admin user vs. `root@pam`

Recommended single-node setup, all shell:

```bash
# 1. break-glass stays as root@pam (just set a strong password)
pveum passwd root@pam

# 2. dedicated PVE-realm admin (no Unix account needed)
pveum user add admin@pve --password 'use-a-long-passphrase' --comment "primary admin"
pveum acl modify / --users admin@pve --roles Administrator

# 3. automation identity + token (next section) instead of scripting as root
```

Why: `root@pam` ignores ACLs and is tied to the host's root password; reserve it for recovery. A
`pve`-realm `Administrator` is auditable, revocable, and can carry TFA without touching system
login. Automation should never carry the root password around - it should carry a _token_ with the
narrowest role that works.

## API TOKENS (the automation primitive)

A token is a named secret attached to a user. It authenticates with a single HTTP header and needs
**no CSRF token**, which is exactly what you want for `curl`/cron/scripts.

### Create, ACL, rotate, delete

```bash
# create with privilege separation ON (recommended)
pveum user token add admin@pve automation --privsep 1 --comment "cron jobs"
# to prints a table containing the SECRET value (a UUID). SHOWN ONCE. Save it now.
# It can NEVER be retrieved again; only regenerated.

# JSON output so you can capture the secret programmatically:
pveum user token add admin@pve automation --privsep 1 --output-format json

# with privsep=1 the token starts with NO rights to grant them explicitly:
pveum acl modify /vms --tokens 'admin@pve!automation' --roles PVEAuditor

pveum user token list admin@pve
pveum user token permissions admin@pve automation
pveum user token modify admin@pve automation --expire 0 # 0 = never expires
pveum user token modify admin@pve automation --regenerate 1 # rotate the secret (old breaks)
pveum user token delete admin@pve automation # instant revoke
```

### Privilege separation and the intersection rule

- `--privsep 1` (default): the token has its **own** ACL entries, and the **effective rights are the
  intersection of the user's rights and the token's rights**. So a token can only ever be _less_
  powerful than its owner, and you scope it independently. A leaked `PVEAuditor` token on an
  `Administrator` user still grants only read-only.
- `--privsep 0`: the token inherits the **full** rights of its user. Convenient, dangerous - a leak
  equals the user. Avoid unless you truly need it.

Token id format on the wire and in ACLs is `USER@REALM!TOKENID`, e.g. `admin@pve!automation`.

### Using a token from the shell with curl

```bash
TOKEN='admin@pve!automation=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' # USER@REALM!ID=SECRET
H="Authorization: PVEAPIToken=$TOKEN"

# GET (read)
curl -sk -H "$H" https://HOST:8006/api2/json/version
curl -sk -H "$H" https://HOST:8006/api2/json/nodes/$(hostname)/qemu

# POST (no CSRF needed for tokens!) - start VM 100
curl -sk -H "$H" -X POST https://HOST:8006/api2/json/nodes/$(hostname)/qemu/100/status/start

# PUT - set a config value
curl -sk -H "$H" -X PUT --data-urlencode 'description=managed by cron' \
 https://HOST:8006/api2/json/nodes/$(hostname)/qemu/100/config

# DELETE
curl -sk -H "$H" -X DELETE https://HOST:8006/api2/json/nodes/$(hostname)/lxc/200
```

(`-k` skips TLS verification while you still have the self-signed cert; drop it after you install a
trusted cert - see TLS section.)

## The older /access/ticket + CSRF flow (for contrast)

This is the session model the GUI uses. Tickets last **2 hours**.

```bash
# 1. log in to get a ticket and a CSRFPreventionToken
RESP=$(curl -sk -d 'username=root@pam' --data-urlencode 'password=PASS' \
 https://HOST:8006/api2/json/access/ticket)
TICKET=$(echo "$RESP" | jq -r .data.ticket)
CSRF=$(echo "$RESP" | jq -r .data.CSRFPreventionToken)

# 2. GET with the cookie (no CSRF needed for reads)
curl -sk -b "PVEAuthCookie=$TICKET" https://HOST:8006/api2/json/nodes

# 3. WRITE: cookie + CSRF header are BOTH required
curl -sk -b "PVEAuthCookie=$TICKET" -H "CSRFPreventionToken: $CSRF" \
 -X POST https://HOST:8006/api2/json/nodes/$(hostname)/qemu/100/status/start
```

Compared to tokens: tickets expire, must be refreshed (re-POST the old ticket as the password), and
require a CSRF header on every write. **Prefer tokens for automation;** the ticket flow is mainly
useful for understanding the GUI and for short-lived interactive sessions.

## `pvesh` in depth (your primary accessible cockpit)

`pvesh` maps API verbs to subcommands and, \*\*as local root, authenticates over the local UNIX
socket

- no credentials, no token, no `-k`.\*\*

| `pvesh`               | HTTP method | meaning                              |
| --------------------- | ----------- | ------------------------------------ |
| `pvesh get <path>`    | GET         | read a resource                      |
| `pvesh ls <path>`     | GET (index) | list child objects of a path         |
| `pvesh create <path>` | POST        | create / invoke an action            |
| `pvesh set <path>`    | PUT         | update                               |
| `pvesh delete <path>` | DELETE      | remove                               |
| `pvesh usage <path>`  | -           | print the API schema/help for a path |
| `pvesh help`          | -           | command help                         |

```bash
pvesh get /version # API + PVE version
pvesh get /cluster/resources --type vm # every guest as text
pvesh ls /nodes # list nodes
pvesh ls /nodes/$(hostname) # browse a node's API subtree
pvesh get /nodes/$(hostname)/status # load, memory, uptime
pvesh create /nodes/$(hostname)/qemu/100/status/start # start VM 100 (POST)
pvesh set /nodes/$(hostname)/qemu/100/config --description "managed"
pvesh delete /nodes/$(hostname)/lxc/200 # destroy CT 200
```

Discovery and machine-readable output (great with a screen reader + `jq`):

```bash
pvesh usage /nodes/{node}/qemu/{vmid}/config -v # full parameter docs as text
pvesh usage /access/users --command create --returns # what POST expects + returns
pvesh get /version --output-format json # also: yaml, text, json-pretty
pvesh get /cluster/resources --output-format yaml
```

`--noproxy` forces the call to stay local instead of proxying to the cluster master (handy
single-node). Because `pvesh` walks the exact same tree the GUI does, "how do I do X in the GUI?"
always reduces to "find X's path with `pvesh ls`/`usage`, then `get`/`create`/`set`."

## Full PVE 9 CLI tool inventory (single-node relevance flagged)

| Tool           | Purpose                                                                       | Single-node note                                |
| -------------- | ----------------------------------------------------------------------------- | ----------------------------------------------- |
| `pvesh`        | Shell over the entire REST API (the universal gateway)                        | Core - primary cockpit                          |
| `pveum`        | Users, groups, roles, ACLs, tokens, pools, realms, TFA                        | Core                                            |
| `pvenode`      | Node: certificates/ACME, task list/log, power, bulk start/stop                | Core                                            |
| `pvesm`        | Storage management (add/remove/list datastores, volumes)                      | Core                                            |
| `qm`           | KVM/QEMU virtual machine management                                           | Core                                            |
| `pct`          | LXC container management (incl. `pct enter` console - accessibility backbone) | Core                                            |
| `pveversion`   | Show PVE package versions (`pveversion -v` for the full list)                 | Core                                            |
| `pvereport`    | One-shot diagnostic dump of the whole system (great for support/audit)        | Core                                            |
| `pveperf`      | Quick CPU/disk/DNS benchmark of the node                                      | Optional                                        |
| `vzdump`       | Backup VMs/containers to a file/PBS                                           | Core                                            |
| `pve-firewall` | Local firewall control (`compile`, `restart`, `status`)                       | Core                                            |
| `pvescheduler` | Daemon running replication + scheduled jobs (backups, etc.)                   | Runs as a service                               |
| `pvecm`        | Cluster create/join/status                                                    | **N/A** on a single node (cluster tooling)      |
| `ha-manager`   | High-availability resource manager                                            | **N/A** single node (HA needs >=3 nodes/quorum) |

Also present and worth knowing: `pvesr` (storage replication - N/A single node), `pvesubscription`
(subscription/enterprise repo status), `pveceph` (Ceph - N/A single node), `pvesdn` (SDN). Note
BTRFS host root has no bearing on these tools; storage _datastores_ are configured separately via
`pvesm` (BTRFS is a supported storage type as well).

## TLS certificates (drop `curl -k` once trusted)

By default `pveproxy` serves a self-signed cert, which is why examples use `-k`. Two ways to fix it,
both pure shell.

### Let's Encrypt via ACME (`pvenode acme ...`)

HTTP-01 (needs port 80 reachable) - simplest if the node is internet-facing:

```bash
pvenode acme account register default you@example.com # pick LE prod or staging
pvenode config set --acme domains=pve.example.com
pvenode acme cert order # validates + installs + restarts pveproxy
```

DNS-01 (works behind NAT / for wildcard; uses a DNS plugin, e.g. OVH/Cloudflare via acme.sh):

```bash
pvenode acme plugin add dns mydns --api cf --data /path/with/CF_Token=... # provider-specific
pvenode config set -acmedomain0 pve.example.com,plugin=mydns
pvenode acme cert order
pvenode acme cert renew # manual renew; a timer auto-renews near expiry
```

### Upload a custom certificate (your own CA / wildcard) to /etc/pve/local

```bash
pvenode cert set /path/fullchain.pem /path/privkey.pem --restart 1
pvenode cert info # inspect the active cert
pvenode cert delete --restart 1 # revert to the self-signed cert
```

The active node cert/key live at `/etc/pve/local/pveproxy-ssl.pem` and
`/etc/pve/local/pveproxy-ssl.key` (per-node under the cluster fs). Once a trusted cert is in place,
**drop `-k` from all your curl commands** and verification will pass.

## Two-factor / TOTP from the shell (the awkward part)

PVE 9 supports **TOTP**, **WebAuthn/FIDO2**, and single-use **recovery keys**. The honest situation:
**enrollment of a new TOTP/WebAuthn factor is GUI-driven** ("via the TFA button in the user list"),
because it involves a challenge/QR exchange. The CLI exposes _management_ but not a clean "enroll
TOTP for myself" flow:

```bash
pveum user tfa list joe@pve # list a user's configured factors
pveum user tfa delete joe@pve --id <factor-id> # remove a factor
pveum user tfa unlock joe@pve # clear a TFA lockout (8 bad TOTP / 100 WebAuthn)
```

Practical accessible workaround for a shell-only admin:

1. Don't block yourself on TFA initially. Use a **strong `root@pam` password** as break-glass plus
   **scoped API tokens** for automation - tokens are themselves a second credential surface you
   fully control from the shell.
2. Add TFA later. TOTP can be enrolled by writing a known secret into the user's TFA config and
   feeding that same secret to a CLI authenticator (e.g. `oathtool --totp -b SECRET`) so you never
   need to read a QR code. WebAuthn (a hardware key tapped at login) is often the _more_
   screen-reader-friendly second factor once configured. Recovery keys (a printable one-time list)
   are worth generating as a backup.
3. WebAuthn requires a valid HTTPS cert and the WebAuthn relying-party config in
   `/etc/pve/datacenter.cfg` - another reason to do the TLS step above first.

## Task logs and auditing (everything leaves a trace)

Every API action that does real work spawns a **task** with a UPID; you can list and read them as
text.

```bash
pvenode task list # recent tasks on this node
pvenode task list --errors 1 # only failures
pvenode task log <UPID> # full output of one task
pvesh get /nodes/$(hostname)/tasks # same data via the API
```

On disk and via journald:

- Task index + logs: `/var/log/pve/tasks/` (active index file plus per-UPID logs in hashed subdirs).
- Daemon logs: `journalctl -u pveproxy -u pvedaemon -u pve-cluster -u pvescheduler` (or
  `journalctl -u 'pve*'`).
- A full diagnostic snapshot for support/audit: `pvereport`.

## PVE 8 to PVE 9 deltas to flag

- **Mapping roles/privileges** (`PVEMappingAdmin/User`, `Mapping.Audit/Modify/Use`) for PCI/USB
  **resource mappings** are part of the modern role set - lean on them instead of hand-rolling
  device-passthrough ACLs.
- **SDN privilege split**: `SDN.Use` is distinct from `SDN.Audit`/`SDN.Allocate`, so you can let a
  user _use_ a vnet without administering SDN.
- **`VM.GuestAgent.*`** is broken into finer per-action guest-agent privileges (a security
  refinement over a single coarse privilege).
- **Realms/OpenID Connect** continue to mature (auto-create users, group-claim mapping); LDAP sync
  uses `--remove-vanished` (the old `--full`/`--purge` flags are deprecated).
- The **core access model is unchanged** from PVE 8: same ACL/role/token mechanics, same
  `pveum`/`pvesh` surface, `root@pam` still the unconfined break-glass account, tokens still
  intersection-scoped under privsep. PVE 9's real platform change is the **Debian 13 "trixie" base +
  kernel 6.x**, not the auth model - so 8-era access-control muscle memory transfers directly.

## Gotchas

- **Token secret is shown once.** Capture it at creation (use `--output-format json`); the only
  recovery is `--regenerate`, which invalidates the old secret.
- **privsep tokens start with zero rights.** After `--privsep 1` you _must_ run a separate
  `pveum acl modify --tokens ...` or every call returns 403.
- **Effective token rights = intersection** with the user. Granting the token a role the user lacks
  on that path does nothing.
- **`root@pam` ignores ACLs**; never rely on an ACL to _restrict_ root. Restrict by not using root.
- **API tokens skip CSRF; the ticket flow does not.** Forgetting the `CSRFPreventionToken` header on
  a ticket-based write is the classic 401.
- **`-k` hides cert problems.** Remove it after installing a trusted cert so you actually validate
  the endpoint.
- **PAM users need a real Unix account**; `pve`-realm users do not. Don't `pveum user add bob@pam`
  expecting it to create a login.
- **Edit `/etc/pve/user.cfg` only via `pveum`** - it's a pmxcfs FUSE file, not a plain file.
- **TFA enrollment is effectively GUI-bound**; plan the token-first workaround rather than
  discovering the gap at lockout time.

## Citations

- pveum(1) manual: [pveum(1)](https://pve.proxmox.com/pve-docs/pveum.1.html)
- pvesh(1) manual: [pvesh(1)](https://pve.proxmox.com/pve-docs/pvesh.1.html)
- pvenode(1) manual: [pvenode(1)](https://pve.proxmox.com/pve-docs/pvenode.1.html)
- User Management chapter (PVE 9 beta):
  [User Management](https://pve.proxmox.com/pve-docs-9-beta/chapter-pveum.html)
- User Management chapter (current):
  [User Management](https://pve.proxmox.com/pve-docs/chapter-pveum.html)
- Proxmox VE API wiki (ticket/CSRF + token auth):
  [Proxmox VE API](https://pve.proxmox.com/wiki/Proxmox_VE_API)
- Sysadmin chapter (ACME/certs):
  [Host System Administration](https://pve.proxmox.com/pve-docs/chapter-sysadmin.html)
- Command Line Tools wiki: [Command Line Tools](https://pve.proxmox.com/wiki/Command_Line_Tools)
- Admin Guide 9.2.2 (PDF):
  [Pve admin guide (pve.proxmox.com)](https://pve.proxmox.com/pve-docs/pve-admin-guide.pdf)
- API viewer: [Proxmox VE API Documentation](https://pve.proxmox.com/pve-docs/api-viewer/)
