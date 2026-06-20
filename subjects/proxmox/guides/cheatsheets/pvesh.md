# Cheatsheet: pvesh (the API from the shell)

`pvesh` is the universal text gateway over the same REST API the web GUI drives: one verb plus one
path reaches anything the GUI can do, because the GUI is just a client of that API. Reach for it
when no friendlier tool (`qm`, `pct`, `pvesm`, `pveum`) covers what you want. Run as root on the
Proxmox host, it talks to the API over a local socket, so it needs no credentials, no token, and no
TLS to arrange. Every line below is plain text you run over SSH, with no web GUI anywhere. For the
framing and a guided tour, see [02 -- The shell and the API](../02-the-shell-and-the-api.md).

`<node>` is this host's name; `$(hostname)` fills it in.

## The verbs

- `pvesh get <path>` -- read a resource (the API's GET).
- `pvesh set <path> [options]` -- update an existing resource (PUT).
- `pvesh create <path> [options]` -- make something or invoke an action (POST).
- `pvesh delete <path>` -- remove a resource (DELETE).
- `pvesh ls <path>` -- list the child objects under a path.
- `pvesh usage <path> -v` -- print the parameters and return shape a path accepts; the `-v`
  (verbose) form is the key discovery tool.

## Reading the tree (discovery)

- `pvesh ls /` -- list the top of the API tree.
- `pvesh ls /nodes/$(hostname)` -- list what hangs off this node (`qemu`, `lxc`, `storage`, `tasks`,
  `network`, and the rest); walk down with another `ls`, read a leaf with `get`.
- `pvesh get /version` -- the API and Proxmox version; the simplest call and a good first test.
- `pvesh get /nodes/$(hostname)/status` -- the node's full status (load, memory, uptime, kernel).
- `pvesh get /cluster/resources` -- every VM, container, and storage in one list.
- `pvesh get /cluster/resources --type vm` -- filter to VMs only (`--type storage` for storage).
- `pvesh usage /nodes/$(hostname)/qemu -v` -- read a path's own docs as navigable prose; the answer
  to "how do I do X?" is always find the path with `ls`, read it with `usage`, then `get` or
  `create`.

## Output format (for screen reader and scripting)

- `pvesh get /version --output-format yaml` -- one labelled value per line; usually the easiest to
  read aloud.
- `pvesh get /version --output-format json` -- the cleanest form to pipe into `jq` when scripting.
- The default `text` output renders wide ASCII-bordered tables that read poorly; prefer
  `--output-format yaml` (or `json`) on every `get`.

## Changing config

- `pvesh set /cluster/options --email-from pve@myhost.example.com` -- set a datacenter-wide option
  (here the default notification from-address).
- `pvesh set /cluster/options --notify package-updates=always` -- another `/cluster/options` key
  (make update notices fire on a home node).
- Create an SMTP notification target:

  ```bash
  pvesh create /cluster/notifications/endpoints/smtp --name smtp-alerts --server smtp.example.com --port 587 --mode starttls --username you@example.com --password '<app-password>' --from-address you@example.com --mailto you@example.com
  ```

  The secret is written to the root-only `/etc/pve/priv/notifications.cfg` for you, but the literal
  password also lands in shell history and is briefly visible in the process table; prefix the
  command with one leading space to keep it out of history, and never paste a real secret into a
  card or a log. See guide 15 for the full notification body and matchers.

- `pvesh create /cluster/notifications/matchers --name all-to-me --target smtp-alerts` -- route
  events to a target (a matcher with no rules matches everything).
- `pvesh create /cluster/notifications/endpoints/smtp/smtp-alerts/test` -- the GUI "Test" button is
  a `test` subpath; trigger it to confirm a target works.

## Orientation: the path is the GUI's path

The path you give `pvesh` is the same one the GUI calls behind every button, so anything the GUI
does, `pvesh` does too; there is no GUI-only capability. When you do not know a path's parameters,
do not guess: read them with `pvesh usage <path> -v`, which prints every option, what it means, and
what the call returns. Walk with `ls`, describe with `usage`, then act with `get`, `set`, `create`,
or `delete`.

## Full treatment

This card is a reminder, not a lesson. For the why and worked examples, see:

- [02 -- The shell and the API](../02-the-shell-and-the-api.md) -- pvesh as the universal text
  gateway, the verb-to-HTTP-method mapping, `ls`/`usage` discovery, `--output-format`, and the
  local-socket no-credentials fact.
- [15 -- Monitoring, maintenance, and notifications](../15-monitoring-maintenance-and-notifications.md)
  -- the real `pvesh get /nodes/<node>/status` and `/cluster/resources` reads, and the full
  `pvesh create /cluster/notifications/...` target and matcher examples.

---

Back to the [cheatsheets index](README.md). Browse all the [guides](../README.md).
