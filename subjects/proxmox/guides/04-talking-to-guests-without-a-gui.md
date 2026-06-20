# Talking to guests without a GUI

## What you'll be able to do

By the end of this guide you will know the three accessible ways into a guest and when to reach for
each: the serial console for a virtual machine, the `pct enter` family for a container, and SSH into
either once it is reachable. This is the reference map; guides 05 through 07 then walk these doors
hands-on with real guests. You will also learn the two cross-cutting habits that make the rest of
the series work: wire serial into a VM before you install its OS, and provision every guest so it
comes up SSH-reachable.

This guide is deliberately conceptual. There is no running guest yet: the first container is created
in guide 05 and the first VM in guide 06. Where a step needs a live guest you cannot act on today,
the text says so and points at the later guide.

## The three doors into a guest

A graphical hypervisor would tell you to open the noVNC or SPICE console in a web browser to "see
the screen" of a guest. This corpus does not use that path for daily operation -- with one narrow
install-time exception covered later in this guide -- because a graphical console is unreadable with
a screen reader and the web GUI is out of reach. Instead there are three text doors, all driven from
the shell over SSH:

- The VM serial console, reached with `qm terminal <vmid>`. A KVM/QEMU VM has emulated hardware and
  its own kernel, so you talk to it through a virtual serial line that carries plain text.
- The container access verbs, `pct enter` / `pct exec` / `pct console`. An LXC container shares the
  host's kernel and runs its own userspace, so you can step straight into a shell inside it without
  any serial emulation.
- SSH into the guest itself, once it has an IP and your key. This is the goal state for daily work;
  the first two doors become the fallback you use to set SSH up and to recover if it ever breaks.

The split matters: a VM uses the serial console and a container uses `pct enter`, because they are
different guest types. You do not `pct enter` a VM, and you do not need `qm terminal` to get a shell
in a container. Knowing which door belongs to which guest is half of this guide.

## Door 1 -- the VM serial console

A VM has no usable screen for you, so you give it a serial line and route its display to that line.
Two `qm set` commands do this, and you run them once when you build the VM, before installing any
OS.

```bash
qm set <vmid> --serial0 socket
qm set <vmid> --vga serial0
```

The first command, `--serial0 socket`, adds a serial port backed by a Unix socket on the host. The
second, `--vga serial0`, redirects the VM's primary display to that serial port. With both set, the
bootloader, the boot menu, and a serial-aware installer render as text over the serial line instead
of to a graphical screen you cannot read. How much firmware-level output reaches the serial line
depends on the firmware: SeaBIOS mirrors to serial readily, while OVMF/UEFI serial output depends on
the firmware build and its early menus are more limited. Wiring this before the OS install is the
whole point: it makes even the installer reachable.

To attach to the serial line from the host shell:

```bash
qm terminal <vmid>
```

After it connects, press Enter once or twice to get output or a login prompt. To detach, press
Ctrl-O (the letter O, not zero; the literal escape character is written `^O`). This is the key to
remember for VMs: Ctrl-O leaves `qm terminal`. (You can change it with `--escape`, but Ctrl-O is the
default and what the rest of the series assumes.)

One gotcha catches everyone. A serial port you add to an already-running VM does not take effect
until the VM is fully power-cycled. A reboot from inside the guest is not enough; you need a full
`qm stop <vmid>` followed by `qm start <vmid>` on the host so QEMU re-reads the hardware config. If
you added `serial0` and `qm terminal` shows nothing, this is almost always why.

If `serial0` ever misbehaves, you can add a second serial port and connect to it as a fallback:

```bash
qm terminal <vmid> --iface serial1
```

The running-VM walkthrough, where you build a VM and drive its install over `qm terminal`, is guide
06 (a later guide). Here you only need the shape of the door.

## Keep serial working inside the guest

Wiring serial on the host gets you through firmware and the installer. Once an OS is installed, the
guest itself must keep a login on the serial line, or `qm terminal` will connect to a silent port
after the first reboot. There are two pieces, both inside the guest.

First, put the kernel's console on the serial line by setting `GRUB_CMDLINE_LINUX` in
`/etc/default/grub` to:

```text
GRUB_CMDLINE_LINUX="console=tty0 console=ttyS0,115200"
```

To make that change without a terminal editor, edit the file the accessible way from guide 02's
"Editing files accessibly" (a `sed` in place on the existing `GRUB_CMDLINE_LINUX` line, or VS Code
Remote-SSH); read it back with `grep GRUB_CMDLINE_LINUX /etc/default/grub` to confirm a single,
correct line.

The last `console=` listed becomes the primary console, so `ttyS0` must come last. That sends the
kernel and init messages, and the boot menu, to serial while still keeping the local screen. Apply
it with:

```bash
update-grub
```

Second, run a login prompt (a getty) on the serial line. On a systemd guest such as Debian 13 this
is one command:

```bash
systemctl enable --now serial-getty@ttyS0.service
```

The `serial-getty@ttyS0` template defaults to 115200 baud and respawns the login prompt, so after a
reboot `qm terminal` lands you at a login. Debian and Ubuntu cloud images already enable `ttyS0` out
of the box, so the cloud-init path in guide 07 skips this whole section; you only do this by hand
when you install from an ISO.

## Door 2 -- into a container with pct

A container does not need a serial console. Because it shares the host kernel, `pct` can drop you
straight into it. There are three verbs, in increasing rawness.

`pct enter <vmid>` opens a clean interactive root shell inside the container. This is the
screen-reader-friendly default: it is a normal PTY that your screen reader reads exactly like any
SSH session, and there is no escape-key dance to leave it (you exit the shell with `exit` or Ctrl-D,
the way you leave any shell).

```bash
pct enter <vmid>
```

`pct exec <vmid> -- <cmd>` runs a single command inside the container and returns. The `--`
separator is important: everything after it is the command to run inside the container, so its own
flags go to that command and not to `pct`. For example:

```bash
pct exec <vmid> -- systemctl status nginx
```

`pct console <vmid>` attaches to the container's raw console, the literal tty. This is the one with
an escape sequence: you leave it by pressing Ctrl-a then q. That is the container counterpart to the
VM's Ctrl-O, and the two are different on purpose, so keep them straight: Ctrl-O detaches a VM's
`qm terminal`, and Ctrl-a then q detaches a container's `pct console`. If Ctrl-a clashes with your
terminal multiplexer, override it with `--escape`:

```bash
pct console <vmid> --escape '^b'
```

There is one `pct` environment detail to internalize. The `--keep-env` option controls whether host
environment variables are carried into the session. The current Proxmox VE 9.2 `pct` manual still
lists the default as 1 (on), but also warns that this default is changing. Do not rely on the
implicit default. If you want a clean environment, say so; if you depend on inherited variables, say
so too:

```bash
pct enter <vmid> --keep-env 0
pct enter <vmid> --keep-env 1
```

For daily work, prefer `pct enter`: it is a clean shell with no escape-key dance. Reach for
`pct console` when you need to watch a container boot or fix a broken network from the raw console.
The running-container walkthrough, where you create a container and step into it, is guide 05 (a
later guide).

## Door 3 -- SSH into the guest

The serial console and `pct enter` are how you reach a guest before it is set up, and your fallback
if it breaks. The goal state for everyday work is different: you want to live in SSH, connecting
straight into the guest the way you SSH into the host, not going through the host's console every
time.

Getting there means baking your SSH public key into the guest at creation, so it comes up already
reachable:

- For a container, inject the key when you create it with `pct create ... --ssh-public-keys <file>`,
  where the file holds your public key. The container boots with that key in root's
  `authorized_keys`.
- For a VM, supply the key through cloud-init with `--sshkeys <file>`. The cloud image reads it on
  first boot and comes up SSH-reachable with no console interaction. This is the cloud-init path,
  covered in guide 07.

One safety note carries over from guide 02. A key you bake in this way can land in pmxcfs (the
`/etc/pve` filesystem), and that carries the same lockout caveat guide 02 covered for the host's own
`authorized_keys`: if pmxcfs is down, a key stored there disappears. That is why guide 02 keeps an
independent copy in `~/.ssh/authorized_keys2` (outside `/etc/pve`), and why the serial console and
`pct enter` are your always-available fallback. Keep them in reach, and if SSH into a guest ever
fails, you still have a door in.

## Which door when

A short decision list:

- A VM with no OS installed yet: use the serial console (`qm terminal`), because there is nothing to
  SSH into yet.
- A container: use `pct enter` for a shell, `pct exec` for one command.
- Either guest, once it is provisioned with your key: use SSH, and treat the console doors as
  fallback.
- Watching a boot or repairing a broken network: use `qm terminal` for a VM or `pct console` for a
  container, the raw consoles that show early output.

One narrow exception to the "no graphical console" rule applies at install time only. When a guest's
own graphical installer has no serial or text path -- Windows is the main case -- you drive it by
ear over the SPICE console, listening to Narrator inside the installer. This is the Console-by-ear
technique and it is covered in [08 -- Windows guests](08-windows-guests.md). It is an install-time
and recovery-only workaround; daily operation stays on the normal non-console paths -- SSH for
Linux, RDP for Windows (guide 08), and an appliance's own web UI where that is how it is run.

For Linux, the picture is more nuanced. The same by-ear principle applies to a graphical-only live
installer (such as the Ubuntu desktop live ISO with Orca over SPICE); guide 08 demonstrates the
technique worked through for Windows, and you adapt the same listening approach to the Linux
installer's screen reader. However, for Debian and any installer that offers a text mode, the serial
console in this guide is strictly better and stays the default -- no SPICE needed. Debian's
text-mode installer renders over the serial console this way. Debian also ships a separate
speech-synthesis installer, which is a different mechanism: at the boot menu you hear a beep, then
pressing `s` followed by Enter selects the speech path, and from there `espeakup` speaks the install
as synthesized audio carried over the SPICE audio channel -- the Console-by-ear technique -- not
over the serial line, which carries text only.

## Verify it worked

You can confirm the tooling and the escape keys right now, without a running guest. First confirm
your version, because the `pct --keep-env` default is version-sensitive:

```bash
pveversion
```

You should see a `9.x` release. Then check that the access commands exist and print their usage:

```bash
qm help terminal
pct help enter
```

`qm help terminal` prints the `qm terminal` usage, including the `--escape` and `--iface` options.
`pct help enter` prints the `pct enter` usage, including `--keep-env`. Seeing the usage text
confirms the tools are installed and lets you verify the default on your exact host.

Finally, list the guests:

```bash
qm list
pct list
```

On a fresh host both are likely empty, printing only a header line or nothing. That is the expected
output and it is not an error: it means you have no guests yet and are ready for guides 05 and 06,
which create the first ones. The real end-to-end verification, attaching to a live guest, seeing a
prompt, and detaching with the right escape key (Ctrl-O for the VM, Ctrl-a then q for the container
console), happens in guides 05 and 06 once those guests exist.

## Sources

- `research/round2-pve9/09-pve9-vms-qm.md` - section 5, the serial console accessibility path:
  `qm set <vmid> --serial0 socket` and `--vga serial0` (a socket-backed serial port and routing the
  VM's primary display to it), `qm terminal` with Ctrl-O to exit and `--iface serial1` as a
  fallback, and the gotcha that a newly added `serial0` needs a full `qm stop` then `qm start`, not
  a reboot. Section 5c backs the in-guest serial setup: `console=tty0 console=ttyS0,115200` last in
  `/etc/default/grub`, `update-grub`, and `systemctl enable --now serial-getty@ttyS0.service`, plus
  the note that cloud images already enable `ttyS0`.
- `research/round2-pve9/10-pve9-lxc-pct.md` - the "Access paths" section: `pct enter` (clean
  interactive shell), `pct exec -- <cmd>` (one command, the `--` separator), `pct console` (raw
  console, escape Ctrl-a then q, override with `--escape`), the guidance to prefer `pct enter` for
  daily work, and the version-sensitive `--keep-env` default.
- `research/round2-pve9/11-pve9-cloudinit-templating.md` - section 1, why the goal is guests that
  boot already SSH-reachable, and the cloud-init `--sshkeys` and container `--ssh-public-keys`
  key-injection paths that get you there.
- `GLOSSARY.md` and `CONTEXT.md` - the canonical definitions of the serial console, `qm`, `pct`,
  KVM/QEMU VM, LXC container, guest, pmxcfs, and the three superpowers reused here.
- Proxmox VE documentation: [Serial Terminal](https://pve.proxmox.com/wiki/Serial_Terminal),
  [qm.1](https://pve.proxmox.com/pve-docs/qm.1.html), and
  [pct.1](https://pve.proxmox.com/pve-docs/pct.1.html).

---

Previous: [03 -- Repositories, updates, and the host](03-repositories-updates-and-the-host.md) |
Next: [05 -- Containers with LXC and pct](05-containers-with-lxc-and-pct.md)
