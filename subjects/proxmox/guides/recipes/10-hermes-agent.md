# Recipe: Hermes Agent (a self-hosted AI agent)

## What you'll be able to do

You will run [Hermes Agent](https://hermes-agent.nousresearch.com/docs) by Nous Research in one
[unprivileged container](../GLOSSARY.md) on the node: an autonomous AI agent that you drive from the
terminal, that keeps its memory and skills on its own disk, and that calls a language model you
choose. You talk to it with `hermes chat` over SSH or `pct enter`, point it at a model with a
bring-your-own API key, and also reach it from Telegram through a small background gateway. Nothing
here needs the web GUI, a graphical console, or (for the path this recipe leads with) a browser; a
dedicated-VM variant and an opt-in browser tool are covered at the end.

## Before you start

This recipe reuses foundations rather than re-teaching them. You need:

- An [unprivileged container](../GLOSSARY.md) to run Hermes in. Creating one is taught in guide
  [05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md); this recipe shows only
  the one `pct create` line and points you there for the rest.
- A static IP for the container, so you always reach it at the same address. Giving a guest a static
  address is taught in guide [10 -- Networking](../10-networking.md). This recipe uses VMID `127` at
  `192.168.1.127`, hostname `hermes`, per [LAB-PLAN.md](../LAB-PLAN.md).
- A language-model API key. Hermes does not ship a model; it calls one. The accessible,
  cost-transparent default here is a bring-your-own key from a provider such as OpenRouter or Azure
  AI Foundry (set up below). A local model on this node is not realistic (see the note under "Give
  it a model").
- A Telegram bot token and your numeric Telegram user id. This recipe connects the agent to Telegram
  so you can reach it from your phone as well as from a shell; the token comes from BotFather inside
  the Telegram app, with no browser and no QR code. The "Reach it from Telegram" section shows how.

Unlike the web services in this part (Vaultwarden, Miniflux, Nextcloud), Hermes is not a web app and
gets no Caddy site block: it makes outbound connections to your model provider and to the Telegram
platform, and listens on no inbound port by default. You reach it by entering the container, not
over HTTPS.

## Pick the pattern and size it

Hermes installs natively from a shell script (it provisions its own uv, Python 3.11, Node, ripgrep,
and ffmpeg under one home directory) and there is no official Docker image, so the corpus's
Docker-Compose pattern does not apply. Two patterns fit:

- Pattern A, a hand-built unprivileged [LXC container](../GLOSSARY.md) (this recipe's default).
  Lightest and most accessible: once it exists you reach it with `pct enter 127`, a root shell with
  no console setup. This is the right choice for the CLI-and-messaging use the recipe leads with.
- Pattern D, a dedicated [KVM/QEMU VM](../GLOSSARY.md) (the variant at the end). Worth it only if
  you want the agent's optional browser tool (headless Chromium) to run with a full kernel, where
  its sandbox just works. Heavier.

There is no community Helper-Script for Hermes, so the corpus's pattern B does not apply here; you
build it by hand.

Sizing for the default headless install (remote model, no browser tool) is modest: about 2 vCPU, 2
GB of RAM, and 16 GB of disk. Inference happens on the provider's servers, so the container only
runs the agent loop, the messaging gateway, and a local SQLite store. Bump RAM to about 4 GB if you
later enable the browser tool, which pulls in Chromium.

Accessibility note: once the container exists you manage it with `pct enter 127`, which drops you
straight into a root shell inside it. Every command below runs either on the Proxmox host (the `pct`
lines) or inside the container after `pct enter` (everything else). Because Hermes installs per user
and puts its command in `~/.local/bin`, which a login shell adds to your `PATH`, run its commands
from a login shell: `pct enter 127` gives you one, and `su - hermes` below switches into the service
user's login shell.

### Create the container

On the Proxmox host, create the unprivileged container with a static address. The line below is the
shape of it; guide [05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md)
explains every option, the OS template, and confirming the template name with `pveam`. Substitute
your own bridge, address, gateway, and key path:

```bash
pct create 127 local-btrfs:vztmpl/debian-13-standard_13.x-1_amd64.tar.zst \
  --hostname hermes \
  --unprivileged 1 \
  --cores 2 --memory 2048 --swap 512 \
  --rootfs local-btrfs:16 \
  --net0 name=eth0,bridge=vmbr0,ip=192.168.1.127/24,gw=192.168.1.1 \
  --features nesting=1,keyctl=1 \
  --onboot 1 \
  --ssh-public-keys /root/hermes.pub
```

The `--features nesting=1,keyctl=1` line is load-bearing: Hermes runs a long-running gateway and
(optionally) nested tooling, and `keyctl=1` plus `nesting=1` give an unprivileged container the
kernel-keyring and nested namespace access that modern userland expects. Guide
[05 -- Containers with LXC and pct](../05-containers-with-lxc-and-pct.md) covers these feature
flags.

Start it and enter it:

```bash
pct start 127
pct enter 127
```

You are now in a root shell inside the container.

### Create a dedicated service user

Run Hermes as its own unprivileged user, not as the container's root, so the agent's files and its
shell tool are confined to one home directory. Create the user and a login shell for it:

```bash
apt update
apt install -y git
adduser --disabled-password --gecos "" hermes
```

Git is the only stated prerequisite for the installer. The one install step that needs root
(installing Chromium's system libraries, and only if you later enable the browser tool) is run from
the container's own root shell, so the `hermes` user needs no `sudo`. Switch into the service user's
login shell for the install:

```bash
su - hermes
```

### Install Hermes

The upstream install is a one-liner that pipes a remote script straight into your shell. Treat it as
untrusted code exactly as guide
[16 -- Automation and the ecosystem](../16-automation-and-the-ecosystem.md) teaches the
Helper-Scripts: download it first, read it, then run the local copy, so you both see what it does
and can pass flags reliably. As the `hermes` user:

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh -o ~/install-hermes.sh
less ~/install-hermes.sh        # read it before running it (quit less with q)
bash ~/install-hermes.sh --skip-browser
```

`--skip-browser` skips the heavy Playwright Chromium download. The agent's browser tool is then
unavailable, which is the right default here: it is the one piece that is awkward inside an
unprivileged container, and a blind operator gains little from automated browser control. The
browser tool is added back as an opt-in at the end. The installer provisions uv, Python 3.11, Node,
ripgrep, and ffmpeg under `~/.hermes` and symlinks the `hermes` command into `~/.local/bin`.

A login shell adds `~/.local/bin` to your `PATH` once that directory exists, so the simplest way to
pick up the new command is to start a fresh login shell, then confirm the version:

```bash
exit              # leave the install shell, back to the container's root
su - hermes       # a fresh login shell now has ~/.local/bin on PATH
hermes --version
```

If `hermes` is still not found (a minimal profile that does not add `~/.local/bin`), add it once and
start a fresh login shell, or call the binary by its full path `~/.local/bin/hermes`:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.profile
```

If the installer reports that Chromium's system libraries are missing and you do want the browser
tool later, that is the one step needing root; it is covered later in "The browser tool (opt-in)"
section below. For the headless default you can ignore it.

## Give it a model

Hermes calls a language model you configure; the agent loop, memory, and tools run locally, but
inference is remote. The accessible default is a bring-your-own key, set through the interactive
`hermes model` wizard, which prompts for the key interactively rather than taking it as a
command-line argument, so the secret never lands in shell history. Run it as the `hermes` user:

```bash
hermes model
```

Two providers worth documenting:

- OpenRouter (simplest). Pick OpenRouter in the wizard and paste an `OPENROUTER_API_KEY` when
  prompted; it fronts many models under one key and is the quickest cost-transparent start.
- Azure AI Foundry (first-class). Pick "Azure AI Foundry" in the wizard (provider id
  `azure-foundry`); it prompts for your Azure OpenAI / Foundry endpoint and key. This is the
  supported path for an Azure deployment.

The wizard writes non-secret choices (provider, model name) to `~/.hermes/config.yaml` and stores
the key in `~/.hermes/.env`; keep that secrets file `chmod 600` (owner-only), as the here-doc form
below creates it. If you would rather script it than use the wizard, write the key into
`~/.hermes/.env` yourself with a here-doc under `umask 077` (the secret-hygiene pattern recipe 03
uses), then set the provider with `hermes config set`:

```bash
umask 077
tee -a ~/.hermes/.env >/dev/null <<'EOF'
OPENROUTER_API_KEY=REPLACE_WITH_YOUR_KEY
EOF
chmod 600 ~/.hermes/.env
hermes config set model.provider openrouter
```

Edit the placeholder to your real key with the accessible methods in guide
[02 -- The shell and the API](../02-the-shell-and-the-api.md); do not echo it on a command line.

A note on local models. Hermes can point at a local OpenAI-compatible endpoint (Ollama, vLLM,
llama.cpp) via a custom `base_url`, and its docs require at least a 64000-token context for the
agent's tool-calling to work. On this node -- 24 GB of RAM and a Ryzen 6800H integrated GPU, no
discrete GPU -- a tool-calling-capable model at that context length is not realistic at usable
speed. Treat a local model as an advanced, explicitly-accepted experiment, not the baseline; the
bring-your-own-key path above is the practical default.

A note on the Nous Portal. Nous offers a hosted "Portal" subscription that bundles a model catalog
and a cloud Tool Gateway (web search, image generation, text-to-speech, browser) behind one login
via `hermes setup --portal`. It is the richest option but is a paid subscription and authenticates
through a one-time browser OAuth, the one browser-only step in the whole product. If you want it,
its docs describe headless flows for a guest with no local browser: a manual copy-paste of the
callback URL, or an `ssh -L` tunnel of the loopback callback port to a browser on your control
station. For this recipe the bring-your-own-key path avoids that step entirely.

## Talk to it from the shell

This is the whole point and it needs no gateway and no GUI. Inside the container as the `hermes`
user, start an interactive terminal chat:

```bash
hermes chat
```

That opens a terminal chat session (a text UI, not a web page). For a quick one-shot prompt, or to
smoke-test from a script, use the non-interactive form, which prints plain text and exits:

```bash
hermes -z "Say hello and name the model you are using."
```

Sessions persist on the container's disk under `~/.hermes`, so you can resume the most recent one
with `hermes --continue` (`-c`) or list them with `hermes sessions list`. Read the agent's own logs
with `hermes logs` (the files live under `~/.hermes/logs/`).

## Reach it from Telegram

Messaging the agent from Telegram is a standard part of this build, not an afterthought: it is how
you reach the agent from your phone, away from a shell. A gateway connects Hermes to a chat
platform, and Telegram is the one fully headless platform to set up: you get a bot token from
Telegram's own BotFather inside the Telegram app (send `/newbot` to `@BotFather` and copy the
token), with no web portal and no QR code. Discord requires a browser visit to its developer portal
to create the bot, and WhatsApp requires scanning a QR code, so neither is a good fit for a blind
operator; Telegram is the platform this recipe uses.

Put the token and an allowlist into the secrets file as the `hermes` user. The allowlist is not
optional: without it, anyone who finds your bot can talk to (and command) your agent. Use your own
numeric Telegram user id:

```bash
umask 077
tee -a ~/.hermes/.env >/dev/null <<'EOF'
TELEGRAM_BOT_TOKEN=REPLACE_WITH_BOTFATHER_TOKEN
TELEGRAM_ALLOWED_USERS=REPLACE_WITH_YOUR_TELEGRAM_USER_ID
EOF
chmod 600 ~/.hermes/.env
```

Never set `GATEWAY_ALLOW_ALL_USERS=true` on a self-hosted agent; that disables the allowlist and
exposes the agent to anyone who can reach the bot. Edit the placeholders with the accessible methods
in guide 02.

If the Telegram token or any model-provider API key in `~/.hermes/.env` is exposed, rotate it at the
provider, update the env file, and restart the affected Hermes service. These keys can spend money
or let someone command the agent, so set provider-side spending alerts where the provider supports
them.

Enable "lingering" for the `hermes` user FIRST. Without lingering, the per-user systemd manager runs
only while `hermes` has an active login session, so the gateway would stop at logout; lingering
starts that manager at boot and keeps it (and the service) running across logouts. It is also what
lets `systemctl --user` and `journalctl --user` work from a plain `su - hermes` shell, which is not
a real login session and otherwise has no user manager or `XDG_RUNTIME_DIR`. Run this from the
container's root shell (exit the `hermes` shell first, or open another `pct enter 127`):

```bash
loginctl enable-linger hermes
```

Then open a fresh `su - hermes` login shell so the per-user systemd manager and `XDG_RUNTIME_DIR`
exist, run the gateway once in the foreground to confirm it connects, and install it as the user
service so it survives a reboot:

```bash
hermes gateway run        # foreground: confirm it connects, then Ctrl-C
hermes gateway install    # install the systemd user service
hermes gateway start
hermes gateway status
```

Read the gateway's logs with `journalctl --user -u hermes-gateway -f` as the `hermes` user. Confirm
the unit's scope and name with `systemctl --user status hermes-gateway` after install, in case a
future Hermes version changes it.

A note on inbound ports. The common chat platforms (Telegram, Discord, Slack, Signal, Matrix) are
outbound: the gateway connects out to them and needs no inbound port, so no Caddy block and no
firewall opening. Two adapters (a generic `webhook` and an `api_server`) would instead listen
locally; if you ever enable one, find the port it binds with `ss -tlnp` inside the container and
only then decide whether to front it with the Caddy container (recipe 00) and add a per-guest
firewall rule (guide [11 -- Firewall](../11-firewall.md)).

## Harden it

A few settings matter because this agent can run shell commands and reach the network on your
behalf:

- Keep the secrets file owner-only. `~/.hermes/.env` should stay `chmod 600`; the here-docs above
  create it that way with `umask 077` and an explicit `chmod 600`. The provider key, the Telegram
  token, and any OAuth tokens (in `~/.hermes/auth.json`) all live under `~/.hermes`.
- Set the messaging allowlist (done above) and never disable it.
- Consider sandboxing the agent's shell tool. By default Hermes runs shell commands directly in the
  container (`terminal.backend: local`). Its security docs recommend a `docker` or `ssh` backend for
  stronger isolation; a Docker backend is awkward inside an unprivileged container, which is one
  reason to choose the dedicated-VM variant if you intend to let the agent execute much code. On a
  single-purpose container the `local` backend confined to this guest is a defensible default.
- Run `hermes doctor` to surface configuration and any flagged supply-chain advisories.

## Verify it worked

Three checks, all inside the container as the `hermes` user. First, the binary runs and reports its
version, proving the install succeeded:

```bash
hermes --version
```

Second, a one-shot prompt returns a model's answer, proving the provider key and model are wired
correctly:

```bash
hermes -z "Reply with the single word: ready"
```

The expected result is the model's reply (containing `ready`); an authentication or provider error
here points back to the `hermes model` step. Third, confirm the Telegram gateway service is active:

```bash
systemctl --user status hermes-gateway
```

The expected key line is `active (running)`. `hermes status` and `hermes doctor` give a fuller
health and configuration report.

## Run it as a dedicated VM instead (Pattern D)

Choose a VM over the container only if you want the agent's browser tool (headless Chromium) to run
with a full kernel where its sandbox is unproblematic, or you want the Docker-sandboxed shell-tool
backend. The shape is the same as the recipes that use a VM: clone the cloud-init golden template
from guide [07 -- Cloud-init templates](../07-cloud-init-templates.md) to a new Debian VM (reach it
with `qm terminal` or SSH, per guide
[06 -- Virtual machines with qm](../06-virtual-machines-with-qm.md)), then run the same
dedicated-user install, model setup, and gateway steps as above inside the VM, this time without
`--skip-browser`. A VM is heavier (a full guest kernel and OS) and is reached over the serial
console or SSH rather than `pct enter`, but it removes the unprivileged-container constraints on
Chromium and on a Docker terminal backend. Everything else in this recipe -- the model setup, the
CLI, the Telegram gateway, the hardening, the backup -- is identical.

## The browser tool (opt-in)

The browser tool lets the agent drive a headless Chromium to read and act on web pages. It is off by
default here because Chromium's sandbox is the awkward part of running Hermes in an unprivileged
container. Enabling it has two parts: install Chromium's system libraries (the one step that needs
root), then install Hermes without the `--skip-browser` flag.

From the container's root shell, install the system libraries. The upstream command is
`sudo npx playwright install-deps chromium`; because you are already root inside the container, the
`sudo` is unnecessary. Under the hood it just runs `apt` to install Chromium's shared libraries
(such as `libnss3` and `libxkbcommon`), and `npx` will prompt once to fetch the `playwright` helper,
which you can let it do:

```bash
# as root inside the container:
apt update
npx playwright install-deps chromium
```

Then install Hermes as the `hermes` user as before, but without the `--skip-browser` flag. If you
already installed Hermes with `--skip-browser` and are adding the browser tool now, snapshot the
agent's state first (`hermes backup -o ~/hermes-pre-browser.zip`, or a Proxmox snapshot of VMID
127), because the upstream docs do not document whether re-running the installer preserves your
existing `~/.hermes`; with that safety net, re-run the installer without the flag. If Chromium still
refuses to launch under the unprivileged container's user-namespace and AppArmor constraints, the
clean answer is the dedicated-VM variant above, where it runs without these limits. Bump the
container's RAM to about 4 GB if you keep the browser tool in an LXC.

## Back it up

Everything Hermes remembers -- its config, your provider key and tokens, its persistent memory, the
skills it has built, and its session history -- lives under `~/.hermes` on the container's own disk.
So a backup of this container captures the agent in full; there is no external database to dump
separately. It is a guest like any other: add VMID `127` to the Proxmox Backup Server backup job
from guide [17 -- Backups with Proxmox Backup Server](../17-backups-with-pbs.md) so it is captured
on the regular schedule, from where it rides into the off-box copy in guide
[18 -- The independent copy and restore](../18-the-independent-copy-and-restore.md). Treat finishing
this recipe and adding the guest to the backup job as one task. Hermes also has its own
`hermes backup -o <file>` snapshot command for an extra, portable copy of just the agent's state,
but the container backup is what protects it on the schedule.

## Sources

- [Hermes Agent documentation](https://hermes-agent.nousresearch.com/docs) -- the
  [installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation) one-liner,
  the `--skip-browser` flag, the per-user `~/.hermes` layout and `~/.local/bin/hermes` symlink, and
  the `sudo npx playwright install-deps chromium` step; the
  [quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart) and
  [CLI reference](https://hermes-agent.nousresearch.com/docs/reference/cli-commands) (`hermes chat`,
  `hermes -z`, `hermes model`, `hermes config set`, `hermes gateway run|install|start|status`,
  `hermes sessions`, `hermes logs`, `hermes doctor`, `hermes backup`, `hermes --version`); the
  [configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration) and
  [providers](https://hermes-agent.nousresearch.com/docs/integrations/providers) pages (config.yaml
  vs the `chmod 600` `~/.hermes/.env`, `auth.json`, the `openrouter`/`OPENROUTER_API_KEY` and
  first-class `azure-foundry` providers, and the local OpenAI-compatible `base_url` path with its
  64000-token tool-calling minimum); the
  [Nous Portal](https://hermes-agent.nousresearch.com/docs/integrations/nous-portal) and
  [OAuth-over-SSH](https://hermes-agent.nousresearch.com/docs/guides/oauth-over-ssh) pages (the
  browser OAuth and its `--manual-paste` / `ssh -L` headless flows); the
  [messaging](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/) pages (Telegram
  BotFather token vs Discord browser / WhatsApp QR, the `TELEGRAM_BOT_TOKEN` /
  `TELEGRAM_ALLOWED_USERS` allowlist, `GATEWAY_ALLOW_ALL_USERS`); and the
  [security](https://hermes-agent.nousresearch.com/docs/user-guide/security) page (the
  `terminal.backend` local/docker/ssh options and the self-hosting hardening checklist).
- `research/round2-pve9/10-pve9-lxc-pct.md` -- the unprivileged-LXC posture and the
  `nesting=1,keyctl=1` (and `fuse=1`) feature flags this workload needs, the PVE 9 cgroup-v2 and
  version-sensitive `--keep-env` behavior, and the bind-mount idmap rule.
- `research/round2-pve9/20-pve9-ecosystem-and-service-patterns.md` -- the four deployment patterns
  and the rule that a service with no upstream container image is hand-built natively in an LXC
  (pattern A) rather than forced into Docker.
- Guide [16 -- Automation and the ecosystem](../16-automation-and-the-ecosystem.md) -- the
  curl-pipe-to-root caution (read first, snapshot, run a downloaded copy) that the Hermes installer
  inherits.
- Recipe [03 -- Miniflux](03-miniflux.md) and recipe [02 -- Vaultwarden](02-vaultwarden.md) -- the
  LXC recipe template this follows: a dedicated unprivileged user, secrets in a `chmod 600` file
  written with `umask 077` and kept off the command line, and a systemd-managed service inside the
  container.
- [LAB-PLAN.md](../LAB-PLAN.md) -- the VMID/IP plan that assigns VMID `127` at `192.168.1.127`,
  hostname `hermes`, and the note that this guest needs no Caddy-fronted port by default.

---

Previous: [09 -- Throwaway dev-lab VM](09-dev-lab-vm.md) | Next:
[20 -- Reinstalling the host remotely](../20-reinstalling-the-host-remotely.md)
