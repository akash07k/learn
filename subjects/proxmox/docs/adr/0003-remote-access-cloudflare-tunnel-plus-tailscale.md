# Remote access: Cloudflare Tunnel for web, Tailscale for admin and sensitive services

Status: accepted

The operator wants to reach home services from outside the LAN, shell-only, without exposing the
router. The domain is registered at CrazyDomains; its DNS is moved to Cloudflare (free) -
registration stays at CrazyDomains. Cloudflare Tunnel requires the domain to be on Cloudflare and
also provides automatic edge HTTPS and a DNS API.

Decision: a hybrid.

- **Cloudflare Tunnel** (`cloudflared` in a small LXC, outbound-only, no port-forward) is the
  primary door for web services and the public personal website. Private services exposed this way
  are gated behind **Cloudflare Access** (login).
- **Tailscale** provides SSH/admin access to the host and end-to-end-private access to the most
  sensitive services (Vaultwarden, optionally Nextcloud). Those crown-jewel services are kept OFF
  the Cloudflare tunnel so their decrypted traffic never transits Cloudflare's edge.

## Considered and rejected

- **Tailscale only**: rejected - no clean way to publish a public website, and no
  browser-from-any-device access without installing the Tailscale client.
- **Cloudflare Tunnel only**: rejected as the sole method because Cloudflare terminates TLS at its
  edge and would sit in the data path for sensitive services like a password manager. Kept for
  everything else.
- **Router port-forwarding + a public reverse proxy**: rejected - unnecessary attack surface and
  hardening burden when the tunnel achieves the goal outbound-only.

## Consequences

- Domain DNS is managed by Cloudflare (nameserver change at CrazyDomains).
- Cloudflare can see decrypted traffic for tunnel-exposed services; this is mitigated by keeping the
  crown-jewel services on Tailscale only.
- `cloudflared`, DNS records, and Tailscale are CLI/API-driven; Cloudflare Access policy
  configuration is partly done in the (web) Cloudflare dashboard/API.
