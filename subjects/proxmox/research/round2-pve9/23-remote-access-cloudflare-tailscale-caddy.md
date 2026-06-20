# Remote Access on PVE 9 - Cloudflare Tunnel, Tailscale, and Caddy (DNS-01)

Scope: latest Proxmox VE 9.x (Debian 13 "trixie"), mid-2026. Reader is a blind, screen-reader,
shell-only operator on a single PVE node, administering everything over SSH from a Windows control
station. The web GUI and graphical consoles are never used. This file is a research brief for guide
12 ("Remote access"); it collects citation-bearing, shell-first command workflows for the hybrid
architecture fixed in ADR-0003.

The architecture (treated as fixed):

- Cloudflare Tunnel (`cloudflared` in a small unprivileged LXC, outbound-only, no router
  port-forwarding) is the primary door for public web services and the personal website. Private
  services exposed this way are gated behind Cloudflare Access (login).
- Tailscale provides SSH/admin access to the host and end-to-end-private access to the most
  sensitive services (Vaultwarden and other crown jewels). Those are kept OFF the Cloudflare tunnel
  so decrypted traffic never transits Cloudflare's edge.
- A Caddy reverse proxy (in an LXC) fronts internal/Tailscale web services with HTTPS using DNS-01
  certificates (Cloudflare DNS plugin), so no inbound port 80/443 is needed.
- The domain is registered at CrazyDomains; its DNS is moved to Cloudflare (free plan). Registration
  stays at CrazyDomains.

## TL;DR / Recommendation

- Move DNS to Cloudflare first (free plan is sufficient). This is a one-time, mostly
  dashboard-driven onboarding: add the zone, Cloudflare assigns two nameservers, you change the
  nameservers at CrazyDomains. After the zone is live, manage records from the shell via the
  Cloudflare REST API; `flarectl` is only an optional wrapper.
- Public web and the personal site go through a locally-managed `cloudflared` tunnel in an
  unprivileged LXC. Locally-managed (credentials JSON plus `/etc/cloudflared/config.yml`) is the
  shell-friendly path; token-based is the dashboard/remote path.
- Crown-jewel services (Vaultwarden) stay on Tailscale only, exposed with `tailscale serve` (private
  to the tailnet), never on the tunnel.
- Tailscale SSH (`tailscale up --ssh`) gives accessible admin access to the host without exposing
  port 22 to the internet.
- Caddy needs a custom build that includes the `caddy-dns/cloudflare` module for DNS-01 (the stock
  binary has no DNS providers). Use `caddy add-package` or `xcaddy build`.
- The least shell-native step is Cloudflare Access policy creation - it is dashboard/API bound. Be
  honest with the reader about that.

## Honesty up front: what cannot be done purely from the shell

- The Cloudflare zone onboarding (adding the site, reviewing scanned records, reading the two
  assigned nameservers) is done in the Cloudflare dashboard or via the Cloudflare API. The
  nameserver change itself happens in the CrazyDomains registrar panel.
- Cloudflare Access application and policy creation is primarily dashboard-driven (an API and
  Terraform exist, but the documented "happy path" is the Zero Trust dashboard).
- Everything else - installing and configuring `cloudflared`, Tailscale, and Caddy, and managing DNS
  records once the zone is live - is fully shell-doable.

## 1. Moving DNS to Cloudflare (CrazyDomains stays the registrar)

The "Full setup" onboarding flow (the only option on Free and Pro plans):

1. Add the domain to Cloudflare. In the dashboard you input the apex domain (or use the Cloudflare
   API to create a zone). Cloudflare automatically scans for existing DNS records and assigns two
   authoritative nameservers specific to your domain. Per the docs: "Cloudflare automatically
   assigns nameservers to a domain and these assignments cannot be changed." You read the assigned
   names from the zone Overview page; they cannot be customized.
2. Review the scanned DNS records (dashboard). Confirm apex, `www`, and any mail records. "Orange
   cloud" means proxied through Cloudflare; "gray cloud" means DNS-only.
3. Update the nameservers at CrazyDomains. Log into the CrazyDomains admin panel, disable DNSSEC if
   it is active, and replace the existing nameservers with Cloudflare's two assigned ones.
4. Cloudflare verifies. "Wait up to 24 hours while your registrar updates your nameservers." The
   zone status flips to "Active" and Cloudflare emails confirmation. Online checkers (for example
   whatsmydns) may show cached results for a while.

Dashboard-only vs API:

- Reading the assigned nameservers and reviewing scanned records is most easily done in the
  dashboard. The nameserver change is registrar-side (CrazyDomains).
- Creating the zone and (especially) managing records afterward can be done via the Cloudflare REST
  API once the zone is live (see below). `flarectl` exists as an optional wrapper in the
  cloudflare-go repo, but it is not the baseline path for this corpus.

Free plan note: the Free plan provides full authoritative DNS and is sufficient for this
architecture (tunnel, DNS-01 certs, and Access all work on Free).

### Managing DNS records from the shell after the zone is live

Cloudflare documents a REST API for zone and DNS-record management. You authenticate with an API
token (create one in the dashboard under My Profile, API Tokens; for DNS edits the documented scope
is Zone:DNS:Edit, plus Zone:Zone:Read to read the zone). Store the token in a root-only file, then
resolve the zone ID and list records:

```bash
export CF_API_TOKEN="$(cat /root/.cloudflare-token)"

ZONE_ID="$(
  curl -fsS 'https://api.cloudflare.com/client/v4/zones?name=example.com' \
    -H "Authorization: Bearer ${CF_API_TOKEN}" |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["result"][0]["id"])'
)"

curl -fsS "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records" \
  -H "Authorization: Bearer ${CF_API_TOKEN}"
```

Create non-tunnel records with `POST /zones/{zone_id}/dns_records`, for example:

```bash
curl -fsS "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records" \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  --data '{"type":"CNAME","name":"www.example.com","content":"example.com","ttl":1,"proxied":false}'
```

Treat `cloudflared tunnel route dns` (section 2) as the preferred way to create the tunnel's CNAME,
because it wires the record to the tunnel automatically. `flarectl` can still be used if installed,
but its subcommands are version-dependent; confirm them with `flarectl dns --help` before scripting.

Citations:

- Cloudflare DNS, Full setup:
  [Set up a primary zone (Full setup)](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/)
- Cloudflare DNS, Add a site / zone setup overview:
  [DNS setups](https://developers.cloudflare.com/dns/zone-setups/)
- Cloudflare nameservers (assigned, cannot be changed):
  [Nameserver options](https://developers.cloudflare.com/dns/nameservers/nameserver-options/)
- Cloudflare API tokens:
  [Create API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
- Cloudflare API, list zones and DNS records:
  [List Zones](https://developers.cloudflare.com/api/resources/zones/methods/list/) ;
  [List DNS Records](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/)
- Cloudflare API, create DNS records:
  [Create DNS Record](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/)
- `flarectl` optional wrapper in the cloudflare-go repo:
  [cloudflare-go/cmd/flarectl at v0 · cloudflare/cloudflare-go](https://github.com/cloudflare/cloudflare-go/tree/master/cmd/flarectl)

## 2. `cloudflared` in an unprivileged Debian LXC (locally-managed tunnel)

`cloudflared` makes only OUTBOUND connections to Cloudflare's edge, so the LXC needs no inbound
ports and no router port-forwarding. Run it in a small unprivileged Debian 13 LXC.

### Install cloudflared on Debian (official apt repo)

The Cloudflare apt repo and signing key (package name `cloudflared`):

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null

echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list

sudo apt-get update && sudo apt-get install cloudflared
```

(Cloudflare also publishes a `next.pkg.cloudflare.com` channel for pre-release builds; use the
stable `pkg.cloudflare.com` line above unless you specifically want pre-release.)

### Locally-managed tunnel workflow (preferred for shell users)

This stores the tunnel's credentials as a JSON file on the LXC and uses a local `config.yml`, so the
whole tunnel definition lives on the node and in version-controllable files - the right model for a
shell-only operator.

Step 1 - authenticate the machine (one-time). This opens a browser-based login; on a headless node
it prints a URL you open on your Windows control station to authorize a zone. It writes a `cert.pem`
into the cloudflared directory (`~/.cloudflared/cert.pem`):

```bash
cloudflared tunnel login
```

Step 2 - create the named tunnel. This creates the tunnel and writes a credentials file named after
the tunnel UUID, by default under the cloudflared directory (`~/.cloudflared/<Tunnel-UUID>.json`;
under `sudo`/root that is `/root/.cloudflared/`):

```bash
cloudflared tunnel create homelab
```

Step 3 - write the ingress config. Put it at `/etc/cloudflared/config.yml` (the path
`cloudflared service install` reads when run as root). Map each public hostname to a local origin
URL, and end with the REQUIRED catch-all `- service: http_status:404`:

```yaml
# /etc/cloudflared/config.yml
tunnel: <Tunnel-UUID>
credentials-file: /root/.cloudflared/<Tunnel-UUID>.json

ingress:
 - hostname: www.example.com
 service: http://10.0.0.20:8080
 - hostname: app.example.com
 service: http://10.0.0.20:443
 - service: http_status:404
```

Notes on the config:

- `tunnel:` is the UUID (or the tunnel name) created in step 2.
- `credentials-file:` points at the JSON written by `tunnel create`. The official example uses paths
  like `/root/.cloudflared/<UUID>.json`.
- The `ingress:` list is evaluated top to bottom; the FIRST matching rule wins. The final rule MUST
  be a catch-all with no `hostname:` - the docs use `http_status:404` (some examples use `503`).
  Without a catch-all, `cloudflared` rejects the config.
- The `service:` target is the local origin reachable from the LXC - for this architecture,
  typically the Caddy reverse-proxy LXC, or a service directly.

Step 4 - create the public DNS CNAME for each hostname. This adds a proxied CNAME in the Cloudflare
zone pointing the hostname at the tunnel (no manual DNS editing needed):

```bash
cloudflared tunnel route dns homelab www.example.com
cloudflared tunnel route dns homelab app.example.com
```

Step 5 - validate the ingress rules before going live:

```bash
cloudflared tunnel ingress validate
```

Step 6 - install as a systemd service. Run as root so it reads `/etc/cloudflared/config.yml`:

```bash
sudo cloudflared service install
sudo systemctl start cloudflared
sudo systemctl status cloudflared
```

After any config change, restart the service:

```bash
sudo systemctl restart cloudflared
```

(For a foreground test before installing the service you can run `cloudflared tunnel run homelab`,
optionally with `--config /path/config.yml`.)

### Token-based (remotely-managed) alternative

If the tunnel is created in the Cloudflare Zero Trust dashboard instead, it is "remotely-managed":
its ingress config lives in the dashboard, and the only thing the host needs is the tunnel token.
You install it with the token as an argument:

```bash
sudo cloudflared service install <TOKEN>
```

When to use each:

- Locally-managed (credentials JSON plus `config.yml`): preferred for a shell-only operator who
  wants the tunnel definition in files on the node, under their control, editable over SSH. This is
  the recommendation for this architecture.
- Token-based (remotely-managed): convenient when the ingress is managed centrally in the dashboard
  or via Terraform, or for fleets. Trade-off: ingress changes are made in the dashboard, not in a
  local file, which is less accessible for this reader. Token rotation is then the critical
  operational concern (re-run `service install <NEW_TOKEN>`).

### The unprivileged-LXC angle

Because `cloudflared` is outbound-only, the LXC needs no inbound ports and no special device access
for the tunnel itself. cloudflared does not require `/dev/net/tun` (that requirement is a Tailscale
concern - see section 4). Do not add nesting or TUN permissions for cloudflared unless a specific
feature you enable documents the need; the basic web-ingress tunnel does not.

Citations:

- Install cloudflared on Debian (apt repo + key): [pkg.cloudflare.com](https://pkg.cloudflare.com/)
  and
  [Downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
- Create a locally-managed tunnel (login, create, credentials JSON, config.yml ingress, route dns,
  ingress validate, run):
  [Create a locally-managed tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/)
- Run as a systemd service on Linux (`cloudflared service install`, start/status/restart):
  [Linux](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/as-a-service/linux/)
- Ingress rules reference (ordered list, required catch-all):
  [Configuration file](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/configuration-file/)
- Token-based / remotely-managed install (`cloudflared service install <TOKEN>`):
  [Tunnel permissions](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/remote-tunnel-permissions/)

## 3. Cloudflare Access (gating a private hostname behind login)

Concept: a Cloudflare Access "self-hosted application" sits in front of a hostname that is published
through your tunnel. Access intercepts requests at Cloudflare's edge and requires the user to
authenticate (against a configured identity provider) before the request ever reaches your origin.
"All Access applications are deny by default - a user must match an Allow policy before they are
granted access."

Why it matters for this architecture: a private service you still want reachable over the tunnel
(not a crown jewel - those stay on Tailscale) gets login protection without you running an auth
layer at the origin.

The honest part: this is the LEAST shell-native step. The documented path is the Zero Trust
dashboard (Zero Trust, then Access controls, then Applications): add a self-hosted application, add
the public hostname, then attach an Allow policy. An API and Terraform provider exist for
automation, but Cloudflare documents the dashboard flow as primary.

A minimal "allow my email" policy:

- Action: Allow.
- Include rule: Emails, set to your address (or "Emails ending in" for a domain).
- Identity provider: at minimum Cloudflare's built-in one-time PIN, which emails a code - no
  external IdP required.

Critical ordering gotcha straight from the docs: create the Access application BEFORE routing the
hostname through the tunnel. "If you do not have an Access application in place, the published
application will be available to anyone on the Internet." Also enable token validation at the origin
so requests that bypass Access are rejected.

Citations:

- Self-hosted public application (dashboard flow, deny-by-default, create-before-route warning):
  [Publish a self-hosted application to the Internet](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/)
- Access policies (Allow/Block, Include rules such as Emails):
  [Policies](https://developers.cloudflare.com/cloudflare-one/policies/access/)
- Access API / Terraform (for the automation-minded):
  [API and Terraform](https://developers.cloudflare.com/cloudflare-one/api-terraform/)

## 4. Tailscale on the Proxmox host (and/or an LXC)

Tailscale builds a WireGuard mesh ("tailnet") and gives accessible admin access plus private service
exposure without any inbound ports.

### Install on Debian (official apt repo)

The simplest documented install is the official script (it adds the Tailscale apt repo and signing
key, then installs the `tailscale` package):

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

The script is the documented method; if you prefer to add the repo by hand, Tailscale publishes
per-distro apt key and `sources.list` instructions on the download page (Debian "trixie" channel).
The package is `tailscale`; it installs the `tailscaled` daemon as a systemd service.

### Bring the node onto the tailnet with the flags that matter here

```bash
sudo tailscale up --ssh --hostname=pve-node --accept-routes
```

Key flags relevant to this architecture:

- `--ssh` - run the Tailscale SSH server, so SSH access is authorized by your tailnet ACL policy
  rather than by exposing port 22 to the internet. This is the accessible admin door.
- `--hostname=<name>` - set the device's name in the tailnet (and its MagicDNS name).
- `--accept-routes` - accept subnet routes advertised by other nodes (relevant if another device
  advertises your LAN).
- `--advertise-routes=<cidr>` - advertise a subnet (for example your LAN
  `--advertise-routes=192.168.1.0/24`) so tailnet peers can reach LAN hosts through this node.
  Subnet routes must be approved in the admin console after advertising.
- `--advertise-tags=tag:server` - tag the device (tags are defined in the tailnet ACL policy and are
  how you scope SSH and ACL rules; tagged nodes are owned by the tailnet, not a user).

### Tailscale SSH and the node's own sshd

`tailscale ssh user@host` connects over the tailnet; it "automatically checks the destination
server's SSH host key against the node's SSH host key advertised via the Tailscale coordination
server," and access is governed by the tailnet's SSH ACL rules (not by the host's
`authorized_keys`). Tailscale SSH runs alongside the host's own `sshd` - it does not replace or
disable it; you can keep OpenSSH for LAN/local access and use Tailscale SSH for remote admin. The
practical win: you can stop exposing OpenSSH to the public internet entirely and reach the host over
the tailnet.

### `tailscale serve` (private HTTPS to the tailnet) vs `tailscale funnel` (public)

`tailscale serve` exposes a local service over HTTPS to your tailnet only - services stay "private
within your Tailscale network." This is the right tool for crown-jewel services (Vaultwarden) that
must NOT transit Cloudflare. Examples:

```bash
# proxy a local HTTP service on port 3000 out as HTTPS to the tailnet
tailscale serve localhost:3000

# run it persistently in the background (survives reboot / tailscaled restart)
tailscale serve --bg localhost:3000

# mount under a path
tailscale serve --https=443 --set-path=/foo localhost:3000

# inspect / clear
tailscale serve status
tailscale serve reset
```

`tailscale funnel` is the opposite: it exposes a served service "publicly, open to the entire
internet." For this architecture, funnel is generally NOT used - public exposure goes through the
Cloudflare tunnel instead, and the crown jewels stay private on `serve`. Funnel syntax mirrors
serve:

```bash
tailscale funnel <target>
tailscale funnel status
tailscale funnel reset
```

### MagicDNS and the `*.ts.net` certificate story

With MagicDNS enabled, each node gets a stable name like `pve-node.<tailnet>.ts.net`.
`tailscale serve` automatically provisions a TLS cert for that name. If you need the cert as files
(for example to hand to another server), `tailscale cert` writes them; the Let's-Encrypt-issued
certs have a 90-day expiry and need periodic renewal when used as files:

```bash
# provision/print a cert for this node's MagicDNS name
tailscale cert pve-node.<tailnet>.ts.net

# write cert and key to files
tailscale cert --cert-file=cert.pem --key-file=key.pem pve-node.<tailnet>.ts.net
```

### Running Tailscale inside an LXC vs on the host (the `/dev/net/tun` requirement)

Running on the host is simplest (no device plumbing). Running inside an unprivileged LXC requires
giving the container access to the `/dev/net/tun` device - "Tailscale ... does need access to a
`/dev/net/tun` (TUN) device which unprivileged containers usually do not provide." Add to the
container config (PVE 7+ uses `cgroup2`):

```text
# /etc/pve/lxc/<CTID>.conf
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
```

Shut down and restart the container for the change to take effect. Documented alternatives: pass the
device through with `pct set <CTID> --dev0 /dev/net/tun`, or run Tailscale in userspace-networking
mode to avoid needing `/dev/net/tun` at all (userspace mode does not create a TUN interface, so
subnet routing and some features are limited).

Citations:

- Install on Linux (script + apt): [Download](https://tailscale.com/download/linux) and
  [Install Tailscale on Linux](https://tailscale.com/kb/1031/install-linux)
- `tailscale up` / CLI reference (--ssh, --advertise-routes, --accept-routes, --advertise-tags,
  --hostname): [Tailscale CLI](https://tailscale.com/kb/1080/cli)
- Tailscale SSH (host-key check, ACL-governed):
  [Tailscale SSH](https://tailscale.com/kb/1193/tailscale-ssh)
- `tailscale serve` (private to tailnet, --bg, --set-path, status, reset):
  [tailscale serve command](https://tailscale.com/kb/1242/tailscale-serve)
- `tailscale funnel` (public exposure): [Tailscale Funnel](https://tailscale.com/kb/1223/funnel)
- `tailscale cert` and MagicDNS HTTPS / ts.net:
  [Enabling HTTPS](https://tailscale.com/kb/1153/enabling-https)
- Tailscale in an unprivileged LXC (/dev/net/tun, cgroup2 lines, pct dev passthrough, userspace
  mode): [Tailscale in LXC containers](https://tailscale.com/kb/1130/lxc-unprivileged)

## 5. Caddy reverse proxy with DNS-01 (Cloudflare) certificates

Caddy fronts internal/Tailscale web services with HTTPS. Using the DNS-01 challenge means Caddy
never needs inbound port 80/443 to obtain certs - it proves domain control by writing a TXT record
via the Cloudflare API. This works behind the tunnel and on the tailnet, and it supports wildcard
certificates. Run Caddy in its own LXC.

### Install Caddy on Debian (official apt repo / Cloudsmith)

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

The package automatically starts and runs Caddy as a systemd service named `caddy`, with the config
at `/etc/caddy/Caddyfile`.

### The DNS-01 requirement: stock Caddy has no DNS providers

The stock Caddy binary does NOT include DNS provider plugins; DNS-01 with Cloudflare needs a Caddy
built with the `caddy-dns/cloudflare` module. Two documented ways:

Option A - add the module to the installed binary (works with the apt package), then restart:

```bash
sudo caddy add-package github.com/caddy-dns/cloudflare
sudo systemctl restart caddy
```

`caddy add-package` "replaces the current Caddy binary with the latest version with the same modules
installed, plus the packages listed" - so it requires restarting the running service. Verify the
module is present:

```bash
caddy list-modules --packages | grep cloudflare
caddy build-info
```

Option B - build a custom binary with `xcaddy` (for example to pin versions or build elsewhere):

```bash
xcaddy build --with github.com/caddy-dns/cloudflare
```

### Caddyfile with the Cloudflare DNS-01 challenge

Per-site form (also supports a wildcard host label):

```text
# /etc/caddy/Caddyfile
internal.example.com {
	reverse_proxy 10.0.0.30:8080
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
}
```

Wildcard form (one cert for all subdomains; requires DNS-01, which is why DNS-01 is used here):

```text
*.example.com {
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
	reverse_proxy 10.0.0.30:8080
}
```

Global form (apply the DNS challenge to every site in the file):

```text
{
	# global options block
}

# then each site can rely on the global tls dns config
```

The Cloudflare API token scope required by the module: Zone:DNS:Edit (to write the challenge TXT
records), plus Zone:Zone:Read (to discover the zone). Create the token in the Cloudflare dashboard
scoped to the specific zone.

### Passing the token to the systemd unit via an environment file

Caddy's Caddyfile reads `{env.CF_API_TOKEN}` from the process environment. For the systemd service,
supply it through an environment file so it is not in the Caddyfile or shell history. Caddy's
packaged unit reads `/etc/caddy/Caddyfile`; add an environment file with a drop-in override:

```bash
# create the secret file, root-only
sudo install -m 600 /dev/null /etc/caddy/caddy.env
printf 'CF_API_TOKEN=%s\n' '<token-with-Zone:DNS:Edit-and-Zone:Read>' | sudo tee /etc/caddy/caddy.env >/dev/null
```

```text
# /etc/systemd/system/caddy.service.d/override.conf
[Service]
EnvironmentFile=/etc/caddy/caddy.env
```

```bash
sudo systemctl daemon-reload
sudo caddy validate --config /etc/caddy/Caddyfile # validate before reload
sudo systemctl restart caddy
```

(Adjust the env-var name to whatever your Caddyfile references - `CF_API_TOKEN` and
`CLOUDFLARE_API_TOKEN` both appear in module examples; pick one and be consistent.)

Why DNS-01 here: no inbound port 80/443 is needed because validation is done via DNS TXT records
over the Cloudflare API, so Caddy obtains and renews certs even behind the tunnel or purely on the
tailnet, and it can issue wildcard certificates.

Citations:

- Install Caddy on Debian/Ubuntu (apt / Cloudsmith repo, systemd service, /etc/caddy/Caddyfile):
  [Install - Caddy Documentation](https://caddyserver.com/docs/install)
- `caddy add-package` / `remove-package` / `list-modules` / `build-info` / `validate` (command
  line): [Command Line - Caddy Documentation](https://caddyserver.com/docs/command-line)
- Building with plugins / xcaddy:
  [Build from source - Caddy Documentation](https://caddyserver.com/docs/build)
- `tls` directive with `dns` challenge (wildcard, env token):
  [tls (Caddyfile directive) - Caddy Documentation](https://caddyserver.com/docs/caddyfile/directives/tls)
- `caddy-dns/cloudflare` module (Caddyfile config, token scope Zone:Zone:Read + Zone:DNS:Edit):
  [GitHub - caddy-dns/cloudflare: Caddy module: dns.providers.cloudflare](https://github.com/caddy-dns/cloudflare)
- Automatic HTTPS / ACME DNS challenge background:
  [Automatic HTTPS - Caddy Documentation](https://caddyserver.com/docs/automatic-https)

## 6. How the three fit together (decision guidance)

Which path each service takes:

- Public web and the personal website: through the `cloudflared` tunnel. cloudflared's ingress
  points at the Caddy LXC (or directly at the service). DNS CNAMEs are created with
  `cloudflared tunnel route dns`.
- Private-but-still-tunneled services: same tunnel, but put a Cloudflare Access self-hosted
  application in front of the hostname so only your login gets through. Create the Access app BEFORE
  routing the hostname.
- Crown jewels (Vaultwarden and similarly sensitive services): Tailscale ONLY. Expose them with
  `tailscale serve` so traffic stays inside the WireGuard tailnet and never has its TLS terminated
  at Cloudflare's edge. Keep these OFF the tunnel entirely.
- Admin/SSH access to the host: Tailscale SSH (`tailscale up --ssh`), so you do not expose OpenSSH
  to the public internet.

Where Caddy sits:

- Caddy is the TLS front for internal/Tailscale web services, issuing certs via DNS-01 so it needs
  no inbound 80/443. It can also be the local origin behind `cloudflared` - that is, cloudflared's
  ingress `service:` points at Caddy, and Caddy reverse-proxies to the real backends. For
  tailnet-only services you can also let `tailscale serve` provide the `*.ts.net` HTTPS and reserve
  Caddy for your own-domain internal hostnames; choose one TLS front per service rather than
  stacking both.

Cross-references to the rest of the corpus:

- LAN-bridge (`vmbr0`) and NAT-bridge networking for the LXCs that host cloudflared, Caddy, and
  Tailscale are covered in guide 10 (networking).
- The Proxmox VE firewall (which inbound/outbound rules to allow on the host and on the LXCs) is
  covered in guide 11. Note that this architecture needs NO inbound port-forwarding on the router:
  cloudflared is outbound-only, Tailscale is outbound-only (WireGuard over UDP), and Caddy uses
  DNS-01 (no inbound 80/443).

## 7. Gotchas

- cloudflared ingress REQUIRES a catch-all final rule with no `hostname:` (the docs use
  `- service: http_status:404`). Omit it and the config is rejected.
- cloudflared credentials file location: `tunnel create` writes `~/.cloudflared/<UUID>.json` (under
  root that is `/root/.cloudflared/`). The `credentials-file:` line in `config.yml` must point at
  it, and `cloudflared service install` (run as root) reads `/etc/cloudflared/config.yml`.
  Mismatched paths are a common "tunnel runs but routes nothing" cause.
- cloudflared `tunnel login` needs a browser to authorize a zone - on a headless node it prints a
  URL you open on your Windows station. This is a one-time interactive step.
- Token-based tunnels keep their ingress config in the dashboard, not in a local file - less
  accessible for a shell-only operator, and token rotation becomes an operational task.
- Tailscale in an unprivileged LXC needs `/dev/net/tun` (the `lxc.cgroup2.devices.allow` and
  `lxc.mount.entry` lines, or `pct set --dev0`, or userspace mode). Forgetting this makes
  `tailscale up` fail to create the interface. Running Tailscale on the host avoids this.
- Tailscale subnet routes (`--advertise-routes`) must be APPROVED in the admin console after
  advertising; advertising alone does not enable them.
- `tailscale funnel` is PUBLIC (open to the whole internet). Do not point it at crown-jewel
  services; use `tailscale serve` (tailnet-private) for those.
- `tailscale cert` file-based certs expire every 90 days and need renewal; `tailscale serve` manages
  its cert automatically, so prefer `serve` over hand-managed cert files where you can.
- Caddy's stock binary has NO DNS providers - DNS-01 with Cloudflare fails until you
  `caddy add-package github.com/caddy-dns/cloudflare` (and restart) or build with xcaddy. Verify
  with `caddy list-modules --packages`.
- `caddy add-package` replaces the binary; you MUST restart the `caddy` service afterward or the new
  module is not loaded.
- Cloudflare Access application/policy creation is dashboard/API-bound - the least shell-native
  step. And per the docs you must create the Access app BEFORE routing the hostname through the
  tunnel, or the published app is briefly open to the entire internet.
- DNS propagation after the nameserver change at CrazyDomains can take up to 24 hours; the zone only
  goes "Active" (and tunnel/cert/Access features only work reliably) after Cloudflare confirms the
  nameserver change.
- The Cloudflare API token for Caddy DNS-01 needs Zone:DNS:Edit plus Zone:Zone:Read, scoped to the
  specific zone. An over-broad token is a needless risk; an under-scoped one fails the challenge.

## Sources / citations (consolidated)

Cloudflare DNS / onboarding:

- [Set up a primary zone (Full setup)](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/)
- [DNS setups](https://developers.cloudflare.com/dns/zone-setups/)
- [Nameserver options](https://developers.cloudflare.com/dns/nameservers/nameserver-options/)
- [Create API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
- [List Zones](https://developers.cloudflare.com/api/resources/zones/methods/list/)
- [List DNS Records](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/)
- [Create DNS Record](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/)
- [cloudflare-go/cmd/flarectl at v0 · cloudflare/cloudflare-go](https://github.com/cloudflare/cloudflare-go/tree/master/cmd/flarectl)

cloudflared / Cloudflare Tunnel:

- [pkg.cloudflare.com](https://pkg.cloudflare.com/)
- [Downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
- [Create a locally-managed tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/)
- [Linux](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/as-a-service/linux/)
- [Configuration file](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/configuration-file/)
- [Tunnel permissions](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/remote-tunnel-permissions/)

Cloudflare Access:

- [Publish a self-hosted application to the Internet](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/)
- [Policies](https://developers.cloudflare.com/cloudflare-one/policies/access/)
- [API and Terraform](https://developers.cloudflare.com/cloudflare-one/api-terraform/)

Tailscale:

- [Download](https://tailscale.com/download/linux)
- [Install Tailscale on Linux](https://tailscale.com/kb/1031/install-linux)
- [Tailscale CLI](https://tailscale.com/kb/1080/cli)
- [Tailscale SSH](https://tailscale.com/kb/1193/tailscale-ssh)
- [tailscale serve command](https://tailscale.com/kb/1242/tailscale-serve)
- [Tailscale Funnel](https://tailscale.com/kb/1223/funnel)
- [Enabling HTTPS](https://tailscale.com/kb/1153/enabling-https)
- [Tailscale in LXC containers](https://tailscale.com/kb/1130/lxc-unprivileged)

Caddy:

- [Install - Caddy Documentation](https://caddyserver.com/docs/install)
- [Command Line - Caddy Documentation](https://caddyserver.com/docs/command-line)
- [Build from source - Caddy Documentation](https://caddyserver.com/docs/build)
- [tls (Caddyfile directive) - Caddy Documentation](https://caddyserver.com/docs/caddyfile/directives/tls)
- [Automatic HTTPS - Caddy Documentation](https://caddyserver.com/docs/automatic-https)
- [GitHub - caddy-dns/cloudflare: Caddy module: dns.providers.cloudflare](https://github.com/caddy-dns/cloudflare)
