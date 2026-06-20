# Recipe: Miniflux (an RSS reader)

## What you'll be able to do

You will run Miniflux, a minimalist self-hosted RSS reader, in one
[unprivileged container](../GLOSSARY.md). It is a single Go binary backed by a PostgreSQL database,
fronted by the shared [Caddy](../GLOSSARY.md) box from recipe 00 for automatic TLS. Miniflux has a
first-class command-line interface and a clean REST API, so you create users, run maintenance, and
read its logs entirely from the shell; the web dashboard is optional.

## Before you start

This recipe reuses foundations rather than re-teaching them. You need:

- An [unprivileged container](../GLOSSARY.md) to run Miniflux in. Creating one is taught in guide
  [05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md); this recipe shows only
  the one `pct create` line and points you there for the rest.
- The shared Caddy container from recipe [00 -- The shared reverse proxy](00-reverse-proxy.md),
  which terminates TLS for every web service. You do not give Miniflux its own certificate handling;
  you add one site block to the Caddyfile there. Do recipe 00 first.
- A static IP for the Miniflux container, so Caddy always finds it at the same upstream address.
  Giving a guest a static address is taught in guide [10 -- Networking](../10-networking.md).
  Throughout this recipe, substitute the container's own static address wherever you see `<mf-ip>`.

## Pick the pattern and size it

Both patterns produce the same thing: one lightweight unprivileged container running Miniflux
natively (a single Go binary plus a systemd service, no Docker) with a PostgreSQL database alongside
it in the same container.

- Pattern A, hand-built: you run `pct create` yourself, install PostgreSQL and Miniflux, and wire
  them together. You see and understand every step.
- Pattern B, Helper-Scripts: the community `ct/miniflux.sh` one-liner builds the unprivileged
  container and installs Miniflux and its database for you in about a minute. It is untrusted root
  code that you read, snapshot, and pin first; see the cross-reference under Path 1 below.

The research recommends pattern B for speed. Both are fully supported here; pick the one you are
comfortable owning.

Sizing is small either way: about 1 vCPU, 512 MB of RAM (PostgreSQL included), and 4 to 8 GB of
disk. A single Go binary plus a small PostgreSQL database has a tiny footprint.

Accessibility note: once the container exists you manage it with `pct enter <vmid>`, which drops you
straight into a root shell inside it with no console or networking setup. Every command below runs
either on the Proxmox host (the `pct` lines) or inside the container after `pct enter` (the install,
database, config, and service lines).

### Path 1 -- Helper-Scripts

On the Proxmox host root shell, the community `ct/miniflux.sh` script builds an unprivileged
container and installs Miniflux and its PostgreSQL database natively:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/miniflux.sh)"
```

The `wget` form is equivalent:

```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/miniflux.sh)"
```

That one-liner pipes code fetched from the internet straight into a root shell on the host. Treat it
as untrusted root code: read it first, snapshot the host, and pin a reviewed commit instead of
`main`, exactly as guide [16 -- Automation and the ecosystem](../16-automation-and-the-ecosystem.md)
teaches. The pinned-commit form substitutes a specific commit hash for `main` in the URL so the code
cannot change between your audit and your run:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/<COMMIT_SHA>/ct/miniflux.sh)"
```

When it finishes, give the new container a static IP (guide 10) if you did not in the script's
Advanced mode, then continue at "Manage it from the shell" and "Put it behind TLS" below. The
Helper-Script writes Miniflux's config and creates the admin user for you; the secret-hygiene notes
in Path 2 still apply when you later edit `/etc/miniflux.conf` or reset a password.

### Path 2 -- hand-built

On the Proxmox host, create the unprivileged container with a static address. The line below is the
shape of it; guide [05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md)
explains every option, the OS template, and confirming the template name with `pveam`. Substitute
your own VMID, bridge, address, gateway, and key path:

```bash
pct create 124 local-btrfs:vztmpl/debian-13-standard_13.x-1_amd64.tar.zst \
  --hostname miniflux \
  --unprivileged 1 \
  --cores 1 --memory 512 --swap 256 \
  --rootfs local-btrfs:8 \
  --net0 name=eth0,bridge=vmbr0,ip=192.168.1.124/24,gw=192.168.1.1 \
  --onboot 1 \
  --ssh-public-keys /root/miniflux.pub
```

Start it and enter it:

```bash
pct start 124
pct enter 124
```

You are now in a root shell inside the container.

#### Install PostgreSQL and create the database

Miniflux needs a PostgreSQL database and a role to own it. Install the server from Debian's own
repository, which enables and starts the `postgresql` service for you:

```bash
apt update
apt install -y postgresql
```

Now create the database role and the database it owns. The role needs a password, and that password
becomes part of the `DATABASE_URL` Miniflux uses to connect, so it is a secret: do not type it on a
command line where it lands in shell history or is visible to `ps`. The `createuser -P` form prompts
for the password instead of taking it as an argument, which is exactly what you want. Run both
commands as the `postgres` system user:

```bash
su - postgres -c "createuser -P miniflux"
su - postgres -c "createdb -O miniflux miniflux"
```

The first command prompts for the new role's password twice and echoes nothing. The second creates a
database named `miniflux` owned by that role. Remember the password you typed; you place it in the
root-only config file in the next step, never on a command line.

A note on the `hstore` extension: older Miniflux setup guides told you to run
`CREATE EXTENSION hstore`. Miniflux no longer needs it (it was dropped in version 2.0.27, and a
migration in 2.2.14 removes it), so do not create it. Creating it as the wrong role can in fact
cause a `must be owner of extension hstore` error on a later upgrade. Leave it out.

#### Install Miniflux from the official apt repository

Miniflux publishes an official Debian apt repository, which is the supported package install and
keeps Miniflux updatable with `apt`. Add the repository, update, and install the `miniflux` package.
State the path, then write the repo list with `tee`. File `/etc/apt/sources.list.d/miniflux.list`:

```bash
echo "deb [trusted=yes] https://repo.miniflux.app/apt/ * *" | tee /etc/apt/sources.list.d/miniflux.list >/dev/null
apt update
apt install -y miniflux
```

Note the `[trusted=yes]`: Miniflux's apt repository publishes no GPG signing key, so this flag tells
APT to install from `repo.miniflux.app` without verifying package signatures. That is upstream's own
documented method, but it is a real trust decision -- a hijacked mirror or a man-in-the-middle could
serve a package that installs as root in this container. Accept it knowingly here: the container is
unprivileged and single-purpose, and the fetch is over HTTPS. Treat it the same way as the
Helper-Script curl-pipe caveat earlier in this recipe. If Miniflux ever publishes a signing key,
switch to the `[signed-by=/etc/apt/keyrings/miniflux.gpg]` form so signatures are verified, as
recipe 04 and guide 12 do for their repositories.

The package installs the `miniflux` binary at `/usr/bin/miniflux`, a systemd service named
`miniflux`, and a default config file at `/etc/miniflux.conf`.

#### Write the config file with the database secret kept off the command line

Miniflux is configured by `/etc/miniflux.conf`: simple `KEY=value` lines. The load-bearing
secret-hygiene point is that the PostgreSQL role's password lives inside `DATABASE_URL` in this
file, so the file must be root-only and the password must never be echoed on a command line. Write
it with a here-doc, set `umask 077` first so it is created non-readable, then lock it to root. File
`/etc/miniflux.conf`:

```bash
umask 077
tee /etc/miniflux.conf >/dev/null <<'EOF'
# Connection string to PostgreSQL. The role password is a secret; this file is
# chmod 600 root-only so it is never world-readable. sslmode=disable is fine for
# a local socket/loopback connection inside this one container.
DATABASE_URL=postgres://miniflux:REPLACE_WITH_DB_PASSWORD@localhost/miniflux?sslmode=disable
# Run pending SQL migrations automatically on service start.
RUN_MIGRATIONS=1
# Listen on all interfaces so Caddy in its own container can reach it.
LISTEN_ADDR=0.0.0.0:8080
# The public base URL Caddy serves Miniflux at. Must match the Caddy site block.
BASE_URL=https://reader.example.com
EOF
chmod 600 /etc/miniflux.conf
chown root:root /etc/miniflux.conf
```

Edit the `REPLACE_WITH_DB_PASSWORD` placeholder to the role password you set with `createuser -P`,
using the accessible editing methods in guide
[02 -- The shell and the API](../02-the-shell-and-the-api.md) (a `sed -i`, a re-issued here-doc, or
VS Code Remote-SSH). Do not echo the password on a command line. `LISTEN_ADDR=0.0.0.0:8080` lets
Caddy on another container reach it; if Miniflux and Caddy ever share a host you can narrow this to
`127.0.0.1:8080`.

#### Run migrations and create the admin user

Migrations create the database schema. Because the config sets `RUN_MIGRATIONS=1`, the service runs
them on start, but you can also run them once by hand now, pointing Miniflux at the config file so
it reads `DATABASE_URL` from there (never from a command-line argument):

```bash
miniflux -migrate -config-file /etc/miniflux.conf
```

Create the first administrator interactively. The `-create-admin` flag prompts for the username and
password at the terminal rather than taking them as arguments, so the admin password stays out of
shell history:

```bash
miniflux -create-admin -config-file /etc/miniflux.conf
```

It asks for a username and a password (entered without echo) and creates the admin account. This
interactive prompt is the preferred path. Miniflux also supports a non-interactive `CREATE_ADMIN=1`
with `ADMIN_USERNAME` and `ADMIN_PASSWORD` in the config file; if you use that form instead, keep
`ADMIN_PASSWORD` only in the chmod-600 `/etc/miniflux.conf` (never on a command line), and remove
those three lines from the file after the first successful start so the plaintext admin password is
not left at rest.

Enable and start the service so it survives a reboot:

```bash
systemctl enable --now miniflux
systemctl status miniflux
```

## Manage it from the shell

Miniflux needs no dashboard for day-to-day work; the binary's CLI, the config file, and the journal
cover everything. Run the CLI commands inside the container after `pct enter 124`, and pass
`-config-file /etc/miniflux.conf` so each command reads the database connection from the root-only
file:

- Read the logs from the journal:

```bash
journalctl -u miniflux
```

(Add `-f` to follow it live, or `-n 50` for the last 50 lines.)

- Create another user, or reset a forgotten password, with a prompt rather than a command-line
  argument so the new secret stays out of history:

```bash
miniflux -create-admin -config-file /etc/miniflux.conf
miniflux -reset-password -config-file /etc/miniflux.conf
```

- Run maintenance from the CLI: `miniflux -run-cleanup-tasks` archives old entries and prunes old
  sessions, `miniflux -reset-feed-errors` clears stuck feed error states, and
  `miniflux -refresh-feeds` refreshes every feed synchronously. Flushing the reading history of all
  entries is exposed through the REST API (`PUT /v1/flush-history`) rather than as a CLI flag.
- The REST API exists for scripted management; with `BASE_URL` set, it lives under `/v1/...` and is
  driveable with `curl` and an API token created per user. The web dashboard remains available if
  you want it, but nothing here requires it.
- Change configuration by editing `/etc/miniflux.conf` (with the accessible methods in guide
  [02 -- The shell and the API](../02-the-shell-and-the-api.md)), then restart so the new settings
  are read: `systemctl restart miniflux`.

## Put it behind TLS

Miniflux listens on plain HTTP inside the container; TLS is the shared Caddy container's job. Do not
give Miniflux its own certificate. Instead, add one site block to the Caddyfile on the Caddy
container from recipe [00 -- The shared reverse proxy](00-reverse-proxy.md), pointing at this
container's address and Miniflux's `LISTEN_ADDR` port (`8080` above). The `BASE_URL` you set in
`/etc/miniflux.conf` must match this hostname exactly, or Miniflux will build links and redirects
against the wrong address.

On the Caddy container (after `pct enter` into it), append the Miniflux block to the shared
Caddyfile, then reload, using the `tee -a` then reload pattern recipe 00 established. Substitute
your hostname and this container's `<mf-ip>`. File `/etc/caddy/Caddyfile`:

```bash
tee -a /etc/caddy/Caddyfile >/dev/null <<'EOF'

reader.example.com {
	reverse_proxy <mf-ip>:8080
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
}
EOF
caddy reload --config /etc/caddy/Caddyfile
```

The `tls { dns cloudflare ... }` block is the DNS-01 form recipe 00 and guide 12 cover; omit it only
if your Caddy container is not using DNS-01. Caddy obtains and renews the certificate for
`reader.example.com` automatically and proxies to Miniflux on port 8080.

## Verify it worked

Three checks confirm Miniflux is serving. First, inside the container (`pct enter 124`), the binary
reports its version, which proves the package is installed and runnable:

```bash
miniflux -version
```

The expected key line is a version string such as `2.2.x`. Second, the service is listening on its
port (still inside the container):

```bash
ss -tlnp 'sport = :8080'
```

The expected key line names a listener on `0.0.0.0:8080` owned by the `miniflux` process. You can
also confirm it answers plain HTTP at the container's address (run from the host or the Caddy
container, which can reach `<mf-ip>`). Hit `/healthcheck`, Miniflux's health endpoint, which
deterministically returns `200 OK` (body `OK`); the root path `/` instead redirects an
unauthenticated request to the login page (`HTTP/1.1 302 Found`), so it is not a reliable up-check:

```bash
curl -I http://192.168.1.124:8080/healthcheck
```

The expected key line is an `HTTP/1.1 200 OK` status, which proves Miniflux is up and serving.
Third, the same reader answers through Caddy over HTTPS at your real hostname, again via the
`/healthcheck` endpoint:

```bash
curl -I https://reader.example.com/healthcheck
```

The expected key line is an `HTTP/2 200` (or `HTTP/1.1 200 OK`) status with no certificate warning,
confirming Caddy obtained a trusted certificate and proxied to Miniflux. From there, log in at
`https://reader.example.com` with the admin user you created.

## Back it up

This container holds your feed subscriptions, read state, and the PostgreSQL database behind them.
Because PostgreSQL stores its data on the container's own disk (under `/var/lib/postgresql`), a
backup of this container captures the database in full; you do not need a separate database dump for
the regular schedule. It is a guest like any other: add VMID 124 to the Proxmox Backup Server backup
job from guide [17 -- Backups with Proxmox Backup Server](../17-backups-with-pbs.md) so it is
captured on the regular schedule. From there it rides along into the off-box copy described in guide
[18 -- The independent copy and restore](../18-the-independent-copy-and-restore.md). Treat finishing
this recipe and adding the guest to the backup job as one task.

## Sources

- `research/round2-pve9/20-pve9-ecosystem-and-service-patterns.md` -- the Miniflux per-service
  pattern (unprivileged LXC via the `miniflux` Helper-Script, single Go binary backed by PostgreSQL,
  sized 1 vCPU / 512 MB / 4-8 GB, first-class CLI and clean REST API so it is very shell-operable,
  front with a reverse-proxy LXC for TLS) and the Helper-Scripts `ct/<name>.sh` curl and wget
  one-liner forms.
- Guide [16 -- Automation and the ecosystem](../16-automation-and-the-ecosystem.md) -- the
  Helper-Scripts curl-pipe-to-root caution (read first, snapshot, pin a commit) that
  `ct/miniflux.sh` inherits.
- Recipe [00 -- The shared reverse proxy](00-reverse-proxy.md) -- the shared Caddy container this
  recipe fronts Miniflux with, and the per-site-block, `tee -a` then reload pattern.
- Miniflux official docs (Context7 `/miniflux/website`): the
  [Debian apt repository install](https://miniflux.app/docs/debian.html) (the
  `repo.miniflux.app/apt/` source list and the `miniflux` package), the
  [database setup](https://miniflux.app/docs/database.html) (`createuser -P miniflux`,
  `createdb -O miniflux miniflux`, and that the `hstore` extension is no longer required since
  2.0.27 and is removed by a 2.2.14 migration), the
  [configuration file](https://miniflux.app/docs/configuration.html) (`DATABASE_URL`,
  `RUN_MIGRATIONS`, `LISTEN_ADDR`, `BASE_URL`, and the
  `CREATE_ADMIN`/`ADMIN_USERNAME`/`ADMIN_PASSWORD` form), and the
  [command line](https://miniflux.app/docs/cli.html) (`miniflux -version`, `-migrate`,
  `-create-admin`, `-reset-password`, `-reset-feed-errors`, `-run-cleanup-tasks`, `-refresh-feeds`,
  `-config-file`) the install, management, and verify commands are grounded in.

---

Previous: [02 -- Vaultwarden](02-vaultwarden.md) | Next: [04 -- Paperless-ngx](04-paperless-ngx.md)
