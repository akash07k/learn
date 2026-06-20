# Recipe: Nextcloud (files, calendar, contacts)

## What you'll be able to do

You will run Nextcloud, a self-hosted files, calendar, and contacts platform, in one
[unprivileged container](../GLOSSARY.md), installed and managed entirely from its `occ` command-line
tool rather than the browser setup wizard. You front it with the shared [Caddy](../GLOSSARY.md) box
from recipe 00 for automatic TLS, and you keep its data on a large separate volume so the files
store grows and is backed up as a unit. Because `occ` exposes essentially everything the web admin
does, this is a strong screen-reader fit: the whole admin surface is on the command line.

## Before you start

This recipe reuses foundations rather than re-teaching them. You need:

- An [unprivileged container](../GLOSSARY.md) to run Nextcloud in. Creating one is taught in guide
  [05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md); this recipe shows only
  the one `pct create` line and points you there for the rest.
- A large separate data volume for Nextcloud's data directory, so your files store does not live on
  the container's small root disk and is backed up deliberately. Adding a dedicated disk is taught
  in guide [09 -- Storage](../09-storage.md), and a [bind mount](../GLOSSARY.md) into the container
  in guide [05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md).
- The shared Caddy container from recipe [00 -- The shared reverse proxy](00-reverse-proxy.md),
  which terminates TLS for every web service. You do not give Nextcloud its own certificate
  handling; you add one site block to the Caddyfile there. Do recipe 00 first.
- A static IP for the Nextcloud container, so Caddy always finds it at the same upstream address.
  Giving a guest a static address is taught in guide [10 -- Networking](../10-networking.md).
  Throughout this recipe, substitute the container's own static address wherever you see `<nc-ip>`.

## Pick the pattern and size it

Nextcloud is a PHP application, not a single binary, so it needs a small stack around it: PHP-FPM, a
web server (nginx or Apache), a database (PostgreSQL or MariaDB), and Redis for caching and file
locking. Both patterns below produce the same thing: one [unprivileged container](../GLOSSARY.md)
running that native stack, no Docker.

- Pattern A, hand-built: you run `pct create` yourself and install the PHP-FPM plus web-server plus
  database plus Redis stack and Nextcloud by hand. You see every moving part, which is the right
  instinct for a service that holds your files, calendar, and contacts.
- Pattern B, Helper-Scripts: the community `ct/nextcloud.sh` one-liner builds the unprivileged
  container and installs the whole stack for you in a few minutes. It is untrusted root code that
  you read, snapshot, and pin first; see the cross-reference under Path 1 below.

The research recommends pattern B for speed (and notes the Nextcloud-on-Alpine variant is the
lightest). Both are fully supported here; pick the one you are comfortable owning. Avoid the
Nextcloud all-in-one Docker image on this node: it runs Docker-in-Docker to manage its own
containers, which is exactly the nested-Docker complication the corpus steers you away from (guide
16). A dedicated [KVM/QEMU VM](../GLOSSARY.md) is worth it only if you want hard isolation because
you are exposing Nextcloud directly to the internet; for a home node behind the Caddy container, the
LXC is the right home.

Size it the same either way: about 2 vCPU, 2 to 4 GB of RAM, and a 10 GB system disk for the guest
itself, plus the large separate data volume from guide 09 for the files store. The system disk holds
only the application and database; your actual files live on the separate volume, which is what lets
it grow without resizing the root disk. Keeping the data directory on its own volume at
`/srv/nextcloud-data`, outside `/var/www`, is also a security requirement: the data directory must
sit outside the web root so the web server never serves your files directly.

Accessibility note: once the container exists you manage it with `pct enter <vmid>`, which drops you
straight into a root shell inside it with no console or networking setup. Every command below runs
either on the Proxmox host (the `pct` lines) or inside the container after `pct enter` (the install,
install-finalize, and `occ` lines). The load-bearing accessibility point of this recipe is that you
never touch the web setup wizard: `occ maintenance:install` does the install from the command line,
and `occ` then does essentially everything the web admin page does.

### Path 1 -- Helper-Scripts

On the Proxmox host root shell, the community `ct/nextcloud.sh` script builds an unprivileged
container and installs the full Nextcloud stack (PHP-FPM, a web server, a database, and Redis)
natively:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/nextcloud.sh)"
```

The `wget` form is equivalent:

```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/nextcloud.sh)"
```

That one-liner pipes code fetched from the internet straight into a root shell on the host. Treat it
as untrusted root code: read it first, snapshot the host, and pin a reviewed commit instead of
`main`, exactly as guide [16 -- Automation and the ecosystem](../16-automation-and-the-ecosystem.md)
teaches. The pinned-commit form substitutes a specific commit hash for `main` in the URL so the code
cannot change between your audit and your run:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/<COMMIT_SHA>/ct/nextcloud.sh)"
```

The script also publishes a Nextcloud-on-Alpine variant, which is the lightest build if you want a
smaller footprint. When it finishes, give the new container a static IP (guide 10) if you did not in
the script's Advanced mode, and point Nextcloud's data directory at the large separate volume from
guide [09 -- Storage](../09-storage.md). Then continue at "Manage it from the shell" and "Put it
behind TLS" below; the reverse-proxy `occ config:system:set` settings in Path 2 apply to the
Helper-Script build too.

### Path 2 -- hand-built

On the Proxmox host, create the unprivileged container with a static address. The line below is the
shape of it; guide [05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md)
explains every option, the OS template, and confirming the template name with `pveam`. Substitute
your own VMID, bridge, address, gateway, and key path:

```bash
pct create 125 local-btrfs:vztmpl/debian-13-standard_13.x-1_amd64.tar.zst \
  --hostname nextcloud \
  --unprivileged 1 \
  --cores 2 --memory 4096 --swap 512 \
  --rootfs local-btrfs:10 \
  --net0 name=eth0,bridge=vmbr0,ip=192.168.1.125/24,gw=192.168.1.1 \
  --onboot 1 \
  --ssh-public-keys /root/nextcloud.pub
```

Attach the large separate data volume before you start the container, so Nextcloud's data directory
lands on it from the first install. A dedicated virtual disk is covered in guide
[09 -- Storage](../09-storage.md), and a bind mount of a host dataset in guide
[05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md); this recipe assumes it is
mounted inside the container at `/srv/nextcloud-data`. Start the container and enter it:

```bash
pct start 125
pct enter 125
```

You are now in a root shell inside the container.

#### Install the stack: PHP-FPM, a web server, a database, and Redis

Nextcloud needs PHP-FPM, a web server (nginx is used below; Apache with `libapache2-mod-php` is the
documented alternative), a database (PostgreSQL is used below; MariaDB is the documented
alternative), and Redis. Install them from Debian's own repository, which enables and starts the
services for you. The PHP module list is the set Nextcloud's documentation requires for a working
install:

```bash
apt update
apt install -y nginx postgresql redis-server \
  php-fpm php-gd php-mbstring php-intl php-bcmath php-gmp \
  php-curl php-xml php-zip php-pgsql php-redis php-imagick \
  unzip bzip2 wget gnupg
```

Create the database role and the database it owns. The role password becomes part of how Nextcloud
connects, so it is a secret: do not type it on a command line where it lands in shell history or is
visible to `ps`. The `createuser -P` form prompts for the password instead of taking it as an
argument, which is exactly what you want. Run both as the `postgres` system user:

```bash
su - postgres -c "createuser -P nextcloud"
su - postgres -c "createdb -O nextcloud nextcloud"
```

The first command prompts for the new role's password twice and echoes nothing; remember it, because
the install step below needs it. The second creates a database named `nextcloud` owned by that role.

#### Obtain and verify the Nextcloud release

Download the official release tarball, its PGP signature, and the Nextcloud signing key, then verify
the signature before you unpack anything. This proves the archive is the unmodified release and not
a tampered download. Substitute the current version for `x.y.z` (the latest release is published at
`download.nextcloud.com/server/releases/`):

```bash
cd /tmp
wget https://download.nextcloud.com/server/releases/nextcloud-x.y.z.tar.bz2
wget https://download.nextcloud.com/server/releases/nextcloud-x.y.z.tar.bz2.asc
wget https://nextcloud.com/nextcloud.asc
gpg --import nextcloud.asc
gpg --verify nextcloud-x.y.z.tar.bz2.asc nextcloud-x.y.z.tar.bz2
```

The verify step must report a good signature from the Nextcloud signing key before you proceed. You
can also confirm the SHA-256 by downloading the matching `.sha256` file and running
`sha256sum -c nextcloud-x.y.z.tar.bz2.sha256` (run from the directory holding both files). Once
verified, unpack it into the web root and hand ownership to the web-server user (`www-data` on
Debian):

```bash
tar -xjf nextcloud-x.y.z.tar.bz2 -C /var/www/
chown -R www-data:www-data /var/www/nextcloud
install -d -o www-data -g www-data /srv/nextcloud-data
```

The `install -d` line makes sure the data directory on the separate volume is owned by `www-data`,
so Nextcloud can write your files there.

#### Run the command-line installer (not the web wizard)

This is the load-bearing accessibility step. Nextcloud's browser setup wizard is the path you do not
use; instead, `occ maintenance:install` finalizes the install from the command line, creating the
database schema, the config, and the first admin account in one pass. You run `occ` as the
`www-data` user from the Nextcloud directory.

Secret hygiene matters here. The documented `occ maintenance:install` form takes `--database-pass`
and `--admin-pass` as arguments, and any argument is visible in `ps` for the moment the command runs
and is recorded in shell history. To keep both secrets out of history, read them into shell
variables with a no-echo prompt and pass the variables, then unset them; this keeps the literals out
of your typed history (the values are still briefly visible to a `ps` run during the few seconds the
installer executes, which is the unavoidable residue of these flags). Treat this as a one-off: run
it once, then never re-type those passwords on a command line again.

```bash
cd /var/www/nextcloud
read -rs -p 'database password: ' NC_DBPASS; echo
read -rs -p 'admin password: ' NC_ADMINPASS; echo
sudo -E -u www-data php occ maintenance:install \
  --database pgsql --database-name nextcloud \
  --database-user nextcloud --database-pass "$NC_DBPASS" \
  --admin-user admin --admin-pass "$NC_ADMINPASS" \
  --data-dir /srv/nextcloud-data
unset NC_DBPASS NC_ADMINPASS
```

The `read -rs` prompts echo nothing, so the passwords never appear on your screen or in history;
`unset` clears them from the shell afterwards. The `--data-dir /srv/nextcloud-data` puts the files
store on the large separate volume from guide 09, not on the container's root disk. When it
finishes, `occ` reports the install succeeded and the admin account exists.

#### Set the reverse-proxy configuration with occ

Because Caddy terminates TLS and forwards to Nextcloud over plain HTTP, Nextcloud must be told its
public hostname, the original HTTPS scheme, and which proxy to trust, or it builds links against the
wrong address and rejects requests as an untrusted domain. Set these with `occ config:system:set`
rather than hand-editing `config.php`. Substitute your real hostname and the Caddy container's
address for `<caddy-ip>`:

```bash
cd /var/www/nextcloud
sudo -E -u www-data php occ config:system:set trusted_domains 1 --value=cloud.example.com
sudo -E -u www-data php occ config:system:set overwrite.cli.url --value=https://cloud.example.com
sudo -E -u www-data php occ config:system:set overwritehost --value=cloud.example.com
sudo -E -u www-data php occ config:system:set overwriteprotocol --value=https
sudo -E -u www-data php occ config:system:set trusted_proxies 0 --value=<caddy-ip>
```

The `trusted_domains 1` and `trusted_proxies 0` arguments are array indices: index 0 of
`trusted_domains` is set to the container's own address by the installer, so your public hostname
goes in index 1; `trusted_proxies` index 0 is the Caddy container, the only host allowed to set
forwarded headers. These settings are what make Nextcloud generate correct
`https://cloud.example.com` URLs while sitting behind the proxy.

You still need the web server itself. Point nginx (or Apache) at `/var/www/nextcloud` following
Nextcloud's documented server example (cited in Sources); write the site config with a here-doc or
`tee`, never a terminal editor, using the accessible methods in guide
[02 -- The shell and the API](../02-the-shell-and-the-api.md). Then enable and start the stack so it
survives a reboot:

```bash
systemctl enable --now php8.4-fpm nginx postgresql redis-server
systemctl status nginx
```

On Debian 13 the PHP-FPM systemd unit is versioned (`php8.4-fpm`); there is no unversioned
`php-fpm.service`. If you installed a different PHP minor version, substitute it -- run
`systemctl list-units 'php*-fpm'` to see the exact unit name.

## Manage it from the shell

Nextcloud's `occ` tool does essentially everything the web admin page does, so you do not need the
dashboard for administration. Run every `occ` command as the `www-data` user from
`/var/www/nextcloud`, because that user owns the install and the data:

- Check status and version (proves the install is live):

```bash
sudo -E -u www-data php occ status
```

- Put the instance into and out of maintenance mode (use this before risky changes and backups):

```bash
sudo -E -u www-data php occ maintenance:mode --on
sudo -E -u www-data php occ maintenance:mode --off
```

- Add a user, enable an app, and add the database indices Nextcloud recommends for performance:

```bash
sudo -E -u www-data php occ user:add jane
sudo -E -u www-data php occ app:enable calendar
sudo -E -u www-data php occ db:add-missing-indices
```

`occ user:add` prompts for the new user's password at the terminal (no echo), so it stays out of
shell history. On a fresh server install the calendar and contacts apps may not be present yet, and
`occ app:enable` only enables an app that is already installed; if it reports the app is not
installed, run `occ app:install calendar contacts` first to fetch them, then enable.

- Upgrade to a newer release. After replacing the code (download and verify the new tarball as
  above, then unpack over the install), run the upgrade from the command line rather than the
  browser:

```bash
sudo -E -u www-data php occ upgrade
```

Take a [snapshot](../GLOSSARY.md) of the container before any upgrade (guide 05) so a bad release
rolls back in seconds.

- Read the logs. By default Nextcloud logs to `nextcloud.log` in the data directory
  (`/srv/nextcloud-data/nextcloud.log`); PHP-FPM, nginx, PostgreSQL, and Redis log to the journal
  (`journalctl -u php8.4-fpm`, `journalctl -u nginx`, and so on).

Change configuration the shell-only way: prefer `occ config:system:set` (as in the reverse-proxy
step above) over editing files. When you do need to read or hand-edit `config/config.php`, note it
is owned by the `www-data` web user, so edit it as that user with the accessible methods in guide
[02 -- The shell and the API](../02-the-shell-and-the-api.md); never use a terminal editor. The web
dashboard remains available for end users, but nothing in this section requires it.

## Put it behind TLS

Nextcloud is served by its own web server on plain HTTP inside the container; TLS is the shared
Caddy container's job. Do not give Nextcloud its own certificate. Add one site block to the
Caddyfile on the Caddy container from recipe [00 -- The shared reverse proxy](00-reverse-proxy.md),
pointing at this container's address and the web server's port (port 80, the nginx default, below).
Nextcloud also needs two `.well-known` redirects so that calendar (CalDAV) and contacts (CardDAV)
clients discover the right endpoint; Caddy can do those redirects in the same block.

On the Caddy container (after `pct enter` into it), append the Nextcloud block to the shared
Caddyfile, then reload, using the `tee -a` then reload pattern recipe 00 established. Substitute
your hostname and this container's `<nc-ip>`. File `/etc/caddy/Caddyfile`:

```bash
tee -a /etc/caddy/Caddyfile >/dev/null <<'EOF'

cloud.example.com {
	redir /.well-known/carddav /remote.php/dav/ 301
	redir /.well-known/caldav /remote.php/dav/ 301
	reverse_proxy <nc-ip>:80
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
}
EOF
caddy reload --config /etc/caddy/Caddyfile
```

The `tls { dns cloudflare ... }` block is the DNS-01 form recipe 00 and guide 12 cover; omit it only
if your Caddy container is not using DNS-01. The two `redir` lines send CalDAV/CardDAV discovery
requests to Nextcloud's `/remote.php/dav/` endpoint, which is what lets calendar and contacts apps
auto-configure. For Nextcloud to generate correct URLs behind this proxy, the `overwrite.cli.url`,
`overwritehost`, `overwriteprotocol=https`, and `trusted_proxies` settings from the install section
must be in place; if links come out as `http://` or point at the container IP, re-check those four
`occ config:system:set` values.

## Verify it worked

Three checks confirm Nextcloud is serving. First, inside the container (`pct enter 125`), `occ`
reports the install is live:

```bash
cd /var/www/nextcloud
sudo -E -u www-data php occ status
```

The expected key line is `installed: true`, alongside the version string, which proves the
command-line install succeeded. Second, the web server answers over plain HTTP at the container's
address (run from the host or the Caddy container, which can reach `<nc-ip>`):

```bash
curl -I http://<nc-ip>
```

The expected key line is an `HTTP/1.1 200 OK` (or a `302` redirect to `/login`) status, which proves
the web server and PHP-FPM are up. Third, the same instance answers through Caddy over HTTPS at your
real hostname:

```bash
curl -I https://cloud.example.com
```

The expected key line is an `HTTP/2 200` (or `HTTP/1.1 200 OK`) status with no certificate warning,
confirming Caddy obtained a trusted certificate and proxied to Nextcloud. Finally, run the built-in
setup checks, which flag configuration and security issues from the command line (use
`--output=json_pretty` for output that reads cleanly):

```bash
sudo -E -u www-data php occ setupchecks
```

Address anything it reports as a problem (common ones are the missing database indices, fixed with
`occ db:add-missing-indices`, and reverse-proxy header warnings, fixed by the
`trusted_proxies`/`overwrite*` settings above). From there, log in at `https://cloud.example.com`
with the admin user you created.

## Back it up

This container holds your files, calendar, and contacts, so its backup is one you do not want
incomplete. It is a guest like any other: add VMID 125 to the Proxmox Backup Server backup job from
guide [17 -- Backups with Proxmox Backup Server](../17-backups-with-pbs.md) so it is captured on the
regular schedule, and from there it rides along into the off-box copy described in guide
[18 -- The independent copy and restore](../18-the-independent-copy-and-restore.md).

Critical: your files live on the large separate volume from guide [09 -- Storage](../09-storage.md),
and a Proxmox Backup Server guest backup captures only the guest's own disks by default, so that
separate volume must be inside the backup scope. A backup that captures the container but misses the
data volume restores an empty Nextcloud. Make sure the data volume is one of the following, and
confirm it once: a virtual disk attached to the container that the backup job includes (guide 09),
or a bind mount of a host dataset (guide 05) that you back up as part of the host. Back up the
database too: it lives on the container's own root disk under `/var/lib/postgresql`, so a backup of
the container captures it, but the database and the files must be captured consistent with each
other. For a consistent backup, put Nextcloud into maintenance mode first
(`sudo -E -u www-data php occ maintenance:mode --on`) so no writes are in flight, take the backup,
then turn it off again (`--off`). Treat finishing this recipe and confirming the data volume is in
the backup as one task.

## Sources

- `research/round2-pve9/20-pve9-ecosystem-and-service-patterns.md` -- the Nextcloud per-service
  pattern (unprivileged LXC via the `nextcloud` Helper-Script, the Alpine variant lightest; the
  native stack of Nextcloud plus PHP-FPM plus a web server plus PostgreSQL/MariaDB plus Redis; fully
  manageable from the shell via `occ`; avoid the all-in-one Docker image's nested-Docker
  complications; a dedicated VM only for hard isolation when externally exposed; sized 2 vCPU / 2-4
  GB RAM / 10 GB system disk plus a large data volume by bind mount or NFS) and the Helper-Scripts
  `ct/nextcloud.sh` curl and wget one-liner forms.
- Guide [16 -- Automation and the ecosystem](../16-automation-and-the-ecosystem.md) -- the
  Helper-Scripts curl-pipe-to-root caution (read first, snapshot, pin a commit) that
  `ct/nextcloud.sh` inherits, and the corpus's avoid-nested-Docker stance.
- Recipe [00 -- The shared reverse proxy](00-reverse-proxy.md) -- the shared Caddy container this
  recipe fronts Nextcloud with, and the per-site-block, `tee -a` then reload pattern.
- Nextcloud official admin docs (Context7 `/websites/nextcloud_server_admin_manual`): the
  [command-line installation](https://docs.nextcloud.com/server/latest/admin_manual/installation/command_line_installation.html)
  (`occ maintenance:install` with `--database`, `--database-name`, `--database-user`,
  `--database-pass`, `--admin-user`, `--admin-pass`, `--data-dir`), the
  [release verification](https://docs.nextcloud.com/server/latest/admin_manual/installation/example_ubuntu.html)
  (the `nextcloud.asc` key, the `.asc` PGP signature, and the `.sha256` checksum), the
  [reverse-proxy configuration](https://docs.nextcloud.com/server/latest/admin_manual/configuration_server/reverse_proxy_configuration.html)
  (`trusted_proxies`, `overwrite.cli.url`, `overwritehost`, `overwriteprotocol`, and the
  `/.well-known/carddav` and `/.well-known/caldav` to `/remote.php/dav/` redirects), and the
  [occ command reference](https://docs.nextcloud.com/server/latest/admin_manual/occ_apps.html)
  (`occ status`, `occ maintenance:mode`, `occ user:add`, `occ app:enable`,
  `occ db:add-missing-indices`, `occ upgrade`, `occ setupchecks`, and `occ config:system:set` with
  array-index and `--type` forms).

---

Previous: [04 -- Paperless-ngx](04-paperless-ngx.md) | Next: [06 -- Drupal](06-drupal.md)
