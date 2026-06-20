# PVE 9 Notification System (Shell-Only)

Target: latest Proxmox VE 9.x on Debian 13 "trixie" (mid-2026). Audience: blind, screen-reader,
shell-only single-node admin. Goal: be alerted to backup failures, SMART disk problems, and
available updates. All configuration shown via direct edits of `/etc/pve/notifications.cfg` and via
`pvesh`.

## Architecture: targets + matchers

The PVE notification system (introduced in 8.1, now the default and only forward-looking path in
PVE 9) has two object kinds:

- **Targets** (a.k.a. endpoints): _where_ a notification goes - an email relay, a Gotify server, a
  webhook, etc.
- **Matchers**: _which_ events go to _which_ targets. A matcher has match rules; every target listed
  on a matching matcher receives the event. A target is notified at most once per event even if
  several matchers select it.

An event flows: subsystem emits a notification (with `severity` + metadata `fields`) to every
matcher is evaluated to targets of all matching matchers are notified.

A matcher with **no** match rules is always true (matches everything). PVE ships a built-in matcher
commonly shown as `default-matcher` that targets the built-in `mail-to-root` target, so a fresh
install already emails `root@pam`'s address for everything. Editing/replacing that matcher is how
you redirect or silence the defaults.

### Built-in defaults present on a fresh install

- Target `mail-to-root` (type `sendmail`) - sends to the email set for the `root@pam` user, via the
  local MTA.
- Matcher `default-matcher` - no match rules (matches all), `target mail-to-root`. So out of the
  box, all notifications go to root's mailbox through local sendmail.

Built-in objects are marked `origin builtin`; once you modify one it becomes `modified-builtin`. You
cannot delete built-ins, but you can disable a matcher with `disable true` or change its target.

## Config files

- **Public:** `/etc/pve/notifications.cfg` - all target + matcher definitions, _non-secret_ fields.
  Cluster-replicated, world-readable within the PVE config FS.
- **Private:** `/etc/pve/priv/notifications.cfg` - _only_ secrets (SMTP `password`, Gotify `token`,
  webhook `secret` values), root-readable only. Each secret stanza repeats the same `type: name`
  header as in the public file and lists only the secret field.

Both are plain INI-like stanza files (a section header `type: name`, then tab-indented keys). You
may edit them directly; `pvesh`/GUI write the same format. After a manual edit no daemon restart is
needed - the config is read per-notification.

Permissions for non-root admins: viewing notification targets requires `Mapping.Audit` on
`/mapping/notifications`, modifying targets requires `Mapping.Modify`, and testing a target requires
`Mapping.Use`, `Mapping.Audit`, or `Mapping.Modify` on that same ACL path. A root shell bypasses
this in practice, but a delegated Proxmox admin role must include these mapping permissions to
manage alerts without `root@pam`.

## Severities

Every event carries one of: `info`, `notice`, `warning`, `error`, `unknown`. `match-severity`
filters on these (and accepts ranges like `warning,error`).

## Target types in PVE 9

Four first-class target types:

1. `sendmail` - hand the mail to the **local MTA** (Postfix on PVE). Has a retry/queue via the MTA.
   Needs a working local mail setup or a smarthost relay in Postfix.
2. `smtp` - talk **SMTP directly** to an external relay (Gmail, Fastmail, your ISP, an internal
   relay) with auth + TLS. No local MTA needed. No retry on failure.
3. `gotify` - push to a self-hosted Gotify server (token in priv file).
4. `webhook` - generic HTTP POST/PUT/GET with Handlebars templating. **This is how ntfy, Discord,
   Slack, Home Assistant, etc. are wired** - there is no dedicated `ntfy` target type; you use
   `webhook` pointed at the ntfy URL. Confirmed: ntfy is NOT first-class; it's done via `webhook`.

### sendmail target

```text
sendmail: example
 mailto-user root@pam
 mailto-user admin@pve
 mailto max@example.com
 from-address pve1@example.com
 comment Send to multiple users/addresses
```

`mailto-user` resolves the email from `users.cfg`; `mailto` is a literal address. Both repeatable.

### smtp target (RECOMMENDED for a home single-node to your own email)

Public stanza in `/etc/pve/notifications.cfg`:

```text
smtp: example
 mailto-user root@pam
 mailto-user admin@pve
 mailto max@example.com
 from-address pve1@example.com
 username pve1
 server mail.example.com
 mode starttls
```

Secret in `/etc/pve/priv/notifications.cfg`:

```text
smtp: example
 password somepassword
```

SMTP options:

- `server` - relay host/IP (required).
- `port` - default 25 (`insecure`), 465 (`tls`), 587 (`starttls`).
- `mode` - `insecure` | `starttls` | `tls`. Default `tls`.
- `username` + `password` - PLAIN/LOGIN auth. Omit both for an unauthenticated relay.
- `from-address` - required-ish for most relays (Gmail wants it = the account).
- `author` - display name, defaults to "Proxmox VE".
- `mailto` / `mailto-user` - recipients, repeatable.

Gmail example: `server smtp.gmail.com`, `mode starttls`, `port 587`, `username you@gmail.com`,
`password <app-password>` (use a Google App Password, not your login), `from-address you@gmail.com`.

### gotify target

Public:

```text
gotify: example
 server http://gotify.example.com:8888
 comment Send to multiple users/addresses
```

Private:

```text
gotify: example
 token somesecrettoken
```

### webhook target (ntfy example)

Webhook supports templating in `url`, `header`, `body`; secrets are injected as
`{{ secrets.<name> }}` and stored in the priv file. Template vars: `{{ title }}`, `{{ message }}`,
`{{ severity }}`, `{{ timestamp }}` (UNIX epoch), `{{ fields.<name> }}` (e.g. `fields.type`,
`fields.hostname`, `fields.job-id`), `{{ secrets.<name> }}`. Helpers: `{{ url-encode v }}`,
`{{ escape v }}` (JSON-safe), `{{ json v }}`.

Generic stanza:

```text
webhook: example
 url https://example.com/notify
 method POST
 header '["Content-Type: application/json"]'
 body '{
 "title": "{{ title }}",
 "message": "{{ message }}",
 "severity": "{{ severity }}"
 }'
 comment Generic webhook
```

The `secret` field lives in the priv file:

```text
webhook: example
 secret '["token=mysecrettoken"]'
```

**ntfy via webhook** (self-hosted ntfy is a good shell-friendly home choice - push to a phone with
no email relay):

- Method: `POST`
- URL: `https://ntfy.sh/{{ secrets.channel }}` (or your self-hosted `https://ntfy.example.com/...`)
- Header: a `Title:` header and optionally `Markdown: yes`
- Body: `{{ message }}`
- Secret: `channel=<your-topic>` (and an auth token header if your ntfy needs one)

Note: the `body`/`header`/`secret` fields are JSON-array-encoded strings when written by the API.
When hand-editing, mirror the format `pvesh` produces (run `pvesh get` once to see exact encoding).

## Matchers - routing and silencing

Matcher fields:

- `target` - destination target name, repeatable.
- `mode` - `all` (AND, default) or `any` (OR) across the match rules.
- `invert-match true` - negate the whole matcher result.
- `match-severity` - e.g. `error`, or `warning,error`.
- `match-field` - `exact:KEY=VAL[,VAL2]` (OR within the list) or `regex:KEY=PATTERN`. Common keys:
  `type`, `hostname`, `job-id`.
- `match-calendar` - time windows, systemd-calendar-ish (`mon-fri 9-17`, `8:00-15:30`).
- `disable true` - turn the matcher off.
- `comment`.

Routing examples (verbatim from docs):

```text
matcher: backup-failures
 match-field exact:type=vzdump
 match-severity error
 target backup-admins
 comment Send notifications about backup failures to one group of admins

matcher: cluster-failures
 match-field exact:type=replication,fencing
 target cluster-admins
 comment Send cluster-related notifications to other group of admins
```

Calendar / on-call example:

```text
matcher: workday
 match-calendar mon-fri 9-17
 target admin

matcher: night-and-weekend
 match-calendar mon-fri 9-17
 invert-match true
 target on-call-admins
```

**Silencing a class of events:** there is no "drop" action; you silence by making sure no enabled
matcher selects those events. Practical pattern for a single-node home box that wants ONLY
failures/problems: replace the always-on default with severity-filtered matchers, e.g. one matcher
`match-severity warning,error target my-smtp`, and either `disable true` the built-in
`default-matcher` or repoint it. (If you only want failures+updates, note `package-updates` is
`info` severity - see below - so you need a matcher that also catches `type=package-updates` or
you'll miss update notices when filtering by severity.)

## Which subsystems emit notifications, and how to route each

| Event                            | `type` field      | Severity | Useful metadata    |
| -------------------------------- | ----------------- | -------- | ------------------ |
| Updates available                | `package-updates` | info     | hostname           |
| Node fenced (HA)                 | `fencing`         | error    | hostname           |
| Storage replication failed       | `replication`     | error    | hostname, job-id   |
| Backup OK                        | `vzdump`          | info     | hostname, job-id\* |
| Backup failed                    | `vzdump`          | error    | hostname, job-id\* |
| Local mail to root (smartd etc.) | `system-mail`     | unknown  | hostname           |

\*`job-id` is only present for _scheduled_ backups, not manual `vzdump` runs.

**Backups (vzdump):** emitted as `type=vzdump`. Per-job you can pick the notification mode in the
job config (`notification-mode`): `notification-system` (default - routes through matchers/targets)
or `legacy-sendmail` (old pre-8.1 behavior, mails the job's configured address directly). For "alert
me only on failure," use the notification system and a matcher `match-field exact:type=vzdump` +
`match-severity error`.

**Replication:** `type=replication`, `error` severity on failure. (Mostly relevant to ZFS
replication; on a single node it rarely fires.)

**Package/system updates:** produced by the daily systemd timer `pve-daily-update.timer` to
`pve-daily-update.service` to `/usr/bin/pveupdate`, which checks for updates and emits
`type=package-updates` (severity `info`) - _if_ enabled. This is gated by the cluster option
`notify`:

- `pvesh set /cluster/options --notify package-updates=always` (send regardless of subscription -
  needed on a no-subscription home box)
- values: `auto` (default; only on subscribed systems), `always`, `never`.
- The `package-updates` key under `notify` is marked **deprecated** in PVE 9 man pages; future
  versions move fully to the notification matcher/target settings, but as of PVE 9 you still set it
  here. Verify with `pvesh get /cluster/options`.

**ZFS / SMART events:** these do NOT have native notification types. They reach you via the
`system-mail` bridge: daemons like `smartd` (SMART) and `zed` (ZFS Event Daemon) send mail to the
local `root` user; PVE intercepts mail to root and converts it into a `type=system-mail`, severity
`unknown` notification, then routes it through matchers. So to get SMART/ZFS alerts you must:

1. Have `smartmontools` installed and `smartd` enabled with `DEVICESCAN -m root ...` (or
   `-m <root>`); for ZFS ensure `zed`'s `ZED_EMAIL_ADDR="root"` is set in `/etc/zfs/zed.d/zed.rc`
   and `ZED_NOTIFY_VERBOSE` as desired.
2. Have a matcher that catches `system-mail` (or just everything) pointed at your target. Note
   severity is `unknown`, so a `match-severity warning,error` matcher will MISS these - catch them
   with `match-field exact:type=system-mail` or a catch-all target.

**BTRFS caveat (this host is BTRFS root):** there is no BTRFS-specific notification type and no
`zed` equivalent. BTRFS device errors / failed scrubs are NOT auto-emailed by default. To be alerted
you must arrange your own mail-to-root (e.g. a cron/systemd-timer running `btrfs scrub` +
`btrfs device stats` and mailing root on error), which then flows through `system-mail`. Plan for
this explicitly - it is a real gap for a BTRFS box.

**Fencing:** `type=fencing`, `error` - HA/cluster only; not applicable to a single node.

## Configuring via pvesh (CLI, no GUI)

The API tree is under `/cluster/notifications/`. Endpoints (targets) are per-type:
`/cluster/notifications/endpoints/{sendmail,smtp,gotify,webhook}`. Matchers under
`/cluster/notifications/matchers`. There is also a read aggregate at
`/cluster/notifications/targets`.

Create an SMTP target:

```bash
pvesh create /cluster/notifications/endpoints/smtp \
 --name smtp-alerts \
 --server smtp.gmail.com \
 --port 587 \
 --mode starttls \
 --username you@gmail.com \
 --password '<app-password>' \
 --from-address you@gmail.com \
 --mailto you@gmail.com \
 --comment 'Alerts to my email'
```

(The `--password` is written to the priv file automatically.)

Create a sendmail target:

```bash
pvesh create /cluster/notifications/endpoints/sendmail \
 --name local-mail \
 --mailto-user root@pam \
 --from-address pve@myhost.example.com \
 --comment 'Local MTA'
```

Create a Gotify target:

```bash
pvesh create /cluster/notifications/endpoints/gotify \
 --name gotify-mobile \
 --server https://gotify.example.com \
 --token "$GOTIFY_TOKEN"
```

Create a matcher (e.g. backup failures to smtp-alerts):

```bash
pvesh create /cluster/notifications/matchers \
 --name backup-failures \
 --match-field 'exact:type=vzdump' \
 --match-severity error \
 --target smtp-alerts \
 --comment 'Backup failures to my email'
```

A catch-all "send me everything" matcher (good simple home default):

```bash
pvesh create /cluster/notifications/matchers \
 --name all-to-me \
 --target smtp-alerts
```

Inspect / edit / delete:

```bash
pvesh get /cluster/notifications/endpoints/smtp
pvesh get /cluster/notifications/endpoints/smtp/smtp-alerts
pvesh set /cluster/notifications/endpoints/smtp/smtp-alerts --mailto other@example.com
pvesh delete /cluster/notifications/endpoints/smtp/smtp-alerts
pvesh get /cluster/notifications/matchers
pvesh set /cluster/notifications/matchers/default-matcher --disable true
```

(`set` on a target may require re-supplying secrets; check with a `get` first.)

## Testing a target from the shell (the "Test" button equivalent)

The GUI "Test" button maps to a `test` API subpath on the endpoint. From the CLI:

```bash
pvesh create /cluster/notifications/endpoints/smtp/smtp-alerts/test
pvesh create /cluster/notifications/endpoints/sendmail/local-mail/test
pvesh create /cluster/notifications/endpoints/gotify/gotify-mobile/test
pvesh create /cluster/notifications/endpoints/webhook/<name>/test
```

This sends a test notification through that specific target (a `notice`-severity test message),
letting you confirm SMTP auth/TLS, Gotify token, or webhook body without waiting for a real event.
Testing requires `Mapping.Use` (or `Mapping.Audit`/`Mapping.Modify`) on the `/mapping/notifications`
ACL node - root has this.

`proxmox-mail-forward`: this is the helper binary PVE uses internally to ingest local mail-to-root
into the notification system (the `system-mail` bridge above). It is NOT a user test command; you
don't invoke it by hand for testing. Use the `/test` API path instead. To test the smartd/ZFS path
end-to-end, send a mail to root, e.g. `echo "test body" | mail -s "test subject" root` (with
`mailutils`/`bsd-mailx` installed) and confirm it arrives at your target as a `system-mail`
notification.

## From-address and the legacy root email

**From-address resolution order** (used by sendmail + smtp targets):

1. the target's own `from-address`;
2. else `email_from` in `/etc/pve/datacenter.cfg`;
3. else `root@$hostname`. The From header is rendered as `$author <$from-address>`.

Set the datacenter-wide default from-address (CLI):

```bash
pvesh set /cluster/options --email-from pve@myhost.example.com
```

or add `email_from: pve@myhost.example.com` to `/etc/pve/datacenter.cfg`.

**root@pam's email** (the address the built-in `mail-to-root` target / `root@pam` `mailto-user`
resolves to) - set it so default mails reach you:

```bash
pveum user modify root@pam --email me@example.com
```

(or edit `/etc/pve/user.cfg`). On a single-node home box this one setting + the built-in default
matcher already gets you basic email-to-self once the host can send mail.

## Migration from PVE 8 / legacy `--mailto`

- **Old model (pre-8.1):** each backup job had its own `--mailto`/`mailtonotification` and the only
  channel was local email. Datacenter had a single `email_from`. There were no targets/matchers.
- **PVE 9:** the notification system is the default everywhere. `vzdump --mailto` and the per-job
  email-only flow are superseded by `notification-mode notification-system` + matchers. Backup jobs
  may still choose `legacy-sendmail` mode for the old behavior, but this mode is documented as
  "might be removed in a later release" - do not build on it.
- **`email_from`** in datacenter.cfg still exists and still feeds the from-address fallback.
- **Gotcha after 8 to 9 upgrade:** some users stopped receiving backup emails because jobs retained
  `legacy-sendmail` mode while their MTA/relay setup changed, or because the default matcher was
  edited. Verify with the `/test` path and `pvesh get /cluster/notifications/matchers`.

## Recommended simple home setup (single node, shell-only, BTRFS)

Two good options:

**Option A - SMTP to your own mailbox (simplest, no extra infra):**

1. `pveum user modify root@pam --email me@example.com`
2. Create an `smtp` target to your provider (Gmail app-password / Fastmail), as above
   (`smtp-alerts`).
3. Either keep `default-matcher` (sends everything to root via local sendmail) OR repoint it / add
   `all-to-me` matcher targeting `smtp-alerts` and disable `default-matcher`, depending on whether
   your local Postfix can relay. Using the smtp target avoids needing a working local MTA at all.
4. `pvesh set /cluster/options --notify package-updates=always` so update notices fire on a
   no-subscription box.
5. Ensure `smartmontools` installed + `smartd` mailing root for SMART; add a BTRFS scrub timer that
   mails root on error (no native BTRFS notifications).
6. Test: `pvesh create /cluster/notifications/endpoints/smtp/smtp-alerts/test`.

**Option B - self-hosted ntfy via webhook (great for phone push, screen-reader friendly):** Run ntfy
somewhere, create a `webhook` target pointing at it (see ntfy stanza above), a catch-all or
severity-filtered matcher targeting it, test via the `/webhook/<name>/test` path. Same
`package-updates=always` and SMART/BTRFS-to-root steps apply.

For "only tell me about problems": use matchers `match-severity warning,error` for
vzdump/replication/fencing, PLUS a separate matcher `match-field exact:type=package-updates`
(updates are `info`) and one for `match-field exact:type=system-mail` (SMART/ZFS/BTRFS are
`unknown`), so nothing important is dropped by a pure-severity filter.

## Gotchas summary

- SMART/ZFS/BTRFS alerts ride the `system-mail` bridge (severity `unknown`) - a severity-only
  matcher MISSES them; match `type=system-mail` explicitly.
- BTRFS has NO native notification type and NO `zed`-style daemon - you must roll your own
  scrub/stats check that mails root.
- `package-updates` is `info` severity and is gated by `--notify package-updates=always` on
  no-subscription hosts; also deprecated-but-still-required in PVE 9.
- SMTP target has no retry; sendmail (via MTA) does. For reliability behind flaky links,
  sendmail+smarthost can be steadier than direct smtp.
- `job-id` metadata exists only for scheduled backups, not manual `vzdump`.
- Secrets must go in `/etc/pve/priv/notifications.cfg` with a matching `type: name` header;
  `pvesh`/GUI handle this split automatically, manual edits must not.
- Built-in `mail-to-root`/`default-matcher` can't be deleted, only modified/disabled.
- Test from CLI with `pvesh create /cluster/notifications/endpoints/<type>/<name>/test`.

## Citations

- Proxmox VE Notifications chapter (current/9):
  [Notifications](https://pve.proxmox.com/pve-docs/chapter-notifications.html)
- Notifications source (.adoc):
  [pve-docs/notifications.adoc at master · proxmox/pve-docs](https://github.com/proxmox/pve-docs/blob/master/notifications.adoc)
- Proxmox VE wiki, Notifications: [Notifications](https://pve.proxmox.com/wiki/Notifications)
- datacenter.cfg manual (notify / email_from):
  [Manual: datacenter.cfg](https://pve.proxmox.com/wiki/Manual:_datacenter.cfg) and
  [datacenter.cfg(5)](https://pve.proxmox.com/pve-docs/datacenter.cfg.5.html)
- Update notifications mechanism (pve-daily-update.timer, package-updates=always):
  [Proxmox VE Update Notifications in the Lab](https://majornetwork.net/2026/04/proxmox-ve-update-notifications-in-the-lab/)
- Targets/matchers/SMTP/Gotify/webhook walkthrough (DATAZONE):
  [Proxmox Notification System: Matchers, Targets, SMTP, Gotify, and Webhooks](https://datazone.de/en/aktuelles/proxmox-notifications-alerting/)
- pvesh test path + endpoint creation (Proxmox forum, "Creating the notifications.cfg file"):
  [Creating the notifications.cfg file](https://forum.proxmox.com/threads/creating-the-notifications-cfg-file.162754/)
- Upgrade 8 to 9 (migration context):
  [Upgrade from 8 to 9](https://pve.proxmox.com/wiki/Upgrade_from_8_to_9)
