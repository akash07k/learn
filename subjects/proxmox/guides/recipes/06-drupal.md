# Recipe: Drupal (a PHP CMS)

## What you'll be able to do

You will run Drupal, an open-source PHP content-management platform, in one
[unprivileged container](../GLOSSARY.md), installed and managed from the Drush command-line tool
rather than the browser setup wizard. You front it with the shared [Caddy](../GLOSSARY.md) box from
recipe 00 for automatic TLS. Because Drush exposes a complete admin CLI (cache rebuild, database
updates, user and config management), the whole site surface is reachable from the shell, which is a
strong screen-reader fit.

## Before you start

This recipe reuses foundations rather than re-teaching them. You need:

- An [unprivileged container](../GLOSSARY.md) to run Drupal in. Creating one is taught in guide
  [05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md); this recipe shows only
  the one `pct create` line and points you there for the rest. As an alternative origin, you can
  mark a base Debian 13 unprivileged container as a template and `pct clone` it (taught in guide
  [05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md)) instead of building
  from a fresh OS template; either way you end up with one Debian 13 unprivileged container to
  install the stack into. (Guide 07's template is a KVM/QEMU VM cloned with `qm clone`, not a
  container, so it is not the origin here.)
- The shared Caddy container from recipe [00 -- The shared reverse proxy](00-reverse-proxy.md),
  which terminates TLS for every web service. You do not give Drupal its own certificate handling;
  you add one site block to the Caddyfile there. Do recipe 00 first.
- A static IP for the Drupal container, so Caddy always finds it at the same upstream address.
  Giving a guest a static address is taught in guide [10 -- Networking](../10-networking.md).
  Throughout this recipe, substitute the container's own static address wherever you see
  `<drupal-ip>`.

There is no first-party Proxmox Helper-Script for Drupal, so unlike most recipes in this part there
is no community one-liner path to compare against. This recipe is hand-built only: a single path
where you create the container yourself (or clone your cloud-init template) and install the
LAMP/LEMP stack natively. That is the recommended pattern, so you lose nothing by it; you simply own
every step.

## Pick the pattern and size it

This recipe is pattern A: a hand-built [unprivileged container](../GLOSSARY.md) running the
LAMP/LEMP stack natively. Drupal is a standard PHP application, so it needs a small stack around it:
PHP-FPM, a web server (Apache or nginx), a database (MariaDB or PostgreSQL), Composer to install the
code, and Drush as the management CLI. No Docker. A dedicated [KVM/QEMU VM](../GLOSSARY.md) is worth
it only if you must match a Docker-based dev/prod-parity setup you already run elsewhere; for a
self-hosted site on this node behind the Caddy container, the LXC is the right home.

Size it small: about 1 to 2 vCPU, 1 to 2 GB of RAM, and an 8 to 16 GB disk. A single Drupal site
with its database has a modest footprint; lean toward the larger end if you will add many modules or
media.

Accessibility note: once the container exists you manage it with `pct enter <vmid>`, which drops you
straight into a root shell inside it with no console or networking setup. Every command below runs
either on the Proxmox host (the `pct` lines) or inside the container after `pct enter` (the install,
Composer, Drush, and web-server lines). The load-bearing accessibility point of this recipe is that
you never touch the web setup wizard: `drush site:install` does the install from the command line,
and Drush then does essentially everything the web admin pages do.

## Build the LXC and the stack

On the Proxmox host, create the unprivileged container with a static address. The line below is the
shape of it; guide [05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md)
explains every option, the OS template, and confirming the template name with `pveam`. Substitute
your own VMID, bridge, address, gateway, and key path:

```bash
pct create 126 local-btrfs:vztmpl/debian-13-standard_13.x-1_amd64.tar.zst \
  --hostname drupal \
  --unprivileged 1 \
  --cores 2 --memory 2048 --swap 512 \
  --rootfs local-btrfs:16 \
  --net0 name=eth0,bridge=vmbr0,ip=192.168.1.126/24,gw=192.168.1.1 \
  --onboot 1 \
  --ssh-public-keys /root/drupal.pub
```

Start the container and enter it:

```bash
pct start 126
pct enter 126
```

You are now in a root shell inside the container. Install the stack from Debian's own repository,
which enables and starts the services for you. The web server below is Apache with
`libapache2-mod-php`; nginx with PHP-FPM is the documented alternative. The database below is
MariaDB; PostgreSQL is the documented alternative. The PHP extension list is the set Drupal's
install requirements call for:

```bash
apt update
apt install -y apache2 libapache2-mod-php mariadb-server composer \
  php php-cli php-mysql php-gd php-mbstring php-xml \
  php-curl php-zip php-intl php-bcmath php-gmp \
  unzip git
```

`libapache2-mod-php` is what wires PHP into Apache as its handler, which is why it is in the list
for the Apache default. If you take the nginx alternative instead, install `php-fpm` in place of
`libapache2-mod-php`, because nginx has no built-in PHP module and serves PHP through FPM over a
socket.

Drupal 11 requires PHP 8.3 or newer; confirm with `php -v` that Debian 13 gave you a recent enough
PHP before continuing. If you choose PostgreSQL instead of MariaDB, install `postgresql` and
`php-pgsql` in place of `mariadb-server` and `php-mysql`.

Now create the database and a role that owns it. The role password becomes part of how Drupal
connects, so it is a secret: do not type it on a command line where it lands in shell history or is
visible to `ps`. MariaDB's `mariadb-secure-installation` and an interactive `mariadb` session let
you set the password at a prompt rather than as an argument. Run the client as root (MariaDB on
Debian uses socket auth for the root user):

```bash
mariadb
```

At the `MariaDB [(none)]>` prompt, create the database and a role, then set its password
interactively (the client does not echo it into your shell history the way a one-line
`mysql -e "..."` would, but the SQL is still in the client's own history; treat the password as a
one-off you will not retype):

```sql
CREATE DATABASE drupal CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
CREATE USER 'drupal'@'localhost' IDENTIFIED BY 'REPLACE_WITH_DB_PASSWORD';
GRANT ALL PRIVILEGES ON drupal.* TO 'drupal'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

Remember the password you set; the install step below needs it, and after that you keep it only in
the root-owned `settings.php`, never on a command line. (If you chose PostgreSQL, the equivalent is
`su - postgres -c "createuser -P drupal"` then `su - postgres -c "createdb -O drupal drupal"`, where
`createuser -P` prompts for the password rather than taking it as an argument.)

## Install Drupal with Composer and Drush

Drupal is installed with Composer, which downloads Drupal core and its dependencies into a project
directory, then with Drush, which runs the actual site install from the command line. Run Composer
and Drush as the web-server user (`www-data` on Debian), never as root, so every file Drupal owns
and writes is owned by the user the web server runs as. Create the site directory owned by
`www-data` first:

The site lives at `/var/www/drupal`:

```bash
install -d -o www-data -g www-data /var/www/drupal
```

Create the project into that directory as `www-data`, then add Drush as a project dependency (Drush
is installed per-project, not globally, so its version matches the site):

```bash
cd /var/www/drupal
sudo -u www-data composer create-project drupal/recommended-project .
sudo -u www-data composer require drush/drush
```

The `recommended-project` template lays the site out with the docroot at `web/`: the web server
serves `/var/www/drupal/web`, while Composer's `vendor/` and the project's `composer.json` sit one
level up, outside the docroot, where the web cannot reach them. Drush installs to
`/var/www/drupal/vendor/bin/drush`; run it from the project root as `www-data`.

Now run the command-line installer. This is the load-bearing accessibility step: Drupal's browser
setup wizard is the path you do not use; `drush site:install` creates the database schema, writes
`settings.php`, and creates the first admin account in one pass. Run it as `www-data` from the
project root.

Secret hygiene matters here. `drush site:install` takes `--db-url` (which embeds the database
password) and `--account-pass` (the admin password) as options, and any option value is visible in
`ps` for the moment the command runs and is recorded in shell history. To keep both secrets out of
your typed history, read them into shell variables with a no-echo prompt and interpolate the
variables, then unset them; the values are still briefly visible to a `ps` run during the few
seconds the installer executes, which is the unavoidable residue of these flags. Treat this as a
one-off: run it once, then rotate the admin password from Drush afterward (shown below) so even the
brief `ps` exposure no longer matches a live credential.

```bash
cd /var/www/drupal
read -rs -p 'database password: ' DB_PASS; echo
read -rs -p 'admin password: ' ADMIN_PASS; echo
sudo -E -u www-data vendor/bin/drush site:install standard \
  --db-url="mysql://drupal:${DB_PASS}@localhost/drupal" \
  --site-name="My Drupal Site" \
  --account-name=admin --account-pass="${ADMIN_PASS}" \
  --yes
unset DB_PASS ADMIN_PASS
```

The `read -rs` prompts echo nothing, so the passwords never appear on your screen or in history;
`unset` clears them from the shell afterward. If you omit `--db-url` and `--account-pass` entirely,
`drush site:install` prompts for the database connection and generates a random admin password it
prints once, which avoids the `ps` exposure altogether at the cost of a generated password you must
capture; either approach is acceptable, but rotate the admin password after install regardless. When
it finishes, Drush reports the install succeeded and the admin account exists, and it has written
`/var/www/drupal/web/sites/default/settings.php` owned by `www-data`. For PostgreSQL, the `--db-url`
scheme is `pgsql://` instead of `mysql://`.

## Manage it from the shell

Drush is the complete CLI for the site, so you do not need the web dashboard for administration. Run
every Drush command as the `www-data` user from `/var/www/drupal`, because that user owns the
install:

- Check status and version (proves the install is live):

```bash
sudo -E -u www-data vendor/bin/drush status
```

- Rebuild the cache after changing code or config, and apply pending database updates after a core
  or module update:

```bash
sudo -E -u www-data vendor/bin/drush cr
sudo -E -u www-data vendor/bin/drush updatedb
```

- Create a user, or set or reset a password. `drush user:create` takes a `--password` option (which
  is `ps`-visible, as above); prefer creating the account and then setting the password as a
  separate one-off, and rotate it from a trusted session:

```bash
sudo -E -u www-data vendor/bin/drush user:create jane --mail=jane@example.com
sudo -E -u www-data vendor/bin/drush user:password jane
```

`drush user:password` is also how you rotate the admin password after install:
`drush user:password admin`. Like the install flags, the password is passed as an argument and is
briefly `ps`-visible, so do this from a session no one else can observe, and treat each set as a
one-off.

- Install (enable) a module you have added with Composer, and export or import the site's
  configuration:

```bash
sudo -E -u www-data vendor/bin/drush pm:install <module_name>
sudo -E -u www-data vendor/bin/drush cex
sudo -E -u www-data vendor/bin/drush cim
```

`cex` (config export) writes the site's configuration to the sync directory as YAML, and `cim`
(config import) applies it; together they are how you move configuration between a staging copy and
the live site without the web UI.

- Read the logs. On the default Apache path PHP runs inside Apache through `mod_php`, so there is no
  separate PHP-FPM unit: the journal units to watch are `journalctl -u apache2` and
  `journalctl -u mariadb`, and PHP errors surface in Apache's log. If you took the nginx
  alternative, PHP runs under its own unit, so add `journalctl -u php8.4-fpm` (adjusting the version
  to your installed PHP). Drupal's own log is reachable from the shell with `drush watchdog:show`.

Change Drupal's configuration the shell-only way. The site's `web/sites/default/settings.php` is
owned by the `www-data` web user, so when you need to read or edit it (for example to add the
reverse-proxy lines below or set `trusted_host_patterns`), edit it as that user with the accessible
methods in guide [02 -- The shell and the API](../02-the-shell-and-the-api.md) (a here-doc appended
with `tee -a`, a `sed -i`, or VS Code Remote-SSH); never use a terminal editor. Set
`trusted_host_patterns` so Drupal only answers for hostnames you expect, which closes off
host-header attacks. File `/var/www/drupal/web/sites/default/settings.php`:

```php
$settings['trusted_host_patterns'] = [
  '^drupal\.example\.com$',
];
```

The web dashboard remains available for content editors, but nothing in this section requires it.

## Put it behind TLS

Drupal is served by its own web server on plain HTTP inside the container; TLS is the shared Caddy
container's job. Do not give Drupal its own certificate. Add one site block to the Caddyfile on the
Caddy container from recipe [00 -- The shared reverse proxy](00-reverse-proxy.md), pointing at this
container's address and the web server's port (port 80, the Apache default, below).

On the Caddy container (after `pct enter` into it), append the Drupal block to the shared Caddyfile,
then reload, using the `tee -a` then reload pattern recipe 00 established. Substitute your hostname
and this container's `<drupal-ip>`. File `/etc/caddy/Caddyfile`:

```bash
tee -a /etc/caddy/Caddyfile >/dev/null <<'EOF'

drupal.example.com {
	reverse_proxy <drupal-ip>:80
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
}
EOF
caddy reload --config /etc/caddy/Caddyfile
```

The `tls { dns cloudflare ... }` block is the DNS-01 form recipe 00 and guide 12 cover; omit it only
if your Caddy container is not using DNS-01.

Because Caddy terminates TLS and forwards to Drupal over plain HTTP, Drupal must be told to trust
the proxy and treat the forwarded requests as HTTPS, or it builds links against `http://` and the
wrong client address. Add the reverse-proxy settings to `settings.php` as the `www-data` user with
the accessible methods in guide [02 -- The shell and the API](../02-the-shell-and-the-api.md).
Substitute the Caddy container's address for `<caddy-ip>`. File
`/var/www/drupal/web/sites/default/settings.php`:

```php
$settings['reverse_proxy'] = TRUE;
$settings['reverse_proxy_addresses'] = ['<caddy-ip>'];
```

`$settings['reverse_proxy'] = TRUE;` makes Drupal honour the forwarded headers, and
`reverse_proxy_addresses` lists the only host whose forwarded headers it trusts, which is the Caddy
container. With these set (alongside the `trusted_host_patterns` from the previous section), Drupal
generates correct `https://drupal.example.com` URLs while sitting behind the proxy.

You still need the web server itself configured to serve the `web/` docroot; Caddy proxies to it but
does not replace it. Point Apache at `/var/www/drupal/web` following Drupal's documented server
configuration, exactly as the Nextcloud recipe points its web server at the Nextcloud docroot (see
recipe [05 -- Nextcloud](05-nextcloud.md) for the same web-server-vhost discipline). Write the vhost
with a here-doc or `tee`, never a terminal editor (guide 02). The minimal Apache vhost below sets
the docroot to `/var/www/drupal/web` and allows Drupal's `.htaccess` to take effect. File
`/etc/apache2/sites-available/drupal.conf`:

```bash
tee /etc/apache2/sites-available/drupal.conf >/dev/null <<'EOF'
<VirtualHost *:80>
	DocumentRoot /var/www/drupal/web

	<Directory /var/www/drupal/web>
		Options FollowSymLinks
		AllowOverride All
		Require all granted
	</Directory>
</VirtualHost>
EOF
a2dissite 000-default
a2ensite drupal
a2enmod rewrite
systemctl restart apache2
```

Apache is already running from its `apt install`, and enabling a site or module does not reload a
running server, so the `systemctl restart apache2` above is what actually activates the new vhost
and the `rewrite` module.

(For nginx instead, write the equivalent `server` block with `root /var/www/drupal/web;` and a
`fastcgi_pass` to the `php8.4-fpm` socket.) Then enable and start the stack so it survives a reboot:

```bash
systemctl enable --now apache2 mariadb
systemctl status apache2
```

For nginx with PHP-FPM, enable `nginx` and the `php8.4-fpm` unit instead, matching your installed
PHP version.

## Verify it worked

Three checks confirm Drupal is serving. First, inside the container (`pct enter 126`), Drush reports
the install is live:

```bash
cd /var/www/drupal
sudo -E -u www-data vendor/bin/drush status
```

The expected key line is `Drupal bootstrap : Successful`, alongside the `Drupal version` string,
which proves the command-line install succeeded and Drush can reach the database. Second, the web
server answers over plain HTTP at the container's address (run from the host or the Caddy container,
which can reach `<drupal-ip>`):

```bash
curl -I http://<drupal-ip>
```

The expected key line is an `HTTP/1.1 200 OK` (or a `302` redirect) status, which proves the web
server and PHP are up and serving the `web/` docroot. Third, the same site answers through Caddy
over HTTPS at your real hostname:

```bash
curl -I https://drupal.example.com
```

The expected key line is an `HTTP/2 200` (or `HTTP/1.1 200 OK`) status with no certificate warning,
confirming Caddy obtained a trusted certificate and proxied to Drupal. From there, log in at
`https://drupal.example.com` with the admin user you created.

## Back it up

This container holds your whole site: the code, the uploaded files, and the database. Two things
must both be in the backup, or a restore is incomplete.

It is a guest like any other: add VMID 126 to the Proxmox Backup Server backup job from guide
[17 -- Backups with Proxmox Backup Server](../17-backups-with-pbs.md) so it is captured on the
regular schedule, and from there it rides along into the off-box copy described in guide
[18 -- The independent copy and restore](../18-the-independent-copy-and-restore.md). A guest backup
of this container captures both the files and the database, because both live on the container's own
root disk: the whole site directory `/var/www/drupal` (including the uploaded-files store at
`/var/www/drupal/web/sites/default/files`) and MariaDB's data under `/var/lib/mysql`.

For an application-consistent database snapshot you can also take a SQL dump with Drush before the
backup, so you hold a portable, restorable dump independent of the disk image:

```bash
sudo -E -u www-data vendor/bin/drush sql:dump --result-file=/var/www/drupal/drupal-db.sql
```

The critical point is that a files-only backup (the site directory without a consistent database) or
a database-only backup (a SQL dump without the site directory and the uploaded files) each restores
a broken site: the database references files that are not there, or the code and uploads have no
schema behind them. Capture both together. Treat finishing this recipe and confirming both the site
directory and the database are in the backup as one task.

## Sources

- `research/round2-pve9/20-pve9-ecosystem-and-service-patterns.md` -- the Drupal per-service pattern
  (unprivileged LXC running the LAMP/LEMP stack natively, pattern A; no first-party Drupal
  Helper-Script, so build the LXC yourself or clone your cloud-init template; Debian 13 plus PHP-FPM
  plus Apache or nginx plus MariaDB/PostgreSQL plus Composer plus Drush; Drush gives a complete CLI
  such as `drush cr`, `drush updatedb`, `drush user:create`; a dedicated VM only to match a Docker
  dev/prod-parity setup; sized 1-2 vCPU / 1-2 GB RAM / 8-16 GB disk; front with the same Caddy
  reverse-proxy LXC for TLS).
- Recipe [00 -- The shared reverse proxy](00-reverse-proxy.md) -- the shared Caddy container this
  recipe fronts Drupal with, and the per-site-block, `tee -a` then reload pattern.
- Recipe [05 -- Nextcloud](05-nextcloud.md) -- the closest analog (a PHP web app in an LXC behind
  Caddy, with a database, a command-line installer instead of the web wizard, run-as-the-web-user
  discipline, and the web-server-vhost cross-reference) this recipe models its web-server and
  secret-hygiene approach on.
- Drupal official docs (Context7 `/drupal/core`): the
  [INSTALL.txt requirements](https://github.com/drupal/core/blob/11.x/INSTALL.txt) (PHP 8.3+, Apache
  2.4.7+ or nginx 1.1+, MariaDB 10.6+ or PostgreSQL 16+, Composer;
  `composer create-project drupal/recommended-project`; the `web/` docroot and `sites/default/files`
  store; `settings.php` and `trusted_host_patterns`) and the reverse-proxy settings
  (`$settings['reverse_proxy'] = TRUE;`, `$settings['reverse_proxy_addresses']`) documented in
  Drupal's `default.settings.php`.
- Drush official docs (Context7 `/websites/drush_13`): the
  [site:install command](https://www.drush.org/13.x/commands/site_install) (`--db-url`,
  `--account-name`, `--account-pass`, `--site-name`, the `standard` profile, the random-password
  default when `--account-pass` is omitted), and the management commands (`drush status`,
  `drush cr`/`cache:rebuild`, `drush updatedb`, `drush user:create`, `drush user:password`,
  `drush pm:install`, `drush cex`/`config:export`, `drush cim`/`config:import`,
  `drush sql:dump --result-file`) the management, verify, and backup commands are grounded in.

---

Previous: [05 -- Nextcloud](05-nextcloud.md) | Next:
[07 -- Home Assistant (HAOS VM)](07-home-assistant-haos-vm.md)
