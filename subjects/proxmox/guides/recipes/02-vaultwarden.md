# Recipe: Vaultwarden (a password manager)

## What you'll be able to do

You will run Vaultwarden, a self-hosted, Bitwarden-compatible password vault, in one
[unprivileged container](../GLOSSARY.md). It is a single Rust binary backed by a SQLite file, so it
is a near-perfect [LXC container](../GLOSSARY.md) fit. You front it with the shared
[Caddy](../GLOSSARY.md) box from recipe 00, which gives it TLS automatically, so the official
Bitwarden apps and browser extensions talk to your own vault over HTTPS.

## Before you start

This recipe reuses foundations rather than re-teaching them. You need:

- An [unprivileged container](../GLOSSARY.md) to run Vaultwarden in. Creating one is taught in guide
  [05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md); this recipe shows only
  the one `pct create` line and points you there for the rest.
- The shared Caddy container from recipe [00 -- The shared reverse proxy](00-reverse-proxy.md),
  which terminates TLS for every web service. You do not give Vaultwarden its own certificate
  handling; you add one site block to the Caddyfile there. Do recipe 00 first.
- A static IP for the Vaultwarden container, so Caddy always finds it at the same upstream address.
  Giving a guest a static address is taught in guide [10 -- Networking](../10-networking.md).
  Throughout this recipe, substitute the container's own static address wherever you see `<vw-ip>`.

Vaultwarden holds every password you own, so it is the most security-sensitive container in this
corpus. Keep it minimal: install nothing on it beyond Vaultwarden itself, do not expose its port
directly to the internet (Caddy is the only thing that should reach it), and take a
[snapshot](../GLOSSARY.md) before every upgrade so a bad release rolls back in seconds (guide 05).

## Pick the pattern and size it

Both patterns produce the same thing: one lightweight unprivileged container running Vaultwarden
natively (a single binary plus a systemd service, no Docker).

- Pattern A, hand-built: you run `pct create` yourself and install Vaultwarden by hand. You see and
  understand every step, which is the right instinct for the container that holds your passwords.
- Pattern B, Helper-Scripts: the community `ct/vaultwarden.sh` one-liner builds the unprivileged
  container and installs Vaultwarden for you in about a minute. It is untrusted root code that you
  read, snapshot, and pin first; see the cross-reference under Path 1 below.

The research recommends pattern B for speed, but for a secrets vault many operators prefer to build
it by hand so nothing about it is a mystery. Both are fully supported here; pick the one you are
comfortable owning.

Sizing is small either way: about 1 vCPU, 512 MB of RAM, and 4 to 8 GB of disk. A single Rust binary
plus a SQLite database has a tiny footprint.

Accessibility note: once the container exists you manage it with `pct enter <vmid>`, which drops you
straight into a root shell inside it with no console or networking setup. Every command below runs
either on the Proxmox host (the `pct` lines) or inside the container after `pct enter` (the install,
config, and service lines).

### Path 1 -- Helper-Scripts

On the Proxmox host root shell, the community `ct/vaultwarden.sh` script builds an unprivileged
container and installs Vaultwarden natively:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/vaultwarden.sh)"
```

The `wget` form is equivalent:

```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/vaultwarden.sh)"
```

That one-liner pipes code fetched from the internet straight into a root shell on the host. Treat it
as untrusted root code: read it first, snapshot the host, and pin a reviewed commit instead of
`main`, exactly as guide [16 -- Automation and the ecosystem](../16-automation-and-the-ecosystem.md)
teaches. The pinned-commit form substitutes a specific commit hash for `main` in the URL so the code
cannot change between your audit and your run:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/<COMMIT_SHA>/ct/vaultwarden.sh)"
```

When it finishes, give the new container a static IP (guide 10) if you did not in the script's
Advanced mode, then continue at "Manage it from the shell" and "Put it behind TLS" below. The
Helper-Script writes Vaultwarden's environment file for you; the secret-hygiene notes in Path 2
still apply when you later edit it to add an admin token or change `SIGNUPS_ALLOWED`.

### Path 2 -- hand-built

On the Proxmox host, create the unprivileged container with a static address. The line below is the
shape of it; guide [05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md)
explains every option, the OS template, and confirming the template name with `pveam`. Substitute
your own VMID, bridge, address, gateway, and key path:

```bash
pct create 123 local-btrfs:vztmpl/debian-13-standard_13.x-1_amd64.tar.zst \
  --hostname vaultwarden \
  --unprivileged 1 \
  --cores 1 --memory 512 --swap 256 \
  --rootfs local-btrfs:8 \
  --net0 name=eth0,bridge=vmbr0,ip=192.168.1.123/24,gw=192.168.1.1 \
  --onboot 1 \
  --features nesting=1,keyctl=1 \
  --ssh-public-keys /root/vaultwarden.pub
```

Start it and enter it:

```bash
pct start 123
pct enter 123
```

You are now in a root shell inside the container. Vaultwarden ships no official Debian package; the
supported native deployment is the compiled `vaultwarden` binary run as a systemd service under a
dedicated unprivileged user, with its data in a fixed working directory. Vaultwarden also ships no
standalone binary for direct download, so you obtain it one of two supported ways: build both the
binary and the web-vault UI assets from source with Rust and cargo (this is heavy and pulls a full
toolchain), or extract both from the official Alpine Docker image. Vaultwarden needs both parts: the
`vaultwarden` binary and the `web-vault` directory of UI assets, because `WEB_VAULT_ENABLED`
defaults to true and Vaultwarden will not serve the web UI without the web-vault folder. The
Alpine-image extraction is the lighter, more accessible path and is shown here; building from source
is the docker-free alternative.

First create the service user and its data directory:

```bash
useradd --system --home /var/lib/vaultwarden --create-home --shell /usr/sbin/nologin vaultwarden
install -d -o vaultwarden -g vaultwarden /var/lib/vaultwarden
```

Then extract both the binary and the web-vault from the official Alpine image. If docker is not
present in the container, install it first with `apt install -y docker.io` (or build from source
instead). Running Docker inside an unprivileged container needs the `nesting=1,keyctl=1` features
set on the `pct create` above (guide 05); without them the daemon will not start and `docker pull`
fails. Pull the image, create a throwaway container, copy out both `/vaultwarden` and `/web-vault`,
then remove the throwaway container and image:

```bash
docker pull docker.io/vaultwarden/server:latest-alpine
docker create --name vw docker.io/vaultwarden/server:latest-alpine
docker cp vw:/vaultwarden /usr/bin/vaultwarden
docker cp vw:/web-vault /var/lib/vaultwarden/web-vault
docker rm vw
docker rmi docker.io/vaultwarden/server:latest-alpine
chmod 755 /usr/bin/vaultwarden
chown -R vaultwarden:vaultwarden /var/lib/vaultwarden
```

The web-vault now sits at `/var/lib/vaultwarden/web-vault`, which is exactly where Vaultwarden looks
by default: `WEB_VAULT_FOLDER` defaults to `web-vault/` relative to the `WorkingDirectory`, and the
systemd unit below sets `WorkingDirectory=/var/lib/vaultwarden`. Because that matches the default,
you do not need to set `WEB_VAULT_FOLDER` in the env file. The `chown -R` step makes both the data
directory and the web-vault owned by the `vaultwarden` service user.

Vaultwarden's data directory is its `DATA_FOLDER`, which defaults to `./data` relative to the
working directory. Because the systemd unit below sets `WorkingDirectory=/var/lib/vaultwarden`, the
SQLite database, attachments, and keys all live under `/var/lib/vaultwarden` on the container's own
disk. That matters for backups: the data is on the container disk, so a backup of this container
(the "Back it up" section) captures the whole vault.

Now the secret hygiene, which is the load-bearing part of this recipe. Vaultwarden's optional admin
page is protected by an `ADMIN_TOKEN`. A token placed inline on a command line leaks into shell
history and is visible to anyone who runs `ps`, so never type the secret on a command line.
Vaultwarden supports an Argon2 PHC-hashed admin token, and that is the preferred form: the config
stores only a one-way hash, not the secret itself. Generate the hash with the `argon2` CLI (OWASP
minimum settings shown), reading your chosen password from a prompt rather than an argument so it
stays out of history:

```bash
apt install -y argon2
read -rs -p 'admin password: ' VW_ADMIN; echo
printf '%s' "$VW_ADMIN" | argon2 "$(openssl rand -base64 32)" -e -id -k 19456 -t 2 -p 1
unset VW_ADMIN
```

That prints a PHC string beginning `$argon2id$`. Copy it into the environment file below. Write the
env file with a here-doc (guide [02 -- The shell and the API](../02-the-shell-and-the-api.md) lists
the accessible editing methods), set `umask 077` first, and lock it to root-only so the hash and any
future SMTP secret are not world-readable. File `/etc/vaultwarden.env`:

```bash
umask 077
tee /etc/vaultwarden.env >/dev/null <<'EOF'
# Where Vaultwarden stores its SQLite database, attachments, and keys.
DATA_FOLDER=/var/lib/vaultwarden/data
# The public base URL Caddy serves this vault at. Must match the Caddy site block.
DOMAIN=https://vault.example.com
# Bind to all of the container's interfaces (0.0.0.0) so the Caddy container can reach it over the
# LAN. This does NOT restrict access -- any host that can route to this container's IP on
# ROCKET_PORT reaches the plaintext listener directly, bypassing Caddy and TLS. Before you start the
# service, add the per-guest firewall rule below so only Caddy can reach tcp/8080.
ROCKET_ADDRESS=0.0.0.0
ROCKET_PORT=8080
# Leave SIGNUPS_ALLOWED=true only long enough to create your own account, then set false.
SIGNUPS_ALLOWED=true
# Argon2 PHC hash of your admin password (preferred over a plaintext token).
# Paste the $argon2id$... string you generated above, in single quotes.
ADMIN_TOKEN='REPLACE_WITH_ARGON2_PHC_STRING'
EOF
chmod 600 /etc/vaultwarden.env
chown root:root /etc/vaultwarden.env
```

The single quotes around the `ADMIN_TOKEN` value matter: the Argon2 PHC string contains `$`
characters, and single quotes stop the shell and the env-file parser from trying to expand them.
Edit the placeholder line to paste your real hash using the accessible methods in guide 02; do not
echo the hash on a command line.

Because this container holds your passwords, do not start Vaultwarden until the host-side guest
firewall limits the plaintext listener to the Caddy container. File `/etc/pve/firewall/123.fw`:

```ini
[OPTIONS]
enable: 1
policy_in: DROP
policy_out: ACCEPT
ipfilter: 1

[RULES]
IN ACCEPT -p tcp -dport 8080 -source 192.168.1.120
IN SSH(ACCEPT) -source 192.168.1.10
```

Then make sure the container's `net0` line has `firewall=1`, as guide
[11 -- Firewall](../11-firewall.md) explains. Substitute your real Caddy and management addresses if
they differ from the lab plan.

Now register the systemd service. The unit runs the binary as the `vaultwarden` user, reads
`/etc/vaultwarden.env`, and confines writes to the data directory. State the path, then write it
with a here-doc. File `/etc/systemd/system/vaultwarden.service`:

```bash
tee /etc/systemd/system/vaultwarden.service >/dev/null <<'EOF'
[Unit]
Description=Vaultwarden Server (Rust Edition)
Documentation=https://github.com/dani-garcia/vaultwarden
After=network.target

[Service]
User=vaultwarden
Group=vaultwarden
EnvironmentFile=/etc/vaultwarden.env
ExecStart=/usr/bin/vaultwarden
LimitNOFILE=1048576
LimitNPROC=64
PrivateTmp=true
PrivateDevices=true
ProtectHome=true
ProtectSystem=strict
WorkingDirectory=/var/lib/vaultwarden
ReadWritePaths=/var/lib/vaultwarden

[Install]
WantedBy=multi-user.target
EOF
```

Enable and start it so it survives a reboot:

```bash
systemctl daemon-reload
systemctl enable --now vaultwarden
systemctl status vaultwarden
```

## Manage it from the shell

Vaultwarden needs no dashboard for day-to-day work; everything is the env file, the service, and the
journal.

- Read the logs from the journal:

```bash
journalctl -u vaultwarden
```

(Add `-f` to follow it live, or `-n 50` for the last 50 lines.)

- Change configuration by editing `/etc/vaultwarden.env` (with the accessible methods in guide
  [02 -- The shell and the API](../02-the-shell-and-the-api.md)), then restart so the new
  environment is read: `systemctl restart vaultwarden`.
- Close registration after you make your account. Sign-ups are how anyone creates a vault on this
  server, so open registration on an internet-reachable vault is an invitation. Once your own
  account exists, set `SIGNUPS_ALLOWED=false` in `/etc/vaultwarden.env` and restart.
- The admin page is optional. It lets you manage users and settings in a browser, but it is
  browser-only, so it is of limited use here and is one more attack surface on your most sensitive
  container. If you do not want it, leave `ADMIN_TOKEN` unset (delete or comment the line): with no
  token set, Vaultwarden disables the admin page entirely. Set the Argon2 hash only if you actually
  need that page.

## Put it behind TLS

Vaultwarden listens on plain HTTP inside the container; TLS is the shared Caddy container's job. Do
not give Vaultwarden its own certificate. Instead, add one site block to the Caddyfile on the Caddy
container from recipe [00 -- The shared reverse proxy](00-reverse-proxy.md), pointing at this
container's address and Vaultwarden's `ROCKET_PORT` (`8080` above). The `DOMAIN` you set in
`/etc/vaultwarden.env` must match this hostname exactly, or the Bitwarden clients will refuse to
connect.

On the Caddy container (after `pct enter` into it), append the Vaultwarden block to the shared
Caddyfile, then reload, using the `tee -a` then reload pattern recipe 00 established. Substitute
your hostname and this container's `<vw-ip>`. File `/etc/caddy/Caddyfile`:

```bash
tee -a /etc/caddy/Caddyfile >/dev/null <<'EOF'

vault.example.com {
	reverse_proxy <vw-ip>:8080
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
}
EOF
caddy reload --config /etc/caddy/Caddyfile
```

The `tls { dns cloudflare ... }` block is the DNS-01 form recipe 00 and guide 12 cover; omit it only
if your Caddy container is not using DNS-01. Caddy obtains and renews the certificate for
`vault.example.com` automatically and proxies to Vaultwarden on port 8080.

## Verify it worked

Three checks confirm the vault is serving. First, inside the container (`pct enter 123`), the
service is listening on its port:

```bash
ss -tlnp 'sport = :8080'
```

The expected key line names a listener on `0.0.0.0:8080` owned by the `vaultwarden` process. Second,
the web vault answers over plain HTTP at the container's address (run from the host or the Caddy
container, which can reach `<vw-ip>`):

```bash
curl -I http://<vw-ip>:8080
```

The expected key line is an `HTTP/1.1 200 OK` status, which proves Vaultwarden is up and serving the
web vault. Third, the same vault answers through Caddy over HTTPS at your real hostname:

```bash
curl -I https://vault.example.com
```

The expected key line is an `HTTP/2 200` (or `HTTP/1.1 200 OK`) status with no certificate warning,
confirming Caddy obtained a trusted certificate and proxied to Vaultwarden. From there, point a
Bitwarden app or browser extension at `https://vault.example.com` as its self-hosted server URL.

## Back it up

This container holds every password you own, so its backup is the one you least want to be missing.
It is a guest like any other: add VMID 123 to the Proxmox Backup Server backup job from guide
[17 -- Backups with Proxmox Backup Server](../17-backups-with-pbs.md) so the whole data directory
under `/var/lib/vaultwarden` is captured on the regular schedule. From there it rides along into the
off-box copy described in guide
[18 -- The independent copy and restore](../18-the-independent-copy-and-restore.md), so a dead node
does not mean a lost vault. And because this box is security-sensitive, take a snapshot before every
Vaultwarden upgrade (guide
[05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md)) so a bad release rolls
back in seconds. Treat finishing this recipe and adding the guest to the backup job as one task.

## Sources

- `research/round2-pve9/20-pve9-ecosystem-and-service-patterns.md` -- the Vaultwarden per-service
  pattern (unprivileged LXC via the `vaultwarden` Helper-Script, single Rust binary plus SQLite,
  sized 1 vCPU / 512 MB / 4-8 GB, security-sensitive so snapshot before upgrades, front with a
  reverse-proxy LXC for TLS, manage via `journalctl -u vaultwarden`) and the Helper-Scripts
  `ct/vaultwarden.sh` curl and wget one-liner forms.
- Guide [16 -- Automation and the ecosystem](../16-automation-and-the-ecosystem.md) -- the
  Helper-Scripts curl-pipe-to-root caution (read first, snapshot, pin a commit) that
  `ct/vaultwarden.sh` inherits.
- Recipe [00 -- The shared reverse proxy](00-reverse-proxy.md) -- the shared Caddy container this
  recipe fronts Vaultwarden with, and the per-site-block, `tee -a` then reload pattern.
- Vaultwarden official docs (Context7 `/dani-garcia/vaultwarden`): the
  [systemd service](https://github.com/dani-garcia/vaultwarden/wiki/Setup-as-a-systemd-service) unit
  (the `vaultwarden` user, `EnvironmentFile=/etc/vaultwarden.env`,
  `WorkingDirectory`/`ReadWritePaths=/var/lib/vaultwarden`, `ExecStart=/usr/bin/vaultwarden`), the
  [admin page](https://github.com/dani-garcia/vaultwarden/wiki/Enabling-admin-page) Argon2 PHC
  `ADMIN_TOKEN` hashing (and that an unset token disables the page), and the `DATA_FOLDER`,
  `DOMAIN`, `SIGNUPS_ALLOWED`, `ROCKET_ADDRESS`, and `ROCKET_PORT` configuration variables.

---

Previous: [01 -- DNS sinkhole](01-dns-sinkhole.md) | Next: [03 -- Miniflux](03-miniflux.md)
