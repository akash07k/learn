# Users, permissions, and API tokens

## What you'll be able to do

By the end of this guide you will be able to create a dedicated admin and scoped automation
identities instead of working as root, grant exactly the access each needs with [roles](GLOSSARY.md)
and [ACLs](GLOSSARY.md), and issue revocable [API tokens](GLOSSARY.md) for your scripts and cron
jobs. You will install a trusted host certificate so you can stop passing `curl -k`, understand the
honest limits of two-factor enrollment from the shell, and keep a guaranteed recovery path open the
whole time. Every step is done from the shell, with no web GUI.

## The GUI is a thin client over the API

You saw this framing in guide [02 -- The shell and the API](02-the-shell-and-the-api.md), and it is
the foundation of everything here. Proxmox VE has exactly one source of truth for what can be done:
a versioned [REST API](GLOSSARY.md) served by `pveproxy` at `https://HOST:8006/api2/json/...`. The
web GUI is just a JavaScript client making the same HTTPS calls you can make yourself, and
[pvesh](GLOSSARY.md) is that same API rendered as text. There is no hidden GUI-only capability
behind a button.

That has a direct consequence for access control: granting someone access is just deciding who may
call which API path. A role binds a set of privileges to a subject on a path, and that is the whole
model. A shell-only operator loses nothing here, because the access model lives in the API and
`pvesh`, not in the GUI.

## Realms and the break-glass account

A [realm (authentication domain)](GLOSSARY.md) decides how a user proves identity, and a full user
id is always written `name@realm`. Two realms matter on a single node:

- `pam` -- Linux PAM. The user must be a real Unix account on the host (in `/etc/passwd`, created
  with `useradd`), and authentication uses the host's password stack. The one that matters is
  `root@pam`. Do not run `pveum user add bob@pam` expecting it to create a login; PAM users need a
  real Unix account first.
- `pve` -- the Proxmox VE built-in authentication server. These users exist only inside Proxmox,
  need no Unix account, and are created purely with [pveum](GLOSSARY.md). This is the right realm
  for a dedicated admin and for automation users.

The [break-glass account (root@pam)](GLOSSARY.md) is special: it authenticates through the host's
Linux PAM stack, it cannot be deleted, and it bypasses every ACL, so no role assignment can
constrain it. That is exactly what makes it your guaranteed recovery path. If you misconfigure or
lock out a `pve`-realm admin, you log in as `root@pam` and fix it. Keep it with a strong password
and reserve it for recovery:

```bash
pveum passwd root@pam
```

User records (everything except passwords) live in `/etc/pve/user.cfg`, and ACLs live alongside them
in [pmxcfs (/etc/pve)](GLOSSARY.md), the database-backed cluster filesystem mounted at `/etc/pve`.
This is the convention-4 point, and it is worth stating plainly: these are pmxcfs FUSE files, not
ordinary text files, and you edit them only through `pveum`, never with a text editor. That is the
exception to the general accessible-editing rule. The full menu of accessible, non-interactive
editing methods (here-docs, `tee`, drop-in files, and VS Code Remote-SSH) is in the "Editing files
accessibly" section of guide [02 -- The shell and the API](02-the-shell-and-the-api.md), and you use
those for ordinary files; but anything under `/etc/pve` that `pveum`, [pvenode](GLOSSARY.md), or
`pvesh` manages is written through that CLI instead.

## A dedicated admin instead of root

The recommended single-node setup is to keep `root@pam` as the break-glass account and do day-to-day
work as a dedicated `pve`-realm admin. Work through these steps in order.

Step 1 -- set a strong break-glass password (if you did not just do it above):

```bash
pveum passwd root@pam
```

Step 2 -- create the dedicated admin in the `pve` realm, then set its password interactively. No
Unix account is needed. Create the user without `--password`, because an inline
`--password 'use-a-long-passphrase'` persists in your shell history (`~/.bash_history`); the
interactive `pveum passwd` prompts for the password and does not echo it to history, exactly as you
did for `root@pam` above:

```bash
pveum user add admin@pve --comment "primary admin"
pveum passwd admin@pve
```

Step 3 -- give that admin the `Administrator` role cluster-wide by binding it on the root path `/`:

```bash
pveum acl modify / --users admin@pve --roles Administrator
```

Be honest about what this identity can and cannot do, because the two surfaces are different. A
`pve`-realm user like `admin@pve` has no Unix account, so it cannot SSH into the host or run the
host CLI tools (`qm`, `pct`, `pvesh`, `pveum`); those run over SSH as `root@pam`, and `pvesh` at the
host shell authenticates as the invoking Unix user (root), not as `admin@pve`. So `admin@pve` (and
the privilege-separated tokens below) is the least-privilege identity for the REST API over HTTPS:
`curl`, Ansible or Terraform, and `pvesh --apitoken` from your control station. Host-shell work
remains `root@pam`, mitigated by key-only SSH, the break-glass password, and `fail2ban` (all in
guide [14 -- Best practices and hardening](14-best-practices-and-hardening.md)). So: use `admin@pve`
for API and automation work, and reserve `root@pam` for the host shell and recovery, rather than
logging into the API as root.

Why bother, when `root@pam` can already do everything? Because a dedicated `pve`-realm admin is
auditable (its actions are attributable to it, not to a shared root login), it is revocable (you can
disable or delete it without touching system login), and it can carry two-factor authentication
without touching the host's Linux login. And there is a sharp safety point hidden here: `root@pam`
ignores ACLs, so never rely on an ACL to restrict root. You do not restrict root by assigning it a
weaker role; that has no effect. You restrict root by not using it.

## Roles and ACLs (the permission model)

An ACL is the binding of four things: a path (for example `/vms/100` or `/`), a subject (a user, a
group, or an API token), a role, and a propagate flag. That is the entire permission model. A role
on its own grants nothing until an ACL binds it to a subject on a path.

To see every role and the exact privilege set it carries on your build:

```bash
pveum role list
```

### The built-in roles

Proxmox VE 9 ships these predefined roles. Prefer them before writing a custom role. Each term below
is the role name, followed by what it grants:

- `Administrator` -- all privileges, though still constrained by the path the ACL is on (unlike
  `root@pam`, which ignores ACLs entirely).
- `NoAccess` -- an explicit deny that cancels every other role on the same path.
- `PVEAdmin` -- almost everything except permission and realm management and the most dangerous
  system settings.
- `PVEAuditor` -- read-only across the system. This is the ideal role for a monitoring token.
- `PVEVMAdmin` -- full administration of VMs and containers.
- `PVEVMUser` -- view, back up, configure CD-ROM, console, and power-manage guests.
- `PVEDatastoreAdmin` -- create and allocate backup space and templates on storage.
- `PVEDatastoreUser` -- allocate backup space and audit storage.
- `PVEPoolAdmin` -- allocate and manage resource pools.
- `PVEPoolUser` -- view resource pools.
- `PVESysAdmin` -- node audit, console, and logs (`Sys.Audit`, `Sys.Console`, `Sys.Syslog`). It does
  not manage users; that is `PVEUserAdmin`.
- `PVEUserAdmin` -- manage users, groups, and tokens.
- `PVESDNAdmin` -- manage SDN configuration.
- `PVESDNUser` -- use bridges and virtual networks.
- `PVEMappingAdmin` -- manage resource mappings (PCI and USB device mapping).
- `PVEMappingUser` -- view and use resource mappings.

### Binding roles with ACLs

`pveum acl modify` binds a role to a subject on a path. A few representative examples:

```bash
# a user on a single VM
pveum acl modify /vms/100 --users joe@pve --roles PVEVMUser

# a group cluster-wide
pveum acl modify / --groups admins --roles Administrator

# an API token on all VMs (see the token section)
pveum acl modify /vms --tokens 'admin@pve!automation' --roles PVEAuditor
```

List and remove ACL entries:

```bash
pveum acl list
pveum acl delete /vms/100 --users joe@pve --roles PVEVMUser
```

The `--propagate` flag (default `1`) makes the permission inherit to deeper paths below the one you
set it on. The inheritance rules are:

- A user's own permissions override permissions they get through a group.
- A permission set on a deeper path overrides one set on a shallower path.
- The `NoAccess` role cancels every other role on its path, so it is how you carve out an explicit
  exception inside an otherwise-granted subtree.

There is also a delegation guard: a user who lacks `Permissions.Modify` on a path can only grant
subsets of the privileges they already hold there. So a `PVEVMAdmin` can hand out `PVEVMUser`, but
cannot hand out `PVEAdmin`. This stops a delegated admin from escalating beyond their own reach.

PVE 9 privilege names to watch when you copy older examples: `VM.Monitor` is gone; basic QEMU
monitor access now uses `Sys.Audit`, and guest-agent actions use the narrower `VM.GuestAgent.*`
privileges. Storage replication management uses `VM.Replicate` on the VM path. Custom roles that
create, restore, or roll back VMs and then start them also need `VM.PowerMgmt`; the built-in roles
already include the right combinations, so this mainly matters if you maintain old custom roles.

### Groups and resource pools

A group lets you ACL many users at once. Create one, then bind a role to it:

```bash
pveum group add admins --comment "VE administrators"
pveum group list
```

A [resource pool](GLOSSARY.md) groups VMs, containers, and storage so a single ACL on `/pool/<name>`
applies to all of them:

```bash
pveum pool add prod --comment "production guests"
pveum pool modify prod --vms 100,101 --storage local-btrfs
pveum acl modify /pool/prod --groups admins --roles PVEPoolUser
```

### Custom roles

You can build a custom role from individual privileges with
`pveum role add Operator --privs "VM.PowerMgmt,VM.Console,VM.Audit"`, but prefer the built-in roles
above. They are maintained across upgrades and cover almost every real need; a custom role is one
more thing to keep correct.

## API tokens

An [API token](GLOSSARY.md) is a named secret attached to a user that authenticates REST API calls
without using the user's password. It is exactly what you want for `curl`, cron, and scripts,
because a leaked token never exposes the account password and can be revoked on its own. Create one
with privilege separation on (the recommended default):

```bash
pveum user token add admin@pve automation --privsep 1 --comment "cron jobs"
```

That command prints the token's secret value, a UUID, in its output. This is the SECRET-SHOWN-ONCE
gotcha, and it is the single most important fact about tokens: the secret is displayed exactly once,
at creation, and can never be retrieved again. Capture it now. To capture it programmatically rather
than reading it off a table, ask for JSON:

```bash
pveum user token add admin@pve automation --privsep 1 --output-format json
```

If you lose the secret, the only recovery is to regenerate it, which breaks the old secret:

```bash
pveum user token modify admin@pve automation --regenerate 1
```

With privilege separation on, the token starts with zero rights. This trips everyone once: after
`--privsep 1` the token has its own ACL entries, separate from the user's, and until you create one
every call returns 403. You must grant the token its rights explicitly:

```bash
pveum acl modify /vms --tokens 'admin@pve!automation' --roles PVEAuditor
```

The reason privsep tokens start empty is the intersection rule. With
[privilege separation (privsep)](GLOSSARY.md) on, the token's effective rights are the intersection
of the owning user's rights and the token's own rights. So a token can only ever be less powerful
than its owner: a `PVEAuditor` token on an `Administrator` user still grants only read-only, and
granting a token a role its owner lacks on that path does nothing. (With `--privsep 0` the token
simply inherits the user's full rights, which is convenient but means a leak equals the user; avoid
it unless you truly need it.)

Manage the token over its life:

```bash
pveum user token list admin@pve
pveum user token permissions admin@pve automation
pveum user token modify admin@pve automation --expire 0      # 0 = never expires
pveum user token delete admin@pve automation                 # instant revoke
```

On the wire and in ACLs, the token id has the form `USER@REALM!TOKENID`, for example
`admin@pve!automation`. The full credential you send is that id plus the secret, joined with `=`.

### Using a token with curl

A token authenticates with a single HTTP header and needs no CSRF token, which is what makes it
ideal for scripts. The header is `Authorization: PVEAPIToken=USER@REALM!ID=SECRET`:

```bash
TOKEN='admin@pve!automation=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'   # USER@REALM!ID=SECRET
H="Authorization: PVEAPIToken=$TOKEN"

# GET (read)
curl -sk -H "$H" https://HOST:8006/api2/json/version
curl -sk -H "$H" https://HOST:8006/api2/json/nodes/$(hostname)/qemu

# POST (no CSRF needed for tokens) -- start VM 100
curl -sk -H "$H" -X POST https://HOST:8006/api2/json/nodes/$(hostname)/qemu/100/status/start

# PUT -- set a config value
curl -sk -H "$H" -X PUT --data-urlencode 'description=managed by cron' \
     https://HOST:8006/api2/json/nodes/$(hostname)/qemu/100/config

# DELETE
curl -sk -H "$H" -X DELETE https://HOST:8006/api2/json/nodes/$(hostname)/lxc/200
```

One hygiene note on that `TOKEN=` line: assigning the live secret at the prompt puts it in your
shell, so it lands in `~/.bash_history` the same way an inline `--password` would. Prefix the line
with a leading space when `HISTCONTROL=ignorespace` (or `ignoreboth`) is set so it is not recorded,
or read the secret from a root-only file instead, for example `TOKEN="$(cat /root/.pve-token)"`
(create it with `install -m 600 /dev/null /root/.pve-token` first). The same caution applies
anywhere you handle a token secret; see guide [12 -- Remote access](12-remote-access.md) for the
equivalent note on the Cloudflare token.

Note the `-k`: it tells `curl` to skip TLS verification, which you need only while the node still
serves its default self-signed certificate. After you install a trusted certificate in the next
section, drop `-k` so `curl` actually validates the endpoint.

### Verify it worked

Two checks confirm the token is live and correctly scoped:

```bash
pveum user token permissions admin@pve automation
```

This prints the rights the token actually has, which should match the role you granted it (read-only
everywhere under `/vms` for the `PVEAuditor` example). And a read through the API with the token
returns data rather than a 403:

```bash
curl -sk -H "$H" https://HOST:8006/api2/json/version
```

A JSON object with the version is success; a 401 or 403 means the header or the ACL is wrong.

## A trusted host certificate (ACME)

By default `pveproxy` serves a self-signed certificate, which is the reason every `curl` example
above carries `-k`. [ACME (host certificate automation)](GLOSSARY.md) is how Proxmox obtains and
renews a trusted certificate, all from the shell with `pvenode acme`. Once a trusted certificate is
in place you can drop `-k`.

Which challenge applies to you: on the remote-access architecture in guide
[12 -- Remote access](12-remote-access.md) there is no inbound port 80 (no router port-forwarding;
the Cloudflare tunnel and Tailscale are outbound-only), so the HTTP-01 challenge cannot complete and
will fail. DNS-01 is your path on this setup. The HTTP-01 subsection below is documented because it
is correct for a node that genuinely has port 80 reachable from the internet, but that is NOT the
case on the guide-12 setup; skip it and use the DNS-01 subsection.

Recovery if a certificate change breaks access: if a bad, expired, or mis-issued certificate from
any of the routes below leaves the API or web interface unreachable,
`pvenode cert delete --restart 1` returns the node to its working self-signed certificate. You can
then reach the API again (with `-k`) and retry the order.

### Let's Encrypt via ACME, HTTP-01 (does NOT apply to the guide-12 setup)

This challenge needs inbound port 80 reachable to the node. On the guide-12 remote-access
architecture there is no inbound port 80, so this route will fail there; use DNS-01 below instead.
It is shown here only for a node that genuinely has port 80 reachable. Register an account, set the
domain, then order the certificate:

```bash
pvenode acme account register default you@example.com
pvenode config set --acme domains=pve.example.com
pvenode acme cert order
```

`pvenode acme cert order` validates, installs the certificate, and restarts `pveproxy` for you.

### Let's Encrypt via ACME, DNS-01 (your path on this setup)

Use the DNS-01 challenge when the node is behind NAT (no inbound port 80, which is the guide-12
case) or you want a wildcard certificate. DNS-01 proves control by writing a TXT record through a
DNS provider plugin. The provider side (a Cloudflare API token and the plugin data) is the same
Cloudflare DNS setup covered in guide [12 -- Remote access](12-remote-access.md); cross-reference
its Cloudflare section for the token scope and zone details.

```bash
pvenode acme plugin add dns mydns --api cf --data /path/with/CF_Token=...
pvenode config set --acmedomain0 pve.example.com,plugin=mydns
pvenode acme cert order
pvenode acme cert renew
```

The `--data` argument points to a FILE containing the provider's credential lines (for example a
line `CF_Token=...`), not a literal path string; for Cloudflare that token is the `Zone:DNS:Edit`
(plus `Zone:Zone:Read`) token from guide [12 -- Remote access](12-remote-access.md).

A renewal timer auto-renews near expiry; `pvenode acme cert renew` forces a renewal by hand.

### A custom certificate

If you have your own certificate (from an internal CA, or a wildcard you obtained elsewhere), upload
it directly:

```bash
pvenode cert set /path/fullchain.pem /path/privkey.pem --restart 1
pvenode cert info
pvenode cert delete --restart 1
```

`pvenode cert info` inspects the active certificate, and `pvenode cert delete --restart 1` reverts
to the self-signed one. Whichever route you take, the active node certificate and key live at
`/etc/pve/local/pveproxy-ssl.pem` and `/etc/pve/local/pveproxy-ssl.key` (per-node, under the cluster
filesystem). Because they are pmxcfs files managed by `pvenode`, you set them with the commands
above, not by writing the files yourself.

Once a trusted certificate is installed, drop `-k` from your `curl` commands.

### Verify it worked

```bash
pvenode cert info
```

This should show the trusted certificate (its issuer and the domain you ordered), not the
self-signed one. And a `curl` without `-k` should now succeed:

```bash
curl -s https://HOST:8006/api2/json/version
```

If that returns the version JSON with no certificate error, the trusted certificate is serving and
verification passes.

## Two-factor from the shell (the honest caveat)

Here is the honest situation, stated plainly: enrolling a new TOTP or WebAuthn factor is effectively
GUI-driven, because enrollment involves a challenge or QR exchange that the CLI does not expose as a
clean "enroll a factor for myself" flow. See [TFA / TOTP (two-factor authentication)](GLOSSARY.md)
for the term. Do not let this block you, and do not discover the gap at lockout time. The accessible
plan is:

1. Do not block yourself on two-factor initially. A strong `root@pam` break-glass password plus
   scoped API tokens is itself a second credential surface you fully control from the shell, so you
   are not unprotected while you defer two-factor.
2. Add two-factor later. TOTP can be enrolled by writing a known secret into the user's two-factor
   config and feeding that same secret to a CLI authenticator, so you never have to read a QR code:

   ```bash
   oathtool --totp -b SECRET
   ```

   `oathtool` is not installed by default; `apt install oathtool` first. That prints the current
   code for the secret you chose, which is what you type at login.

3. Prefer WebAuthn once you can. A hardware key tapped at login is often the more
   screen-reader-friendly second factor once configured, and it needs a valid HTTPS certificate,
   which is another reason the ACME step above comes first. Generate one-time recovery keys as a
   backup either way.

The CLI exposes two-factor management (listing, deleting, and clearing a lockout), even though it
does not cleanly enroll:

```bash
pveum user tfa list joe@pve
pveum user tfa delete joe@pve --id <id>
pveum user tfa unlock joe@pve
```

`pveum user tfa unlock` clears a two-factor lockout (Proxmox locks a user after repeated bad codes).

## The authorized_keys2 safeguard

This safeguard runs through the whole corpus, and it belongs here in full. On the Proxmox host,
`/root/.ssh/authorized_keys` is a symlink into pmxcfs (it lives under `/etc/pve`). If the
`pve-cluster` service (pmxcfs) fails to start, that file disappears, and key-based SSH login as root
breaks with it. On a headless node with no local console, that is a serious lockout.

The fix is to keep an independent copy of your control station's public key in
`~/.ssh/authorized_keys2`, a real file on the root disk, outside `/etc/pve`. OpenSSH reads both
`authorized_keys` and `authorized_keys2` by default, so a key in the second file still lets you log
in even when pmxcfs is down and the first file has vanished.

This is a real file on the root filesystem, not a pmxcfs file, so you write it with the accessible,
non-interactive shell form (the same methods in the "Editing files accessibly" section of guide
[02 -- The shell and the API](02-the-shell-and-the-api.md)), never a terminal editor. Append your
public key and fix the permissions:

```bash
tee -a ~/.ssh/authorized_keys2 <<'EOF'
ssh-ed25519 AAAA...your-public-key... you@control-station
EOF

chmod 600 ~/.ssh/authorized_keys2
```

This append is safe to run once on a fresh system, but a second run appends a duplicate key line.
After a reinstall the file starts empty, so there is nothing to dedupe; if you are re-running it on
an existing system, read the file back first and remove any duplicate before relying on it:

```bash
cat ~/.ssh/authorized_keys2
```

This is the first of two recovery layers. The second is the strong `root@pam` break-glass password
from earlier: if key-based login is broken for any reason, password login as `root@pam` is still
there as long as a login channel exists -- over SSH if you kept password authentication on, or via
physical/console access to the box (the Proxmox installer ISO in Rescue Boot, or a host serial
console if the hardware has one). Keep both.

## Auditing: everything leaves a trace

Every API action that does real work spawns a task with a UPID, and you can read all of them as
text. This is how you answer "what happened, and did it succeed" without sighted help.

List and read tasks on this node:

```bash
pvenode task list
pvenode task list --errors 1
pvenode task log <UPID>
pvesh get /nodes/$(hostname)/tasks
```

`pvenode task list --errors 1` shows only the failures, and `pvenode task log <UPID>` prints one
task's full output. The same data is on disk and in the journal:

- Task index and per-task logs live under `/var/log/pve/tasks/`.
- Daemon logs are in journald: `journalctl -u 'pve*'` covers the Proxmox services in one query.
- For a full diagnostic snapshot of the whole system (useful for an audit or a support request), run
  `pvereport`.

To audit who can do what, read the effective permissions of a user and dump every ACL:

```bash
pveum user permissions <user>
pveum acl list
```

`pveum user permissions` resolves a user's effective rights across all paths (including what they
inherit through groups), and `pveum acl list` is the complete picture of every binding on the node.

## Sources

- `research/round2-pve9/17-pve9-users-auth-api.md` -- the authoritative source for this entire
  guide: the GUI-as-thin-client-over-the-API framing and the three ways to call it; the `pam` and
  `pve` realms and the `root@pam` break-glass account that cannot be deleted and bypasses all ACLs;
  the `pveum` surface for users, groups, roles, ACLs, pools, and realms; the built-in role set and
  the privilege atoms; the dedicated-admin-instead-of-root recommendation; the API token model
  (privsep, the secret-shown-once gotcha, the zero-rights start, the intersection rule, the
  `USER@REALM!TOKENID` wire format, and the `curl` header with no CSRF and the `-k` note); the ACME
  and custom-certificate flows with the `/etc/pve/local/pveproxy-ssl.pem` paths; the honest
  two-factor caveat and the `oathtool` workaround; and the task-log and auditing commands.
- `GLOSSARY.md` -- the canonical definitions reused here of
  [realm (authentication domain)](GLOSSARY.md), [break-glass account (root@pam)](GLOSSARY.md),
  [role](GLOSSARY.md), [ACL (access control list entry)](GLOSSARY.md), [API token](GLOSSARY.md),
  [privilege separation (privsep)](GLOSSARY.md), [resource pool](GLOSSARY.md),
  [ACME (host certificate automation)](GLOSSARY.md),
  [TFA / TOTP (two-factor authentication)](GLOSSARY.md), [the REST API](GLOSSARY.md),
  [pveum](GLOSSARY.md), [pvesh](GLOSSARY.md), [pvenode](GLOSSARY.md), and
  [pmxcfs (/etc/pve)](GLOSSARY.md); plus the built-in role names (`Administrator`, `NoAccess`,
  `PVEAdmin`, `PVEAuditor`, `PVEVMAdmin`, `PVEVMUser`, `PVEDatastoreAdmin`, `PVEDatastoreUser`,
  `PVEPoolAdmin`, `PVEPoolUser`, `PVESysAdmin`, `PVEUserAdmin`, `PVESDNAdmin`, `PVESDNUser`,
  `PVEMappingAdmin`, `PVEMappingUser`).
- [pveum(1) manual](https://pve.proxmox.com/pve-docs/pveum.1.html) -- users, groups, roles, ACLs,
  tokens, pools, realms, and two-factor management.
- [pvesh(1) manual](https://pve.proxmox.com/pve-docs/pvesh.1.html) -- the shell over the REST API.
- [pvenode(1) manual](https://pve.proxmox.com/pve-docs/pvenode.1.html) -- node certificates and
  ACME, plus the task list and log.
- [User Management chapter](https://pve.proxmox.com/pve-docs/chapter-pveum.html) -- the
  access-control model, realms, roles, ACLs, tokens, and two-factor.
- [Proxmox VE API wiki](https://pve.proxmox.com/wiki/Proxmox_VE_API) -- the token-auth header and
  the older ticket and CSRF flow.
- [Sysadmin chapter (ACME and certificates)](https://pve.proxmox.com/pve-docs/chapter-sysadmin.html)
  -- the certificate and ACME details behind `pvenode acme` and `pvenode cert`.
- [Proxmox VE API viewer](https://pve.proxmox.com/pve-docs/api-viewer/) -- the navigable, text
  reference for every API path and its parameters.

---

Previous: [12 -- Remote access](12-remote-access.md) | Next:
[14 -- Best practices and hardening](14-best-practices-and-hardening.md)
