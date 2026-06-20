# Cheatsheet: pct (LXC containers)

`pct` drives the whole lifecycle of an LXC container on the Proxmox host: create it, power it,
configure it, snapshot and clone it, and (the accessibility win) step straight into a root shell
inside it. Reach for it whenever you are working with a container rather than a full VM; VMs are the
[qm](qm.md) card, and this card is containers only. Every line below is plain text you run as root
on the Proxmox host over SSH, with no web GUI anywhere. For the why and the worked builds, see the
full guide [05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md).

`<vmid>` is the container's numeric ID; substitute your own.

## Lifecycle

- `pct create <vmid> <storage>:vztmpl/<template> [options]` -- create a container from an OS
  template volid (`local-btrfs:vztmpl/debian-13-standard_*_amd64.tar.zst`; on this btrfs-root node
  the active storage is `local-btrfs`, since the plain `local` directory storage is disabled);
  options map one-to-one to config lines.
- `pct start <vmid>` -- power on.
- `pct shutdown <vmid>` -- graceful shutdown from inside the container.
- `pct stop <vmid>` -- hard stop (pulls the plug; no clean shutdown).
- `pct reboot <vmid>` -- graceful restart; also the way to apply changes after a by-hand edit of the
  config file.
- `pct destroy <vmid>` -- DESTRUCTIVE: deletes the container and its config; blocked if
  `protection: 1` is set.

The norm in this corpus is an unprivileged container, so create with `--unprivileged 1` (the
recommended setting, and the GUI default); a privileged container needs `--unprivileged 0` plus
extra privilege.

## Check state

- `pct list` -- every container with its status (look for `running`).
- `pct status <vmid>` -- the status of one container.
- `pct config <vmid>` -- the effective config (the `key: value` lines), for example to confirm
  `unprivileged: 1`.

The config file itself is `/etc/pve/lxc/<vmid>.conf` on pmxcfs; `pct config` prints the effective
version.

## Get inside

This is the accessibility point of containers: no console wiring, no serial port, no networking
needed to get a shell.

- `pct enter <vmid>` -- drop straight into a clean interactive root shell inside the container; a
  normal PTY your screen reader reads like any SSH session, exit with `exit` or Ctrl-D. Always
  available as the fallback door even when SSH is not reachable. Works on LXC containers on the
  host, NOT on VMs.
- `pct exec <vmid> -- <cmd>` -- run one command inside the container; the `--` separates pct's
  options from the command (`pct exec 110 -- cat /etc/os-release`).
- `pct console <vmid>` -- attach to the container's console (tty).
- The `--keep-env` default is version-sensitive. The current PVE 9.2 manual still lists it as on
  while warning that the default is changing. Pass `--keep-env 0` for a clean environment or
  `--keep-env 1` to inherit the host's environment variables.

Containers use `pct enter` and `pct console`; VMs instead use `qm terminal` (see the [qm](qm.md)
card). Do not reach for `pct enter` on a VM.

## Configure and disks

`pct set` is the workhorse: each `--<key> <value>` writes one line into `/etc/pve/lxc/<vmid>.conf`
and validates the change. Apply by-hand edits with `pct reboot <vmid>`.

- `pct set <vmid> --memory 2048` -- RAM limit in MB (add `--swap 512` for swap in MB).
- `pct set <vmid> --cores 2` -- number of CPU cores visible to the container.
- `pct set <vmid> --net0 name=eth0,bridge=vmbr0,ip=<addr>/24,gw=<gw>` -- network interface with a
  static address (this corpus's default); swap for `ip=dhcp` to use DHCP, append `,tag=<vlan>` for a
  VLAN, `,firewall=1` for the firewall.
- `pct set <vmid> --mp0 /srv/media,mp=/media,ro=1` -- a bind mount (source is an absolute host
  path), here read-only; a volume mount instead names a storage volid
  (`local-btrfs:20,mp=/var/lib/data,backup=1`). Bind mounts on an unprivileged container need the
  idmap fix from guide 05.
- `pct set <vmid> --onboot 1` -- auto-start the container when the host boots.
- `pct resize <vmid> rootfs +18G` -- grow a volume (rootfs or an `mp[n]`); growth only.

There is no `pct set` option for `lxc.idmap`; that is the rare line you append to the config file by
hand, then `pct reboot`.

## Snapshots

- `pct snapshot <vmid> <name> [--description "..."]` -- take a snapshot (native btrfs subvolume
  snapshot on btrfs storage); covers only Proxmox-managed volumes, not bind mounts.
- `pct listsnapshot <vmid>` -- list snapshots.
- `pct rollback <vmid> <name>` -- DESTRUCTIVE: revert the container to a snapshot, discarding
  everything since.
- `pct delsnapshot <vmid> <name>` -- remove a snapshot.

A snapshot lives on the same disk as the original, so it is a quick undo, not a backup.

## Templates, clones, restore

- `pct template <vmid>` -- mark a prepared container read-only as a template; you clone from it, you
  do not run it.
- `pct clone <vmid> <newid> [--hostname <name>]` -- clone; from a template this can be a LINKED
  clone (thin, copy-on-write, depends on the template's base, so do not delete a template with
  linked clones), otherwise a FULL independent copy.
- `pct restore <vmid> <archive> [options]` -- create a container by restoring a `vzdump` backup
  archive into the given VMID.

## Full treatment

This card is a reminder, not a lesson. For the why and worked examples, see:

- [05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md) -- the full `pct`
  surface, `pveam` templates, the config file, the unprivileged idmap fix, bind versus volume
  mounts, snapshots, clones, and the PVE 9 deltas.
- [04 -- Talking to guests without a GUI](../04-talking-to-guests-without-a-gui.md) -- the access
  verbs (`pct enter`, `pct exec`, `pct console`) and the `--keep-env` default in full.

---

Back to the [cheatsheets index](README.md). Browse all the [guides](../README.md).
