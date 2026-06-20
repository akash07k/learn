# Interactive OS install by ear over the SPICE console

Status: accepted

The operator (blind, shell-only) sometimes needs to install or repair a guest interactively with no
answer file - most importantly Windows, which (per ADR-0004) has no serial install surface. ADR-0004
originally listed the interactive (attended) Windows install as rejected on the grounds that the
graphical installer needs sighted help. That reasoning was incomplete: it assumes the operator must
read the installer with their eyes from the host. They do not.

Decision: when no serial/text install path exists, drive the guest's OWN speaking installer or
recovery environment by ear over the SPICE console.

- SPICE (unlike noVNC) forwards the guest's audio to the client. A screen reader running INSIDE the
  guest - Windows Narrator (Win+Ctrl+Enter, available from the first Setup screen) or the Debian
  installer's espeakup - speaks to the operator through remote-viewer, with keystrokes going back.
  This is the install-time sibling of ADR-0004's "RDP + NVDA inside the guest": both are graphical
  surfaces driven by ear, not by eye.
- It is used ONLY for installs and installer-class recovery (Windows Setup and WinRE, Linux
  live/rescue media), never for daily operation. After the install the operator switches to the
  ADR-0004 daily path (RDP with an in-guest screen reader).
- The VM gets a SPICE display and audio device for the install (`vga: qxl`,
  `audio0: device=ich9-intel-hda,driver=spice`); without the audio device the install is silent, and
  the audio path requires qxl. After the install the display returns to `vga: std` for RDP.
- The client is remote-viewer (from the `virt-viewer` package) - effectively the only maintained
  native Windows SPICE client; Proxmox has no supported web-SPICE path (its browser console is
  noVNC, which is VNC and carries no audio). The operating hotkeys (release-cursor, fullscreen,
  secure-attention) are baked into the `console.vv` file so the operator never depends on
  remote-viewer's own menus, whose Windows screen-reader accessibility is unverified.
- A small PowerShell tool on the control station fetches a fresh `console.vv` from the `spiceproxy`
  API for each connection (the ticket expires in about 30 seconds) and opens it. It authenticates
  with a least-privilege API token and pins the node's TLS certificate by fingerprint.

## Considered and rejected

- **noVNC for the install**: rejected - VNC carries no audio, so nothing speaks.
- **SPICE for daily operation too**: rejected - the shell (the three superpowers) and RDP cover
  daily use; SPICE is graphical and only justified where no text/serial path exists.
- **Skipping TLS verification to reach the self-signed API**: rejected - it exposes the API token to
  a LAN man-in-the-middle. The tool pins the node certificate fingerprint instead, with no blanket
  skip-verify path; a stale fingerprint after a certificate change is fixed by refreshing the value
  in the config, not by disabling verification.

## Consequences

- A new, narrow exception to the corpus's "graphical consoles are unused" stance: a graphical
  console driven by ear (Console-by-ear) is allowed for install and installer-class recovery. The
  wording across the guides is softened from "never SPICE" to "never for daily operation; one
  documented install-time exception".
- The install VM config diverges briefly (`vga: qxl` + `audio0`) and returns to `vga: std`
  afterward; Windows re-detects the display on the next boot.
- A new client dependency on the control station (virt-viewer / remote-viewer) and a new tool under
  `subjects/proxmox/scripts/`. The tool holds an API token in a gitignored, ACL-locked config file.
- The mechanism also serves installer-class recovery (WinRE, Linux live media). EMS/SAC over serial
  (ADR-0004) remains the headless-text diagnosis path and is not replaced.
