# Recipe: a DNS sinkhole (Pi-hole or AdGuard Home)

## What you'll be able to do

You will run one LAN-wide ad and tracker blocking resolver in a single
[unprivileged container](../GLOSSARY.md): every device on your network points its DNS at this box,
and known ad, tracker, and malware domains are answered with a dead address instead of the real one.
You can optionally have the sinkhole recurse from the internet's root servers itself (via Unbound)
instead of trusting a third-party upstream resolver. You pick exactly one of two engines, Pi-hole or
AdGuard Home; both are first-class here.

## Before you start

This recipe reuses foundations rather than re-teaching them. You need:

- An [unprivileged container](../GLOSSARY.md) to run the sinkhole in. Creating one is taught in
  guide [05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md); this recipe shows
  only the one `pct create` line and points you there for the rest.
- A static IP for that container. A DNS sinkhole only works as your LAN resolver if it always
  answers at the same address, so it must not use DHCP for its own address. Giving a guest a static
  address is taught in guide [10 -- Networking](../10-networking.md).

Two design choices are yours, and both options of each are fully supported here. First, the engine:
Pi-hole or AdGuard Home. Second, the install path: the Helper-Scripts one-liner (pattern B) or a
hand-built native install (pattern A). Neither engine is "the alternative" and neither path is
second-class. Pick one engine; running both for the same role is redundant.

## Pick the pattern and size it

Both patterns produce the same thing: one lightweight unprivileged container with the engine
installed natively (apt plus systemd, no Docker).

- Pattern A, hand-built: you run `pct create` yourself and install the engine by hand. You see and
  understand every step.
- Pattern B, Helper-Scripts: the community `ct/<name>.sh` one-liner builds the unprivileged
  container and installs the engine for you in about a minute. It is untrusted root code that you
  read, snapshot, and pin first; see the cross-reference under each engine below.

Sizing is small either way: about 1 vCPU, 256 to 512 MB of RAM, and 2 to 4 GB of disk are plenty for
a DNS sinkhole.

Accessibility note: once the container exists you manage it with `pct enter <vmid>`, which drops you
straight into a root shell inside it with no console or networking setup. Every command below runs
either on the Proxmox host (the `pct` lines) or inside the container after `pct enter` (the install,
config, and service lines).

The static IP matters here more than for most services: this container becomes the resolver every
device on your LAN points at, so it must keep one fixed address. Set the static address when you
create the container (the `ip=.../gw=...` form), per guide [10 -- Networking](../10-networking.md).
Throughout this recipe, substitute the container's own static address wherever you see
`<sinkhole-ip>`.

## Choose your engine

Both engines block ads and trackers network-wide by answering blocklisted domains with a sink
address, and both are fully manageable from the shell so the web dashboard is optional, not
required. They differ in shape:

- AdGuard Home is a single Go binary with one YAML config file (`AdGuardHome.yaml`) and a REST API,
  plus a service control verb on the binary itself. That makes it the more shell-friendly of the
  two: one file to read, one binary to drive. The research names it the more shell-friendly option.
- Pi-hole is the older, very widely deployed engine. It installs several components (its FTL
  resolver, the gravity blocklist database, an optional web interface) and is driven by a mature,
  well-documented `pihole` command-line tool.

Pick one. Both are good; the difference is mostly taste and how much you value a single-file config
versus a long-established CLI. Do not run both for the same role on the same LAN; it is redundant
and only complicates which box your devices trust.

The two engines are written up below as peers. Read only the one you chose.

## AdGuard Home

### Path 1 -- Helper-Scripts

On the Proxmox host root shell, the community `ct/adguard.sh` script builds an unprivileged
container and installs AdGuard Home natively:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/adguard.sh)"
```

The `wget` form is equivalent:

```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/adguard.sh)"
```

That one-liner pipes code fetched from the internet straight into a root shell on the host. Treat it
as untrusted root code: read it first, snapshot the host, and pin a reviewed commit instead of
`main`, exactly as guide [16 -- Automation and the ecosystem](../16-automation-and-the-ecosystem.md)
teaches. The pinned-commit form substitutes a specific commit hash for `main` in the URL so the code
cannot change between your audit and your run:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/<COMMIT_SHA>/ct/adguard.sh)"
```

When it finishes, give the new container a static IP (guide 10) if you did not in the script's
Advanced mode, and continue at "Recurse it yourself with Unbound" or "Point your LAN at it" below.

### Path 2 -- hand-built

On the Proxmox host, create the unprivileged container with a static address. The line below is the
shape of it; guide [05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md)
explains every option, the OS template, and confirming the template name with `pveam`. Substitute
your own VMID, bridge, address, gateway, and key path:

```bash
pct create 121 local-btrfs:vztmpl/debian-13-standard_13.x-1_amd64.tar.zst \
  --hostname adguard \
  --unprivileged 1 \
  --cores 1 --memory 512 --swap 256 \
  --rootfs local-btrfs:4 \
  --net0 name=eth0,bridge=vmbr0,ip=192.168.1.121/24,gw=192.168.1.1 \
  --onboot 1 \
  --ssh-public-keys /root/adguard.pub
```

Start it and enter it:

```bash
pct start 121
pct enter 121
```

You are now in a root shell inside the container. Before AdGuard Home binds port 53, make sure
nothing else already holds it. On Debian, `systemd-resolved` (when present) keeps a stub resolver
listening on `127.0.0.53:53`, which can collide with the engine and cause a silent bind failure that
is hard to diagnose without a GUI. Check what owns the port with an accessible command:

```bash
ss -ulpn 'sport = :53'
ss -tlpn 'sport = :53'
```

If the output names `systemd-resolved`, disable its stub listener and re-point resolution. State the
path, then write the drop-in with a here-doc. File `/etc/systemd/resolved.conf.d/no-stub.conf`:

```bash
mkdir -p /etc/systemd/resolved.conf.d
tee /etc/systemd/resolved.conf.d/no-stub.conf >/dev/null <<'EOF'
[Resolve]
DNSStubListener=no
EOF
systemctl restart systemd-resolved
```

Then point `/etc/resolv.conf` at a real upstream so the container can still resolve names while you
finish setup (AdGuard Home will manage resolution itself once it binds 53). On a `systemd-resolved`
system `/etc/resolv.conf` is usually a symlink into `/run/systemd/resolve/`; writing through it with
`tee` would land in the managed stub file and be reverted, so replace the symlink with a real file.
File `/etc/resolv.conf`:

```bash
rm -f /etc/resolv.conf
tee /etc/resolv.conf >/dev/null <<'EOF'
nameserver 1.1.1.1
EOF
```

If the `ss` output shows nothing on port 53, you are clear and can skip this step. The minimal
`debian-13-standard` LXC template often does not run `systemd-resolved` at all, so this may be a
no-op, but checking first is the safe move.

Install AdGuard Home with its official install script, which downloads the right binary, installs it
under `/opt/AdGuardHome`, and registers it as a service:

```bash
curl -s -S -L https://raw.githubusercontent.com/AdguardTeam/AdGuardHome/master/scripts/install.sh | sh -s -- -v
```

This script is also fetched-from-the-internet code piped into a root shell, here inside the
container rather than on the host. The same caution applies in lighter form (the container is
disposable, but still read it first if you want to be careful); the official project publishes this
as the supported install path.

After it installs, AdGuard Home starts a first-run setup listener on port `3000`. Because you work
from the shell, complete the one-time setup over the API instead of a browser: it accepts a
`POST /control/install/configure` with the web and DNS bind settings and the admin username and
password. The admin password is a secret, so do not place it inline on a long command where it lands
in shell history or is visible to `ps`. Put the JSON body in a chmod-600 file and post that file,
then delete it. For example:

```bash
umask 077
cat > /root/aghsetup.json <<'EOF'
{"web":{"ip":"0.0.0.0","port":80},"dns":{"ip":"0.0.0.0","port":53},"username":"admin","password":"REPLACE_WITH_A_STRONG_PASSWORD"}
EOF
curl -s -X POST --data @/root/aghsetup.json http://127.0.0.1:3000/control/install/configure
rm -f /root/aghsetup.json
```

Edit `/root/aghsetup.json` to set a real password before running the `curl` (use the accessible
editing methods in guide [02 -- The shell and the API](../02-the-shell-and-the-api.md)); the
`umask 077` and the `rm` keep the secret off disk and out of history. After setup, AdGuard Home
serves its DNS on port 53 and its admin UI/REST API on the web port you set.

Required containment: the admin UI and REST API bind to `0.0.0.0`, so they answer on the LAN, not
just localhost. The DNS service on port 53 must stay open to every LAN client (that is the whole
point of the resolver), but the admin/REST plane should not be. On the host, create a guest firewall
file for this container that allows DNS from the LAN and the admin port only from the management
address. File `/etc/pve/firewall/121.fw`:

```ini
[OPTIONS]
enable: 1
policy_in: DROP
policy_out: ACCEPT
ipfilter: 1

[RULES]
IN ACCEPT -p udp -dport 53
IN ACCEPT -p tcp -dport 53
IN ACCEPT -p tcp -dport 80 -source 192.168.1.10
IN SSH(ACCEPT) -source 192.168.1.10
```

Then make sure the container's `net0` line has `firewall=1` as guide
[11 -- Firewall](../11-firewall.md) explains. Substitute your real management address if it is not
`192.168.1.10`.

Confirm the service is running now and set to start at boot:

```bash
/opt/AdGuardHome/AdGuardHome -s status   # is it running right now?
systemctl is-enabled AdGuardHome         # will it start on boot? (expect: enabled)
```

From here, AdGuard Home's whole configuration lives in one YAML file,
`/opt/AdGuardHome/AdGuardHome.yaml`, and it also exposes a REST API at `/control/...` for scripted
changes. Edit the YAML only while the service is stopped, or it will overwrite your changes on exit.

## Pi-hole

### Path 1 -- Helper-Scripts

On the Proxmox host root shell, the community `ct/pihole.sh` script builds an unprivileged container
and installs Pi-hole natively:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/pihole.sh)"
```

The `wget` form is equivalent:

```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/pihole.sh)"
```

As with the AdGuard script, this is untrusted root code piped into the host's root shell: read it
first, snapshot the host, and pin a reviewed commit instead of `main`, exactly as guide
[16 -- Automation and the ecosystem](../16-automation-and-the-ecosystem.md) teaches. The
pinned-commit form:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/<COMMIT_SHA>/ct/pihole.sh)"
```

When it finishes, give the new container a static IP (guide 10) if you did not set one during the
script, and continue below.

### Path 2 -- hand-built

On the Proxmox host, create the unprivileged container with a static address, the same shape as
above (guide [05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md) for the full
explanation):

```bash
pct create 122 local-btrfs:vztmpl/debian-13-standard_13.x-1_amd64.tar.zst \
  --hostname pihole \
  --unprivileged 1 \
  --cores 1 --memory 512 --swap 256 \
  --rootfs local-btrfs:4 \
  --net0 name=eth0,bridge=vmbr0,ip=192.168.1.122/24,gw=192.168.1.1 \
  --onboot 1 \
  --ssh-public-keys /root/pihole.pub
```

Start it and enter it:

```bash
pct start 122
pct enter 122
```

You are now in a root shell inside the container. Before Pi-hole's FTL resolver binds port 53, check
that the port is free, exactly as in the AdGuard Home hand-built path above. Run the same accessible
check:

```bash
ss -ulpn 'sport = :53'
ss -tlpn 'sport = :53'
```

If the output names `systemd-resolved`, follow the same disable-the-stub-listener step from the
AdGuard Home Path 2 section above (the `/etc/systemd/resolved.conf.d/no-stub.conf` drop-in with
`DNSStubListener=no`, `systemctl restart systemd-resolved`, then re-point `/etc/resolv.conf`). As
noted there, the minimal `debian-13-standard` template often does not run `systemd-resolved`, so
this may be a no-op, but checking first avoids a silent bind failure.

Install Pi-hole with its official installer:

```bash
curl -sSL https://install.pi-hole.net | bash
```

The Pi-hole project itself notes that piping to `bash` prevents you from reading the code first, and
publishes clone-and-review alternatives for those who prefer to inspect it; the same read-first
instinct from guide 16 applies. The installer runs a short text-mode setup. When it asks for an
upstream DNS provider, you can pick a public resolver now and switch to a local Unbound later (next
section). The installer can set a web admin password; if it does not, or to change it later, set it
from the CLI with a prompt rather than on the command line so the secret stays out of shell history:

```bash
pihole setpassword
```

Run `pihole setpassword` with no argument and it prompts for the password instead of echoing it on
the command line.

Required containment: Pi-hole's web admin interface listens on the LAN, not just localhost. As with
AdGuard Home, keep DNS on port 53 open to every LAN client, but scope the admin port to your
management address. File `/etc/pve/firewall/122.fw`:

```ini
[OPTIONS]
enable: 1
policy_in: DROP
policy_out: ACCEPT
ipfilter: 1

[RULES]
IN ACCEPT -p udp -dport 53
IN ACCEPT -p tcp -dport 53
IN ACCEPT -p tcp -dport 80 -source 192.168.1.10
IN SSH(ACCEPT) -source 192.168.1.10
```

Then make sure the container's `net0` line has `firewall=1` as guide
[11 -- Firewall](../11-firewall.md) explains. Substitute your real management address if it is not
`192.168.1.10`.

## Recurse it yourself with Unbound (optional)

Your sinkhole has to send the queries it does not block somewhere to be resolved. You have two
honest choices, and Unbound is entirely skippable.

- Without Unbound: point the sinkhole's upstream at a public recursive resolver you trust, for
  example Cloudflare's `1.1.1.1` or Google's `8.8.8.8`. This is simplest, but that third party then
  sees every domain your network looks up.
- With Unbound: run your own recursive resolver alongside the sinkhole, so it resolves names by
  talking to the internet's authoritative root servers directly. No single upstream company sees all
  your lookups. The trade-off is a little more setup and slightly slower cold lookups (warmed by
  caching). You can run Unbound in the same container as the sinkhole.

If you skip Unbound, set the engine's sole upstream to your chosen public resolver (in AdGuard Home,
the upstream DNS field of the YAML or the setup; in Pi-hole, the upstream chosen during install or
via `pihole`) and you are done with this section.

To recurse yourself, install Unbound inside the sinkhole container and configure it to listen only
on localhost at port 5335, grounded in the official Pi-hole Unbound guide. Install it:

```bash
apt install -y unbound
```

The package pulls in the `dns-root-data` dependency, which provides the root hints automatically, so
you do not download a root.hints file by hand. Now write Unbound's drop-in config. State the path,
then write it with a here-doc rather than a terminal editor (guide
[02 -- The shell and the API](../02-the-shell-and-the-api.md) lists the accessible editing methods).
File `/etc/unbound/unbound.conf.d/pi-hole.conf`:

```bash
tee /etc/unbound/unbound.conf.d/pi-hole.conf >/dev/null <<'EOF'
server:
    # If no logfile is specified, syslog is used
    # logfile: "/var/log/unbound/unbound.log"
    verbosity: 0

    interface: 127.0.0.1
    port: 5335
    do-ip4: yes
    do-udp: yes
    do-tcp: yes

    # May be set to no if you don't have IPv6 connectivity
    do-ip6: yes

    # You want to leave this to no unless you have *native* IPv6. With 6to4 and
    # Terredo tunnels your web browser should favor IPv4 for the same reasons
    prefer-ip6: no

    # Use this only when you downloaded the list of primary root servers!
    # If you use the default dns-root-data package, unbound will find it automatically
    #root-hints: "/var/lib/unbound/root.hints"

    # Trust glue only if it is within the server's authority
    harden-glue: yes

    # Require DNSSEC data for trust-anchored zones, if such data is absent, the zone becomes BOGUS
    harden-dnssec-stripped: yes

    # Don't use Capitalization randomization as it known to cause DNSSEC issues sometimes
    # see https://discourse.pi-hole.net/t/unbound-stubby-or-dnscrypt-proxy/9378 for further details
    use-caps-for-id: no

    # Reduce EDNS reassembly buffer size.
    # Suggested by the DNS Flag Day 2020
    edns-buffer-size: 1232

    # Perform prefetching of close to expired message cache entries
    # This only applies to domains that have been frequently queried
    prefetch: yes

    # One thread should be sufficient, can be increased on beefy machines.
    num-threads: 1

    # Ensure kernel buffer is large enough to not lose messages in traffic spikes
    so-rcvbuf: 1m

    # Ensure privacy of local IP ranges
    private-address: 192.168.0.0/16
    private-address: 169.254.0.0/16
    private-address: 172.16.0.0/12
    private-address: 10.0.0.0/8
    private-address: fd00::/8
    private-address: fe80::/10

    # Ensure no reverse queries to non-public IP ranges (RFC6303 4.2)
    private-address: 192.0.2.0/24
    private-address: 198.51.100.0/24
    private-address: 203.0.113.0/24
    private-address: 255.255.255.255/32
    private-address: 2001:db8::/32
EOF
```

Restart Unbound to load the config:

```bash
systemctl restart unbound
```

Now point the sinkhole's sole upstream at this local resolver, `127.0.0.1#5335`, and disable every
other upstream so all unblocked queries go through Unbound:

- AdGuard Home: in `/opt/AdGuardHome/AdGuardHome.yaml`, set the `upstream_dns` list under `dns:` to
  the single entry `127.0.0.1:5335` (AdGuard uses the `host:port` form, not the `#` form), with no
  other upstream listed. You can also do this via the REST `POST /control/dns_config`. Edit the YAML
  only while the service is stopped, or it overwrites your changes on exit. Then also clear or check
  the `fallback_dns` list under `dns:`: the install defaults often leave public resolvers there, and
  a fallback fires when Unbound is unresponsive, so leaving them in lets your queries leak to the
  very third parties Unbound is meant to cut out. Remove those public entries. The `bootstrap_dns`
  list is different and fine to leave pointing at a well-known IP: bootstrap only resolves the
  addresses of named upstreams, and with a plain-IP upstream like `127.0.0.1` it is never used to
  send your queries anywhere, so it is not a leak.
- Pi-hole: set the custom upstream DNS server to `127.0.0.1#5335` and ensure all other upstream
  servers are disabled.

The privacy trade-off, stated plainly: with Unbound, your network recurses from the root servers
itself and no single third party sees all your lookups; without it, you hand every unblocked query
to one public resolver like `1.1.1.1` or `8.8.8.8` and trust them with that visibility. Either is a
legitimate choice, and Unbound can be skipped entirely.

## Manage it from the shell

Neither engine needs its dashboard for day-to-day work; both are fully driveable from the shell
after `pct enter <vmid>`.

- AdGuard Home: its whole configuration is the YAML file `/opt/AdGuardHome/AdGuardHome.yaml` (edit
  it with the service stopped), and the REST API under `/control/...` plus the
  `/opt/AdGuardHome/AdGuardHome -s status|start|stop|restart` service verbs cover the rest. Read its
  logs from the journal with `journalctl -u AdGuardHome`.
- Pi-hole: the `pihole` command does it all. `pihole -g` rebuilds the gravity blocklist database
  from your subscribed lists; `pihole -up` updates Pi-hole's own components; `pihole setpassword`
  sets the admin password with a prompt; `pihole status` shows whether blocking is active; and
  `pihole tail` follows the live query log. Read the service logs from the journal with
  `journalctl -u pihole-FTL`.

The web dashboard of either engine remains available if you ever want it, but nothing in this recipe
requires it.

## Point your LAN at it

A sinkhole only filters traffic that is actually sent to it. Make it your network's resolver by
setting the DNS server your devices use to the sinkhole's static address, `<sinkhole-ip>`. The
cleanest way is to set it once in your router's DHCP settings so every device picks it up
automatically; alternatively set it per device. Choosing and assigning the static address itself is
covered in guide [10 -- Networking](../10-networking.md); the router's own configuration is outside
this corpus.

## Local DNS names for your LAN (\*.home.arpa)

Once your LAN uses the sinkhole as its resolver (previous section), the same box can also answer
names you define yourself. This lets every static-IP machine on your network -- the Proxmox host,
the Backup Server, and each service container or VM -- be reached by a stable name from any device,
without relying on each device advertising itself via mDNS. Guide
[10 -- Networking](../10-networking.md) gives the Proxmox host a name (`pve.local`) through mDNS,
but mDNS is link-local only and does not cross router hops; `*.home.arpa` records served by your own
resolver are network-wide. This is the network-wide layer that `pve.local` only approximates for the
host.

`home.arpa` (RFC 8375) is the standard reserved domain for home networks. It is served locally by
this resolver, and stays local as long as each device's own resolver -- its `/etc/resolv.conf` --
points at the sinkhole rather than a public or router resolver. A device still pointed at a public
or router resolver will send its `home.arpa` lookups there instead, so set the Proxmox host's
`/etc/resolv.conf` to the sinkhole IP once the sinkhole is live (replacing the router-first fallback
from guide [10 -- Networking](../10-networking.md)). Answering your own records locally is exactly
its intended use.

### The record set

The addresses below come from [LAB-PLAN.md](../LAB-PLAN.md), which is the source of truth. Keep your
records in sync with that file so they never drift.

```text
192.168.1.10   pve.home.arpa
192.168.1.50   pbs.home.arpa
192.168.1.120  caddy.home.arpa
192.168.1.121  adguard.home.arpa
192.168.1.122  pihole.home.arpa
192.168.1.123  vaultwarden.home.arpa
192.168.1.124  miniflux.home.arpa
192.168.1.125  nextcloud.home.arpa
192.168.1.126  drupal.home.arpa
192.168.1.127  hermes.home.arpa
192.168.1.128  website.home.arpa
192.168.1.130  paperless.home.arpa
192.168.1.132  home-assistant.home.arpa
```

Each guest's actual hostname must match its record. The corpus sets hostnames to match LAB-PLAN, so
if you followed the other recipes they already do.

You run only one sinkhole engine (you picked one earlier), so the list above includes both
`adguard.home.arpa` (`.121`) and `pihole.home.arpa` (`.122`) only because LAB-PLAN reserves an
address for each. Add a record only for the engine's container you actually deployed and omit the
other -- a record for the engine you did not install would point at a guest that does not exist.
Likewise, only add records for guests you have actually created.

Both engines are covered below; as elsewhere in this recipe, AdGuard Home is written up first. Read
only the subsection for the engine you chose.

### AdGuard Home: add rewrites to the YAML

AdGuard Home stores DNS rewrites in the `filtering: rewrites:` block of
`/opt/AdGuardHome/AdGuardHome.yaml`. Edit the file only while the service is stopped or it will
overwrite your changes on exit.

Stopping AdGuard Home briefly drops DNS resolution for every LAN client that points at this
sinkhole, including your own control station and any SSH session that needs name resolution during
the edit window. Keep a fallback resolver in `/etc/resolv.conf` on the Proxmox host (for example
`nameserver 1.1.1.1`) for the duration, or use the AdGuard REST API (`POST /control/rewrite/add`),
which adds rewrites without stopping the service.

Stop the service, add the rewrites, then start it again:

```bash
/opt/AdGuardHome/AdGuardHome -s stop
# edit /opt/AdGuardHome/AdGuardHome.yaml as below (the service overwrites the file if running)
/opt/AdGuardHome/AdGuardHome -s start
```

The rewrites block to add or merge into the YAML. Each entry needs `enabled: true`, or AdGuard Home
treats the record as disabled and silently ignores it (you get NXDOMAIN for the name with no error).
Include only records for guests you actually created -- you deployed AdGuard here, so omit the
`pihole.home.arpa` entry below (there is no Pi-hole container), and drop any other service you have
not built:

```yaml
filtering:
  rewrites:
    - domain: pve.home.arpa
      answer: 192.168.1.10
      enabled: true
    - domain: pbs.home.arpa
      answer: 192.168.1.50
      enabled: true
    - domain: caddy.home.arpa
      answer: 192.168.1.120
      enabled: true
    - domain: adguard.home.arpa
      answer: 192.168.1.121
      enabled: true
    - domain: pihole.home.arpa # omit: you deployed AdGuard, so there is no Pi-hole container
      answer: 192.168.1.122
      enabled: true
    - domain: vaultwarden.home.arpa
      answer: 192.168.1.123
      enabled: true
    - domain: miniflux.home.arpa
      answer: 192.168.1.124
      enabled: true
    - domain: nextcloud.home.arpa
      answer: 192.168.1.125
      enabled: true
    - domain: drupal.home.arpa
      answer: 192.168.1.126
      enabled: true
    - domain: hermes.home.arpa
      answer: 192.168.1.127
      enabled: true
    - domain: website.home.arpa
      answer: 192.168.1.128
      enabled: true
    - domain: paperless.home.arpa
      answer: 192.168.1.130
      enabled: true
    - domain: home-assistant.home.arpa
      answer: 192.168.1.132
      enabled: true
```

### Pi-hole v6: set dns.hosts with pihole-FTL --config

Pi-hole v6 keeps local DNS records in the `dns.hosts` array inside `/etc/pihole/pihole.toml`. The
`pihole-FTL --config` command writes the config from the shell, with no web UI. The command below is
one long line (the whole `dns.hosts` array in a single argument). Before running it, drop any record
for a guest you have not created; in particular, you deployed Pi-hole here, so remove the
`adguard.home.arpa` entry (`pihole.home.arpa` is this sinkhole and stays). Then copy the edited line
in full:

```bash
pihole-FTL --config dns.hosts '[ "192.168.1.10 pve.home.arpa", "192.168.1.50 pbs.home.arpa", "192.168.1.120 caddy.home.arpa", "192.168.1.121 adguard.home.arpa", "192.168.1.122 pihole.home.arpa", "192.168.1.123 vaultwarden.home.arpa", "192.168.1.124 miniflux.home.arpa", "192.168.1.125 nextcloud.home.arpa", "192.168.1.126 drupal.home.arpa", "192.168.1.127 hermes.home.arpa", "192.168.1.128 website.home.arpa", "192.168.1.130 paperless.home.arpa", "192.168.1.132 home-assistant.home.arpa" ]'
```

Whether the running resolver picks up `dns.hosts` without a restart varies by Pi-hole v6 version, so
do not assume it. After setting the config, verify the names resolve ("Verify the names resolve"
below); if they do not yet answer, restart the resolver and check again:

```bash
systemctl restart pihole-FTL
```

One gotcha: `dns.hosts` is a single array, so `--config` sets the entire list in one shot. To add or
change one record later, re-run the command with the full updated list. In v5 you could edit
`/etc/pihole/custom.list` directly; v6 removed that mechanism entirely. The v6 file
`/etc/pihole/hosts/custom.list` is a generated file that FTL writes from the `dns.hosts` array in
`pihole.toml` -- it is not a user-editable drop-in, and any direct edit is overwritten. Use
`pihole-FTL --config dns.hosts` (or the REST API) as shown above.

### Verify the names resolve

From the control station or the Proxmox host, ask the sinkhole for one of the records:

```bash
nslookup pve.home.arpa <sinkhole-ip>
```

It should return `192.168.1.10`. Replace `<sinkhole-ip>` with the sinkhole's address: `.121` for
AdGuard Home, `.122` for Pi-hole.

### Optional: per-guest .local via mDNS

The `*.home.arpa` records above already name every guest network-wide with no changes needed inside
each guest. If you also want a guest reachable as `name.local` (mDNS), install `avahi-daemon` inside
that guest:

```bash
apt install -y avahi-daemon
systemctl enable --now avahi-daemon
```

This is the same step guide [10 -- Networking](../10-networking.md) uses for the Proxmox host:
install the package and enable the service so it starts now and on every boot. It is optional here
-- `name.home.arpa` already works network-wide without it.

## Verify it worked

From your control station or the Proxmox host, confirm the sinkhole resolves and blocks. First, an
ordinary domain should resolve through the sinkhole:

```bash
dig @<sinkhole-ip> example.com
```

The expected key line is an `ANSWER SECTION` containing an `A` record for `example.com` with a real
public address, and `status: NOERROR` in the header. Second, a known ad or tracker domain should be
sinkholed, not resolved to its real address:

```bash
dig @<sinkhole-ip> doubleclick.net
```

The expected key line is an `A` record answer of `0.0.0.0` (the sink address; AdGuard Home's
default), or the sinkhole's own address, rather than the domain's real address. Pi-hole may instead
return `status: NXDOMAIN` with no answer, depending on its blocking mode; either way the real
address is not returned, which is the point.

If you set up Unbound, also confirm the recursive resolver answers from inside the container. After
`pct enter <vmid>`:

```bash
dig @127.0.0.1 -p 5335 example.com
```

The expected key line is again a `NOERROR` header and an `ANSWER SECTION` with `example.com`'s
address, proving Unbound recursed from the root servers successfully. To confirm DNSSEC validation,
the official guide suggests `dig fail01.dnssec.works @127.0.0.1 -p 5335` should return
`status: SERVFAIL` (a bogus signature, correctly rejected). For the positive side, run
`dig +ad dnssec.works @127.0.0.1 -p 5335` and look for the `ad` (authenticated-data) flag in the
response header flags: `ad` proves the signatures validated, whereas a bare `NOERROR` only proves
the name resolved, not that DNSSEC validation succeeded.

## Back it up

This container is now a guest like any other, and it holds your blocklists, custom rules, and (if
used) your Unbound config. Add its VMID to the Proxmox Backup Server backup job from guide
[17 -- Backups with Proxmox Backup Server](../17-backups-with-pbs.md) so it is captured on the
regular schedule. From there it rides along into the off-box copy described in guide
[18 -- The independent copy and restore](../18-the-independent-copy-and-restore.md). Treat finishing
this recipe and adding the guest to the backup job as one task.

## Sources

- `research/round2-pve9/20-pve9-ecosystem-and-service-patterns.md` -- the "Pi-hole or AdGuard Home"
  per-service pattern (unprivileged LXC, sized 1 vCPU / 256-512 MB / 2-4 GB disk, static IP so it is
  the LAN resolver, AdGuard the more shell-friendly, pick one as running both is redundant) and the
  Helper-Scripts `ct/<name>.sh` curl and wget one-liner forms.
- Guide [16 -- Automation and the ecosystem](../16-automation-and-the-ecosystem.md) -- the
  Helper-Scripts curl-pipe-to-root caution (read first, snapshot, pin a commit) that both
  `ct/adguard.sh` and `ct/pihole.sh` inherit.
- AdGuard Home official docs (Context7 `/adguardteam/adguardhome`): the `scripts/install.sh`
  automated install one-liner, the `/opt/AdGuardHome` working directory and `AdGuardHome.yaml`
  config file, the `/opt/AdGuardHome/AdGuardHome -s status|start|stop|restart` service control, the
  first-run `POST /control/install/configure` setup and `POST /control/dns_config` upstream
  settings, and the `:3000` setup / `:53` DNS ports.
- Pi-hole official docs: the
  [one-step automated install](https://docs.pi-hole.net/main/basic-install/)
  (`curl -sSL https://install.pi-hole.net | bash`) and
  [the pihole command](https://docs.pi-hole.net/main/pihole-command/) (`pihole -g`, `pihole -up`,
  `pihole setpassword`, `pihole status`, `pihole tail`).
- Pi-hole official [Unbound guide](https://docs.pi-hole.net/guides/dns/unbound/) -- the `unbound`
  package, the `/etc/unbound/unbound.conf.d/pi-hole.conf` config listening on `127.0.0.1` port
  `5335`, the `dns-root-data` root hints, the `service unbound restart` and
  `dig ... @127.0.0.1 -p 5335` test, and pointing the sinkhole's sole upstream at `127.0.0.1#5335`.

---

Previous: [00 -- The shared reverse proxy](00-reverse-proxy.md) | Next:
[02 -- Vaultwarden](02-vaultwarden.md)
