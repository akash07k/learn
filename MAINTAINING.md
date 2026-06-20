# Maintaining learn

This file keeps the durable maintenance rules from the repository review in the public tree without
keeping the full process-history directories.

## Before Review Or Push

Run the CI-parity gate from the repository root:

```bash
bun run ci:local
```

This runs JavaScript linting, formatter checks, Markdown linting, TypeScript typechecking, tests,
and the build/glyph/link/convention gate. Use `bun run check` only when you specifically want the
HTML build and subject checks without the full CI suite.

## Keep Local Work Local

- `html/`, `tmp/`, and `.scratch/` are ignored and safe to recreate locally.
- Do not commit local agent/editor state such as `.agents/`, `.claude/`, `.cursor/`, `.aider*`, or
  `skills-lock.json`.
- Durable project documentation belongs in tracked Markdown files, not in `tmp/` or `.scratch/`.

## Preserve ADR Discipline

Subject-level ADRs are product decisions, not loose notes. If a guide change would contradict an
ADR, either change the guide to honor the ADR or write a new ADR that explicitly supersedes the old
decision.

For the Proxmox subject, pay special attention to these decision areas:

- btrfs root filesystem and `local-btrfs` storage;
- PBS primary and independent-copy topology;
- Cloudflare Tunnel plus Tailscale remote-access split;
- Windows RDP plus EMS/SAC access model;
- SPICE Console-by-ear as install/recovery only, never daily operation.

## Manage Proxmox And PBS Drift

Proxmox VE, Proxmox Backup Server, Debian, kernel, QEMU, ZFS, and service ecosystems move quickly.
Before major guide updates or public releases, re-check:

- Proxmox VE release history and admin guide;
- Proxmox Backup Server release history and docs;
- `pct(1)` and `qm(1)` option defaults;
- PVE firewall backend status;
- PBS removable datastore behavior;
- community arm64 PBS package freshness, if the Raspberry Pi second-copy path still recommends it.

When a claim appears in several guides or cheat-sheets, update every copy in the same change. Avoid
copying older round-1 research examples into current Proxmox VE 9 instructions without checking
whether a newer guide, ADR, or upstream document supersedes them.

## Naming Policy

Use `home.arpa` for permanent home-network DNS names. It is the reserved home-network domain, so it
avoids collisions with public DNS and invented private TLDs. Use `.local` only for mDNS/Avahi names
such as `pve.local`; do not use `.lan` as current guidance.

Friendly browser-facing service names should normally come from Caddy and a domain you control, for
example `reader.example.com` for Miniflux. The local DNS name remains the stable internal identity,
for example `miniflux.home.arpa`.

## Accessibility Maintenance

Automated checks catch mechanical issues such as banned glyphs, broken internal links, nav-chain
errors, prose arrows, and subject lint rules. They do not prove prose quality. Future manual passes
should review:

- heading usefulness;
- link text quality;
- plain-language clarity;
- command-output readability;
- whether workflows can be completed without sighted help.

## Release Checklist

Before a public release or large PR:

1. Run `bun run ci:local`.
2. Confirm `git status --short` contains only intended tracked changes.
3. Re-check moving Proxmox/PBS facts touched by the change.
4. Confirm local-only paths remain ignored.
5. Confirm no process-history or agent-state artifacts are being added unintentionally.
