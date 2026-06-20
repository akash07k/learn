# Cheatsheet: pveum (users, tokens, roles, ACLs)

`pveum` is the Proxmox VE user manager: it creates users and groups, issues and revokes API tokens,
defines roles, binds those roles to subjects with ACLs, manages two-factor, and builds resource
pools. Reach for it whenever you are deciding who may call which API path. Everything here is plain
text you run as root on the Proxmox host over SSH, with no web GUI. For the why and the worked
setups, see the full guide
[13 -- Users, permissions, and API tokens](../13-users-permissions-and-api-tokens.md).

A user id is always `name@realm` (for example `root@pam`, `admin@pve`). A token id is
`user@realm!tokenid` (for example `admin@pve!automation`). The `@pam` realm is for real Unix
accounts authenticating through the host's PAM stack; `@pve` is the Proxmox built-in realm for users
that exist only inside Proxmox and need no Unix account. `root@pam` is special: it cannot be deleted
and it bypasses every ACL, so no role can constrain it. You never edit `/etc/pve/user.cfg` or ACLs
by hand; only through `pveum`.

Secret hygiene, stated once: never put a password or token secret inline on a command line (it
persists in `~/.bash_history`). Set passwords with the prompted `pveum passwd`, and capture a token
secret at creation because it is shown exactly once.

## Users and groups

- `pveum user add admin@pve --comment "primary admin"` -- create a `pve`-realm user (no Unix account
  needed). A `bob@pam` user needs a real Unix account to exist first (`useradd`);
  `pveum user add bob@pam` does not create a login.
- `pveum user modify admin@pve --comment "..."` -- change a user's attributes (comment,
  enable/disable, groups, expiry).
- `pveum user list` -- list all users.
- `pveum passwd admin@pve` -- set or change a password; PROMPTED, never echoed to history. Use this
  instead of an inline `--password`.
- `pveum passwd root@pam` -- set the break-glass password; keep it strong and reserve `root@pam` for
  recovery.
- `pveum group add admins --comment "VE administrators"` -- create a group so you can ACL many users
  at once.
- `pveum group list` -- list all groups.

## API tokens

A token is a named secret on a user that authenticates API calls without the user's password, and it
can be revoked on its own. The token id form is `user@realm!tokenid`.

- `pveum user token add admin@pve automation --privsep 1 --comment "cron jobs"` -- create a token.
  The secret (a UUID) prints ONCE in the output; capture it now, it can never be retrieved again.
- `pveum user token add admin@pve automation --privsep 1 --output-format json` -- same, but emit
  JSON so a script can capture the secret programmatically.
- `pveum user token list admin@pve` -- list a user's tokens.
- `pveum user token permissions admin@pve automation` -- show the rights the token actually has (the
  audit check after granting an ACL).
- `pveum user token modify admin@pve automation --expire 0` -- set expiry (`0` = never expires).
- `pveum user token modify admin@pve automation --regenerate 1` -- regenerate the secret if you lost
  it; this breaks the old secret.
- `pveum user token delete admin@pve automation` -- instant revoke.

Privilege separation: with `--privsep 1` (the recommended default) the token starts with its OWN
separate, empty ACL entries and gets 403 on everything until you grant it rights explicitly; its
effective rights are then the intersection of the owner's rights and the token's own. With
`--privsep 0` the token simply inherits the user's full rights (convenient, but a leak equals the
user; avoid unless you truly need it). Grant a privsep token its own rights with an ACL on its token
id (see below).

## Roles and ACLs

An ACL binds four things: a path (for example `/vms/100` or `/`), a subject (user, group, or token),
a role, and a propagate flag. A role grants nothing until an ACL binds it. Prefer the built-in roles
(`Administrator`, `PVEAuditor`, `PVEVMUser`, and so on) before writing a custom one.

- `pveum role list` -- every role and the exact privileges it carries on your build.
- `pveum role add Operator --privs "VM.PowerMgmt,VM.Console,VM.Audit"` -- build a custom role from
  privilege atoms (prefer built-ins).
- `pveum acl modify /vms/100 --users joe@pve --roles PVEVMUser` -- bind a role to a user on a single
  VM.
- `pveum acl modify / --users admin@pve --roles Administrator` -- bind cluster-wide on the root path
  `/`.
- `pveum acl modify / --groups admins --roles Administrator` -- bind a role to a group.
- `pveum acl modify /vms --tokens 'admin@pve!automation' --roles PVEAuditor` -- bind a role to an
  API token (read-only on all VMs here); quote the token id.
- `pveum acl modify /pool/prod --groups admins --roles PVEPoolUser` -- bind on a pool path.
- `pveum acl list` -- the complete picture of every binding on the node.
- `pveum acl delete /vms/100 --users joe@pve --roles PVEVMUser` -- remove one binding.

Real ACL paths are `/` (cluster-wide), `/vms/<vmid>` (one guest) or `/vms` (all guests),
`/storage/<id>`, and `/pool/<name>`. The `--propagate` flag (default `1`) inherits the permission to
deeper paths. The `NoAccess` role cancels every other role on its path, so it is how you carve out
an explicit exception. A deeper-path permission overrides a shallower one, and a user's own
permission overrides one from a group. Note: an ACL cannot constrain `root@pam`, which ignores ACLs
entirely; you restrict root by not using it.

## Permissions, two-factor, and pools

- `pveum user permissions admin@pve` -- resolve a user's effective rights across all paths,
  including what they inherit through groups (the audit-what-a-user-can-do command).
- `pveum user tfa list joe@pve` -- list a user's enrolled two-factor factors.
- `pveum user tfa delete joe@pve --id <id>` -- remove one factor by its id.
- `pveum user tfa unlock joe@pve` -- clear a two-factor lockout (Proxmox locks a user after repeated
  bad codes). Note: enrolling a NEW factor is effectively GUI-driven; the CLI lists, deletes, and
  unlocks but does not cleanly enroll. See guide 13 for the accessible TOTP workaround.
- `pveum pool add prod --comment "production guests"` -- create a resource pool (group VMs,
  containers, and storage under one ACL on `/pool/<name>`).
- `pveum pool modify prod --vms 100,101 --storage local-btrfs` -- add members to a pool.

## Full treatment

This card is a reminder, not a lesson. For the why, the dedicated-admin-instead-of-root setup, the
token-with-curl recipe, and the honest two-factor caveat, see:

- [13 -- Users, permissions, and API tokens](../13-users-permissions-and-api-tokens.md) -- realms
  and the break-glass account, the full role and ACL model, the API token lifecycle, certificates,
  two-factor, and auditing.
- [GLOSSARY.md](../GLOSSARY.md) -- the canonical definitions of realm, role, ACL, API token,
  privilege separation, and resource pool.

---

Back to the [cheatsheets index](README.md). Browse all the [guides](../README.md).
