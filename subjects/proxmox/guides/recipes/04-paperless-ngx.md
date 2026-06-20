# Recipe: Paperless-ngx (document management)

## What you'll be able to do

You will run Paperless-ngx, a self-hosted document archive that OCRs every scan and PDF you feed it
and turns the lot into a full-text-searchable library. This recipe gives you two co-equal
first-class paths: Path 1 runs the official Docker Compose stack inside one Debian
[KVM/QEMU VM](../GLOSSARY.md) (the path the Paperless-ngx developers ship and support), and Path 2
runs the community Helper-Scripts native [LXC container](../GLOSSARY.md) (lighter, no Docker).
Either way the document store lives on a separate data volume so the archive is large, durable, and
backed up as a unit.

## Before you start

This recipe reuses foundations rather than re-teaching them. You need:

- For Path 1: a Debian [KVM/QEMU VM](../GLOSSARY.md) with Docker installed. Creating a VM is taught
  in guide [06 -- Virtual machines with qm](../06-virtual-machines-with-qm.md), and cloning one from
  a cloud-init template (the fast, repeatable way) in guide
  [07 -- Cloud-init templates](../07-cloud-init-templates.md). This recipe shows only the one
  `qm clone` (or `qm create`) line and points you there for the rest. You reach the VM with
  `qm terminal <vmid>` (the serial console set up in guide 07) or by SSH.
- For Path 2: the Helper-Scripts `paperless-ngx` LXC, which builds the unprivileged container and
  installs Paperless-ngx natively for you. You reach it with `pct enter <vmid>`; the LXC background
  is guide [05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md).
- A separate data volume for the documents, the consume directory, and the media/data store, so the
  archive does not live on the guest's small root disk and is backed up deliberately. Adding a
  dedicated disk is taught in guide [09 -- Storage](../09-storage.md), and a bind mount into a
  container in guide [05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md).
  Throughout, substitute the guest's own static address wherever you see `<pl-ip>`.
- A static IP for the guest, so a reverse proxy (and you) always find Paperless at the same address.
  Giving a guest a static address is taught in guide [10 -- Networking](../10-networking.md).
- Optionally, the shared [Caddy](../GLOSSARY.md) box from recipe
  [00 -- The shared reverse proxy](00-reverse-proxy.md) if you want TLS in front of it. Do recipe 00
  first if so.

## Pick the pattern and size it

Paperless-ngx is the one mission service that is genuinely Docker-first upstream, so this recipe
splits honestly into two first-class paths. Neither is "the alternative"; pick by how you want to
track upstream.

- Path 1, Docker Compose in a Debian VM, is the upstream-supported path. The Paperless-ngx
  developers ship and support a multi-service `docker compose` stack: a web server, a task worker, a
  PostgreSQL database, a Redis broker, Gotenberg (Office-to-PDF), and Tika (text extraction). If you
  want to follow the project's own install and upgrade instructions exactly, this is the path. It
  runs in a VM, not an LXC, because the corpus follows Proxmox's official line that Docker belongs
  in a VM, not an LXC (guide
  [16 -- Automation and the ecosystem](../16-automation-and-the-ecosystem.md)). You SSH into the VM
  (or use `qm terminal`) and drive `docker compose`.
- Path 2, the Helper-Scripts native LXC, is lighter. The community `ct/paperless-ngx.sh` script does
  a bare-metal native install (Debian 13 plus PostgreSQL plus Redis, no Docker) inside an
  unprivileged container. It is excellent on resources and reachable with `pct enter`, but you
  accept that it diverges from the upstream-blessed docker path for upgrades: you follow the
  community script's update flow, not the project's `docker compose pull`.

Size it the same either way: about 2 vCPU, 2 to 4 GB of RAM, and 16 GB or more of disk for the guest
itself, plus the separate document/consume volume from guide 09 for the archive. OCR is CPU- and
RAM-hungry on big batches, so the 2 vCPU / 2-4 GB floor matters; a single-core guest will crawl
through a large import.

Accessibility note: a VM is reached with `qm terminal <vmid>` (the serial console from guide 07) or
by SSH; an LXC is reached with `pct enter <vmid>`, which drops you straight into a root shell with
no console setup. Every command below runs either on the Proxmox host (the `qm`/`pct` lines), inside
the VM over SSH (Path 1's `docker compose` lines), or inside the LXC after `pct enter` (Path 2's
lines).

### Path 1 -- Docker Compose in a Debian VM (the upstream-supported path)

#### Create the Debian VM

On the Proxmox host, the fast, repeatable way is to clone the Debian cloud-init template you built
in guide [07 -- Cloud-init templates](../07-cloud-init-templates.md). The line below is the shape of
it; guide 07 explains the template, the `--serial0 socket --vga serial0` pair that makes
`qm terminal` work, and setting the static IP through cloud-init. Substitute your own template VMID,
new VMID, and name:

```bash
qm clone 9000 130 --name paperless --full
qm set 130 --cores 2 --memory 4096
qm start 130
```

If you do not yet have a template, guide
[06 -- Virtual machines with qm](../06-virtual-machines-with-qm.md) shows the `qm create` plus
`qm importdisk` path from a Debian cloud image instead. Either way, reach the VM with
`qm terminal 130` (the serial console) or SSH to its static address. Everything from here runs
inside the VM.

#### Install Docker and the Compose plugin in the VM

Inside the VM, install Docker Engine and the Compose plugin from Docker's official apt repository.
State the path, then write the repo source with `tee`. File `/etc/apt/sources.list.d/docker.list`:

```bash
apt update
apt install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list >/dev/null
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
```

Confirm Docker and the Compose plugin answer:

```bash
docker --version
docker compose version
```

#### Mount the separate data volume for the archive

Before you bring the stack up, mount the separate document volume from guide
[09 -- Storage](../09-storage.md) inside the VM (an added virtual disk formatted and mounted). Mount
it at a fixed path, for example `/srv/paperless`, with subdirectories the compose stack will bind
to:

```bash
mkdir -p /srv/paperless/consume /srv/paperless/media /srv/paperless/data /srv/paperless/export
```

Putting the consume, media, data, and export directories on this separate volume (rather than the
named Docker volumes the stock compose file uses) is what keeps your whole archive on one
deliberately backed-up disk. Guide 09 covers the disk add, the filesystem, and the `/etc/fstab`
entry so the mount survives a reboot.

#### Fetch the official Compose files

Paperless-ngx publishes per-database `docker-compose.*.yml` files plus a `docker-compose.env`. The
supported, easiest install is the project's interactive bootstrap script, which downloads the right
compose file for PostgreSQL, writes `docker-compose.env`, pulls the images, runs the migrations, and
prompts you to create the superuser, all in one pass. Run it inside the VM in an empty directory
such as `/opt/paperless`:

```bash
mkdir -p /opt/paperless
cd /opt/paperless
bash -c "$(curl --location --silent --show-error https://raw.githubusercontent.com/paperless-ngx/paperless-ngx/main/install-paperless-ngx.sh)"
```

The script is interactive: it asks for the URL, the OCR language, the time zone, and the directories
for consume/media/data, and it offers the Tika/Gotenberg (Office documents) variant. Point its
consume/media/data answers at the `/srv/paperless/...` directories you created above so the archive
lands on the separate volume. The bootstrap script prompts only for consume/media/data and not for
an export directory, so if you used it you must also add an export bind mount (for example
`/srv/paperless/export:/usr/src/paperless/export`) to the webserver service in the generated
`docker-compose.yml`, so `document_exporter` writes onto the backed-up volume rather than the
container's ephemeral layer. If you prefer to do it by hand instead of the bootstrap, download one
`docker-compose.postgres.yml` (rename it to `docker-compose.yml`), the matching
`docker-compose.env`, and `.env` into `/opt/paperless`, then edit the consume/media/data bind mounts
to your `/srv/paperless/...` paths (the stock line is `./consume:/usr/src/paperless/consume`; change
the left side to `/srv/paperless/consume`, and likewise for media, data, and export).

#### Set docker-compose.env (keep the admin password out of the shell)

Paperless reads its configuration from `docker-compose.env`. Set the public URL and the OCR
language. The export path is not an env variable: it comes from the export bind mount you added to
the webserver service plus the `../export` argument you pass to `document_exporter` later. The
load-bearing secret-hygiene point: an initial superuser can be created from `PAPERLESS_ADMIN_USER`
plus `PAPERLESS_ADMIN_PASSWORD`, but that puts a plaintext password at rest in the env file, so keep
that file chmod 600 and remove the password line after the first successful start. State the path,
then write it. File `/opt/paperless/docker-compose.env`:

```bash
umask 077
tee -a /opt/paperless/docker-compose.env >/dev/null <<'EOF'
# The public base URL Paperless is served at. Set to the reverse-proxy hostname
# if you front it with Caddy, otherwise to http://<pl-ip>:8000.
PAPERLESS_URL=https://paperless.example.com
# Default OCR language (a tesseract code, e.g. eng, deu, fra). Match your documents.
PAPERLESS_OCR_LANGUAGE=eng
EOF
chmod 600 /opt/paperless/docker-compose.env
```

If you ran the bootstrap script it already wrote `PAPERLESS_URL` and `PAPERLESS_OCR_LANGUAGE` from
your interactive answers. The `tee -a` above appends, so running it on a bootstrapped file creates a
second `PAPERLESS_URL` and `PAPERLESS_OCR_LANGUAGE` line, and the appended values silently override
the answers you gave. In that case do not append: edit the existing keys in place instead, or trim
the block above to only keys the bootstrap did not write.

If you want the superuser created automatically on first boot instead of interactively (next step),
add `PAPERLESS_ADMIN_USER` and `PAPERLESS_ADMIN_PASSWORD` to this same chmod-600 file, never on a
command line, and delete both lines once the account exists so the plaintext password is not left at
rest. The interactive form below is preferred because no password is written to disk at all. Edit
this file with the accessible methods in guide
[02 -- The shell and the API](../02-the-shell-and-the-api.md); do not echo a password on a command
line.

If you used the env-file superuser form, confirm that you removed the plaintext admin credentials
after the first successful start:

```bash
if [ ! -f /opt/paperless/docker-compose.env ]; then
  echo 'DANGER: /opt/paperless/docker-compose.env is missing; confirm the stack path before checking credentials'
elif grep -q '^PAPERLESS_ADMIN_' /opt/paperless/docker-compose.env; then
  echo 'DANGER: remove PAPERLESS_ADMIN_USER and PAPERLESS_ADMIN_PASSWORD now'
else
  echo 'OK: no plaintext admin password remains in the env file'
fi
```

#### Bring the stack up, migrate, and create the superuser

Start the stack. Compose pulls the six service images and starts them; database migrations run
automatically as the web server comes up:

```bash
cd /opt/paperless
docker compose up -d
docker compose logs -f webserver
```

Wait for the web server log to report it is ready (the migrations finish first), then stop following
with Ctrl-C. Now create the first administrator interactively, so the password is typed at a prompt
and never lands in shell history or the env file:

```bash
docker compose run --rm webserver createsuperuser
```

It prompts for a username, an email, and a password (entered without echo) and creates the admin
account. This interactive prompt is the preferred path over the `PAPERLESS_ADMIN_PASSWORD` env form.

### Path 2 -- the Helper-Scripts native LXC (lighter)

On the Proxmox host root shell, the community `ct/paperless-ngx.sh` script builds an unprivileged
container and installs Paperless-ngx natively (Debian 13 plus PostgreSQL plus Redis, no Docker):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/paperless-ngx.sh)"
```

The `wget` form is equivalent:

```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/paperless-ngx.sh)"
```

That one-liner pipes code fetched from the internet straight into a root shell on the host. Treat it
as untrusted root code: read it first, snapshot the host, and pin a reviewed commit instead of
`main`, exactly as guide [16 -- Automation and the ecosystem](../16-automation-and-the-ecosystem.md)
teaches. The pinned-commit form substitutes a specific commit hash for `main` in the URL so the code
cannot change between your audit and your run:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/<COMMIT_SHA>/ct/paperless-ngx.sh)"
```

This is a native bare-metal install, not Docker. That is what makes it light, but it also means it
diverges from the upstream docker upgrade path: you update Paperless by re-running the community
script's update flow, not by `docker compose pull`. Accept that trade before you choose this path.

When the script finishes it prints the URL and the admin credentials it generated. Change that admin
password as soon as you log in; do not leave the generated default in place. Give the new container
a static IP (guide 10) if you did not in the script's Advanced mode, and point its consume directory
at the separate volume (a bind mount into the container, taught in guide
[05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md)), so the archive lives on
a deliberately backed-up disk rather than the container's root. Then continue at "Manage it from the
shell" and the optional TLS and verify sections below.

## Manage it from the shell

Paperless needs no dashboard for day-to-day operation; the web UI is optional. How you manage it
depends on the path.

On Path 1 (the Docker VM), run these from `/opt/paperless` inside the VM:

- See what is running and read logs:

```bash
docker compose ps
docker compose logs -f webserver
```

- Upgrade to a newer release the upstream way (pull the new images, then recreate):

```bash
docker compose pull
docker compose up -d
```

- Export the whole archive (documents, metadata, and database) to the export directory, and import
  it back, with the management commands the project ships. The `-T` flag suppresses TTY errors when
  run non-interactively:

```bash
docker compose exec -T webserver document_exporter ../export
docker compose exec -T webserver document_importer ../export
```

On Path 2 (the native LXC), enter the container with `pct enter <vmid>` and manage it as native
services:

- Read the logs from the journal (the community install runs Paperless under systemd units):

```bash
journalctl -u paperless-webserver
journalctl -u paperless-task-queue
```

(Add `-f` to follow live, or `-n 50` for the last 50 lines; the exact unit names are whatever the
script registered, which you can list with `systemctl list-units 'paperless*'`.) The same
`document_exporter` and `document_importer` management commands exist in the native install too,
invoked through the Paperless virtualenv the script set up rather than through `docker compose`.

On both paths, change configuration by editing the env file (Path 1:
`/opt/paperless/docker-compose.env`; Path 2: the `paperless.conf` the script wrote) with the
accessible methods in guide [02 -- The shell and the API](../02-the-shell-and-the-api.md), then
restart so the new settings are read (`docker compose up -d` on Path 1, `systemctl restart` the
Paperless units on Path 2). The web dashboard remains available if you want it, but nothing here
requires it.

## Put it behind TLS (optional)

Paperless listens on plain HTTP at port 8000; TLS is the shared Caddy container's job. Do not give
Paperless its own certificate. Add one site block to the Caddyfile on the Caddy container from
recipe [00 -- The shared reverse proxy](00-reverse-proxy.md), pointing at the guest's address and
Paperless's port 8000.

On the Caddy container (after `pct enter` into it), append the Paperless block to the shared
Caddyfile, then reload, using the `tee -a` then reload pattern recipe 00 established. Substitute
your hostname and the guest's `<pl-ip>`. File `/etc/caddy/Caddyfile`:

```bash
tee -a /etc/caddy/Caddyfile >/dev/null <<'EOF'

paperless.example.com {
	reverse_proxy <pl-ip>:8000
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
}
EOF
caddy reload --config /etc/caddy/Caddyfile
```

The `tls { dns cloudflare ... }` block is the DNS-01 form recipe 00 and guide 12 cover; omit it only
if your Caddy container is not using DNS-01.

Two Paperless settings must match this. First, `PAPERLESS_URL` in the env file must be the public
URL (`https://paperless.example.com`), or Paperless rejects the request as a bad host / CSRF
mismatch. Second, Paperless must trust the proxy's forwarded headers: set
`PAPERLESS_USE_X_FORWARD_HOST=true` and `PAPERLESS_USE_X_FORWARD_PORT=true` (and, because Caddy
terminates TLS and forwards over HTTP,
`PAPERLESS_PROXY_SSL_HEADER='["HTTP_X_FORWARDED_PROTO", "https"]'` so Paperless detects the original
HTTPS scheme). Add these to the env file, restart, and re-read the official hosting-and-security
docs cited in Sources before enabling the SSL-header form, which has security implications if the
proxy is not the only thing reaching Paperless.

## Verify it worked

Two checks confirm Paperless is serving and actually ingesting documents.

First, the web UI answers over plain HTTP at the guest's address (run from the host or the Caddy
container, which can reach `<pl-ip>`):

```bash
curl -I http://<pl-ip>:8000
```

The expected key line is an `HTTP/1.1 200 OK` (or a `302` redirect to `/accounts/login/`) status,
which proves the web server is up. If you fronted it with Caddy, the same check over HTTPS at your
real hostname confirms the certificate and proxy:

```bash
curl -I https://paperless.example.com
```

Second, and more important, confirm the consume pipeline actually ingests a document. Copy a PDF
into the consume directory you mounted on the separate volume:

```bash
cp /root/test.pdf /srv/paperless/consume/
```

(On Path 1 the consume directory is the `/srv/paperless/consume` you bound into the compose stack;
on Path 2 it is the consume path the script configured.) Within a few seconds the consumer picks the
file up, OCRs it, files it as a document, and removes it from the consume directory. The expected
behavior is that the file disappears from `/srv/paperless/consume/` and a new document appears in
Paperless (visible in the web UI, or via the REST API). You can watch the ingest happen in the logs:
`docker compose logs -f webserver` on Path 1, or `journalctl -fu paperless-task-queue` on Path 2
(consumption runs inside the task-queue service; use the `systemctl list-units 'paperless*'` hedge
if the script named the units differently). A file that is consumed and removed, with a matching
"added document" log line, proves OCR and indexing work end to end.

## Back it up

This guest holds your entire document archive, so its backup is the one you least want to be
incomplete. It is a guest like any other: add the VM (Path 1) or the LXC (Path 2) by its VMID to the
Proxmox Backup Server backup job from guide
[17 -- Backups with Proxmox Backup Server](../17-backups-with-pbs.md) so it is captured on the
regular schedule, and from there it rides along into the off-box copy described in guide
[18 -- The independent copy and restore](../18-the-independent-copy-and-restore.md).

Critical: the document/media/data store lives on the separate volume from guide
[09 -- Storage](../09-storage.md), and a Proxmox Backup Server guest backup captures only the
guest's own disks by default, so that separate volume must be inside the backup scope. A backup that
captures the VM or LXC but misses the documents volume is worthless: it restores an empty Paperless.
Make sure the separate volume is one of the following, and confirm it once: a virtual disk attached
to the guest that the backup job includes, a bind mount of a host dataset (Path 2's container) that
you back up as part of the host, or covered by a regular `document_exporter` run whose export
directory is itself inside the backup scope. Treat finishing this recipe and confirming the
documents volume is in the backup as one task.

## Sources

- `research/round2-pve9/20-pve9-ecosystem-and-service-patterns.md` -- the Paperless-ngx per-service
  pattern (the pragmatic VM-vs-LXC split: Docker Compose in one Debian VM as the cleanest
  upstream-supported path, the Helper-Scripts `paperless-ngx` LXC as the lighter native install;
  multi-service stack of web/worker/PostgreSQL/Redis/Gotenberg/Tika; sized 2 vCPU / 2-4 GB RAM / 16+
  GB disk plus a bind/NFS mount for the document store and consume directory; OCR is CPU/RAM
  hungry), the Docker-belongs-in-a-VM-not-an-LXC rule, and the Helper-Scripts `ct/<name>.sh` curl
  and wget one-liner forms.
- Guide [16 -- Automation and the ecosystem](../16-automation-and-the-ecosystem.md) -- the
  Helper-Scripts curl-pipe-to-root caution (read first, snapshot, pin a commit) that
  `ct/paperless-ngx.sh` inherits, and the corpus's Docker-in-a-VM stance.
- Paperless-ngx official docs (Context7 `/paperless-ngx/paperless-ngx`): the
  [setup guide](https://docs.paperless-ngx.com/setup/) (the `install-paperless-ngx.sh` bootstrap,
  the per-database `docker-compose.*.yml` plus `docker-compose.env`, the default port 8000, and the
  consume-directory bind mount), the
  [configuration reference](https://docs.paperless-ngx.com/configuration/) (`PAPERLESS_URL`,
  `PAPERLESS_OCR_LANGUAGE`, `PAPERLESS_ADMIN_USER`/`PAPERLESS_ADMIN_PASSWORD`, and the
  `PAPERLESS_USE_X_FORWARD_HOST`/`PAPERLESS_USE_X_FORWARD_PORT`/`PAPERLESS_PROXY_SSL_HEADER`
  reverse-proxy settings), the
  [administration guide](https://docs.paperless-ngx.com/administration/) (`createsuperuser`,
  `document_exporter`, `document_importer`), and the
  [reverse-proxy wiki](https://github.com/paperless-ngx/paperless-ngx/wiki/Using-a-Reverse-Proxy-with-Paperless-ngx)
  (the Caddy and Nginx examples the TLS section is grounded in).

---

Previous: [03 -- Miniflux](03-miniflux.md) | Next: [05 -- Nextcloud](05-nextcloud.md)
