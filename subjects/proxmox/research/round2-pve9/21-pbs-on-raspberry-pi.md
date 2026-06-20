# PBS on a Raspberry Pi 4B (ARM64)? Official Support, Community Paths, and the Right Backup Architecture

Research question (settled below): Can Proxmox Backup Server (PBS) run on a Raspberry Pi 4B (ARM64)
in mid-2026, how, is it a good idea, and what is the best backup architecture for a single amd64
Proxmox VE 9 node + a Pi 4B 8GB + USB HDDs, shell-only?

Scope note: "official" below means published/supported by Proxmox. Everything else is clearly
labeled community/unofficial.

## TL;DR

- PBS server is **officially amd64-only**. There is **no official arm64/aarch64 package** for
  `proxmox-backup-server`, and the Proxmox forum staff position is explicitly "not officially
  supported."
- It **can** run on a Pi 4B 8GB via a **community build** (`wofferl/proxmox-backup-arm64`). A live
  check on 2026-06-19 found the latest tagged release at `4.2.1-1`, with the main branch already
  updated for `4.2.2-1`; treat that as active maintenance, but verify the latest tag again before
  relying on this path. It works, but it is unsupported, you carry the maintenance/trust risk, and
  the Pi 4B + USB HDD combo is slow for the CPU/IO-heavy operations (verify, garbage collection).
- **Recommended architecture:** run PBS as a VM **on the amd64 node** (officially supported), put
  its datastore on a dedicated **external USB HDD**, and use the **Pi 4B as an independent off-box
  second copy** - preferably as a **second PBS instance (community arm64 build) that you pull/sync
  to**, or, if you want zero unsupported software, as a plain SSH/ZFS rsync target receiving a copy
  of the datastore. This gives 3-2-1 with an independent failure domain, dedup/incremental, and is
  fully shell-driven.

## 1. Official architecture support: amd64 only

The official PBS installation docs list the CPU requirement as **"64bit (x86-64 or AMD64), 2+
Cores"** and recommend a "Modern AMD or Intel 64-bit based CPU." **ARM64/AArch64 is never
mentioned.** There is no arm64 entry in the official PBS package repositories.

Official repositories (all amd64):

- Enterprise (subscription): `https://enterprise.proxmox.com/debian/pbs`
- No-subscription (community): `http://download.proxmox.com/debian/pbs` (component
  `pbs-no-subscription`)
- Client-only (Debian 13/Trixie): `http://download.proxmox.com/debian/pbs-client`

Note the distinction: Proxmox **does** ship an official **`proxmox-backup-client`** for amd64 (the
`pbs-client` repo), but even that is **amd64-only** - there is no official arm64 client either. For
arm64 you must use community builds (see below) even just for the client.

Forum confirmation of the official stance: when a user asked about installing PBS on a Pi 4B,
Proxmox staff replied plainly "No it is not official supported," and a community member who pointed
to the arm64 build project added "don't ask for support here."

Bottom line for #1: **Definitively amd64-only. No official arm64/aarch64 PBS server or client
package exists as of mid-2026 (PBS 4.2.x).**

Sources:

- [Installation](https://pbs.proxmox.com/docs/installation.html)
- [Install PBS on Raspberry Pi 4B with Debian 12 running on it](https://forum.proxmox.com/threads/install-pbs-on-raspberry-pi-4b-with-debian-12-running-on-it.157995/)
- [Any plans for aarch/arm64 support in Proxmox Backup Client?](https://forum.proxmox.com/threads/any-plans-for-aarch-arm64-support-in-proxmox-backup-client.94496/)

## 2. Community / unofficial path to run PBS on ARM64

PBS is written in Rust, and its source is public at `https://git.proxmox.com/`. The source itself
does not build cleanly for ARM out of the box, so the community route is a patched build harness
rather than a plain `cargo build`.

### Primary project: `wofferl/proxmox-backup-arm64`

- URL:
  [GitHub - wofferl/proxmox-backup-arm64: Script for building Proxmox Backup Server 3.x (Bookworm) or 4.x (Trixie) for Armbian64](https://github.com/wofferl/proxmox-backup-arm64)
- What it is: a build script (`build.sh`) plus GitHub Actions (docker buildx) that compile the
  Proxmox source into **unofficial arm64 `.deb` packages** for both the server and the client.
- Currency (live-checked 2026-06-19): **actively maintained.** `main` branch targets **PBS 4.x on
  Debian 13 (Trixie)**; the `stable-3` branch targets PBS 3.x on Bookworm. The latest tagged release
  from GitHub's releases API was **4.2.1-1 (published 28 May 2026)**, matching the upstream PBS
  4.2.1 line. The repository README and main branch had already been updated for **4.2.2-1** about
  20 hours before the check, but there was not yet a `4.2.2-1` tagged release. Treat that as a good
  maintenance signal, not a guarantee; re-check the latest tag before installing. It ships prebuilt
  arm64 assets including `proxmox-backup-server`, `proxmox-backup-client`, and
  `proxmox-backup-client-static`.
- Hardware: explicitly supports Raspberry Pi (incl. Pi 5 with a kernel workaround), Helios64,
  Armbian64. Pi 4B is squarely in scope.

### Alternative community projects (context, not recommended as primary)

- `ayufan/pve-backup-server-dockerfiles` - unofficial PBS in a container for amd64/arm64,
  self-described as "unofficial, and unmaintained." Avoid for a primary backup target.
- `dexogen/pipbs` (PiPBS) - Raspberry-Pi-focused installer wrapper; thinner and less active than
  wofferl. Treat as secondary.

### How to install on Pi OS / Debian arm64 (high level + key commands)

Use a 64-bit OS (Raspberry Pi OS 64-bit / Debian 13 arm64). Prebuilt install is the fast path:

```bash
git clone https://github.com/wofferl/proxmox-backup-arm64
cd proxmox-backup-arm64
# Install the latest prebuilt arm64 packages:
./build.sh install
# ...or pin a version:
./build.sh install=4.2.1-1
# ...or just fetch the .debs without installing:
./build.sh download
```

If you instead build from source (slow on a Pi - "several hours"):

```bash
apt-get install -y --no-install-recommends \
 build-essential curl ca-certificates sudo git lintian fakeroot \
 pkg-config libudev-dev libssl-dev libapt-pkg-dev libclang-dev \
 libpam0g-dev zlib1g-dev nettle-dev
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
./build.sh # native build, or:
docker buildx build -o packages --platform linux/arm64 . # cross-build
```

Compiling needs **at least 4 GB RAM**; on a Pi add swap first:

```bash
sudo fallocate -l 4G /var/swap && sudo mkswap /var/swap && sudo swapon /var/swap
```

Post-install housekeeping noted by the project:

- The official Proxmox apt repo does not serve arm64, so disable it so OS updates don't break:
  `sudo sed -i 's#^Enabled:.*#Enabled: false#g' /etc/apt/sources.list.d/pbs-enterprise.sources`
- Raspberry **Pi 5** only: its default 16k-page kernel is incompatible with PBS; pin the 4k kernel
  by adding `kernel=kernel8.img` to `/boot/firmware/config.txt`. (Pi 4B is unaffected.)

### Maintenance / trust caveats (important)

- **Unsupported.** No Proxmox support; the forum explicitly tells you not to ask there.
- **Supply-chain trust.** You are running third-party-compiled binaries of your _backup_ system.
  Mitigate by building from source yourself or verifying the Actions provenance.
- **Update treadmill.** You track wofferl's releases, not Proxmox's apt repo; security/feature
  updates depend on that one maintainer keeping pace (he has, so far, very well).
- **Single maintainer / bus factor.** If the project stalls, you're stuck on the last build.

Sources:

- [GitHub - wofferl/proxmox-backup-arm64: Script for building Proxmox Backup Server 3.x (Bookworm) or 4.x (Trixie) for Armbian64](https://github.com/wofferl/proxmox-backup-arm64)
- [Releases · wofferl/proxmox-backup-arm64](https://github.com/wofferl/proxmox-backup-arm64/releases)
- [proxmox-backup-arm64/build.sh at main · wofferl/proxmox-backup-arm64](https://github.com/wofferl/proxmox-backup-arm64/blob/main/build.sh)
- [GitHub - ayufan/pve-backup-server-dockerfiles: Unofficial, and unmaintained build of proxmox-backup-server](https://github.com/ayufan/pve-backup-server-dockerfiles)
- [GitHub - dexogen/pipbs: PiPBS - Proxmox Backup Server for the Raspberry Pi](https://github.com/dexogen/pipbs)

## 3. Performance reality on a Pi 4B 8GB + USB HDD

For a small home dataset (a handful of small LXC/VM guests, say tens to low-hundreds of GB),
PBS-on-Pi is **usable** but **noticeably slow on the heavy operations**. PBS is chunk-based: data is
split into ~4 MiB chunks, each **SHA-256 hashed** for dedup and content addressing. That makes three
operations CPU- and IO-bound:

- **Backup ingest:** incremental + dedup means only changed chunks move, so day-to-day backups are
  light. RAM is fine (8 GB is plenty for a small datastore; PBS wants ~4 GB for OS/cache plus ~1 GiB
  per TiB of datastore).
- **Verification:** re-reads and re-hashes chunks. This is the worst case - bounded by Pi 4B SHA-256
  throughput AND by USB HDD random read. Expect it to be slow; schedule it off-hours and
  infrequently (e.g. weekly/monthly), not after every backup.
- **Garbage collection (GC):** walks the chunk store (lots of small-file metadata IO) and deletes
  unreferenced chunks. On a USB-attached spinning HDD this is IOPS-starved and slow; run it weekly,
  not daily.

Bottlenecks, ranked:

1. **USB-attached HDD IO** - biggest limiter. USB 3.0 + spinning disk gives poor random IOPS;
   GC/verify suffer most. Use a quality USB3-to-SATA bridge (avoid UAS-buggy adapters), and a single
   dedicated disk for the datastore.
2. **CPU for SHA-256 chunk hashing** - the Cortex-A72 in the Pi 4B has no dedicated SHA
   crypto-extension acceleration, so hashing is the CPU ceiling for verify and initial backup.
   (Telling detail: the project had to pin a 4k-page kernel on Pi 5 for PBS to work at all - PBS is
   sensitive to the platform, reinforcing "this is off the beaten path.")
3. **RAM** - least concern. 8 GB is comfortable for a small home datastore.
4. **Thermals** - sustained verify/GC can heat the SoC; use active cooling/heatsink.

Rough expectation: fine as a **second-copy / off-box target** that receives syncs and runs
occasional verify, NOT something you want as your only backup if you value fast restores or frequent
verification. Restores of small guests are acceptable; large multi-TB restores are a known pain
point reported by community users.

Sources:

- [Installation](https://pbs.proxmox.com/docs/installation.html) (RAM sizing: 4 GiB + 1 GiB/TiB)
- [GitHub - wofferl/proxmox-backup-arm64: Script for building Proxmox Backup Server 3.x (Bookworm) or 4.x (Trixie) for Armbian64](https://github.com/wofferl/proxmox-backup-arm64)
  (Pi 5 16k-page kernel incompatibility note)
- [Turn your Raspberry Pi into a Proxmox Backup Server - Bachelor Tech](https://bachelor-tech.com/detailed-guides/turn-your-raspberry-pi-into-a-proxmox-backup-server/)

## 4. Alternatives, ranked

### a. PBS as a VM on the amd64 Proxmox node; datastore on external USB HDD; Pi used separately

- **Officially supported:** YES (amd64 PBS in a VM is a normal, documented deployment).
- **Independent failure domain:** PARTIAL. The datastore lives on a separate physical USB disk
  (survives node-disk failure), but PBS runs _on the same box_ it is backing up - a node death,
  theft, or ransomware reaching the host can take both. Good for disk-failure/oops recovery, weak
  for "the whole box is gone."
- **Shell-only:** YES. Install PBS in the VM, `proxmox-backup-manager datastore create` on the USB
  mount, add it as a PVE storage with `pvesm`, run backups via `vzdump`/scheduled jobs.
- Verdict: the **supported, performant core** of the design - but it is not, by itself, an
  independent copy. Pair it with (b) or (c).

### b. PBS-on-node as primary, then replicate an independent copy to the Pi

Two sub-variants:

- **b1 - Second PBS on the Pi + sync job (needs community arm64 PBS).** Run the community arm64 PBS
  on the Pi as a second datastore, and configure a **PBS sync job** (pull is more secure; or push)
  from the node's PBS to the Pi. Set `remove-vanished=false` so the Pi keeps snapshots independently
  of the source's pruning.
- Independent failure domain: YES (separate box, separate power, separate disk).
- Officially supported: NO on the Pi side (community build); the sync mechanism itself is a
  first-class PBS feature.
- Shell-only: YES - `proxmox-backup-manager remote create` + `... sync-job create`.
- This is the only option that preserves **dedup/incremental on the second copy too** (the Pi copy
  is also a deduplicated PBS datastore, minimal writes).

- **b2 - Plain copy of the datastore to the Pi over SSH (rsync or ZFS send).** Keep PBS only on the
  node; periodically `rsync`/`zfs send` the _chunk datastore_ to the Pi as a dumb target.
- Independent failure domain: YES.
- Officially supported: the Pi runs no PBS, just SSH/ZFS - fully supported software, but note
  Proxmox's preferred replication is sync jobs, not rsyncing the raw chunk store. ZFS send of the
  datastore dataset is the cleaner, atomic variant.
- Shell-only: YES.
- Caveat: a raw-`rsync` copy is restorable only by another PBS reading that datastore; ZFS send/recv
  of the datastore dataset is the robust form. No second-side GC/verify unless you later mount it
  under a PBS.

### c. Pi as a plain backup target only (NFS/SMB/SSH/rsync or ZFS-on-USB), PBS stays on node

- **Independent failure domain:** YES (separate box).
- **Officially supported:** YES - the Pi runs only standard Linux file services; PBS stays amd64 on
  the node. You'd back up to PBS locally and _additionally_ dump/sync to the Pi.
- **Shell-only:** YES.
- **Downside:** if the Pi is just an NFS/SMB share holding `vzdump` archives or rsynced files, you
  **lose PBS dedup/incremental on that copy** (full-ish archives, more writes), unless you point a
  PBS datastore at it - which then needs a PBS somewhere. This is the simplest and most "supported,"
  but the least storage-efficient second copy.

## 5. Bottom-line recommendation for THIS user

Target: supported + independent off-box copy + dedup/minimal-writes + shell-only, on 1× amd64 PVE 9
node + 1× Pi 4B 8GB + external USB HDDs.

Recommended 3-2-1-ish architecture:

- **Primary (supported, fast): PBS as a VM on the amd64 node.** Install official amd64 PBS in a
  small VM (or LXC) on the node. Attach a **dedicated external USB HDD** and create the datastore
  there, so the primary backup store is on a _different physical disk_ than the guests. Schedule
  guest backups to it; run GC weekly and verify weekly/monthly. This is the workhorse: fast SHA-256
  on the amd64 CPU, dedup + incremental, and 100% officially supported and shell-driven
  (`proxmox-backup-manager`, `pvesm`, `vzdump`).

- **Independent second copy on the Pi (off-box failure domain): community arm64 PBS + sync job
  (option b1).** Stand up `wofferl/proxmox-backup-arm64` PBS on the Pi 4B with its own USB HDD
  datastore, and configure a **scheduled PBS pull sync** from the node's PBS to the Pi, with
  `remove-vanished=false`. The Pi copy is then an _independent, deduplicated_ second copy on
  separate hardware/power - exactly the "2 media, 1 off-box" leg of 3-2-1, with minimal writes
  because it's chunk-dedup, not full archives.

  If you are unwilling to run unsupported software on the backup path, substitute **option b2
  (ZFS-on-USB on the Pi receiving `zfs send` of the PBS datastore dataset)** - still an independent
  copy, still shell-only, no unofficial binaries, at the cost of the Pi not being a queryable PBS
  (it's cold storage until mounted under a PBS for restore/verify).

- **The "off-site" leg (optional, to make it true 3-2-1): rotate a USB HDD.** Periodically
  `zfs send` or `proxmox-backup-client`/sync a copy to a **second external USB HDD that you rotate
  off-site** (or to the Pi if the Pi lives in another room/building). This gives the third copy /
  geographic separation.

Why this is the best fit:

- **Supported where it matters:** the primary, fast, frequently-used store is official amd64 PBS.
  The unsupported community build is pushed to the _secondary_ role, where slowness and
  lack-of-support are tolerable and the blast radius is limited.
- **Independent failure domain:** the Pi (separate box/power/disk) holds a copy that survives node
  death, host ransomware, or a datastore-disk failure.
- **Dedup / minimal writes on both copies:** PBS-to-PBS sync keeps the second copy deduplicated and
  incremental - important for USB HDD longevity and the small home dataset.
- **Shell-only throughout:** every step is `proxmox-backup-manager` / `pvesm` / `vzdump` / `zfs` /
  `ssh`; the inaccessible PBS web GUI is never required.

If you want to minimize unsupported software entirely, the fully-supported variant is: **PBS-on-node
(amd64) as primary + Pi as a ZFS-on-USB `zfs send` target (b2/c) + a rotated off-site USB disk.**
You trade away dedup on the second copy's _queryability_ but keep an independent, supported,
shell-only off-box copy.

## Sources

- Proxmox Backup Server - Installation / system requirements:
  [Installation](https://pbs.proxmox.com/docs/installation.html)
- Managing Remotes & Sync (sync jobs, push/pull, remove-vanished):
  [Managing Remotes & Sync](https://pbs.proxmox.com/docs/managing-remotes.html)
- Backup Storage / datastore concepts: [Backup Storage](https://pbs.proxmox.com/docs/storage.html)
- Forum - "Install PBS on Raspberry Pi 4B" (staff: not officially supported):
  [Install PBS on Raspberry Pi 4B with Debian 12 running on it](https://forum.proxmox.com/threads/install-pbs-on-raspberry-pi-4b-with-debian-12-running-on-it.157995/)
- Forum - arm64 support for backup client:
  [Any plans for aarch/arm64 support in Proxmox Backup Client?](https://forum.proxmox.com/threads/any-plans-for-aarch-arm64-support-in-proxmox-backup-client.94496/)
- Community arm64 build (primary):
  [GitHub - wofferl/proxmox-backup-arm64: Script for building Proxmox Backup Server 3.x (Bookworm) or 4.x (Trixie) for Armbian64](https://github.com/wofferl/proxmox-backup-arm64)
- Community arm64 releases (4.2.1-1, May 2026):
  [Releases · wofferl/proxmox-backup-arm64](https://github.com/wofferl/proxmox-backup-arm64/releases)
- Community arm64 build script:
  [proxmox-backup-arm64/build.sh at main · wofferl/proxmox-backup-arm64](https://github.com/wofferl/proxmox-backup-arm64/blob/main/build.sh)
- Unofficial PBS Docker (amd64/arm64, unmaintained):
  [GitHub - ayufan/pve-backup-server-dockerfiles: Unofficial, and unmaintained build of proxmox-backup-server](https://github.com/ayufan/pve-backup-server-dockerfiles)
- PiPBS installer:
  [GitHub - dexogen/pipbs: PiPBS - Proxmox Backup Server for the Raspberry Pi](https://github.com/dexogen/pipbs)
- Pi-as-PBS community guide (performance/cooling context):
  [Turn your Raspberry Pi into a Proxmox Backup Server - Bachelor Tech](https://bachelor-tech.com/detailed-guides/turn-your-raspberry-pi-into-a-proxmox-backup-server/)
