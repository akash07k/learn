# Cheatsheet: qm (virtual machines)

`qm` drives the whole lifecycle of a KVM/QEMU VM on the Proxmox host: create it, power it, configure
it, snapshot and clone it, and reach its serial console. Reach for it whenever you are working with
a full VM (a guest with its own kernel) rather than a container; containers are the `pct` card, and
this card is VMs only. Every line below is plain text you run as root on the Proxmox host over SSH,
with no web GUI anywhere. For the why and the worked builds, see the full guide
[06 -- Virtual machines with qm](../06-virtual-machines-with-qm.md).

`<vmid>` is the VM's numeric ID; substitute your own.

## Lifecycle

- `qm create <vmid> [options]` -- create a VM (options map one-to-one to config lines).
- `qm start <vmid>` -- power on.
- `qm shutdown <vmid>` -- graceful ACPI or guest-agent shutdown.
- `qm stop <vmid>` -- hard power-off (pulls the virtual plug; no clean guest shutdown).
- `qm reboot <vmid>` -- graceful restart; note a newly added `serial0` needs a full stop then start,
  not a reboot, to take effect.
- `qm destroy <vmid> [--purge]` -- DESTRUCTIVE: deletes the VM and its config; `--purge` also drops
  it from backup jobs and HA.
- `qm unlock <vmid>` -- clear a stale `lock:` line left by an interrupted operation.

## Check state

- `qm list` -- every VM with its status (look for `running`).
- `qm status <vmid> [--verbose]` -- the status of one VM.
- `qm config <vmid>` -- the effective config (the `key: value` lines).
- `qm pending <vmid>` -- values that are set but waiting for a power-cycle.
- `qm showcmd <vmid> --pretty` -- the exact KVM command line Proxmox would run; the best aid when a
  VM will not start.

## Configure and disks

`qm set` is the workhorse: each `--<key> <value>` writes one line into
`/etc/pve/qemu-server/<vmid>.conf` and hotplugs the change where the device supports it.

- `qm set <vmid> --serial0 socket` -- add a serial port backed by a host socket (pair with
  `--vga serial0` on Linux to route the display there).
- `qm set <vmid> --memory 4096` -- RAM in MiB; add `--balloon 2048` for a reclaim floor,
  `--balloon 0` to disable ballooning.
- `qm set <vmid> --cores 4` -- vCPU cores (keep `--sockets 1` on a single-socket consumer CPU).
- `qm set <vmid> --cpu host` -- expose every host CPU flag; right on a single node that never
  live-migrates (the PVE 9 default is the portable `x86-64-v2-AES`).
- `qm set <vmid> --net0 virtio,bridge=vmbr0` -- a virtio NIC on bridge `vmbr0`; append `,firewall=1`
  or `,tag=<vlan>` as needed.
- `qm set <vmid> --scsi0 local-btrfs:32,iothread=1,discard=on,ssd=1` -- allocate a 32 GiB OS disk on
  `local-btrfs` (`iothread=1` pairs with `virtio-scsi-single`; `discard`/`ssd` enable TRIM).
- `qm set <vmid> --boot 'order=scsi0;ide2;net0'` -- boot device priority; quote the value because
  `;` is a shell separator.
- `qm set <vmid> --agent enabled=1` -- enable guest-agent integration (you still install
  qemu-guest-agent inside the guest).
- `qm set <vmid> --ide2 local-btrfs:iso/<file>.iso,media=cdrom` -- attach an installer ISO;
  `--ide2 none,media=cdrom` detaches it.
- `qm disk resize <vmid> scsi0 +18G` -- grow a disk (the old bare `resize` is an alias).
- `qm disk move <vmid> scsi0 <storage>` -- move a disk to another storage.
- `qm disk rescan` -- pick up volumes added on disk out of band.
- `qm disk import <vmid> <host-path> <storage>` -- import a disk image (source is a host filesystem
  path, not a `storage:` id); lands as an `unused` disk to attach next.
- `qm set <vmid> --scsi1 local-btrfs:0,import-from=<host-path>` -- the one-shot import-and-attach
  form (size `0` is replaced by the image size).
- `qm importovf <vmid> <file.ovf> <storage>` -- import a whole-appliance OVA/OVF.
- `qm cloudinit dump <vmid> user` -- print the user-data (or `network`/`meta`) a cloud-init VM would
  get, without booting it.
- `qm cloudinit update <vmid>` -- regenerate the cached cloud-init disk after changing any `ci*`
  option or snippet.

## Snapshots

- `qm snapshot <vmid> <name> [--description "..."]` -- take a snapshot; add `--vmstate 1` to also
  capture live RAM.
- `qm listsnapshot <vmid>` -- list snapshots.
- `qm rollback <vmid> <name>` -- DESTRUCTIVE: revert the VM to a snapshot, discarding everything
  since.
- `qm delsnapshot <vmid> <name>` -- remove a snapshot.

A snapshot lives on the same storage as the VM, so it is a quick undo, not a backup.

## Templates and clones

- `qm template <vmid>` -- mark a prepared VM read-only as a template; you clone from it, you do not
  run it.
- `qm clone <vmid> <newid> --name <name>` -- clone; from a template this defaults to a LINKED clone
  (thin, copy-on-write, depends on the template's base disk, so do not delete a template with linked
  clones).
- `qm clone <vmid> <newid> --name <name> --full` -- force an independent FULL copy (cloning a
  non-template VM is always full).

## Console and agent

- `qm terminal <vmid>` -- the accessible serial console; press Enter once or twice to wake it, exit
  with Ctrl-O (the letter O). REQUIRES a serial device on the VM (`qm set <vmid> --serial0 socket`),
  and a generic installer also needs its guest kernel pointed at `ttyS0`; see guides
  [06](../06-virtual-machines-with-qm.md) and [07](../07-cloud-init-templates.md). It does not work
  out of the box without that wiring.
- `qm agent <vmid> <command>` -- run a guest-agent command, e.g.
  `qm agent <vmid> network-get-interfaces` to read the guest's IPs (needs qemu-guest-agent installed
  and running inside the guest).
- `qm monitor <vmid>` -- the low-level QEMU monitor (`qm>` prompt) for advanced poking; rarely
  needed.

## Full treatment

This card is a reminder, not a lesson. For the why and worked examples, see:

- [06 -- Virtual machines with qm](../06-virtual-machines-with-qm.md) -- the full `qm` surface, the
  config file, the serial-first build, snapshots, clones, and disk import.
- [07 -- Cloud-init templates](../07-cloud-init-templates.md) -- the golden template, `qm clone` per
  service, and the `qm cloudinit` workflow.
- [08 -- Windows guests](../08-windows-guests.md) -- the Windows differences: `--vga std` plus
  `--serial0 socket`, the vTPM, and SAC over `qm terminal`.

---

Back to the [cheatsheets index](README.md). Browse all the [guides](../README.md).
