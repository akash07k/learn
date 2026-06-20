# Remote access: reaching the node and its services from anywhere

## What you'll be able to do

By the end of this guide you will be able to reach the Proxmox host and the services it runs from
outside your LAN without forwarding a single router port. You combine a
[Cloudflare Tunnel](GLOSSARY.md) for public web, [Tailscale](GLOSSARY.md) for SSH/admin and the most
sensitive services, and a [Caddy](GLOSSARY.md) [reverse proxy](GLOSSARY.md) for internal HTTPS.
Everything that can be done over SSH is shown in the accessible, non-interactive shell form; the few
steps that are dashboard- or registrar-bound are named honestly up front.

## The plan: no port-forwarding

The architecture here is fixed by ADR-0003, and the single most important idea is this: nothing in
this design opens an inbound port on your router. Every agent makes only outbound connections, so
there is nothing to port-forward and nothing new to defend on the edge.

The hybrid model has four roles:

- Public web and your personal website go through a [cloudflared](GLOSSARY.md) tunnel. The tunnel is
  outbound-only: `cloudflared` dials Cloudflare's edge from inside your network, and Cloudflare
  publishes the chosen hostnames to the internet. No inbound port is opened.
- Private-but-still-tunneled services use the same tunnel but sit behind
  [Cloudflare Access](GLOSSARY.md), so only an authenticated login gets through to the origin.
- Crown-jewel services, above all Vaultwarden, stay on Tailscale ONLY and never touch the tunnel.
  The reason is decisive: Cloudflare terminates TLS at its edge, so any service published through
  the tunnel has its traffic decrypted on Cloudflare's servers. For a password manager that is
  unacceptable, so its traffic stays end-to-end-private inside the [WireGuard](GLOSSARY.md) mesh and
  never transits a third party in the clear.
- SSH and admin access to the host go over [Tailscale SSH](GLOSSARY.md), so you can stop exposing
  OpenSSH to the public internet entirely.

This design touches the rest of the corpus in two places. The LXCs that run `cloudflared`, Caddy,
and Tailscale attach to the bridges you set up in guide [10 -- Networking](10-networking.md) (the
LAN bridge `vmbr0`, or a NAT bridge for an isolated subnet). And because every agent is
outbound-only, the host firewall from guide [11 -- Firewall](11-firewall.md) needs NO inbound rules
for any of this: cloudflared is outbound-only, Tailscale is outbound-initiated WireGuard over UDP,
and Caddy uses [DNS-01 (ACME DNS challenge)](GLOSSARY.md) so it never needs inbound port 80 or 443.

## What is not shell-only (honesty up front)

Almost all of this is fully shell-doable over SSH. A few steps are not, and you should know that
before you start:

- Cloudflare zone onboarding: adding the domain to Cloudflare and reading the two nameservers
  Cloudflare assigns is done in the Cloudflare dashboard (or via the Cloudflare API).
- The nameserver change itself happens in the CrazyDomains registrar panel, where the domain is
  registered.
- The one-time `cloudflared tunnel login` authorization: on a headless node it prints a URL you must
  open in a browser on your control station to authorize a zone.
- Cloudflare Access application and policy creation: the documented path is the Cloudflare Zero
  Trust dashboard. An API and Terraform provider exist, but the dashboard flow is primary.

Everything else -- installing and configuring `cloudflared`, Tailscale, and Caddy, and managing DNS
records once the zone is live -- is done entirely from the shell.

## Move DNS to Cloudflare

Cloudflare Tunnel requires your domain's DNS to be hosted at Cloudflare. Registration stays at
CrazyDomains; only the DNS moves. The free plan is sufficient: full authoritative DNS, tunnels,
DNS-01 certificates, and Access all work on Free.

The onboarding flow (the "Full setup", the only option on Free and Pro) is mostly dashboard-driven
and one-time:

1. Add the domain to Cloudflare. Cloudflare scans for existing DNS records and assigns two
   authoritative nameservers specific to your domain. Per Cloudflare's docs these assignments cannot
   be changed, so you read the assigned names off the zone Overview page; you cannot pick your own.
2. Review the scanned records. Confirm the apex, `www`, and any mail records came across. A
   "proxied" record routes through Cloudflare; a "DNS-only" record does not.
3. Change the nameservers at CrazyDomains. Log into the CrazyDomains admin panel, disable DNSSEC if
   it is active, and replace the existing nameservers with Cloudflare's two assigned ones.
4. Wait for Cloudflare to verify. This can take up to 24 hours while the registrar update
   propagates. The zone status flips to "Active" and Cloudflare emails confirmation. Public DNS
   checkers may show cached results for a while.

Once the zone is Active, you manage records from the shell. Create an API token in the Cloudflare
dashboard (My Profile, then API Tokens) scoped to `Zone:DNS:Edit` (to edit records) plus
`Zone:Zone:Read` (to read the zone). Use Cloudflare's documented REST API as the baseline shell
path. Put the token in a root-only file, read it into the environment, then resolve the zone ID and
list records:

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

Create non-tunnel records with the same API. For example, this creates a DNS-only CNAME; change
`proxied` to `true` only when you want Cloudflare's edge proxy in front of that hostname:

```bash
curl -fsS "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records" \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  --data '{"type":"CNAME","name":"www.example.com","content":"example.com","ttl":1,"proxied":false}'
```

For the tunnel's own DNS records, prefer `cloudflared tunnel route dns` (next section): it creates
the CNAME and wires it to the tunnel in one step, so you do not hand-edit those records at all.
`flarectl` still exists as a CLI wrapper in Cloudflare's Go SDK repo, but its subcommands are
version-dependent and it is not the most stable baseline for this guide. If you choose to use it,
confirm the installed binary with `flarectl dns --help` before scripting create/update calls.

## Cloudflared in an unprivileged LXC

`cloudflared` makes only outbound connections to Cloudflare's edge, so the container needs no
inbound ports and no special device access for a basic web tunnel. Run it in a small
[unprivileged container](GLOSSARY.md) on Debian 13. Creating that LXC is taught in guide
[05 -- Containers with LXC and pct](05-containers-with-lxc-and-pct.md); everything below runs inside
that container.

A note that runs through this whole guide: whenever you create or edit a file, use the accessible,
non-interactive shell form (a here-doc, `tee`, or a drop-in `.d/` file), never a terminal editor
like vim or nano. The full menu, including VS Code Remote-SSH, is in the "Editing files accessibly"
section of guide [02 -- The shell and the API](02-the-shell-and-the-api.md). The `cloudflared` and
Caddy config files below are ordinary files inside their LXCs, so here-doc and `tee` are exactly
right; only `/etc/pve/...` files (the LXC `.conf` later in this guide) are
[pmxcfs (/etc/pve)](GLOSSARY.md) and are written through their documented LXC mechanism instead.

### Install cloudflared

Add Cloudflare's apt repository and signing key, then install the `cloudflared` package. The key
goes to `/usr/share/keyrings/cloudflare-main.gpg` and the repository line to
`/etc/apt/sources.list.d/cloudflared.list`:

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null

echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list

sudo apt-get update && sudo apt-get install cloudflared
```

Cloudflare also publishes a `next.pkg.cloudflare.com` channel for pre-release builds; use the stable
`pkg.cloudflare.com` line above unless you specifically want pre-release.

### Create a locally-managed tunnel

A locally-managed tunnel keeps its credentials JSON and its ingress `config.yml` as files on the
node, so the whole tunnel definition lives where you can read and edit it over SSH. That is the
right model for this reader. Work through these steps in order.

Step 1 -- authenticate the machine, one time. This needs a browser to authorize a zone. On a
headless node it prints a URL; open that URL on your control station to authorize, and `cloudflared`
writes a certificate to `~/.cloudflared/cert.pem` (under `sudo`/root that is
`/root/.cloudflared/cert.pem`):

```bash
cloudflared tunnel login
```

Step 2 -- create the named tunnel. This writes a credentials file named after the tunnel's UUID, by
default in the cloudflared directory (`~/.cloudflared/<UUID>.json`; under root,
`/root/.cloudflared/<UUID>.json`):

```bash
cloudflared tunnel create homelab
```

Step 3 -- write the ingress config at `/etc/cloudflared/config.yml`. This is the path that
`cloudflared service install` reads when run as root. Map each public hostname to a local origin
URL, and end with the REQUIRED catch-all `- service: http_status:404`. Write it accessibly with a
here-doc. File `/etc/cloudflared/config.yml`:

```bash
sudo tee /etc/cloudflared/config.yml >/dev/null <<'EOF'
tunnel: <Tunnel-UUID>
credentials-file: /root/.cloudflared/<Tunnel-UUID>.json

ingress:
  - hostname: www.example.com
    service: http://10.0.0.20:8080
  - hostname: app.example.com
    service: http://10.0.0.20:443
  - service: http_status:404
EOF
```

A few things about that file:

- `tunnel:` is the UUID (or the name) from step 2, and `credentials-file:` points at the JSON that
  `tunnel create` wrote.
- The `ingress:` list is evaluated top to bottom and the FIRST matching rule wins, so order your
  hostnames before the catch-all.
- The final rule MUST be a catch-all with no `hostname:`; the docs use `service: http_status:404`.
  This is not optional: omit the catch-all and `cloudflared` rejects the whole config.
- Each `service:` target is the local origin reachable from the LXC -- for this architecture,
  typically the Caddy reverse-proxy LXC, or a service directly.

Step 4 -- create the public DNS CNAME for each hostname. This adds a proxied CNAME in your
Cloudflare zone pointing the hostname at the tunnel, so you do not edit DNS by hand:

```bash
cloudflared tunnel route dns homelab www.example.com
cloudflared tunnel route dns homelab app.example.com
```

Step 5 -- validate the ingress rules before going live:

```bash
cloudflared tunnel ingress validate
```

Step 6 -- install as a systemd service, run as root so it reads `/etc/cloudflared/config.yml`, then
start and check it:

```bash
sudo cloudflared service install
sudo systemctl start cloudflared
sudo systemctl status cloudflared
```

After any change to `config.yml`, restart the service so it re-reads the file:

```bash
sudo systemctl restart cloudflared
```

One note on the service identity: `cloudflared service install` runs the daemon as root by default,
which is simplest and is what reads `/etc/cloudflared/config.yml`. A purely outbound tunnel needs no
root at runtime, so a stricter alternative is to run it under a dedicated non-root service user; for
this single-node setup the root default is acceptable, and it is what the rest of this guide
assumes.

(For a foreground test before installing the service you can run `cloudflared tunnel run homelab`,
optionally with `--config /path/config.yml`.)

### Token-based tunnels (the alternative)

If you instead create the tunnel in the Cloudflare Zero Trust dashboard, it is "remotely-managed":
its ingress config lives in the dashboard, and the host only needs the tunnel token, supplied as an
argument:

```bash
sudo cloudflared service install <TOKEN>
```

For this reader, prefer the locally-managed tunnel above. Its definition lives in files on the node,
under your control and editable over SSH, whereas a token-based tunnel keeps its ingress in the
dashboard (less accessible) and makes token rotation an ongoing operational task.

### Verify it worked

- `sudo systemctl status cloudflared` reports the service active (running).
- `cloudflared tunnel ingress validate` passes with no errors.
- The public hostname resolves to the tunnel: requesting `www.example.com` reaches your origin, and
  Cloudflare shows the CNAME pointing at the tunnel.

## Cloudflare Access (gate a private hostname)

[Cloudflare Access](GLOSSARY.md) puts a login gate in front of a hostname that is published through
your tunnel. A self-hosted application in Access is deny-by-default: a request must match an Allow
policy before it ever reaches your origin. This is how you keep a private service reachable from
anywhere over the tunnel without running an auth layer at the origin yourself. Crown jewels do not
belong here -- they stay on Tailscale -- but a private service you are content to tunnel does.

A minimal "allow my email" policy:

- Action: Allow.
- Include rule: Emails, set to your address (or "Emails ending in" your domain).
- Identity provider: at minimum Cloudflare's built-in one-time PIN, which emails you a code, so no
  external identity provider is required.

The critical ordering gotcha, straight from Cloudflare's docs: create the Access application BEFORE
you route the hostname through the tunnel. If you route the hostname first, then for the window
before the Access app exists the published application is open to the entire internet. Create the
app, then route. Also enable token validation at the origin so requests that try to bypass Access
are rejected.

Be plain with yourself about this step: it is dashboard/API-bound, the least shell-native part of
the whole stack.

## Tailscale for SSH and crown jewels

[Tailscale](GLOSSARY.md) builds a [WireGuard](GLOSSARY.md) mesh -- your [tailnet](GLOSSARY.md) --
and gives you accessible admin access plus private service exposure with no inbound ports.

### Install and join the tailnet

The documented install is Tailscale's official script. It adds the Tailscale apt repository and
signing key and installs the `tailscale` package, which brings up the `tailscaled` daemon as a
systemd service:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

Piping a script straight into a shell is the method Tailscale documents, and it is shown here for
that reason; if you would rather not, Tailscale publishes per-distro apt key and `sources.list`
instructions on its download page (the Debian "trixie" channel) so you can add the repository by
hand and `apt install tailscale`. Either way the package is `tailscale` and the daemon is
`tailscaled`.

Bring the node onto the tailnet with the flags that matter here:

```bash
sudo tailscale up --ssh --hostname=pve-node --accept-routes
```

What each relevant flag does:

- `--ssh` runs the Tailscale SSH server, so SSH access is authorized by your tailnet ACL policy
  rather than by exposing port 22 to the internet. This is your accessible admin door.
- `--hostname=<name>` sets the device's name in the tailnet (and its [MagicDNS](GLOSSARY.md) name).
- `--accept-routes` accepts subnet routes other nodes advertise (relevant if another device
  advertises your LAN).
- `--advertise-routes=<cidr>` advertises a subnet (for example `--advertise-routes=192.168.1.0/24`)
  so tailnet peers can reach LAN hosts through this node. Advertised subnet routes must be approved
  in the Tailscale admin console before they take effect; advertising alone does not enable them.
- `--advertise-tags=tag:server` tags the device. Tags are defined in the tailnet ACL policy and are
  how you scope SSH and ACL rules; a tagged node is owned by the tailnet rather than by a user.

### Tailscale SSH

[Tailscale SSH](GLOSSARY.md) runs alongside the host's own `sshd`; it does not replace or disable
it. Access is governed by your tailnet's SSH ACL rules, not by the host's `authorized_keys`, and
Tailscale checks the destination's SSH host key through its coordination server. The practical win
is that you can stop exposing OpenSSH to the public internet entirely and reach the host over the
tailnet instead.

Safety callout, and treat this as non-negotiable on a headless node: SSH is your only way in, and
there is no local console to recover from. Keep your existing SSH session open, and confirm
Tailscale SSH works from a brand-new session before you rely on it or tighten the firewall to drop
public port 22. Open a fresh connection with `tailscale ssh user@pve-node` from another tailnet
device and confirm it lands; only once a new session connects cleanly should you close the old one
or remove the public SSH path. Never test only over an already-established session.

### Expose services: serve (private) vs funnel (public)

[tailscale serve / funnel](GLOSSARY.md) are two commands that expose a local service over HTTPS, and
the difference is the whole point.

`tailscale serve` publishes a local service over HTTPS to your tailnet ONLY -- it stays private
inside your Tailscale network. This is the right tool for crown-jewel services like Vaultwarden that
must not transit Cloudflare:

```bash
tailscale serve localhost:3000

tailscale serve --bg localhost:3000

tailscale serve --https=443 --set-path=/foo localhost:3000

tailscale serve status
tailscale serve reset
```

Use `--bg` to run it in the background so the proxy persists across reboot and `tailscaled`
restarts. `tailscale funnel` is the opposite -- it publishes a served service to the entire public
internet -- and for this architecture it is generally NOT used, because public traffic goes through
the Cloudflare tunnel and the crown jewels stay private on `serve`. Its syntax mirrors serve
(`tailscale funnel <target>`, `tailscale funnel status`, `tailscale funnel reset`). Do not point
funnel at a crown-jewel service.

With MagicDNS enabled, each node gets a stable name like `pve-node.<tailnet>.ts.net`, and
`tailscale serve` provisions a TLS certificate for that name automatically. If you ever need the
certificate as files (to hand to another service), `tailscale cert` writes them; those
Let's-Encrypt-issued certs expire every 90 days and need renewal when used as files, so prefer
letting `serve` manage the cert where you can:

```bash
tailscale cert pve-node.<tailnet>.ts.net

tailscale cert --cert-file=cert.pem --key-file=key.pem pve-node.<tailnet>.ts.net
```

### Running Tailscale inside an unprivileged LXC

Running Tailscale on the Proxmox host is simplest, because it needs no device plumbing and avoids
the issue below entirely. If you run it inside an unprivileged LXC instead, the container needs
access to the `/dev/net/tun` device, which unprivileged containers do not provide by default. Add
two lines to the container's config. This file is on pmxcfs, so it is the one place in this guide
where you do NOT use a here-doc on the file directly; it is written through the documented LXC
config mechanism and the container is then restarted.

The two lines to add (Proxmox VE 7 and later uses `cgroup2`). File `/etc/pve/lxc/<CTID>.conf`:

```text
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
```

Shut the container down and start it again for the change to take effect. Documented alternatives:
pass the device through with `pct set <CTID> --dev0 /dev/net/tun`, or run Tailscale in
userspace-networking mode, which needs no `/dev/net/tun` at all (userspace mode creates no TUN
interface, so subnet routing and some features are limited). Again, running Tailscale on the host
sidesteps all of this.

### Verify it worked

- `tailscale status` lists this node as online and shows its tailnet name.
- From another tailnet device, `tailscale ssh user@pve-node` connects and lands you on the host.

## Caddy reverse proxy with DNS-01 certs

[Caddy](GLOSSARY.md) is the TLS front for internal and tailnet web services. Using the
[DNS-01 (ACME DNS challenge)](GLOSSARY.md) means Caddy proves domain control by writing a TXT record
through the Cloudflare API, so it never needs inbound port 80 or 443 to obtain or renew
certificates. Run Caddy in its own LXC.

### Install Caddy

Add Caddy's official apt repository (hosted on Cloudsmith) and install the `caddy` package, which
starts and runs Caddy as a systemd service named `caddy` with its config at `/etc/caddy/Caddyfile`:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

### Add the Cloudflare DNS module

The stock Caddy binary has NO DNS provider plugins, so DNS-01 with Cloudflare will not work until
you add the `caddy-dns/cloudflare` module. Add it to the installed binary, then restart:

```bash
sudo caddy add-package github.com/caddy-dns/cloudflare
sudo systemctl restart caddy
```

`caddy add-package` replaces the current Caddy binary with a new one that has the same modules plus
the package you named, so the `systemctl restart caddy` afterward is mandatory -- without it the
running process is still the old binary and the new module is not loaded. Confirm the module is
present:

```bash
caddy list-modules --packages | grep cloudflare
```

(Seeing the `cloudflare` line in that output is the confirmation. `caddy build-info` shows the full
build if you want it.)

### Caddyfile with DNS-01

Tell Caddy to use the Cloudflare DNS challenge in the `tls` block, reading the API token from the
environment. Write it accessibly with a here-doc. File `/etc/caddy/Caddyfile`, per-site form:

```bash
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
internal.example.com {
	reverse_proxy 10.0.0.30:8080
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
}
EOF
```

The wildcard form issues one certificate for all subdomains, which is only possible with DNS-01
(another reason DNS-01 is used here). File `/etc/caddy/Caddyfile`:

```text
*.example.com {
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
	reverse_proxy 10.0.0.30:8080
}
```

The Cloudflare API token for this module needs `Zone:DNS:Edit` (to write the challenge TXT records)
plus `Zone:Zone:Read` (to discover the zone), scoped to the specific zone.

### Pass the token via a systemd env file

Caddy reads `{env.CF_API_TOKEN}` from the process environment, so supply it to the systemd service
through a root-only environment file rather than putting it in the Caddyfile or your shell history.
Create the secret file accessibly with `install` (to set mode 0600 atomically) and `tee`. File
`/etc/caddy/caddy.env`:

```bash
sudo install -m 600 /dev/null /etc/caddy/caddy.env
printf 'CF_API_TOKEN=%s\n' '<token-with-Zone:DNS:Edit-and-Zone:Read>' | sudo tee /etc/caddy/caddy.env >/dev/null
```

Then point Caddy's unit at that file with a systemd drop-in override. File
`/etc/systemd/system/caddy.service.d/override.conf`:

```bash
sudo install -d /etc/systemd/system/caddy.service.d
sudo tee /etc/systemd/system/caddy.service.d/override.conf >/dev/null <<'EOF'
[Service]
EnvironmentFile=/etc/caddy/caddy.env
EOF
```

Reload systemd, validate the config, and restart:

```bash
sudo systemctl daemon-reload
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl restart caddy
```

One consistency point: both `CF_API_TOKEN` and `CLOUDFLARE_API_TOKEN` appear in module examples.
Pick one name and use it in both the Caddyfile and the env file; this guide uses `CF_API_TOKEN`
throughout. As with every file edit here, if you would rather not use a here-doc, the "Editing files
accessibly" section of guide [02 -- The shell and the API](02-the-shell-and-the-api.md) lists the
alternatives.

Why DNS-01 here, in one breath: it needs no inbound port 80 or 443, it supports wildcard
certificates, and it works both behind the tunnel and purely on the tailnet, because the challenge
is answered over the Cloudflare API rather than on an inbound web port.

### Verify it worked

- `sudo caddy validate --config /etc/caddy/Caddyfile` reports the config valid.
- `sudo systemctl status caddy` reports the service active (running).
- The internal hostname serves HTTPS with a trusted certificate (no certificate warning), confirming
  Caddy obtained the cert via DNS-01.

## Which service goes where

A short decision guide for routing each service:

- Public web and your personal website: through the `cloudflared` tunnel. The tunnel's ingress
  `service:` can point at the Caddy LXC (or directly at a service), and the public CNAMEs are
  created with `cloudflared tunnel route dns`.
- Private-but-still-tunneled services: the same tunnel, with a Cloudflare Access self-hosted
  application in front of the hostname so only your login gets through. Create the Access app before
  routing the hostname.
- Crown jewels (Vaultwarden and similarly sensitive services): Tailscale ONLY, exposed with
  `tailscale serve` so the traffic stays inside the WireGuard tailnet and never has its TLS
  terminated at Cloudflare's edge. Keep these off the tunnel entirely.
- Admin and SSH access to the host: Tailscale SSH, so you do not expose OpenSSH to the public
  internet.
- Caddy: the TLS front for internal and tailnet web services, issuing certs via DNS-01 so it needs
  no inbound 80/443. It can also be the local origin behind `cloudflared`.

One rule ties it together: choose ONE TLS front per service rather than stacking both. For a
tailnet-only service, let `tailscale serve` provide the `*.ts.net` HTTPS; for your own internal
hostnames, let Caddy do it. Do not put both in front of the same service.

## Sources

- `research/round2-pve9/23-remote-access-cloudflare-tailscale-caddy.md` -- the authoritative source
  for this entire guide: the hybrid architecture and the no-port-forwarding premise; the Cloudflare
  DNS "Full setup" onboarding flow, the two assigned-and-unchangeable nameservers, the CrazyDomains
  nameserver change, the up-to-24-hour wait, and the post-onboarding REST API shell workflow with
  the `Zone:DNS:Edit` plus `Zone:Zone:Read` token scope; the `cloudflared` apt repo and key block,
  the locally-managed tunnel workflow (`tunnel login`, `tunnel create`, the
  `/etc/cloudflared/config.yml` ingress with its required `http_status:404` catch-all and
  first-match-wins ordering, `tunnel route dns`, `ingress validate`, `service install`,
  start/status/restart), the token-based alternative, and the outbound-only LXC angle; the
  Cloudflare Access deny-by-default self-hosted application, the minimal one-time-PIN Allow policy,
  and the create-before-route ordering gotcha; the Tailscale install script,
  `tailscale up --ssh --hostname --accept-routes` and the `--advertise-routes`/`--advertise-tags`
  flags, Tailscale SSH alongside `sshd`, `tailscale serve` (with `--bg`) versus `tailscale funnel`,
  MagicDNS and `tailscale cert`, and the `/dev/net/tun` requirement for an unprivileged LXC (the
  `cgroup2`/`mount.entry` lines, `pct set --dev0`, userspace mode); and the Caddy Cloudsmith apt
  repo, the `caddy add-package github.com/caddy-dns/cloudflare` module with the mandatory restart,
  the Caddyfile `tls { dns cloudflare {env.CF_API_TOKEN} }` per-site and wildcard forms, and the
  root-only env file plus systemd drop-in for the token.
- `docs/adr/0003-remote-access-cloudflare-tunnel-plus-tailscale.md` -- the fixed architecture and
  the reasoning behind it: Cloudflare Tunnel for public web, Tailscale for SSH/admin and the crown
  jewels, and crucially that the crown-jewel services stay OFF the tunnel because Cloudflare
  terminates TLS at its edge and would otherwise sit in the data path with decrypted traffic.
- `GLOSSARY.md` -- the canonical definitions reused here of [Cloudflare Tunnel](GLOSSARY.md),
  [cloudflared](GLOSSARY.md), [Cloudflare Access](GLOSSARY.md), [Tailscale](GLOSSARY.md),
  [tailnet](GLOSSARY.md), [Tailscale SSH](GLOSSARY.md), [tailscale serve / funnel](GLOSSARY.md),
  [MagicDNS](GLOSSARY.md), [Caddy](GLOSSARY.md), [reverse proxy](GLOSSARY.md),
  [DNS-01 (ACME DNS challenge)](GLOSSARY.md), [ingress rule](GLOSSARY.md), and
  [WireGuard](GLOSSARY.md), plus the role names (the Proxmox host, the control station, the guest,
  and the unprivileged container).
- Cloudflare DNS / onboarding:
  [Full setup](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/),
  [zone setups overview](https://developers.cloudflare.com/dns/zone-setups/),
  [assigned nameservers cannot be changed](https://developers.cloudflare.com/dns/nameservers/nameserver-options/),
  [create an API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/),
  [list zones](https://developers.cloudflare.com/api/resources/zones/methods/list/),
  [list DNS records](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/),
  [create DNS records](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/),
  and
  [`flarectl` in the cloudflare-go repo](https://github.com/cloudflare/cloudflare-go/tree/master/cmd/flarectl).
- cloudflared / Cloudflare Tunnel: [the apt package index](https://pkg.cloudflare.com/),
  [downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/),
  [create a locally-managed tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/),
  [run as a Linux systemd service](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/as-a-service/linux/),
  [the ingress configuration file reference](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/configuration-file/),
  and
  [token-based / remote tunnel permissions](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/remote-tunnel-permissions/).
- Cloudflare Access:
  [self-hosted public application (deny-by-default, create-before-route)](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/),
  [Access policies](https://developers.cloudflare.com/cloudflare-one/policies/access/), and
  [the Access API and Terraform](https://developers.cloudflare.com/cloudflare-one/api-terraform/).
- Tailscale: [install on Linux](https://tailscale.com/download/linux) and
  [the Linux install KB](https://tailscale.com/kb/1031/install-linux),
  [the `tailscale up` / CLI reference](https://tailscale.com/kb/1080/cli),
  [Tailscale SSH](https://tailscale.com/kb/1193/tailscale-ssh),
  [`tailscale serve`](https://tailscale.com/kb/1242/tailscale-serve),
  [`tailscale funnel`](https://tailscale.com/kb/1223/funnel),
  [enabling HTTPS and `tailscale cert`](https://tailscale.com/kb/1153/enabling-https), and
  [Tailscale in an unprivileged LXC](https://tailscale.com/kb/1130/lxc-unprivileged).
- Caddy: [install on Debian/Ubuntu](https://caddyserver.com/docs/install),
  [the command line (`add-package`, `list-modules`, `validate`)](https://caddyserver.com/docs/command-line),
  [building with plugins / xcaddy](https://caddyserver.com/docs/build),
  [the `tls` directive with the DNS challenge](https://caddyserver.com/docs/caddyfile/directives/tls),
  [automatic HTTPS background](https://caddyserver.com/docs/automatic-https), and
  [the `caddy-dns/cloudflare` module](https://github.com/caddy-dns/cloudflare).

---

Previous: [11 -- Firewall](11-firewall.md) | Next:
[13 -- Users, permissions, and API tokens](13-users-permissions-and-api-tokens.md)
