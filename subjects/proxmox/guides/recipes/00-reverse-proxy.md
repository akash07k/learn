# Recipe: the shared reverse proxy (Caddy)

## What you'll be able to do

You will stand up one [Caddy](../GLOSSARY.md) [reverse proxy](../GLOSSARY.md) in its own
[LXC container](../GLOSSARY.md) that fronts all your web services and handles TLS automatically.
This is the box every web-facing recipe in Part G builds on: when you later add Vaultwarden,
Nextcloud, Drupal, or your personal website, you do not give each its own proxy or certificate
handling. You add one site block to the Caddyfile here and reload. Do this recipe first if you are
standing up anything web-facing.

## Before you start

This recipe reuses foundations rather than re-teaching them. You need:

- An [unprivileged container](../GLOSSARY.md) to run Caddy in. Creating one is taught in guide
  [05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md); this recipe shows only
  the one `pct create` line and points you there for the rest.
- A static IP for that container, so the services that depend on it always find it at the same
  address. Giving a guest a static address is taught in guide
  [10 -- Networking](../10-networking.md).
- The Caddy and [DNS-01 (ACME DNS challenge)](../GLOSSARY.md) background from guide
  [12 -- Remote access](../12-remote-access.md). Guide 12 already teaches the full Caddy install,
  the `caddy-dns/cloudflare` module, the `tls { dns cloudflare ... }` block, and the root-only token
  env file. This recipe establishes that same box as the shared front end and the per-site-block
  pattern the other recipes copy; it cross-references guide 12 for the certificate mechanics rather
  than re-teaching them.

There is no first-party Proxmox helper script for the reverse proxy, so you build it once by hand.
That is deliberate: every web recipe then assumes one known Caddy container at a fixed address, with
a Caddyfile you understand line by line. A community `caddy` Helper-Script does exist, but it pipes
code fetched from the internet straight into a root shell on the host, so the same curl-pipe-to-root
caution from guide [16 -- Automation and the ecosystem](../16-automation-and-the-ecosystem.md)
applies (read first, snapshot, pin a commit). The recipes assume the hand-built box below.

## Pick the pattern

This recipe is pattern A: a hand-built [unprivileged container](../GLOSSARY.md). A reverse proxy is
a tiny, native service (a single Go binary driven by a config file), so it has no Docker upside and
an LXC is the lightest, most accessible home for it.

Sizing is small: about 1 vCPU, 256 to 512 MB of RAM, and a few GB of disk are plenty.

Accessibility note: once the container exists you manage it with `pct enter <vmid>`, which drops you
straight into a root shell inside it with no console or networking setup. Everything below runs
either on the Proxmox host (the `pct` lines) or inside the container after `pct enter` (the install
and Caddyfile lines).

## Build the Caddy LXC

On the Proxmox host, create the unprivileged container. The line below is the shape of it; guide
[05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md) explains every option, the
OS template, and how to confirm the template name with `pveam`. Give it a static address here rather
than DHCP, because services point at this box by IP. Substitute your own VMID, bridge, address,
gateway, and key path:

```bash
pct create 120 local-btrfs:vztmpl/debian-13-standard_13.x-1_amd64.tar.zst \
  --hostname caddy \
  --unprivileged 1 \
  --cores 1 --memory 512 --swap 256 \
  --rootfs local-btrfs:4 \
  --net0 name=eth0,bridge=vmbr0,ip=192.168.1.120/24,gw=192.168.1.1 \
  --onboot 1 \
  --ssh-public-keys /root/caddy.pub
```

The static `ip=192.168.1.120/24,gw=192.168.1.1` is the networking cross-reference: see guide
[10 -- Networking](../10-networking.md) for choosing an address on your bridge and for the static-IP
form in full. Start the container and enter it:

```bash
pct start 120
pct enter 120
```

You are now in a root shell inside the container. Install Caddy from its official apt repository
(hosted on Cloudsmith). This is the same install guide 12 teaches, reproduced here for convenience
so the recipe stays runnable on its own; it adds Caddy's repo and signing key, makes both
world-readable so APT's `_apt` user can read them under a restrictive umask, installs the `caddy`
package, and leaves Caddy running as a systemd service named `caddy` with its config at
`/etc/caddy/Caddyfile`:

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
chmod o+r /etc/apt/sources.list.d/caddy-stable.list
apt update
apt install -y caddy
```

The package install enables and starts the service for you. Confirm it is running, then enable it
explicitly so it survives a reboot:

```bash
systemctl enable --now caddy
systemctl status caddy
```

This recipe's template issues certificates with DNS-01 (the recommended path for this corpus, so
Caddy needs no inbound port 80 or 443), which the stock `caddy` binary cannot do on its own. Add the
Cloudflare DNS module now, before you write or validate any Caddyfile that contains the
`dns cloudflare` block -- a stock binary fails to load that directive. Build a Caddy that bundles
the module, then restart the service to run the new binary:

```bash
caddy add-package github.com/caddy-dns/cloudflare
systemctl restart caddy
```

Then set up the root-only token env file, following the "Add the Cloudflare DNS module" and "Pass
the token via a systemd env file" sections of guide [12 -- Remote access](../12-remote-access.md).
Do not put the Cloudflare API token on a command line; it leaks into shell history and `ps`. Guide
12 shows the chmod-600 env-file hygiene in full.

## The shared Caddyfile

Caddy is config-file driven: the whole front end lives in one file, `/etc/caddy/Caddyfile`, as a
list of site blocks. Each web service you stand up later gets one block. A block names the hostname
Caddy serves, and `reverse_proxy` forwards matching requests to that service's upstream LXC at its
IP and port. Caddy obtains and renews the TLS certificate for the hostname automatically.

Establish the file with one example block as the template the other recipes copy. Write it with a
here-doc rather than a terminal editor; the "Editing files accessibly" section of guide
[02 -- The shell and the API](../02-the-shell-and-the-api.md) lists the alternatives. File
`/etc/caddy/Caddyfile`:

```bash
tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
# Shared reverse proxy. One site block per web service.
# Each later recipe appends its own block below, then reloads Caddy.

internal.example.com {
	reverse_proxy <service-ip>:<port>
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
}
EOF
```

Reading that block:

- `internal.example.com` is the hostname Caddy answers for. Caddy gets a certificate for it
  automatically.
- `reverse_proxy <service-ip>:<port>` forwards requests to the upstream service in its own container
  or VM. Each later recipe substitutes its own service's real address and port here (for example
  Vaultwarden at `192.168.1.123:8080`).
- The `tls { dns cloudflare {env.CF_API_TOKEN} }` block tells Caddy to prove domain control with the
  DNS-01 challenge over the Cloudflare API, reading the token from the environment (the env file
  from guide 12), so no inbound port is needed. Guide [12 -- Remote access](../12-remote-access.md)
  covers this block, the wildcard form, and the token env file in full; omit the `tls` block
  entirely if a given site does not use DNS-01.

How a later web recipe adds itself: it appends its own site block to this same file (with `tee -a`,
or the editing methods in guide 02), then reloads Caddy (next section). It does not create a second
proxy. Over time `/etc/caddy/Caddyfile` grows one block per web service, and this one box fronts
them all.

## Manage it from the shell

Caddy needs no dashboard; it is entirely config-file driven, and everything you need is on the
command line inside the container.

- Check the config before applying it. `caddy validate` loads the config and runs each module's
  setup, so it catches errors a plain syntax check misses -- but it does not start the servers,
  issue certificates, or make any network calls:

```bash
caddy validate --config /etc/caddy/Caddyfile
```

- Apply a Caddyfile change without dropping live connections. After editing the file, reload in
  place:

```bash
caddy reload --config /etc/caddy/Caddyfile
```

The equivalent through systemd is `systemctl reload caddy`, which the packaged service wires to the
same graceful reload. Use `systemctl restart caddy` only when you genuinely need a full restart (for
example after `caddy add-package`, as guide 12 notes).

- Read the logs. The packaged service logs to the journal:

```bash
journalctl -u caddy
```

(Add `-f` to follow it live, or `-n 50` for the last 50 lines.)

## Verify it worked

Two checks confirm the box is serving. First, the config is valid:

```bash
caddy validate --config /etc/caddy/Caddyfile
```

Run this only after the Cloudflare DNS module is installed (above) and after you have replaced the
`<service-ip>:<port>` placeholder with a real upstream address. `caddy validate` does not make
network calls or issue certificates, but it does load and check the whole config, so it still fails
if the `dns cloudflare` module is not built into the binary or if the placeholder is not a valid
host:port. On success Caddy prints a `Valid configuration` line and exits zero; any error names the
offending file and line. Second, Caddy answers over HTTP. From the host or your control station,
send a header-only request to the container's address:

```bash
curl -I http://192.168.1.120
```

You should get an HTTP status line back and a `Server: Caddy` header, which proves the request
reached Caddy. Once a real site block with DNS-01 is live, the same check against its hostname over
HTTPS confirms the certificate:

```bash
curl -I https://internal.example.com
```

The expected key line is the `HTTP/2 200` (or `HTTP/1.1 200 OK`) status with no certificate warning,
confirming Caddy obtained a trusted certificate and proxied to the upstream. A reverse proxy by
itself opens no inbound router port and does not lock you out. If you ever pair it with a firewall
change, follow guide [11 -- Firewall](../11-firewall.md): preview the ruleset, keep a second SSH
session open, and confirm the SSH-allow rule before enabling.

## Back it up

This container is now a guest like any other, and it holds your whole web front-end config. Add VMID
120 to the Proxmox Backup Server backup job from guide
[17 -- Backups with Proxmox Backup Server](../17-backups-with-pbs.md) so it is captured on the
regular schedule. From there it rides along into the off-box copy described in guide
[18 -- The independent copy and restore](../18-the-independent-copy-and-restore.md). Treat finishing
this recipe and adding the guest to the backup job as one task.

## Sources

- `research/round2-pve9/20-pve9-ecosystem-and-service-patterns.md` -- Part 2 (the per-service
  patterns: a reverse proxy is the shared web front end, pattern A, sized small) and Part 3 ("One
  reverse-proxy LXC (Caddy) in front of all web services for automatic TLS"); Part 1 for the
  Helper-Scripts curl-pipe-to-root caveat that the community `caddy` script inherits.
- Guide [12 -- Remote access](../12-remote-access.md) -- the full Caddy apt install, the
  `caddy-dns/cloudflare` module, the `tls { dns cloudflare {env.CF_API_TOKEN} }` per-site and
  wildcard forms, and the root-only token env file and systemd drop-in this recipe builds on.
- Caddy official docs (Context7 `/caddyserver/website`):
  [install on Debian/Ubuntu](https://caddyserver.com/docs/install), the
  [Caddyfile site-block concepts](https://caddyserver.com/docs/caddyfile/concepts), and the
  [command line](https://caddyserver.com/docs/command-line) (`caddy validate --config`,
  `caddy reload`) the management and verify commands are grounded in.

---

Previous: [19 -- Applied recipes overview](../19-recipes-overview.md) | Next:
[01 -- DNS sinkhole](01-dns-sinkhole.md)
