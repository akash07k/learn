# PVE 9 APT Repositories and Updates (deb822)

Target: latest Proxmox VE 9.x on Debian 13 "trixie", mid-2026. Single node, no cluster/HA,
shell-only. This document reports what is TRUE in PVE 9 and flags every delta from PVE 8.

## The single biggest 8-to-9 change: deb822 replaces one-line .list

In PVE 8 (Debian 12 "bookworm") APT repositories were one-line entries in `*.list` files, e.g.
`/etc/apt/sources.list.d/pve-enterprise.list` containing:

```text
deb https://enterprise.proxmox.com/debian/pve bookworm pve-enterprise
```

In PVE 9 the default and recommended format is **deb822** - multi-line stanzas in `*.sources` files
under `/etc/apt/sources.list.d/`. The old one-line `.list` format still works (APT understands
both), but a fresh PVE 9 install ships only `.sources` files, and the docs recommend migrating. This
is the first thing a returning PVE 8 user trips over: editing the file they remember
(`pve-enterprise.list`) does nothing because the active config now lives in
`pve-enterprise.sources`.

deb822 stanza anatomy (one repository = one stanza, blank-line separated):

- `Types:` - usually `deb` (binary). Add `deb-src` for source packages.
- `URIs:` - the mirror base URL.
- `Suites:` - the release codename, `trixie` (plus `trixie-updates`, `trixie-security` for Debian
  base).
- `Components:` - e.g. `pve-enterprise`, `pve-no-subscription`, `main`.
- `Signed-By:` - absolute path to the keyring that must sign this repo.
- `Enabled:` - optional; `Enabled: no` disables the stanza without deleting it.

Field names are capitalized and colon-terminated. Multiple values on `Types`, `URIs`, `Suites`,
`Components` are space-separated. A single file may hold several stanzas separated by one blank
line.

## Migrating PVE 8 .list files: `apt modernize-sources`

The clean, official way to convert existing one-line `.list` files to deb822 is the APT 3.0 (trixie)
subcommand:

```bash
apt modernize-sources
```

It rewrites `.list` files into equivalent `.sources` files and preserves the originals as `.bak`
(e.g. `pve-enterprise.list.bak`), commenting out / disabling the old entries so they do not
double-load. The PVE 9 admin guide explicitly recommends running it: "Modernizing your package
repositories is recommended for Proxmox VE 9 to avoid potential issues with apt on Debian Trixie."
This is normally run as part of the 8-to-9 upgrade, after `apt update` succeeds on the new release.
After verifying the new `.sources` files, the leftover `.bak` files can be removed.

## The archive keyring: proxmox-archive-keyring + Signed-By

PVE 9 repos are verified by a keyring shipped in the **`proxmox-archive-keyring`** package,
installed at:

```text
/usr/share/keyrings/proxmox-archive-keyring.gpg
```

Every Proxmox `.sources` stanza points at it via `Signed-By:`. (Delta from PVE 8, which referenced
`proxmox-release-bookworm.gpg`.) On a normal install/upgrade the package provides the key
automatically. Manual fetch (only if bootstrapping by hand, e.g. offline) - the trixie key:

```bash
wget https://enterprise.proxmox.com/debian/proxmox-archive-keyring-trixie.gpg \
 -O /usr/share/keyrings/proxmox-archive-keyring.gpg
```

(Published SHA256 at time of research:
`136673be77aba35dcce385b28737689ad64fd785a797e57897589aed08db6e45` - verify against the wiki before
trusting.) Debian base repos use the distro keyring
`/usr/share/keyrings/debian-archive-keyring.gpg`.

## File: /etc/apt/sources.list.d/pve-enterprise.sources

Enabled by default on a fresh install. Requires a paid subscription key; without one, `apt update`
throws a 401 error on this repo. For a no-subscription single-node lab, disable it (see below).

```text
Types: deb
URIs: https://enterprise.proxmox.com/debian/pve
Suites: trixie
Components: pve-enterprise
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
```

## File: /etc/apt/sources.list.d/proxmox.sources (no-subscription / test)

NOTE the filename. The PVE-managed non-enterprise repos live in **`proxmox.sources`** (not
`pve-no-subscription.sources`). The web GUI repository tool writes here, and the no-subscription and
test components are both expressed as components of this same file/URI. This is the repo to enable
for a free single-node lab.

No-subscription (recommended for a lab - freely accessible, less rigorously tested than enterprise
but the standard choice for non-production):

```text
Types: deb
URIs: http://download.proxmox.com/debian/pve
Suites: trixie
Components: pve-no-subscription
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
```

## The test repository (pve-test)

For trying brand-new features / bug fixes before they reach no-subscription. Docs warn: "The
pve-test repository should (as the name implies) only be used for testing new features or bug
fixes." Same URI as no-subscription, just a different component. Do NOT leave it enabled on a
machine you care about.

```text
Types: deb
URIs: http://download.proxmox.com/debian/pve
Suites: trixie
Components: pve-test
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
```

You can place this as its own stanza in `proxmox.sources`, but typically you run only ONE of
pve-enterprise / pve-no-subscription / pve-test at a time.

## File: /etc/apt/sources.list.d/ceph.sources (only if you run Ceph)

A single node with no cluster does NOT need Ceph. If `ceph.sources` exists and you do not run Ceph,
the safest move is to disable or delete it - a stale Ceph repo (especially a wrong codename) is a
common cause of `apt update` errors on fresh PVE 9 boxes.

IMPORTANT codename caveat: PVE 9 spans the Ceph **Squid** to **Tentacle** transition. Earlier PVE
9.x ships `ceph-squid`; later PVE 9.x (and the mid-2026 target) moves to `ceph-tentacle`. Both
directories exist on the mirror. The rule: match whatever the existing `ceph.sources` already
references and what `pveceph install --version` offers (`squid | tentacle`). Do not hand-edit the
codename blindly. Tentacle no-subscription example:

```text
Types: deb
URIs: http://download.proxmox.com/debian/ceph-tentacle
Suites: trixie
Components: no-subscription
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
```

Enterprise Ceph (subscription) and test variants use the same URI base with `Components: enterprise`
(URI `https://enterprise.proxmox.com/debian/ceph-tentacle`) or `Components: test` respectively.
Squid equivalents simply replace `ceph-tentacle` with `ceph-squid`.

## File: /etc/apt/sources.list.d/debian.sources (Debian trixie base)

PVE 9 ships the Debian base in deb822 too (in PVE 8 these were lines in `/etc/apt/sources.list`). A
correct single-node base looks like:

```text
Types: deb deb-src
URIs: http://deb.debian.org/debian
Suites: trixie trixie-updates
Components: main contrib non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb deb-src
URIs: http://security.debian.org/debian-security
Suites: trixie-security
Components: main contrib non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
```

Drop `deb-src` if you do not build from source (slightly faster `apt update`). `non-free-firmware`
is important for hardware on a bare-metal host. After `apt modernize-sources` the old
`/etc/apt/sources.list` is typically emptied/commented and this `debian.sources` takes over.

## Enabling no-subscription / disabling enterprise from the shell

Two shell-only approaches. Pick one.

Approach A - toggle the `Enabled:` field (keeps files in place, reversible):

Disable enterprise by appending `Enabled: no` to its stanza. Cleanest with a small edit; with the
file holding a single stanza you can append the line:

```bash
echo 'Enabled: no' >> /etc/apt/sources.list.d/pve-enterprise.sources
```

Re-enable later by deleting that line (or set `Enabled: yes`). The benefit of `Enabled: no` over
deletion: `apt update` stops erroring on the missing subscription without you losing the template.

Approach B - remove the enterprise file and write the no-subscription file:

```bash
rm -f /etc/apt/sources.list.d/pve-enterprise.sources

cat > /etc/apt/sources.list.d/proxmox.sources <<'EOF'
Types: deb
URIs: http://download.proxmox.com/debian/pve
Suites: trixie
Components: pve-no-subscription
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
EOF
```

(Heredoc quoted as `'EOF'` so nothing is expanded.) If a `ceph.sources` exists and you do not run
Ceph, also disable it the same way. Then `apt update`.

The `Enabled:` toggle is screen-reader friendly and fully scriptable, which is why it is the
preferred mechanism here over the GUI repository panel.

## Update workflow: apt update + full-upgrade (NEVER plain upgrade)

```bash
apt update
apt full-upgrade
```

Always `full-upgrade` (equivalent to the older `apt-get dist-upgrade`), NEVER plain `apt upgrade`.
Reason: Proxmox kernel/package transitions frequently need to install NEW packages and remove
obsolete ones; plain `apt upgrade` refuses to add/remove packages and will hold back kernel and core
updates, leaving a half-updated, possibly unbootable-after-reboot system. This is a hard rule in the
Proxmox docs for both minor updates and the 8-to-9 major upgrade.

`pveupgrade` is a thin Proxmox wrapper around the apt workflow that additionally warns about
reboot-requiring kernel updates and running guests; running it is equivalent to
`apt update && apt full-upgrade` plus those safety checks. Either is acceptable on a single node.

Check installed component versions (the canonical "what do I have" command):

```bash
pveversion -v
```

`pveversion -v` prints the running kernel plus every key PVE package version (pve-manager,
pve-kernel, qemu-server, ceph if present, etc.) - the first thing to paste when asking for help or
confirming an upgrade landed.

## proxmox-offline-mirror (air-gapped - skip deep)

For hosts with no internet access, Proxmox provides `proxmox-offline-mirror`: you mirror the
enterprise/no-subscription repos (and the subscription key) on a connected machine, carry the mirror
to the air-gapped host, and point a local `.sources` file at it. `pceph install --repository manual`
exists precisely for this (it configures no repo and expects you to have mirrored Ceph packages
yourself). Out of scope for a normal internet-connected single-node lab; noted for completeness.

## GUI subscription nag (cosmetic - irrelevant to a CLI user)

After login the web GUI shows a "No valid subscription" popup when no key is present. This is
**purely cosmetic** and has ZERO effect on a shell-only / pvesh / serial-console workflow - `apt`,
`pct`, `qm`, `pvesh` all work identically with or without it. A blind shell-only user can simply
ignore it.

If you nonetheless want it gone, it is a one-file JavaScript patch (no functional change):

```bash
sed -Ezi.bak "s/(function\(orig_cmd\) \{)/\1\n\torig_cmd\(\);\n\treturn;/g" \
 /usr/share/javascript/proxmox-widget-toolkit/proxmoxlib.js
systemctl restart pveproxy.service
```

Caveats (important):

- The patched file (`proxmoxlib.js`) belongs to the `proxmox-widget-toolkit` package and is
  OVERWRITTEN on every update of that package - so the nag returns after the next `apt full-upgrade`
  that touches it, and you must re-apply. People work around this with an APT post-invoke hook or a
  re-apply script, but that is extra moving parts on a system you otherwise keep stock.
- `.bak` is written next to the file by `sed -i.bak` so you can revert.
- Browser caches the JS - hard-reload (Ctrl+Shift+R) after restarting pveproxy.
- For a CLI-only user the recommendation is: do not bother patching. It is cosmetic, it breaks on
  update, and it touches a package file.

## Deltas from PVE 8 - quick reference

- Format: one-line `.list` to deb822 `.sources` (biggest change).
- Suite codename: `bookworm` to `trixie`.
- Keyring: `proxmox-release-bookworm.gpg` to `proxmox-archive-keyring.gpg` (package
  `proxmox-archive-keyring`).
- New migration command: `apt modernize-sources` (APT 3.0 on trixie).
- No-subscription/test PVE repos now live in `proxmox.sources` (not a `pve-no-subscription.list`).
- Ceph: Squid to Tentacle transition occurs within the PVE 9 lifecycle; match the existing
  `ceph.sources`.
- Debian base moved from `/etc/apt/sources.list` into `debian.sources`.
- Unchanged: still `apt update && apt full-upgrade` (never plain upgrade); `pveversion -v`;
  `pveupgrade`.

## Gotchas

- Editing the old `*.list` file on PVE 9 and seeing no effect - the live config is in `*.sources`.
  Check `/etc/apt/sources.list.d/*.sources` first.
- `apt update` 401 error = enterprise repo enabled with no subscription. Disable it.
- `apt update` error on Ceph = stale/wrong-codename `ceph.sources` on a non-Ceph node.
  Disable/remove it.
- Duplicate-source warnings after upgrade = both the new `.sources` and an un-disabled old `.list`
  are active; finish `apt modernize-sources` cleanup and delete `.bak`/old `.list`.
- Never `apt upgrade` - use `apt full-upgrade`.

## Citations

- Proxmox VE wiki, Package Repositories:
  [Package Repositories](https://pve.proxmox.com/wiki/Package_Repositories)
- Proxmox VE admin guide, sysadmin chapter (deb822 stanzas, keyring, workflow):
  [Host System Administration](https://pve.proxmox.com/pve-docs/chapter-sysadmin.html)
- pve-docs source (authoritative adoc):
  [pve-docs/pve-package-repos.adoc at master · proxmox/pve-docs](https://github.com/proxmox/pve-docs/blob/master/pve-package-repos.adoc)
- Upgrade from 8 to 9 (modernize-sources, migration):
  [Upgrade from 8 to 9](https://pve.proxmox.com/wiki/Upgrade_from_8_to_9)
- Ceph Squid to Tentacle:
  [Ceph Squid to Tentacle](https://pve.proxmox.com/wiki/Ceph_Squid_to_Tentacle)
- pveceph install (`--repository manual`, `--version squid|tentacle`):
  [Proxmox VE Administration Guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.html)
- PVE FAQ (apt update && apt full-upgrade for minor upgrades):
  [Frequently Asked Questions](https://pve.proxmox.com/pve-docs/chapter-pve-faq.html)
- Nag removal background (community, verify before use):
  [Get rid of the subscription Nag and set up public repos](https://blog.opsvox.com/proxmox-9-nag/)
  ;
  [Removing the Proxmox VE subscription notice | Carey Metcalfe](https://cmetcalfe.ca/blog/remove-proxmox-subscription-notice.html)
