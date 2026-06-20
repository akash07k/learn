# Proxmox VE 9: Release Overview and the Full 8-to-9 Delta

Target: latest Proxmox VE 9.x on Debian 13 "trixie", as of mid-2026 (current shipping line is 9.2,
released 21 May 2026). Audience: a shell-only, single-node home-lab + self-hosting user installing
**fresh** on a BTRFS root, with ZFS only on an external USB disk. This document is the "what is true
in PVE 9, and what changed from PVE 8" baseline for the rest of the guide.

Sources are marked **[official]** (Proxmox press releases, pve-docs, the Roadmap wiki, the
Upgrade_from_8_to_9 wiki) or **[community]**. Primary citations:

- Proxmox VE 9.0 press release (official):
  [Proxmox Virtual Environment 9.0 with Debian 13 released](https://www.proxmox.com/en/about/company-details/press-releases/proxmox-virtual-environment-9-0)
- Proxmox VE 9.1 press release (official):
  [Proxmox Virtual Environment 9.1 available](https://www.proxmox.com/en/about/company-details/press-releases/proxmox-virtual-environment-9-1)
- Proxmox VE 9.2 press release (official):
  [Proxmox Virtual Environment 9.2 with Dynamic Load Balancer released](https://proxmox.com/en/about/company-details/press-releases/proxmox-virtual-environment-9-2)
- Roadmap / per-release changelog (official): [Roadmap](https://pve.proxmox.com/wiki/Roadmap)
- Upgrade from 8 to 9 (official):
  [Upgrade from 8 to 9](https://pve.proxmox.com/wiki/Upgrade_from_8_to_9)
- Automated Installation / answer.toml (official):
  [Automated Installation](https://pve.proxmox.com/wiki/Automated_Installation)
- Package repositories chapter, pve-docs (official):
  [Proxmox VE Administration Guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.html)
- Firewall chapter, pve-docs (official):
  [Proxmox VE Firewall](https://pve.proxmox.com/pve-docs/chapter-pve-firewall.html)
- Support lifecycle / EOL (official forum + community endoflife.date):
  [Proxmox VE - Support Lifecycle](https://forum.proxmox.com/threads/proxmox-ve-support-lifecycle.35755/)
  , [Proxmox VE](https://endoflife.date/proxmox-ve)

---

## 1. The base: Debian 13 "trixie" and the kernel line

PVE 9 is built on **Debian 13 "trixie"** (vs. Debian 12 "bookworm" for PVE 8). This is the single
biggest "everything underneath changed" fact: new glibc, new systemd, new toolchain, deb822 APT
format expectations, `/tmp` as tmpfs, etc. **[official]**

Kernel default by point release (the kernel is Proxmox's own "pve-kernel", independent of Debian's
stock kernel) **[official, Roadmap]**:

- PVE 9.0 (5 Aug 2025): Linux **6.14.8-2** stable default.
- PVE 9.1 (19 Nov 2025): Linux **6.17.2-1** stable default.
- PVE 9.2 (21 May 2026): Linux **7.0** stable default, on Debian **13.5**.

A 2026 fresh install of the current ISO lands you on the 9.2 line: Debian 13.5, kernel 7.0. Newer
kernels are available as opt-in (`proxmox-kernel-*` meta packages) and you can pin a kernel with
`proxmox-boot-tool kernel pin <version>`.

Bundled stack versions (deltas from PVE 8, which shipped QEMU 8.x / LXC 5.x / ZFS 2.2 / Ceph
Quincy/Reef) **[official, Roadmap]**:

- PVE 9.0: QEMU 10.0.2, LXC 6.0.4, ZFS 2.3.3, Ceph Squid 19.2.3.
- PVE 9.1: QEMU 10.1.2, LXC 6.0.5, ZFS 2.3.4.
- PVE 9.2: QEMU 11.0, LXC 7.0, ZFS **2.4**, Ceph Squid 19.2.3 / Tentacle 20.2.1.

ZFS 2.3+ matters for this reader's external-USB ZFS disk: it brings **RAIDZ expansion** (add a disk
to an existing RAIDZ vdev) and faster `zpool` operations. Single-disk USB pools don't use RAIDZ, but
the newer ZFS is still the on-disk feature baseline. Note the host **root is BTRFS** here, so the
ZFS version only affects the external pool, not boot.

---

## 2. Headline new features in 9.0 (vs PVE 8)

All **[official]** unless noted. Items the reader can use; HA/cluster/mobile items are flagged
"note-and-skip" for a single shell-only node.

- **Snapshots on thick-provisioned LVM shared storage** (iSCSI/FC SAN). New in 9.0. Largely
  irrelevant to a single-node BTRFS+local user, but it's the marquee storage feature. Mechanism is
  "snapshots as volume chains" (qcow2-on-LVM), a technology preview in 9.0.
- **SDN "Fabrics"**: declarative routed-network fabric config (OpenFabric / OSPF). Power feature for
  multi-node routed networks; **note-and-skip** for a single node, though SDN VNets/zones can still
  be useful for isolating lab networks on one host.
- **ZFS RAIDZ expansion** (see section 1).
- **HA resource affinity rules**: cluster/HA only; **skip**.
- **nftables firewall** maturing (see section 4) -- the big networking delta you _will_ care about.
- **AMD SEV-SNP** out of "highly experimental"; **Intel TDX** initial support arrives in the 9.x
  line (TDX listed under 9.1). Confidential-compute memory encryption; niche for a home lab:
  **note-and-skip**.
- **Mobile web UI** rebuilt on the new Proxmox widget toolkit: **skip** (GUI, and this reader is
  shell-only).
- **AppArmor 4**, extended/RRD metrics handling, new `VM.Replicate` privilege.

### 9.1 additions [official]

- **OCI images as LXC templates**: pull standard OCI/Docker images from a registry (or upload a
  tarball) and run them as system _or_ application LXC containers. Genuinely useful for self-hosting
  -- it narrows the gap with Docker while staying in native LXC.
- **vTPM state in qcow2**: lets you snapshot a VM that has an active vTPM even on file-level storage
  (NFS/CIFS/dir). Relevant if running Windows 11 guests.
- **Per-VM `nested-virt` vCPU flag** for fine-grained nested virtualization, and **per-VM KSM
  (Kernel Samepage Merging) disable**.
- SDN monitoring/reporting in the UI (skip), datacenter-level bulk actions.

### 9.2 additions [official]

- **Dynamic Load Balancer** in the Cluster Resource Scheduler: cluster/HA only; **skip**.
- **SDN gains WireGuard and BGP** fabric protocols, route maps, prefix lists, IPv6 EVPN underlay.
  WireGuard-in-SDN is interesting but heavyweight; a plain `wg` interface is simpler for one node.
- **Custom CPU models** manageable from the web UI (CLI/config still works).
- **"Disarm/arm HA"** for maintenance: cluster/HA only; **skip**.

---

## 3. Deprecated / removed in 9 (watch list)

**[official, Roadmap]** -- the ones a fresh-install user can actually trip over:

- **GlusterFS storage support: dropped.** If you were planning Gluster, don't.
- **cgroup v1: removed** (pure cgroup v2 / "unified" hierarchy). Containers running systemd 230
  (2016) or older won't boot. Any modern distro template is fine; ancient container images are not.
- **`VM.Monitor` privilege removed**; **`maxfiles` backup retention setting removed** (use
  `prune-backups` / keep-\* retention instead).
- **`starttime` and `dow` backup-job API params removed** from API responses (9.2); use the modern
  schedule format.
- Legacy single-line APT sources still _work_ but Debian 13 emits deprecation **warnings**; deb822
  is now the expected format (section 5).
- The test repository was renamed to **`pve-test`**.
- cgroup v1-in-containers warnings continue tightening in 9.2.

Breaking-behaviour changes to expect even on a fresh install **[official]**:

- **Network interface names can change** vs PVE 8 (new kernel/udev naming). On a fresh install this
  just means you must read your actual NIC name (`ip -br link`) rather than assume `eth0`/`ens18`.
  See interface pinning in section 6.
- **VirtIO vNIC default MTU field changed.**
- **Creating _privileged_ containers now requires the `Sys.Modify` privilege.** As root this is a
  non-issue; relevant only if you delegate.
- **`/tmp` is now tmpfs** (RAM-backed, up to 50% of RAM) and `/tmp` + `/var/tmp` are periodically
  auto-cleaned at runtime. Don't stash anything you want to keep in `/tmp`. This is a Debian 13
  default, not PVE-specific.
- Boot may log `System is tainted: unmerged-bin` -- cosmetic, ignore.

---

## 4. nftables firewall (the networking delta you care about)

PVE has been rewriting its firewall on **nftables** (the new backend, `proxmox-firewall`, is written
in Rust) to replace the legacy iptables backend. **Important nuance for accuracy:** as of the 9.x
line nftables is **opt-in**, not yet the unconditional default -- you enable it explicitly. The
legacy iptables-based `pve-firewall` remains the default backend so existing rule behaviour is
preserved. **[official, pve-docs firewall chapter]**

Enable the nftables backend host-wide in the host firewall config file
`/etc/pve/nodes/<node>/host.fw`:

```ini
[OPTIONS]

nftables: 1
```

Rules are still written the same way (`/etc/pve/firewall/cluster.fw`,
`/etc/pve/nodes/<node>/host.fw`, and per-guest `<vmid>.fw`); only the enforcement backend changes.
For a single shell-only node, the firewall config files under `/etc/pve/firewall/` and `host.fw` are
fully CLI/editor-managed -- no GUI needed. Recommendation for this guide: cover the firewall as
config-file editing, mention the nftables opt-in switch, but don't assume it's already on.

---

## 5. APT repositories: the deb822 format change

This is one of the most visible fresh-install differences and is shell-relevant. PVE 9 / Debian 13
moves to the **deb822** multi-line `.sources` format. Legacy one-line `deb http://...` entries in
`/etc/apt/sources.list` still parse but emit warnings. New installs ship deb822 `.sources` files in
`/etc/apt/sources.list.d/`. **[official, pve-docs]**

The repos you actually want on a **no-subscription home lab** -- create/edit these `.sources` files:

`/etc/apt/sources.list.d/pve-no-subscription.sources` (the free PVE updates repo; the Enterprise
repo is enabled by default and will 401 without a key, so disable it and add this instead):

```text
Types: deb
URIs: http://download.proxmox.com/debian/pve
Suites: trixie
Components: pve-no-subscription
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
```

`/etc/apt/sources.list.d/proxmox-enterprise.sources` (enabled by default; either delete it or keep a
key). For reference, the enterprise stanza is:

```text
Types: deb
URIs: https://enterprise.proxmox.com/debian/pve
Suites: trixie
Components: pve-enterprise
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
```

Debian base repos live in `/etc/apt/sources.list.d/debian.sources` and now use **Suites: trixie**
with `non-free-firmware` enabled by default on PVE 9 installs:

```text
Types: deb deb-src
URIs: http://deb.debian.org/debian
Suites: trixie trixie-updates
Components: main contrib non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
```

Notes:

- The keyring is now `proxmox-archive-keyring.gpg`; for the trixie line the key is fetched from
  `https://enterprise.proxmox.com/debian/proxmox-archive-keyring-trixie.gpg` if you need to install
  it manually. **[official]**
- During an 8 to 9 _upgrade_, Debian provides `apt modernize-sources` (and Proxmox references a
  `proxmox-offline-mirror`-style migration); the wiki shows a blunt
  `sed -i 's/bookworm/trixie/g' /etc/apt/sources.list` to bump the suite. A fresh install skips all
  of this. **[official, Upgrade wiki]**

---

## 6. answer.toml / automated (unattended) install changes

Fresh-install relevant if the reader scripts the install via `proxmox-auto-install-assistant` (the
accessible, no-GUI install path). The answer file is TOML, validated with
`proxmox-auto-install-assistant validate-answer answer.toml`. **[official]**

Key changes across the 9.x line **[official, Automated_Installation wiki]**:

- **9.0-1: kebab-case keys.** All answer-file keys may now be `kebab-case`; the old `snake_case` is
  deprecated and slated to become a hard error in a future release. So write `root-password`, not
  `root_password`.
- **9.1-1: interface name pinning** via a `[network.interface-name-pinning]` section -- directly
  addresses the "NIC names changed in PVE 9" problem by letting you bind stable `nicX`/custom names
  to MAC addresses at install time.
- **9.2-1: `subscription-key`** (a `[global]` key). Staged during install and auto-activated on
  first boot; implies installing `proxmox-first-boot`. A no-subscription home user simply omits it.

Representative PVE 9.2 `answer.toml` (kebab-case, ZFS example shown; for this reader's BTRFS root
use `filesystem = "btrfs"` instead):

```toml
[global]
keyboard = "us"
country = "us"
fqdn = "pve.home.lab"
mailto = "admin@home.lab"
timezone = "America/Toronto"
root-password = "CHANGE-ME"
# subscription-key = "pveXc-0123456789" # 9.2+, omit for no-subscription

[network]
source = "from-dhcp"

# 9.1+ : pin NIC names to MACs so "eth0" surprises don't bite
[network.interface-name-pinning]
enabled = true

[network.interface-name-pinning.mapping]
"24:8a:07:1e:05:bc" = "lan0"

[disk-setup]
filesystem = "btrfs" # this reader's host root is BTRFS
disk-list = ["sda"]
# zfs.raid = "raid1" # only if doing ZFS-on-root, which this reader is NOT
```

The installer's BTRFS-on-root support (single disk, no RAID) is available and is the right choice
here; ZFS is reserved for the external USB disk and is created post-install with `zpool create`, not
via the installer.

---

## 7. Upgrade path 8 to 9 (brief; reader is installing fresh)

For completeness only -- this reader is doing a clean install, so this is note-and-skip.
**[official, Upgrade wiki]**

- Run the **`pve8to9`** checklist tool first (`pve8to9 --full`). It ships in PVE 8.4 packages; it
  reports issues, it does not fix them. Must be on **PVE 8.4.1+** before upgrading.
- Prereqs: 5+ GB free on root (10+ ideal), tested VM/CT backups, console/IPMI access, Ceph already
  at Squid 19.2 if hyper-converged, co-installed PBS moved to PBS 4.
- Then: switch APT to trixie + deb822 (section 5), `apt update`, `apt dist-upgrade`, reboot into the
  new kernel.
- A single non-cluster node is the simplest case; no quorum/HA dance.

---

## 8. End-of-life timeline for 8.x

Proxmox support tracks the underlying Debian release (~3 years from initial release). **[official
forum + community endoflife.date]**

- **Proxmox VE 8** (Debian 12 "bookworm"): first released 2023-06; Debian 12 EOL ~2026-07; **PVE 8
  EOL ~August 2026.** As of June 2026 that's roughly two months of support left -- another reason a
  2026 fresh install should be **9.x, not 8.x**.
- **Proxmox VE 9** (Debian 13 "trixie"): first released 2025-08; EOL "TBA" but expected ~2028 by the
  Debian-release-aligned pattern.

---

## 9. What a 2026 fresh-install user MUST know is different (the short list)

1. **Install PVE 9.2** (Debian 13.5, kernel 7.0). Don't install 8.x -- it's EOL ~Aug 2026.
2. **Debian 13 base** = new everything underneath; `/tmp` is now **tmpfs and auto-cleaned** -- never
   leave keepsakes in `/tmp` or `/var/tmp`.
3. **APT is deb822 now.** Manage repos as `.sources` files in `/etc/apt/sources.list.d/`. Disable
   the default **Enterprise** repo, add **`pve-no-subscription`** (suite `trixie`). Keyring is
   `proxmox-archive-keyring.gpg`.
4. **NIC names may not be what you expect.** Read the real name with `ip -br link`; consider
   **interface name pinning** (answer-file `[network.interface- name-pinning]`, 9.1+) for stable
   names.
5. **answer.toml uses kebab-case** (`root-password`); snake_case is deprecated. `subscription-key`
   (9.2) -- omit it for a no-subscription box.
6. **Firewall: nftables is opt-in**, set `nftables: 1` in `/etc/pve/nodes/<node>/host.fw`; otherwise
   the legacy iptables backend is still the default. Rules are plain-file edits under
   `/etc/pve/firewall/`.
7. **GlusterFS is gone; cgroup v1 is gone.** Use modern container templates; pick a different
   shared-storage tech if you had Gluster in mind.
8. **ZFS is 2.4** (RAIDZ expansion, faster ops) -- relevant to the **external USB pool** only;
   **host root is BTRFS** and unaffected by the ZFS version. Create the USB pool post-install with
   `zpool create`, not via the installer.
9. **Backup retention** uses `prune-backups`/keep-\* now; `maxfiles` is removed.
10. **OCI images as LXC templates (9.1+)** is the most useful new self-hosting feature -- pull a
    registry image and run it as a native container.
11. Skip as not-applicable to a single shell-only node: HA affinity / dynamic load balancer, SDN
    fabrics (WireGuard/BGP/EVPN), mobile UI, confidential- compute (SEV-SNP/TDX).
