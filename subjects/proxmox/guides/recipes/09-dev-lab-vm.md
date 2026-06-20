# Recipe: a throwaway dev-lab VM

## What you'll be able to do

You will spin up a disposable full [KVM/QEMU VM](../GLOSSARY.md) from your cloud-init
[template / linked clone](../GLOSSARY.md) in a single command, then treat it as something you are
free to break. You install whatever you want, take a [snapshot](../GLOSSARY.md) before each risky
experiment and roll back instantly when it goes wrong, and when you are done you delete the VM and
re-clone a fresh one. Every step is `qm` over SSH plus the [serial console](../GLOSSARY.md); the
disposability is the whole point.

## Before you start

This recipe reuses foundations rather than re-teaching them. It is the lightest, most
cross-referential recipe in this part, because almost everything it needs is already built in guides
06 and 07. You need:

- The Debian 13 golden cloud-init template at VMID 9000 from guide
  [07 -- Cloud-init templates](../07-cloud-init-templates.md). That guide builds the template once,
  wires `--serial0 socket --vga serial0` into it so every clone has a working `qm terminal` from its
  first boot, and bakes in the cloud-init user and your SSH key. This recipe clones it; do guide 07
  first.
- The `qm` lifecycle and the serial-console workflow from guide
  [06 -- Virtual machines with qm](../06-virtual-machines-with-qm.md): `qm clone`,
  `qm start`/`qm stop`/`qm status`, `qm terminal`, and the snapshot family (`qm snapshot`,
  `qm rollback`, `qm delsnapshot`). This recipe shows only the lines it uses and points you there
  for the teaching.

There is no helper script for this recipe, and none is needed. A dev-lab VM is one `qm clone` line;
there is nothing a community one-liner would save you and nothing to audit. This is the single
hand-built path, and it is the shortest in the corpus.

## Why a VM, not a container

Every other recipe in this part runs in an [unprivileged container](../GLOSSARY.md), because a
container is the lightest home for a long-lived service. A throwaway lab is the one case where a
full VM is the right call instead.

A VM gives you a full, isolated kernel of your own. That lets you install Docker, run nested
virtualization (a VM inside this VM), boot and test other Linux distributions, load kernel modules,
and otherwise make a mess at the kernel level, then trash the whole thing without touching the host.
An LXC shares the host's kernel, so those same experiments either do not work or risk the host
itself. The isolation a VM gives you is exactly what makes "break it and roll back" safe here, which
is why this lab is a VM and the services are containers.

## Clone it from your template

The lab is one clone of template 9000. Guide 07 covers linked versus full clones in full; the short
version is that a clone of a template defaults to a [template / linked clone](../GLOSSARY.md):
instant, space-efficient, sharing the template's base disk by copy-on-write. That is exactly what
you want for a throwaway, so take the default. Pass `--full` only if you want a copy that does not
depend on the template (for a lab you will keep around independently). On the Proxmox host, clone
9000 into a new VMID (here `150`):

```bash
qm clone 9000 150 --name devlab
```

That is the whole spin-up. A linked clone keeps it cheap and instant; a full clone is independent of
the template at the cost of copying the base disk.

The template's defaults are already lab-sized, but you can scale per experiment. A sensible dev-lab
size is about 2 vCPU, 2 to 4 GB of RAM, and a 20 GB disk; set the cores and memory with `qm set`
(and resize the disk with `qm disk resize`, as guide 07 shows, if you need more than the template
gives):

```bash
qm set 150 --cores 2 --memory 4096
```

Give it an address and start it. The template's cloud-init handles the user and your SSH key; set
the lab's IP the same way guide 07 does (`qm set 150 --ipconfig0 ip=...,gw=...`, or leave it on DHCP
for a throwaway), then start it and attach to the serial console to watch it boot:

```bash
qm start 150
qm terminal 150
```

Be honest about what the serial console shows, exactly as guide 06 teaches: host-side serial wiring
alone is not enough for a generic guest; the guest's own kernel must drive `ttyS0`. Here that comes
from the Debian cloud image itself, not from anything the template baked into the kernel command
line: the Debian cloud image already runs a getty and a kernel console on `ttyS0` out of the box
(that is what guide 07's template relies on). The template's `--serial0 socket --vga serial0` does
not add a `console=ttyS0` cmdline; it simply routes that serial output to `qm terminal`. With the
cloud image driving the console and the template routing it, on `qm terminal` you see the Debian
boot messages and then a real `login:` prompt. Press Enter once or twice if the screen looks idle
(Proxmox does not buffer serial, so a late attach can look blank until a keypress). Exit with Ctrl-O
(the letter O, not zero). Once cloud-init has run you also reach the lab over SSH as the template's
cloud-init user with your key, which is the comfortable day-to-day door.

## Use it safely: snapshot, break, roll back

This is the disposability workflow, and it is the reason the lab is a VM. Before any risky
experiment, take a snapshot; do the experiment; if it goes wrong, roll back to the snapshot and the
VM is exactly as it was. Guide 06 covers the snapshot family in full; here is the loop. Snapshot
first (a name plus an optional description), substituting your VMID:

```bash
qm snapshot 150 clean --description "fresh lab before experiment"
```

Now do whatever you came to do: install Docker, build something, break it. When you want to undo it
all, roll back to the snapshot and the disk (and, if you captured RAM, the running state) returns to
that moment:

```bash
qm rollback 150 clean
```

When you no longer need a snapshot, delete it to reclaim its space:

```bash
qm delsnapshot 150 clean
```

Snapshots need snapshot-capable storage. The host root in this corpus is btrfs, which qualifies:
`qm snapshot` uses native btrfs subvolume snapshots underneath, so they are instant and initially
share their blocks with the original (guide [09 -- Storage](../09-storage.md) covers what storage
supports snapshots and linked clones). Two cautions from guide 06 carry over: a snapshot lives on
the same disk as the VM, so it is a quick undo, not a backup; and the btrfs storage integration in
PVE 9 is still a technology preview, another reason not to lean on snapshots as a safety net. For a
throwaway lab that is fine, because the real reset is to delete and re-clone.

To fully reset the lab to a pristine state, do not bother rolling back: destroy it and clone a fresh
one. This is the cleanest reset of all, and it is why the lab exists. DESTRUCTIVE: `qm destroy`
permanently removes that VM and its disk, so confirm with `qm list` that 150 is still the throwaway
lab and not a VM you have since repurposed before you run this.

```bash
qm stop 150
qm destroy 150
qm clone 9000 150 --name devlab
```

You are back to a clean lab in one clone, with nothing carried over from the mess you made.

## Optional: nested virtualization and Docker

Two common lab uses need a word of setup.

For Docker: Docker belongs in a VM (this lab), not an LXC. Running the Docker daemon inside an
unprivileged container is awkward and fragile, while a full VM gives it the clean, isolated kernel
it expects. This is the same stance the Paperless recipe takes for its Docker workload. Inside the
lab over SSH, install Docker from its own repository as you would on any Debian host; nothing
Proxmox-specific is required.

For nested virtualization (running a VM, or a KVM-accelerated container runtime, inside the lab):
the guest needs to see the host CPU's virtualization features, which means the VM must use the host
CPU type. Guide 06 already creates lab VMs with `--cpu host`, but guide 07's cloud-init template
sets no `--cpu` flag, so a clone of it inherits the Proxmox default CPU type (x86-64-v2-AES on PVE
9), not `host`; confirm with `qm config 150` and set `host` explicitly if it is missing:

```bash
qm set 150 --cpu host
```

`--cpu host` passes the host CPU's features (including the virtualization extensions) straight
through to the guest, which is what nested KVM needs. If nested VMs still fail to start, the host's
KVM module may need its nested option enabled; this is a host-level kernel-module setting, so make
that change on the host and ground it in the Proxmox documentation before relying on it. For most
lab work (Docker, testing distros) plain `--cpu host` is enough and no host change is needed.

## Verify it worked

Three checks confirm the lab is alive and disposable the accessible way.

First, the clone and start succeeded. `qm clone` returns to the prompt with no error, and after
starting, the status reads running:

```bash
qm status 150
```

The expected key line is `status: running`, which proves the VM started.

Second, the serial console reaches a login prompt. On the Proxmox host:

```bash
qm terminal 150
```

Press Enter once or twice if the screen looks idle; you should see the Debian boot messages and then
a `login:` prompt, which proves the clone booted and the serial wiring it inherited from the
template works. Exit with Ctrl-O. Once cloud-init has finished you can also SSH in as the template's
cloud-init user with your key, which confirms the network and your access.

Third, the snapshot-and-rollback loop actually undoes a change. Make a visible change, then roll
back and confirm it is gone. Inside the lab over SSH or the serial console, create a marker file,
then on the host snapshot, change, and roll back:

```bash
# inside the lab:
touch /root/experiment-marker
# on the Proxmox host:
qm snapshot 150 testpoint
# inside the lab, make a change AFTER the snapshot:
rm /root/experiment-marker
# on the host, roll back:
qm rollback 150 testpoint
```

After the rollback, the marker file is present again inside the lab (the post-snapshot deletion was
undone), which proves the rollback worked and the disposability loop is sound. Delete the test
snapshot with `qm delsnapshot 150 testpoint` when you are done.

## Back it up

Do not back up the throwaway. This is the one recipe whose "Back it up" answer is, by design, that
you usually should not. A dev-lab VM is disposable on purpose: its value is that you can break it
and rebuild it, not that it holds anything you must keep.

The reproducibility lives elsewhere. The lab comes from the cloud-init template in guide
[07 -- Cloud-init templates](../07-cloud-init-templates.md), and anything you set up inside it
should come from provisioning you can re-run (a script, a Docker compose file, a git repository)
rather than from a snapshot you are afraid to lose. If you lose the lab, you re-clone the template
and re-run your provisioning. That is the whole design: keep the recipe, not the cake.

So the default stance is the opposite of every other recipe in this part: do not add the throwaway
lab to the Proxmox Backup Server job. If a particular lab stops being throwaway and becomes
something you actually care about, then it has graduated out of this recipe, and you treat it like
any other guest: add its VMID to the PBS backup job in guide
[17 -- Backups with Proxmox Backup Server](../17-backups-with-pbs.md), from where it rides along
into the off-box copy in guide
[18 -- The independent copy and restore](../18-the-independent-copy-and-restore.md). Until then, the
honest answer is to leave it out of the backup and lean on the template plus your provisioning to
rebuild it.

## Sources

- `research/round2-pve9/20-pve9-ecosystem-and-service-patterns.md` -- the throwaway dev/test VM
  per-service pattern (a dedicated VM cloned from the cloud-init template, pattern D, disposability
  in mind; a full isolated kernel so you can install Docker, run nested virtualization, test other
  distros, and trash it without risking the host, which an LXC cannot safely give you; cloning from
  the template makes spin-up the one-liner `qm clone 9000 <newid>`; sized 2 vCPU / 2-4 GB RAM / 20
  GB disk, a linked clone keeps it cheap, scale per experiment; reach via `qm terminal` serial
  console because the template set `--serial0 socket --vga serial0`, plus SSH; snapshot before each
  risky experiment and roll back instantly).
- Guide [06 -- Virtual machines with qm](../06-virtual-machines-with-qm.md) -- the `qm` lifecycle
  (`qm clone`, `qm start`/`qm stop`/`qm status`/`qm destroy`, `qm set`), the
  `--serial0 socket --vga serial0` serial console and `qm terminal` (and the honest "the guest's own
  kernel must drive ttyS0" caveat), the `--cpu host` CPU type, and the snapshot family
  (`qm snapshot`, `qm rollback`, `qm delsnapshot`, `qm listsnapshot`) with its "a snapshot is not a
  backup" and btrfs-technology-preview cautions.
- Guide [07 -- Cloud-init templates](../07-cloud-init-templates.md) -- the Debian 13 golden
  cloud-init template at VMID 9000, the `--serial0 socket --vga serial0` baked into it, the
  cloud-init user/key, linked-versus-full clones (`qm clone 9000 <id>` defaults to a linked clone;
  `--full` for an independent copy), and `qm disk resize` for sizing.
- Guide [09 -- Storage](../09-storage.md) -- which storage supports snapshots and linked clones (the
  btrfs host root qualifies, and `qm snapshot` uses native btrfs subvolume snapshots).
- Official `qm` documentation -- the `qm clone`, `qm snapshot`/`qm rollback`/`qm delsnapshot`, and
  `qm set --cpu host` command surface, consistent with guides 06 and 07.

---

Previous: [08 -- Personal website via Cloudflare Tunnel](08-personal-website-cloudflare-tunnel.md) |
Next: [10 -- Hermes Agent](10-hermes-agent.md)
