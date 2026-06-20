# The shell and the API: living in the control plane

## What you'll be able to do

By the end of this guide you will be at home in the control plane you operate the Proxmox host
through. You will SSH in from the control station with the key you baked into the install,
understand `/etc/pve` (pmxcfs) as the single source of truth for the host's configuration, and use
`pvesh` as the universal text gateway to everything the web GUI can do. This is where the central
idea of this corpus becomes concrete: the GUI is a thin client over the REST API, and `pvesh` is
that same API rendered as text.

There is nothing destructive here. This guide is a tour and a set of read-only commands, so you can
run every one of them on a fresh host without changing anything.

## Connecting

You drive the Proxmox host from the control station over SSH, and you already have the way in: guide
01 baked your public key into the host with `root-ssh-keys`, so key-based login as root works the
moment the host finishes booting. From the control station you connect with the private half of that
key.

The shape of the command is the same whether you run it from PowerShell or from WSL on the control
station:

```bash
ssh -i ~/.ssh/<key> root@<host-ip>
```

So with the key named `proxmox` from guide 01, and a host at `192.168.1.10`, that is:

```bash
ssh -i ~/.ssh/proxmox root@192.168.1.10
```

From PowerShell the key path is written `$env:USERPROFILE\.ssh\proxmox`; from WSL it is
`~/.ssh/proxmox`. The OpenSSH client ships with both, so no extra software is needed on the control
station.

A note on the address before you go further. The host is headless and you reach it only by its IP,
so that IP needs to be stable. If it came from DHCP (as the guide 01 install did), the router is
free to hand it a different address on a future lease, and then your saved `ssh` command points at
nothing. The fix is a DHCP reservation: in the router's admin page, tie the host's MAC address to a
fixed IP, so the host always gets the same address from DHCP. (Setting a static IP on the host
itself, in `/etc/network/interfaces`, is the other option, but that is a networking change on a
headless machine with the lockout risks that carries, so it is covered later. A DHCP reservation
gets you a stable address today with no host-side change.)

To save typing the key and address every time, you can add a short stanza to the control station's
SSH config (`~/.ssh/config`), giving the host a name:

```text
Host pve
 HostName 192.168.1.10
 User root
 IdentityFile ~/.ssh/proxmox
```

After that, `ssh pve` is enough. The rest of this corpus assumes you are logged in to the host this
way.

## The lay of the land: /etc/pve

Once you are in, the first thing to understand is where the host keeps its mind. Every piece of
Proxmox configuration (storage, guests, users, firewall rules, notification settings) lives under
one directory: `/etc/pve`. This is the single source of truth. Change something here and the host's
behaviour changes; this is the same place the GUI would be writing to.

But `/etc/pve` is not an ordinary directory on the btrfs root disk. It is the mount point for
**pmxcfs**, the Proxmox Cluster File System: a small FUSE filesystem, implemented in user space,
backed by a single SQLite database at `/var/lib/pve-cluster/config.db`. The live tree is held in RAM
and persisted to that database. It is provided by the `pve-cluster` service, and despite the word
"cluster" in the name, it is present and mounted even on a single standalone node. There is no "not
using pmxcfs"; every Proxmox install stores its config exactly here.

You can confirm it is a FUSE mount rather than part of the btrfs root:

```bash
findmnt /etc/pve
```

That reports the source as `pmxcfs` and the `FSTYPE` field as `fuse`, which is the proof that this
directory is a database wearing a filesystem's clothes.

### A read-only tour

Here is what lives under `/etc/pve` and is worth knowing by name. You can list any of these to read
them, but read the safety note below before you think about editing them by hand. The top-level,
datacenter-wide files first:

- `storage.cfg` - the storage configuration: every configured storage, its backend type, its content
  types, and its options. This is the file you will touch most as you add storage.
- `datacenter.cfg` - datacenter-wide options (keyboard layout, console defaults, migration defaults,
  and similar). "Datacenter" here is just the single host.
- `user.cfg` - access control: the users, groups, roles, and ACL assignments (everything except
  passwords).
- `jobs.cfg` - scheduled jobs, including the modern backup schedules driven by `pvescheduler`.
- `notifications.cfg` - the notification system's targets and matchers (where alerts go).

Then the per-node and grouped subtrees:

- `qemu-server/` - one config file per virtual machine, as `qemu-server/<vmid>.conf`. This is a
  convenience shortcut that always points at this node's VM configs.
- `lxc/` - one config file per container, as `lxc/<vmid>.conf`, the container counterpart of the
  above.
- `nodes/<node>/` - the per-node subtree, named after this host's hostname. On a single node there
  is exactly one such directory. The `qemu-server/` and `lxc/` shortcuts above point inside it, and
  `nodes/<node>/config` holds the node-level settings that `pvenode` reads and writes.
- `firewall/` - the plain-text firewall rule files: `cluster.fw` for datacenter-wide rules,
  `<node>.fw` for the host, and `<vmid>.fw` per guest.
- `priv/` - the private, root-only subtree. It holds the secrets: `priv/shadow.cfg` (password hashes
  for built-in users), `priv/token.cfg` (API token secrets), `priv/tfa.cfg` (two-factor config),
  `priv/authorized_keys` (the SSH public keys managed through the API), and the cluster CA private
  key. Unlike the rest of `/etc/pve`, this is readable only by root.

A few of these you have already met indirectly. The VM and container config files under
`qemu-server/` and `lxc/` are the same files guide 00 named when it described where a guest's
configuration lives.

### The safety notes

Two things about pmxcfs matter before you ever write to it.

First, it goes **read-only without quorum**. In a real cluster, pmxcfs makes `/etc/pve` read-only
whenever a node cannot reach a majority of its peers, to stop conflicting writes. On a single node
this almost never bites you, because a node that was never joined to a cluster is quorate by default
(it expects exactly one vote, its own), so `/etc/pve` is writable normally. You would only see the
read-only state if cluster config had been left lying around from a past experiment. If you ever
find that even root cannot write to `/etc/pve` (a `touch /etc/pve/test` fails read-only, or config
changes are refused), that lost-quorum state is the cause, and it is recoverable: restore
writability with `pvecm expected 1`, which lowers the expected vote count to one (non-destructive
and immediate, it only changes the quorum expectation). If a stray `corosync`/cluster config left
over from a past experiment is why it lost quorum in the first place, that leftover config is what
to remove once you are writable again.

Second, and the rule to carry from here on: **do not hand-edit these files casually.** pmxcfs is a
config API surface, not a scratch disk. It is deliberately not a full POSIX filesystem (you cannot
make your own symlinks in it, you cannot chmod its files, and some atomic-write tricks behave
NFS-like), and each file has a tool that writes it safely and validates what you wrote. Edit
`user.cfg` with `pveum`, `storage.cfg` with `pvesm`, the firewall files through the firewall
tooling, and so on. The CLI tools are the safe way to change this directory; reach for a text editor
only when a guide explicitly tells you to and explains why - and when you do edit a flat config
file, do it the accessible way described in "Editing files accessibly" below. Reading these files to
understand the host is always fine.

### Safety: keep an SSH key outside pmxcfs

This is the single most important operational note in this section. Act on it now, before moving on.

Notice that `priv/authorized_keys` is listed under `priv/` above. On a Proxmox host,
`/root/.ssh/authorized_keys` is not a real file: it is a **symlink** that points into pmxcfs at
`/etc/pve/priv/authorized_keys`. That is convenient (keys managed via the Proxmox API automatically
land in the right place), but it means your SSH public key lives inside the cluster filesystem.

The trap: if the `pve-cluster` service ever fails to start, `/etc/pve` is empty (unmounted). The
symlink then points at nothing, sshd cannot read your key, and a key-only login is refused - even
though the key itself is perfectly intact. On a headless host with no accessible local console, that
is a complete lockout with no way back in.

The safeguard is to keep an independent copy of the same public key in a file that lives entirely
outside pmxcfs. OpenSSH's `sshd` reads `~/.ssh/authorized_keys2` by default (it is in the standard
`AuthorizedKeysFile` search path), and that file is just a regular file on the root btrfs
filesystem, unaffected by pmxcfs state. Copy the key there now:

```bash
cp /etc/pve/priv/authorized_keys /root/.ssh/authorized_keys2
chmod 600 /root/.ssh/authorized_keys2
```

Do this once on a fresh host, and re-copy whenever you add or rotate keys. With `authorized_keys2`
in place, SSH key login works even if pmxcfs is completely down, so you can still reach the host and
repair whatever is wrong with `pve-cluster`.

## pvesh: the GUI as text

Now the central idea, stated plainly. Proxmox VE has exactly one source of truth for what can be
done: a versioned REST API, served by `pveproxy` at `https://<host>:8006/api2/json/...`. The web GUI
is a JavaScript client that makes the very same calls against that API. There is no hidden, GUI-only
capability; if a button exists in the GUI, there is an API path behind it. This is the fact that
makes a screen reader sufficient: anything the GUI can do, the API can do, and `pvesh` is that API
as text.

`pvesh` is a command-line shell over that REST API. Run as local root on the host, it talks to the
API over a local socket, so it needs **no credentials, no token, and no TLS** to arrange; being root
on the host is the authentication. (Reaching the same API from the control station, with `curl` and
an API token, is a later topic. Logged in over SSH as root, you already have the simplest path.) Its
subcommands map onto the API's verbs: `get` reads a resource, `ls` lists the child objects under a
path, `create` invokes an action or makes something, `set` updates, and `delete` removes.

Start by asking the host its version. This is the simplest possible call and a good first test:

```bash
pvesh get /version
```

That returns the API and Proxmox version as a small block of fields. Next, list what hangs off this
node in the API tree. `$(hostname)` fills in the host's own name, so the path matches whatever you
named the node at install:

```bash
pvesh ls /nodes/$(hostname)
```

That prints the child paths under your node (things like `qemu`, `lxc`, `storage`, `tasks`,
`network`), each one a corner of the API you can descend into with another `ls` or read with `get`.
This is how you explore: walk the tree with `ls`, then read a leaf with `get`.

When you reach a path and want to know what it accepts and returns, ask it to describe itself. The
API is self-documenting, and `pvesh usage` prints that documentation as navigable prose rather than
a mouse-driven tree:

```bash
pvesh usage /nodes/$(hostname)/qemu -v
```

The `-v` (verbose) form prints the full parameter documentation for the path: every option, what it
means, and what the call returns. For a screen-reader user this is the decisive feature. The
question "how do I do X?" always reduces to "find X's path with `ls`, read its docs with `usage`,
then `get` or `create` it."

Finally, output format. Many `pvesh` reads can print as YAML or JSON instead of the default, and
both read far more cleanly with a screen reader than a wide, column-aligned table does, because each
value sits on its own labelled line:

```bash
pvesh get /version --output-format yaml
pvesh get /version --output-format json
```

YAML is usually the easiest to read aloud; JSON is the easiest to pipe into a tool like `jq` when
you script. Keep `--output-format yaml` in mind throughout the corpus; whenever a command's default
output is an awkward table, check whether it offers this flag.

## The core CLI tools

You will not reach for raw `pvesh` for everything. Proxmox ships a set of focused command-line
tools, each a friendlier front end over its corner of the same API. Learn these by name; the later
guides teach each one in depth.

- `qm` - manages the full lifecycle of a KVM/QEMU virtual machine: create, start, stop, configure,
  snapshot, clone, destroy. It also attaches to a VM's serial console with `qm terminal`, the first
  superpower.
- `pct` - the container counterpart of `qm`: the full lifecycle of an LXC container, plus the
  container access path `pct enter` and `pct exec`, the second superpower.
- `pvesm` - the storage manager: lists storage status and volumes, and adds, changes, or removes
  storage definitions in `storage.cfg`.
- `pveum` - user management: users, groups, roles, ACLs, API tokens, pools, authentication realms,
  and two-factor auth.
- `pvenode` - node-level settings and host health: reading and writing the node config,
  certificates, the task list, and related per-node operations.
- `vzdump` - the built-in backup tool, writing one self-contained archive per guest per run to a
  backup storage.
- `pve-firewall` - local firewall control: compiling, previewing, and applying the plain-text `.fw`
  rule files.
- `pveversion` - shows the Proxmox package versions; `pveversion -v` lists every component (kernel,
  QEMU, pve-manager, and the rest).
- `pvereport` - a one-shot diagnostic dump of the whole host as one long text report: hardware,
  storage, network, versions, and service state.
- `pvesh` itself - the universal gateway under all of these. When no friendlier tool covers what you
  need, `pvesh` reaches it, because every one of the tools above is doing `pvesh`-style API calls
  underneath.

Two tools you will see named in the official documentation do not apply here. `pvecm` creates and
joins clusters, and `ha-manager` drives high availability; both need more than one node, so on this
single host they are effectively not applicable, apart from the one-off `pvecm expected 1` recovery
use noted earlier. You can read about them as background and otherwise ignore them.

## Editing files accessibly

Most host configuration is not edited by hand at all. As the sections above showed, the files under
`/etc/pve` are a config API surface: you change them with the CLI tools (`pveum` for users, `pvesm`
for storage, the firewall tooling for rules), and pmxcfs validates what those tools write. That rule
stands. This section is about the other category of file: the genuinely flat config files that you
do edit directly. Those are ordinary text files on the root disk, things like `/etc/default/grub`,
`/etc/network/interfaces`, an `sshd` drop-in, a cloud-init snippet, or a Windows `autounattend.xml`
you author on the control station, plus the rare documented case where a guide tells you to
hand-edit a guest config. The goal of this section is simple: when you edit one of these, you should
never be forced into a terminal TUI editor like vim or nano, which is hostile to a screen reader.

There are two approaches. Reach for the first by default; use the second when a file is large enough
to want a full editor.

### Stay in the shell (the default)

For small changes, you do not need an editor at all. Each of these commands does its edit
non-interactively and prints plain, linear text you can hear, with no editor window to navigate.

Replace a whole small file with a here-document. This writes the file's entire contents in one
command, exactly as typed between the markers, which is ideal for a short config file you control
top to bottom.

`/etc/ssh/sshd_config.d/10-example.conf`

```bash
cat > /etc/ssh/sshd_config.d/10-example.conf <<'EOF'
# whole file content goes here, exactly as you want it
EOF
```

Quoting the marker as `'EOF'` is deliberate: it tells the shell not to expand `$variables` or
backticks inside the here-document, so the text lands in the file exactly as written. That is what
you want for literal config, where a `$` is a `$` and not a variable to substitute.

Append a single line with `tee -a`, so you can add one line without opening an editor to do it.

`/etc/default/grub`

```bash
echo 'GRUB_CMDLINE_LINUX="console=tty0 console=ttyS0,115200"' | tee -a /etc/default/grub
```

The screen-reader win here is that `tee` echoes to standard output exactly what it appended, so you
hear immediate confirmation of what was written rather than having to open the file to check. Use
`tee -a` to add a genuinely new line. If the key you are writing already exists in the file (as
`GRUB_CMDLINE_LINUX` does by default), appending a second definition leaves two; the last one wins
so it often still works, but to change an existing key cleanly, use the `sed` form below or a
drop-in file instead.

Change one existing line in place with `sed -i`, taking a backup first.

`/etc/ssh/sshd_config`

```bash
sed -i.bak 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
```

The `-i.bak` form edits the file in place and, before it does, saves the original alongside it as
`/etc/ssh/sshd_config.bak`, so you can restore it if the substitution went wrong. Because `sed` does
not show you the result, read it back afterwards (with `grep` or `cat`) to confirm the line now
reads what you intended; the read-back will also reveal it if the key appeared more than once and
you now have duplicates.

Prefer a drop-in file over editing a big main config, when the software supports it. Many tools read
every file in a `.d/` directory and merge them: `sshd` reads `/etc/ssh/sshd_config.d/`, `apt` reads
`/etc/apt/apt.conf.d/`, `modprobe` reads `/etc/modprobe.d/`, and systemd reads `.d/` override
directories. A small dedicated file you write whole with a here-doc is easier to author and safer to
reason about than surgically editing one line deep inside a long main config file you cannot see.

The habit that ties all of this together: after any edit, read the file back with `cat` or `grep` so
you hear the result as linear text, and where the software offers a validator, run it before you
apply the change. `sshd -t` checks the SSH config for syntax errors before you reload; for the
pmxcfs files, the CLI tools (`pvesm`, `pveum`) are themselves the validation. Read back, check, then
apply.

### Edit in a real editor over SSH (VS Code Remote-SSH)

When a file is large enough that you want a real editor with search and navigation, edit it on the
host from a fully accessible editor on the control station rather than over a TUI.

VS Code Remote-SSH is the method to reach for first. From VS Code on the control station, install
the "Remote - SSH" extension, connect to the host using the same `pve` SSH host alias you set up in
the "Connecting" section above, and then open and edit files that live on the host directly inside
VS Code, which is a fully accessible editor with your screen reader. There is no manual copy step:
saving in VS Code writes straight back to the host over SSH. This uses your normal key-based SSH
login, which is already set up, and on the first connection VS Code installs a small helper on the
host automatically.

WinSCP is a lighter alternative. It is an accessible Windows SFTP client: browse to the file on the
host, press Enter or F4 to open it in your local editor (Notepad or VS Code), and when you save,
WinSCP uploads it back to the host automatically.

The plain fallback, if you want neither, is an `scp` round trip: fetch the file to the control
station, edit it locally in VS Code or Notepad, then put it back.

```bash
scp pve:/etc/default/grub .
scp ./grub pve:/etc/default/grub
```

Both commands use the `pve` host alias from the "Connecting" section.

One caution carries over from earlier: opening a file under `/etc/pve` in an external editor does
not exempt it from the "use the CLI tools" rule. pmxcfs still expects `pveum`, `pvesm`, and the
firewall tooling to be the things that write it. Use these editor methods for the flat config files
on the root disk, not as a way around the CLI tools.

Throughout the rest of this corpus, wherever a guide says to "edit" a file, either approach works;
for the small changes the guides make, the shell-only form is usually quickest.

## Verify it worked

Two read-only commands confirm that the control plane is reachable and that you can read the host as
text.

First, the API responds:

```bash
pvesh get /version
```

This returns the version as a small set of labelled fields (the release, the API version, the
repository id). Add `--output-format yaml` if you want each field on its own line. Seeing a
`release` of `9.x` confirms that `pvesh` reached the API over the local socket and that the host is
on the version this corpus targets.

Second, the full diagnostic report runs and reads cleanly:

```bash
pvereport | less
```

`pvereport` prints a long, linear text report covering the host's hardware, storage, network,
package versions, and service state, all as plain text. Piping it into `less` lets you page and
search through it with the keyboard, which is exactly the kind of one-big-text-blob output that
reads well with a screen reader. (Press `q` to quit `less`.) If both commands work, you are fluent
in the control plane: you can reach the API as text and read the whole host's state without any
sighted help.

## Sources

- `research/round2-pve9/17-pve9-users-auth-api.md` - the GUI-as-thin-client-over-the-REST-API
  framing, the `pvesh` verb-to-HTTP-method mapping, `ls`/`usage` discovery, `--output-format`, the
  local-socket no-credentials fact, and the full single-node CLI tool inventory.
- `research/round2-pve9/05-pve9-host-and-services.md` - pmxcfs as a FUSE filesystem backed by SQLite
  mounted at `/etc/pve`, the file-system layout (`storage.cfg`, `datacenter.cfg`, `qemu-server/`,
  `lxc/`, `nodes/<node>/`, `firewall/`, `jobs.cfg`, `notifications.cfg`, `user.cfg`, `priv/`), the
  POSIX caveats, the quorum read-only behaviour and single-node quorate-by-default note, and
  `pvereport`.
- `research/round1-general/07-users-auth-api-cli.md` - supplementary access-control and API/CLI
  background.
- `GLOSSARY.md` and `CONTEXT.md` - the canonical definitions of pmxcfs, pvesh, the REST API, the
  per-tool entries (`qm`, `pct`, `pvesm`, `pveum`, `pvenode`, `vzdump`, `pve-firewall`), the control
  station, and the Proxmox host.
- Proxmox VE documentation: the
  [pmxcfs chapter](https://pve.proxmox.com/pve-docs/chapter-pmxcfs.html) and the `pvesh`, `pvenode`,
  and `pveum` manual pages at [pve-docs](https://pve.proxmox.com/pve-docs/).

---

Previous: [01 -- Install Proxmox VE 9 unattended](01-install-proxmox-unattended.md) | Next:
[03 -- Repositories, updates, and the host](03-repositories-updates-and-the-host.md)
