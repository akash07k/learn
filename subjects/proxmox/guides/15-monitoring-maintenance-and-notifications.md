# Monitoring, maintenance, and notifications

## What you'll be able to do

By the end of this guide you will be able to watch the node's health entirely as text, with no
dashboards and no graphical console: node status, guest inventory, disk health, and a single
full-text snapshot. You will schedule the disk-integrity scrubs and make the logs survive a reboot.
And you will set up the Proxmox [notification system](GLOSSARY.md) so the host alerts you (by email
now, and by phone push later if you want it) when a backup fails, a disk degrades, or updates are
waiting.

## Text monitoring (no dashboards)

Everything in this section produces plain text or structured YAML or JSON. None of it needs the web
GUI, and where a command can emit a machine format you should ask for it, because the default `text`
output uses ASCII-art borders that read poorly with a screen reader.

### Node and resource status

Read the node's full status, then the resource and storage and disk inventories, as YAML through
[pvesh](GLOSSARY.md):

```bash
# Full node status as YAML (clean for a screen reader, no ASCII borders):
pvesh get /nodes/$(hostname)/status --output-format yaml

# All resources (VMs, containers, storage) in one list:
pvesh get /cluster/resources --output-format yaml
pvesh get /cluster/resources --type vm --output-format yaml

# Storage status on this node:
pvesh get /nodes/$(hostname)/storage --output-format yaml

# Disks the node sees, including a SMART health summary per disk:
pvesh get /nodes/$(hostname)/disks/list --output-format yaml
```

Prefer `--output-format yaml` (or `json`) over the default `text` on every `pvesh get`. The default
renders wide column-aligned tables with ASCII-art borders; YAML and JSON are linear key-and-value
text that a screen reader follows cleanly. A useful habit is to wrap the node-status command in a
shell alias so it is one word to type.

### Guest inventory

List and inspect the guests from the shell. `qm` covers VMs and `pct` covers containers:

```bash
qm list                       # VMs: id, name, status, memory, disk, pid
pct list                      # containers
qm config 100                 # full configuration of one VM
qm status 100                 # running or stopped, plus the QMP status
pct config 101                # full configuration of one container
pct status 101                # running or stopped
```

`qm list` and `pct list` are short and read acceptably as plain tables; the per-guest `config` and
`status` commands are linear key-and-value text.

### pvereport

`pvereport` gathers one big plain-text snapshot of the host: versions, storage, network, ZFS state,
running guests, replication, and more. It is excellent to read end to end, and it is the right thing
to attach when you ask for help. Save it with a dated filename:

```bash
pvereport > /root/pvereport-$(date +%F).txt
```

On PVE 9 the report uses the renamed `zarcstat` tool for its ZFS ARC section (ZFS 2.4 renamed the
old `arcstat`), so do not be surprised by the new name in the output.

### glances

[glances](GLOSSARY.md) is a live monitor. Its full-screen visual mode and its web dashboard are of
no use here, but its `--stdout` mode prints periodic plain-text metric lines that a screen reader
can follow, which is exactly what you want for a live look at the node:

```bash
apt install -y glances
glances --stdout cpu.total,mem.percent,load,fs   # plain stdout, no visual UI
glances --stdout-csv cpu.total,mem.used           # CSV form, for scripting
```

Choose the stdout mode over the visual TUI or the web dashboard deliberately: it is the one form of
glances that emits linear text rather than a redrawn screen or a graphical page.

## Disk health: SMART and smartd

smartmontools is preinstalled. Read the NVMe's health directly:

```bash
smartctl -a /dev/nvme0       # full health and identify
smartctl -H /dev/nvme0       # just the overall health verdict
```

The NVMe endurance fields worth watching:

- `Percentage Used` is the wear estimate; 100% means the rated endurance has been reached (the drive
  may still work, but plan its replacement).
- `Available Spare` against its `Available Spare Threshold`: replace the drive if the spare drops
  near the threshold.
- `Media and Data Integrity Errors` should stay at 0.

Most modern NVMe drives support self-tests. Start one and read the results log:

```bash
smartctl -t short /dev/nvme0     # quick self-test
smartctl -t long /dev/nvme0      # extended self-test
smartctl -l selftest /dev/nvme0  # the self-test results log
```

Now configure [smartd](GLOSSARY.md) so the tests run on a schedule and problems are mailed to root.
smartd already auto-scans the NVMe and mails root on problems every 30 minutes by default; this adds
scheduled self-tests and pins the mail recipient. Edit `/etc/smartd.conf` the accessible,
non-interactive way (a here-doc appended with `tee`; see guide
[02 -- The shell and the API](02-the-shell-and-the-api.md) for the full menu of accessible editing
methods, including VS Code Remote-SSH):

```bash
tee -a /etc/smartd.conf <<'EOF'
# nvme0: monitor all, short test daily 2am, long test 1st of month 3am, mail root
/dev/nvme0 -a -o on -S on -s (S/../.././02|L/../01/./03) -m root -M exec /usr/share/smartmontools/smartd-runner
EOF
```

Because `tee -a` only appends, re-running this step adds a second `/dev/nvme0` directive. Read back
what is in the file and confirm the device appears exactly once:

```bash
grep nvme0 /etc/smartd.conf
```

You want a single `/dev/nvme0` line; if a re-run left a duplicate, delete the extra before starting
the daemon. (A bare `DEVICESCAN` line, if your config has one, auto-discovers devices but does not
carry the scheduled-self-test and mail options above, so it does not cover this `nvme0` directive.)

Then enable and start the daemon:

```bash
systemctl enable --now smartd
```

The `-m root` part sends smartd's alerts to the local root mailbox. That local mail does not vanish
into a file you never read: Proxmox intercepts mail to root and turns it into a `system-mail`
notification, so it flows through the notification system you set up below and reaches whatever
target you configure there.

### Verify it worked

```bash
smartctl -H /dev/nvme0       # expect: SMART overall-health ... PASSED
systemctl status smartd      # expect: active (running)
```

## Filesystem scrubs and scheduling

Guide [09 -- Storage](09-storage.md) taught what a scrub does: a [btrfs scrub](GLOSSARY.md) and a
[zpool scrub](GLOSSARY.md) each read every allocated block and verify it against its stored
checksum, and on this single-disk host they detect and report corruption rather than repair it. This
section is about running them on a schedule and being told when one finds a problem; see guide 09
for the mechanics and the single-disk caveats.

Run them by hand and read their status as plain text:

```bash
btrfs scrub start /          # start a scrub of the btrfs root
btrfs scrub status /         # progress and errors, read-friendly text
btrfs device stats /         # cumulative per-device error counters

zpool scrub <pool>           # start a scrub of the external ZFS pool
zpool status -v <pool>       # state, errors, and scrub progress (plain text)
```

For scheduling, the two filesystems differ:

- ZFS on Debian ships a per-pool monthly timer. Enable it once for your pool:

  ```bash
  systemctl enable --now zfs-scrub-monthly@<pool>.timer
  ```

- btrfs has no scrub-and-alert timer of its own. The kernel does ship a per-mount scrub timer
  (`btrfs-scrub@-.timer` for the root mount), which guide [09 -- Storage](09-storage.md) covers for
  getting the scrub itself scheduled. What neither that timer nor btrfs provides is any alert when a
  scrub or a device counter goes bad: btrfs has no notification mechanism. So if you rely on the
  kernel timer for scheduling, you still need to add your own check that mails root on error. A
  small monthly systemd timer (or a cron entry) running a scrub and then inspecting
  `btrfs device stats` and mailing root when an error count is non-zero closes that gap.

Here is that check in a systemd form. It does not try to repair anything; it only turns non-zero
btrfs device counters into a local root mail, which the Proxmox notification system below can route
to the target you configure. File `/usr/local/sbin/check-btrfs-device-stats`:

```bash
tee /usr/local/sbin/check-btrfs-device-stats >/dev/null <<'EOF'
#!/bin/sh
set -eu

OUT=$(btrfs device stats /)
if printf '%s\n' "$OUT" | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+$/ && $i != 0) bad=1 } END { exit bad ? 0 : 1 }'; then
  if command -v sendmail >/dev/null 2>&1; then
    {
      printf 'Subject: btrfs device errors on pve\n\n'
      printf '%s\n' "$OUT"
    } | sendmail root
  elif command -v mail >/dev/null 2>&1; then
    printf '%s\n' "$OUT" | mail -s 'btrfs device errors on pve' root
  else
    logger -p daemon.err 'btrfs device errors detected, but no sendmail or mail command is installed'
    printf '%s\n' "$OUT"
    exit 1
  fi
fi
EOF
chmod 755 /usr/local/sbin/check-btrfs-device-stats
```

Create the service and timer. File `/etc/systemd/system/check-btrfs-device-stats.service`:

```ini
[Unit]
Description=Check btrfs device error counters

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/check-btrfs-device-stats
```

File `/etc/systemd/system/check-btrfs-device-stats.timer`:

```ini
[Unit]
Description=Monthly btrfs device error counter check

[Timer]
OnCalendar=monthly
Persistent=true

[Install]
WantedBy=timers.target
```

Enable it and run it once:

```bash
systemctl daemon-reload
systemctl enable --now check-btrfs-device-stats.timer
systemctl start check-btrfs-device-stats.service
systemctl status check-btrfs-device-stats.service
```

The service exits cleanly when all counters are zero. If any counter is non-zero, it sends root a
mail containing the full `btrfs device stats /` output.

That btrfs alerting gap ties directly into the notification system in the next section: SMART and
ZFS daemons mail root on trouble and so reach you automatically, but btrfs does not, so the
mail-on-error step is yours to add.

## Logs that survive a reboot (journald)

By default [journald](GLOSSARY.md) keeps its logs in memory, so they are lost on reboot, which is
exactly when you most want to read what happened. Make them persistent and cap their size. Edit
`/etc/systemd/journald.conf` the accessible way (here-doc via `tee`, or a drop-in, per guide
[02 -- The shell and the API](02-the-shell-and-the-api.md)); a drop-in under
`/etc/systemd/journald.conf.d/` is the cleanest form, but setting the keys in the main file works
too:

```bash
tee /etc/systemd/journald.conf.d/00-persistent.conf <<'EOF'
[Journal]
Storage=persistent
SystemMaxUse=1G
SystemKeepFree=2G
MaxRetentionSec=1month
EOF
```

Create the journal directory and restart the service so it takes effect:

```bash
mkdir -p /var/log/journal
systemctl restart systemd-journald
```

Reading the logs:

```bash
journalctl -u <service> -e    # one service, jump to the end
journalctl -p err -b          # this boot, errors and worse
journalctl -k                 # the kernel ring buffer
```

If the journal ever grows too large, trim it manually:

```bash
journalctl --disk-usage       # how much it is using now
journalctl --vacuum-size=500M # trim to a size
journalctl --vacuum-time=14d  # trim to an age
```

### Verify it worked

```bash
journalctl --disk-usage       # should report storage under /var/log/journal
```

A path under `/var/log/journal` in the output (rather than `/run/log/journal`) confirms the journal
is now persistent on disk.

## The notification system

### How it works

The [notification system](GLOSSARY.md) has two kinds of object:

- A [notification target](GLOSSARY.md) is where a notification goes: a `sendmail` target (hand the
  mail to the local MTA), an `smtp` target (talk SMTP directly to an external relay), a `gotify`
  push server, or a generic `webhook`.
- A [notification matcher](GLOSSARY.md) decides which events go to which targets. Every matcher is
  evaluated for each event, and every target on a matching matcher is notified (a target is notified
  at most once per event). A matcher with no match rules matches everything.

A fresh install already alerts you, after a fashion: it ships a built-in `mail-to-root` target (type
`sendmail`, sending to the `root@pam` address) and a built-in always-on `default-matcher` with no
rules pointed at it, so out of the box every notification is mailed to root through the local
sendmail path. You cannot delete the built-ins, but you can modify or disable them.

Every event carries a severity, one of `info`, `notice`, `warning`, `error`, or `unknown`. Matchers
can filter on severity, and the choice of severity matters in two gotchas described below.

The configuration is split across two files: the public `/etc/pve/notifications.cfg` holds the
target and matcher definitions, and the secret `/etc/pve/priv/notifications.cfg` holds only the
secrets (SMTP passwords, Gotify tokens, webhook secrets), root-readable only. You can hand-edit
these files, but `pvesh` is cleaner because it writes the public-and-secret split for you
automatically; the rest of this section uses `pvesh /cluster/notifications/...`.

If you are not working as `root@pam`, notification target management is gated by mapping ACLs:
viewing targets needs `Mapping.Audit` on `/mapping/notifications`, editing targets needs
`Mapping.Modify`, and testing a target needs `Mapping.Use`, `Mapping.Audit`, or `Mapping.Modify`.
The root shell path in this guide already has those privileges, but the distinction matters if you
delegate alert configuration later.

### Set your address and from-address

First make sure the default mail actually reaches you, and that it is sent from a sensible address.
Set the email on `root@pam` (this is the address the built-in `mail-to-root` target resolves to; see
guide [13 -- Users, permissions, and API tokens](13-users-permissions-and-api-tokens.md) for
`root@pam` and `pveum`):

```bash
pveum user modify root@pam --email me@example.com
```

Set the datacenter-wide default from-address, used when a target does not set its own:

```bash
pvesh set /cluster/options --email-from pve@myhost.example.com
```

### An SMTP target to your own mailbox

The simplest reliable home path is an `smtp` target that talks directly to your mail provider,
because it needs no working local MTA. Create one:

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

The `--password` value is written to the secret file `/etc/pve/priv/notifications.cfg`
automatically, but the literal password also lands in root's shell history (`~/.bash_history`) and
is briefly visible in the process table. To prevent the line from being recorded, prefix the command
with a leading space (one space before `pvesh`) when `HISTCONTROL` is set to `ignorespace` or
`ignoreboth` in your shell profile; if you forget, remove the entry with `history -d <n>` (where
`<n>` is the line number shown by `history`) and then clear `~/.bash_history` with
`history -c && history -w`. For Gmail, use a Google App Password here, not your normal login
password. Other providers (Fastmail, your ISP, an internal relay) follow the same shape; the ports
are 587 for `starttls`, 465 for `tls`, and 25 for `insecure`.

Now route events to that target with a matcher. A focused matcher for backup failures only:

```bash
pvesh create /cluster/notifications/matchers \
  --name backup-failures \
  --match-field 'exact:type=vzdump' \
  --match-severity error \
  --target smtp-alerts \
  --comment 'Backup failures to my email'
```

Or, for a simple home node, a catch-all that sends everything to you:

```bash
pvesh create /cluster/notifications/matchers \
  --name all-to-me \
  --target smtp-alerts
```

The catch-all is the easiest correct choice on a single node, because it cannot miss the two awkward
cases described next. If you instead filter by severity to cut noise, read those two cases first.

### Make update notices fire

Update notifications are produced by the daily `pve-daily-update` timer, but only if the cluster
`notify` option permits it. On a no-subscription home node the default (`auto`) stays silent, so set
it to always:

```bash
pvesh set /cluster/options --notify package-updates=always
```

This key is marked deprecated in the PVE 9 manuals (future versions move fully to matchers and
targets), but as of PVE 9 you still set it here, so set it. Note that a package-updates notification
has `info` severity, so a matcher that filters by severity for `warning,error` will miss update
notices; if you filter by severity, add a separate matcher with
`--match-field 'exact:type=package-updates'` to catch them.

### The system-mail bridge and the btrfs gap

SMART and ZFS do not have their own notification types. Instead, their daemons (smartd for SMART,
the ZFS Event Daemon for ZFS) mail the local root user, and Proxmox converts mail-to-root into a
notification of `type=system-mail` with severity `unknown`. That `unknown` severity is the trap: a
matcher that filters by `--match-severity warning,error` will miss every SMART and ZFS alert. Catch
them with a field match instead, or with the catch-all above:

```bash
pvesh create /cluster/notifications/matchers \
  --name system-mail-to-me \
  --match-field 'exact:type=system-mail' \
  --target smtp-alerts \
  --comment 'SMART/ZFS mail-to-root alerts'
```

btrfs is a further gap. It has no native notification type and no daemon equivalent to the ZFS Event
Daemon, so a btrfs device error or a failed scrub is not auto-mailed at all. This is the loose end
from the scrubs section above: to be alerted about btrfs you must add your own scheduled check that
runs a scrub (or reads `btrfs device stats`) and mails root on error. That mail then rides the same
`system-mail` bridge and reaches your target like any other. On a btrfs-root host, plan for this
explicitly; nothing else will tell you.

### ntfy via webhook (later, for phone push)

When you want alerts pushed to a phone rather than emailed, ntfy is a good shell-friendly choice.
There is no dedicated ntfy target type, so you wire it through a `webhook` target pointed at the
ntfy URL: method `POST`, the URL of your ntfy topic, a `Title:` header, and `{{ message }}` as the
body. One caveat for hand-editing: the webhook's `body`, `header`, and `secret` fields are stored as
JSON-array-encoded strings. Rather than guess the encoding, create one webhook with `pvesh` and run
a `pvesh get /cluster/notifications/endpoints/webhook/<name>` once to see the exact format before
you adjust it.

### Test from the shell

The GUI "Test" button maps to a `test` subpath on the endpoint. Trigger it from the shell to confirm
SMTP auth and TLS without waiting for a real event:

```bash
pvesh create /cluster/notifications/endpoints/smtp/smtp-alerts/test
pvesh create /cluster/notifications/endpoints/webhook/<name>/test
```

To exercise the `system-mail` path end to end (the one SMART, ZFS, and your btrfs check all use),
send a mail to root and confirm it arrives at your target as a `system-mail` notification. This
needs a local mail command; install one if `mail` is not yet available (`mailutils` also provides
`mail`):

```bash
apt install -y bsd-mailx
```

```bash
echo "test body" | mail -s "test subject" root
```

### Verify it worked

The `/test` call above should deliver a test message to your configured mailbox (or, for a webhook
to ntfy, to your phone) within a few seconds. If it does not arrive, re-check the server, port,
mode, username, and the app-password in the target before suspecting the matcher.

## External metric servers (and why to skip them)

Proxmox can push metrics to Graphite, InfluxDB, or OpenTelemetry, defined in `/etc/pve/status.cfg`,
and the community `prometheus-pve-exporter` exposes the API as Prometheus metrics. These all exist
to feed graphical dashboards such as Grafana or an OpenTelemetry stack. They produce data, not an
accessible text interface, so for a screen-reader, shell-only workflow they add real complexity with
little benefit. The honest recommendation here is to skip the metric-server-and-Grafana stack and
rely on the CLI tools in this guide (`pvesh ... --output-format yaml`, `pvereport`,
`glances --stdout`, `journalctl`, `smartctl`, and the scrub-status commands). Set one up only if a
sighted collaborator will actually use the dashboard. This is an accessibility judgement, not an
endorsement.

## Sources

- `research/round2-pve9/19-pve9-hardening-and-monitoring.md` -- the source for the monitoring half:
  the `pvesh` node, resources, storage, and disk-list reads with `--output-format yaml` and the
  point that YAML and JSON beat the ASCII-art `text` default; the `qm`/`pct` guest inventory;
  `pvereport` and the PVE 9 `zarcstat` rename; the SMART and smartd commands, the NVMe endurance
  fields, the NVMe self-tests, the `/etc/smartd.conf` scheduled-self-test line and `-m root`, and
  the smartd enable-and-verify; the btrfs and ZFS scrub commands and the
  `zfs-scrub-monthly@<pool>.timer`; the journald persistent-storage settings and the `journalctl`
  reads and vacuum commands; and glances `--stdout`; and the External Metric Server section with its
  accessibility caveat.
- `research/round2-pve9/18-pve9-notifications.md` -- the source for the entire notification section:
  targets and matchers and the built-in `mail-to-root` and `default-matcher`; the severities; the
  public-and-secret config-file split; the `smtp` target and Gmail app-password note; the matcher
  examples (`backup-failures`, `all-to-me`, `system-mail`); `package-updates=always` and the
  `info`-severity gotcha; the `system-mail` bridge with its `unknown`-severity gotcha and the
  btrfs-no-native-alerts gap; ntfy via webhook with the JSON-array-encoding note; the
  `pvesh /cluster/notifications/...` configuration paths; the `/test` path and the
  `mail -s ... root` system-mail test; and the `root@pam` email and `--email-from` from-address
  settings.
- `GLOSSARY.md` -- the canonical definitions reused here of [smartd](GLOSSARY.md),
  [glances](GLOSSARY.md), [journald](GLOSSARY.md), the [notification system](GLOSSARY.md),
  [notification target](GLOSSARY.md), [notification matcher](GLOSSARY.md),
  [btrfs scrub](GLOSSARY.md), [zpool scrub](GLOSSARY.md), and [pvesh](GLOSSARY.md), plus the
  `root@pam` role reused from guide
  [13 -- Users, permissions, and API tokens](13-users-permissions-and-api-tokens.md).
- [Disk Health Monitoring wiki](https://pve.proxmox.com/wiki/Disk_Health_Monitoring) -- smartctl,
  the smartd auto-scan, and NVMe health.
- [External Metric Server chapter](https://pve.proxmox.com/pve-docs/chapter-sysadmin.html#external_metric_server)
  -- the `status.cfg` Graphite, InfluxDB, and OpenTelemetry support behind the skip recommendation.
- [Notifications chapter](https://pve.proxmox.com/pve-docs/chapter-notifications.html) -- targets,
  matchers, the target types, severities, target permissions, and the test path.
- [datacenter.cfg manual](https://pve.proxmox.com/pve-docs/datacenter.cfg.5.html) -- the `notify`
  and `email_from` options.

---

Previous: [14 -- Best practices and hardening](14-best-practices-and-hardening.md) | Next:
[16 -- Automation and the ecosystem](16-automation-and-the-ecosystem.md)
