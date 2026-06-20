# Recipe: a personal website, public via Cloudflare Tunnel

## What you'll be able to do

You will serve a static personal website from one tiny [unprivileged container](../GLOSSARY.md)
running [Caddy](../GLOSSARY.md) (or Nginx) and expose it to the public internet over HTTPS through a
[Cloudflare Tunnel](../GLOSSARY.md). Because the tunnel is outbound-only, the site is reachable from
anywhere without forwarding a single inbound port on your router or firewall. This recipe reuses the
`cloudflared` tunnel that guide 12 already teaches and adds only the one ingress mapping that points
your public hostname at this site.

## Before you start

This recipe reuses foundations rather than re-teaching them. You need:

- An [unprivileged container](../GLOSSARY.md) to run the site in. Creating one is taught in guide
  [05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md); this recipe shows only
  the one `pct create` line and points you there for the rest. As an alternative origin, you can
  mark a base Debian 13 unprivileged container as a template and `pct clone` it (taught in guide
  [05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md)) instead of building
  from a fresh OS template; either way you end up with one small Debian 13 unprivileged container.
  (Guide 07's template is a KVM/QEMU VM cloned with `qm clone`, not a container.)
- The [Cloudflare Tunnel](../GLOSSARY.md) and Cloudflare DNS from guide
  [12 -- Remote access](../12-remote-access.md). Guide 12 already teaches the whole `cloudflared`
  install, the locally-managed tunnel (`tunnel login`, `tunnel create`), the ingress `config.yml`,
  the `cloudflared tunnel route dns` step, and [Cloudflare Access](../GLOSSARY.md). This recipe
  cross-references it and shows only the one [ingress rule](../GLOSSARY.md) that maps your hostname
  to this site. Do the tunnel setup in guide 12 first.
- Optionally, the shared Caddy container from recipe
  [00 -- The shared reverse proxy](00-reverse-proxy.md). You can either serve this site directly
  from a small Caddy in the site container (the lightest path, used below) or front it with the
  shared Caddy container if you already run one; either way the tunnel forwards to a local origin.

There is no first-party Proxmox Helper-Script for a personal website, so unlike most recipes in this
part there is no community one-liner path to compare against. This recipe is hand-built only: a
single path where you create the container yourself (or clone your cloud-init template) and serve a
folder of files. That is the recommended pattern for a static site, and it is tiny, so you lose
nothing by it; you simply own every step. If instead you want a dynamic CMS (WordPress, Ghost,
Drupal), that is the Drupal pattern -- see recipe [06 -- Drupal](06-drupal.md).

## Pick the pattern and size it

This recipe is pattern A: a static site in a small [unprivileged container](../GLOSSARY.md) running
[Caddy](../GLOSSARY.md) (or Nginx) to serve the files. A static site is just a folder of HTML, CSS,
and assets, whether you hand-write the HTML or build it with a static-site generator such as Hugo or
Astro. It needs almost nothing, so an LXC is the lightest, most accessible home for it and is
trivially snapshot-able.

Size it small: about 1 vCPU, 256 to 512 MB of RAM, and a 2 to 4 GB disk are plenty.

Accessibility note: once the container exists you manage it with `pct enter <vmid>`, which drops you
straight into a root shell inside it with no console or networking setup. Every command below runs
either on the Proxmox host (the `pct` lines) or inside the container after `pct enter` (the install,
config, and deploy lines).

The request path is worth fixing in your mind, because it explains why no inbound port is ever
opened:

1. A public visitor requests `https://www.example.com`. The request lands on Cloudflare's edge, and
   Cloudflare terminates TLS there (the HTTPS certificate is Cloudflare's, issued for your
   hostname).
2. Cloudflare forwards that request down the tunnel to the [cloudflared](../GLOSSARY.md) agent
   running inside your network. The tunnel is outbound-only: `cloudflared` dialed out to
   Cloudflare's edge, so the inbound traffic rides back along a connection your side opened.
3. `cloudflared` proxies the request to this site's local origin over plain HTTP -- the small Caddy
   serving the files, for example `http://localhost:80` if `cloudflared` and Caddy share a
   container, or `http://<site-lxc-ip>:80` if they are separate.

Because every hop into your network is initiated from inside it, nothing on your router or host
firewall is opened to the internet. That is the whole reason guide 12's design forwards no ports.

## Build the site LXC and serve the files

On the Proxmox host, create the unprivileged container. The line below is the shape of it; guide
[05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md) explains every option, the
OS template, and confirming the template name with `pveam`. Give it a static address if
`cloudflared` runs in a separate container and points at this one by IP (guide
[10 -- Networking](../10-networking.md)). Substitute your own VMID, bridge, address, gateway, and
key path:

```bash
pct create 128 local-btrfs:vztmpl/debian-13-standard_13.x-1_amd64.tar.zst \
  --hostname website \
  --unprivileged 1 \
  --cores 1 --memory 512 --swap 256 \
  --rootfs local-btrfs:4 \
  --net0 name=eth0,bridge=vmbr0,ip=192.168.1.128/24,gw=192.168.1.1 \
  --onboot 1 \
  --ssh-public-keys /root/website.pub
```

Start the container and enter it:

```bash
pct start 128
pct enter 128
```

You are now in a root shell inside the container. Install Caddy from its official apt repository,
exactly the install recipe 00 and guide 12 use; it leaves Caddy running as a systemd service named
`caddy` with its config at `/etc/caddy/Caddyfile`:

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update
apt install caddy
```

(You do not need the `caddy-dns/cloudflare` DNS module here, because this Caddy is not obtaining a
certificate -- Cloudflare terminates TLS at its edge. That module is only for the DNS-01 path in
guide 12 and recipe 00.)

Put the site files under a docroot. Create the directory and drop an index page in for now; you
replace its contents in the next section. The docroot is `/var/www/site`:

```bash
install -d /var/www/site
echo '<!doctype html><title>It works</title><h1>It works</h1>' > /var/www/site/index.html
```

Now point Caddy at that docroot, serving plain HTTP only. The site address `:80` (a bare port with
no hostname) tells Caddy to serve over plain HTTP and NOT to attempt automatic HTTPS, which is
exactly what you want: TLS is handled at the Cloudflare edge, and the tunnel reaches this origin
over plain HTTP. The `root` directive sets the docroot and `file_server` serves the files. Write the
config with a here-doc rather than a terminal editor; the "Editing files accessibly" section of
guide [02 -- The shell and the API](../02-the-shell-and-the-api.md) lists the alternatives. File
`/etc/caddy/Caddyfile`:

```bash
tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
# Static personal site, served over plain HTTP for the Cloudflare Tunnel.
# Cloudflare terminates TLS at its edge; this origin needs no certificate.
:80 {
	root * /var/www/site
	file_server
}
EOF
```

Reading that block:

- `:80` is a bare-port site address, so Caddy listens on port 80 over plain HTTP and does not try to
  obtain a certificate. (Prefixing a hostname with `http://` would do the same; the bare port is
  simplest for a tunnel origin.)
- `root * /var/www/site` sets the docroot for all requests (`*`) to the folder your files live in.
- `file_server` serves the static files from that root, with `index.html` as the default document.

Validate the config, make sure Caddy is enabled at boot, then reload it so the new Caddyfile takes
effect. The package install already started Caddy, so a plain `enable --now` would not re-read the
config -- the explicit `reload` is what loads it:

```bash
caddy validate --config /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy
```

If you would rather use Nginx, install `nginx` instead and write a minimal static server block whose
`root` is `/var/www/site` and that listens on `listen 80;`; the rest of this recipe (deploy, tunnel
ingress, verify, backup) is identical. Caddy is shown as the default because its config is a few
lines and it needs no separate enable step.

## Deploy your content

There are two common ways to get your content into `/var/www/site`, and you can use either. Keep
your site's source in a git remote regardless, so the box is reproducible; the docroot below is just
the published output.

The first way is rsync over SSH from your control station: build the site locally (or just author
the HTML), then push the finished files into the docroot. From the control station, push the
contents of your local build directory to the container's docroot (mind the trailing slashes;
`build/` copies the contents, not the directory itself):

```bash
rsync -av --delete ./build/ root@192.168.1.128:/var/www/site/
```

The `--delete` flag makes the docroot mirror your build exactly, removing files you deleted locally.
If `cloudflared` runs in a separate box and this container has no public SSH, rsync over your LAN
address as shown, or over Tailscale (guide 12) if you reach it that way.

The second way is `git pull` plus a build step on the container itself: clone your site's repository
into the container once, then on each deploy pull the latest commit and (for a generator such as
Hugo or Astro) run the build so its output lands in the docroot. Inside the container
(`pct enter 128`):

```bash
cd /var/www/site-src
git pull
# then run your generator so it writes into /var/www/site, for example:
# hugo --destination /var/www/site
```

For a plain hand-written HTML site there is no build step: the repository contents are the docroot,
so a `git pull` in `/var/www/site` is the whole deploy. Pick whichever fits how you author; do not
teach yourself a specific generator here, just point its output at `/var/www/site`.

## Expose it via Cloudflare Tunnel

This is the headline of the recipe, and it is almost entirely guide 12's work. Guide
[12 -- Remote access](../12-remote-access.md) already walks the full `cloudflared` setup in an
unprivileged LXC: `cloudflared tunnel login`, `cloudflared tunnel create`, writing
`/etc/cloudflared/config.yml`, `cloudflared tunnel route dns`,
`cloudflared tunnel ingress validate`, and `cloudflared service install`. Do not repeat any of that.
All this recipe adds is the one ingress entry that maps your public hostname to this site's local
origin.

In the tunnel's ingress config, add the entry for your hostname above the required catch-all. The
catch-all (`service: http_status:404`, with no `hostname:`) must stay last, or `cloudflared` rejects
the whole file; guide 12 explains the first-match-wins ordering. The `service:` target is this
site's local origin: `http://localhost:80` if `cloudflared` and Caddy share a container, or
`http://<site-lxc-ip>:80` if they are separate. In the existing `/etc/cloudflared/config.yml` from
guide 12, the ingress list becomes (leave the `tunnel:` and `credentials-file:` keys above it in
place):

```yaml
ingress:
  - hostname: www.example.com
    service: http://192.168.1.128:80
  - service: http_status:404
```

Then route the public DNS name to the tunnel and restart `cloudflared`, both covered in guide 12
(shown here only so the cross-reference is concrete):

```bash
cloudflared tunnel route dns homelab www.example.com
systemctl restart cloudflared
```

`cloudflared tunnel route dns` creates the proxied CNAME in your Cloudflare zone so you do not
hand-edit DNS, and the restart makes `cloudflared` re-read the ingress. From here Cloudflare
publishes `www.example.com`, terminates TLS at its edge, and forwards down the tunnel to your Caddy
origin.

A personal website is usually meant to be seen, so leave it fully public. You can put
[Cloudflare Access](../GLOSSARY.md) in front of the hostname if you want to gate it (for a staging
site, or a page only you should see), exactly as guide 12 describes for private-but-tunneled
services -- but unlike the crown-jewel services in guide 12, Access is optional here and most
personal sites do not use it.

## Manage it from the shell

Everything is the docroot, the web server, and the journal; no dashboard is needed.

- Check the Caddy config before applying it, then reload in place without dropping connections:

```bash
caddy validate --config /etc/caddy/Caddyfile
caddy reload --config /etc/caddy/Caddyfile
```

(For Nginx the equivalents are `nginx -t` to test and `systemctl reload nginx` to apply.)

- Read the logs. Both the web server and the tunnel log to the journal:

```bash
journalctl -u caddy
journalctl -u cloudflared
```

(Add `-f` to follow live, or `-n 50` for the last 50 lines. `cloudflared` runs wherever you
installed it in guide 12, which may be a different container than Caddy.)

- Redeploy content by re-running the rsync push or the `git pull` plus build from the "Deploy your
  content" section. A content change needs no service restart; the file server picks up the new
  files immediately.

## Verify it worked

Three checks confirm the site is serving, from the origin outward. First, inside the site container
(`pct enter 128`), Caddy answers locally over plain HTTP:

```bash
curl -I http://localhost
```

The expected key line is an `HTTP/1.1 200 OK` status with a `Server: Caddy` header, which proves
Caddy is up and serving the docroot. (If `cloudflared` is in a separate box, also confirm it can
reach this origin with `curl -I http://192.168.1.128` from there.)

Second, the public hostname resolves and serves over HTTPS through the tunnel. From your control
station or anywhere on the internet:

```bash
curl -I https://www.example.com
```

The expected key line is an `HTTP/2 200` (or `HTTP/1.1 200 OK`) status with no certificate warning,
which proves Cloudflare published the hostname, terminated TLS with a trusted certificate, and
forwarded down the tunnel to your Caddy origin.

Third, the tunnel itself is healthy, which is guide 12's check: `systemctl status cloudflared`
reports the service active (running), and `cloudflared tunnel ingress validate` passes with no
errors against your `config.yml`.

## Back it up

A static site is largely reproducible: its source lives in a git remote, so in the worst case you
re-clone, rebuild, and redeploy. Keep that git remote current; it is your real source of truth. But
back up the container anyway, because the box also holds the `cloudflared` credentials and ingress
config (and any Caddy or Nginx tuning you have added), which are not in your site repository.

It is a guest like any other: add VMID 128 to the Proxmox Backup Server backup job from guide
[17 -- Backups with Proxmox Backup Server](../17-backups-with-pbs.md) so it is captured on the
regular schedule, and from there it rides along into the off-box copy described in guide
[18 -- The independent copy and restore](../18-the-independent-copy-and-restore.md). If
`cloudflared` lives in its own LXC, back that container up too, since it holds the tunnel
credentials. Treat finishing this recipe and adding the guest to the backup job as one task.

## Sources

- `research/round2-pve9/20-pve9-ecosystem-and-service-patterns.md` -- the personal-website
  per-service pattern (a static site in an unprivileged LXC running Caddy or Nginx, pattern A; tiny
  and trivially snapshot-able, served by a tiny Caddy or Nginx origin with TLS terminated at the
  Cloudflare edge; a dynamic CMS is the Drupal pattern instead; sized 1 vCPU / 256-512 MB / 2-4 GB;
  deploy via `git pull` plus a build step or rsync over SSH; reuse one Caddy reverse-proxy LXC in
  front of all web services).
- Guide [12 -- Remote access](../12-remote-access.md) -- the full `cloudflared` Cloudflare Tunnel
  setup this recipe builds on: the apt install, the locally-managed tunnel (`tunnel login`,
  `tunnel create`), the `/etc/cloudflared/config.yml` ingress with its required `http_status:404`
  catch-all and first-match-wins ordering, `cloudflared tunnel route dns`,
  `cloudflared tunnel ingress validate`, `cloudflared service install`, the
  `systemctl status`/`restart` checks, and the optional Cloudflare Access gate. The request-path
  framing (Cloudflare terminates TLS at the edge, then forwards down the outbound-only tunnel to a
  local origin, so no inbound port is opened) is guide 12's no-port-forwarding premise.
- Recipe [00 -- The shared reverse proxy](00-reverse-proxy.md) -- the shared Caddy container and the
  Caddy apt install this recipe reuses, for the alternative of fronting the site with the shared
  proxy instead of serving it directly.
- Caddy official docs (Context7 `/caddyserver/website`): the
  [static files quick-start](https://caddyserver.com/docs/quick-starts/static-files) and the
  [`file_server` directive](https://caddyserver.com/docs/caddyfile/directives/file_server) (the
  `root` directive plus `file_server`), and that an `http://` prefix or a bare port like `:80`
  serves plain HTTP with no automatic HTTPS (the
  [Caddyfile tutorial](https://caddyserver.com/docs/caddyfile-tutorial) and the
  [`auto_https` option](https://caddyserver.com/docs/caddyfile/options)).

---

Previous: [07 -- Home Assistant (HAOS VM)](07-home-assistant-haos-vm.md) | Next:
[09 -- Throwaway dev-lab VM](09-dev-lab-vm.md)
