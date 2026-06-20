# Authoring Conventions

Read this first before writing or editing any guide in the `learn` corpus. It defines who the reader
is, how to format for a screen reader, how to ground claims in research, and how to keep the corpus
reading as one consistent voice. These conventions are subject-agnostic: they apply to every subject
under `subjects/`, whether it teaches Proxmox, a programming language, or anything else.

Each subject grounds these conventions in its own vocabulary and may add a short
`AUTHORING-NOTES.md` at its root for domain-specific rules (the safety callouts, version facts, and
lint conventions that only make sense for that subject). The Proxmox subject is the worked example:
see `subjects/proxmox/AUTHORING-NOTES.md`.

## Audience and voice

Write in the second person ("you"), calm and concrete. The reader is someone who is blind and uses a
screen reader, learning entirely through text and the keyboard. Accessibility is not an afterthought
here; it is the reason this corpus exists, so every choice serves a reader who never sees a
screenshot and never points a mouse.

- Never rely on a graphical UI step ("click here", "open the panel", "drag the slider"). If the
  official docs only describe a GUI path, find and teach the command-line, config-file, or keyboard
  equivalent instead.
- Assume keyboard and screen-reader navigation. Prefer commands and tools whose output is linear
  text. Where a tool can emit structured text such as JSON, mention it, because JSON reads more
  cleanly than wide column-aligned tables.
- Be concrete: give the exact command and the exact file path. Do not hand-wave ("configure it
  somehow"); show the line that changes.
- Keep the tone steady and unhurried. Explain the "why" before the "do", and flag anything that is
  irreversible or risky before the step, not after.

## Formatting

These guides are read with a screen reader and are also built to HTML by pandoc, which turns the
Markdown heading hierarchy into the navigable table of contents. So the formatting rules below are
not cosmetic; they are how the reader moves through the document.

- Use real Markdown headings (`#`, `##`, `###`) for every section. The heading tree is the reader's
  table of contents, so headings must be accurate and properly nested (do not skip levels, do not
  fake a heading with bold text).
- Use hyphen bullets for lists. Use numbered lists only for genuinely ordered steps.
- Put commands and config in fenced code blocks. Immediately above each block, state the full path
  of the file being shown or edited (for example, "Edit `/etc/hosts`:"), so the reader always knows
  where a snippet belongs. For commands, a short lead-in sentence is enough.
- When a guide tells the reader to edit a file, prefer a shell-only, non-interactive form (a
  here-doc, `tee`, `sed -i`, or a drop-in file) over a full-screen terminal editor, which is hostile
  to a screen reader. If the subject has a guide on editing files accessibly, point to it.
- Do not use ASCII art, box-drawing characters, emoji, or decorative arrows. Do not write `->`;
  write the word "to", or "then", or "becomes", whichever the sentence means.
- Do not build "matrix" grid tables where meaning lives in the cell layout. Use a bullet list or a
  definition-style list instead. Simple, genuinely tabular data (a small list of values with one
  label each) may use a real Markdown table, but prefer prose or bullets when in doubt.
- Never encode meaning in colour or in a symbol a screen reader cannot read aloud. State the meaning
  in words.

## Line length and Markdown mechanics

The corpus is linted with markdownlint and formatted with Prettier (Markdown) and oxfmt (code).
`bun run format` auto-formats, `bun run lint:md` runs markdownlint, and `bun run check` runs the
build, link, glyph, and convention gate. These mechanical rules keep the source clean and the lint
green:

- Hard-wrap prose at 100 columns. Prettier (via `bun run tools/format-md.ts`) does this for you, so
  do not hand-pack long lines; just write and let the formatter wrap. markdownlint enforces a
  120-column cap as a backstop. Code blocks and tables are exempt, because neither can be reflowed.
- Give every fenced code block a language. Use `bash` for Linux shell commands, `powershell` for
  PowerShell, `ini` for systemd, fail2ban, and other INI-style config, `toml`, `json`, or `yaml` for
  those formats, and `text` for literal command output or a config format with no highlighter. A
  fence with no language fails the lint.
- Never leave a bare URL. Write `[descriptive title](https://example.com/page)`, not the raw URL.
  For a URL whose path contains parentheses, use the angle-bracket form
  `[title](<https://example.com/PCI(e)>)` so the `)` cannot close the link early.
- Do not put a literal `<placeholder>` in prose or a heading. A screen reader and the HTML build
  read `<...>` as an empty HTML tag, so it vanishes. Wrap the placeholder in backticks
  (`` `<vmid>` ``) or escape the angle brackets (`\<vmid\>`).

## Sourcing

Ground every factual claim in the subject's research and the official upstream documentation. Do not
invent commands or options from memory.

- Each subject keeps its authoring sources under its own `research/` directory. Treat those
  researched, citation-bearing briefs as the primary source for the specifics they cover.
- If a command, flag, or default is not supported by a named research file or an official doc, do
  not state it. When unsure, say less and stay factual rather than guessing.
- End every guide with a short "Sources" section listing the doc sections or URLs (and the relevant
  `research/` files) the guide drew on. This lets the reader verify and go deeper, and it lets a
  future author re-check the claims.

## Glossary discipline

Keep the vocabulary identical across a subject so the reader builds one mental model, not many.

- The first time a guide uses a defined term, use it exactly as it appears in the subject's
  `GLOSSARY.md`, and assume that definition. Do not coin synonyms.
- Use the role names from the subject's `CONTEXT.md` consistently, and avoid the discouraged words
  it lists where a precise role name exists.
- If a guide needs a term that is not yet in `GLOSSARY.md`, add it to the glossary rather than
  defining it ad hoc in one guide.

## Safety callouts

Any step that can lock the operator out of a machine they cannot physically reach, or can destroy
data, must state the safe procedure before the dangerous command. The reader often has no local
console to recover from, so a lockout is severe.

- For any change that could cut your own access (network, firewall, or remote-login configuration),
  state the safe sequence first: keep a second session open, preview or dry-run the change, and
  confirm a way back in before you commit it.
- For destructive disk and filesystem operations, show how to identify the right target first
  (prefer stable device names over volatile ones) and state plainly that the command erases data.
- A subject's `AUTHORING-NOTES.md` records the concrete, named traps for that domain. Follow them as
  hard rules when authoring that subject.

## Version awareness

Write for the latest stable release of whatever the subject teaches, and be explicit about versions.

- Show "if you are on an older release" notes only where the current release genuinely differs, and
  keep such notes short and clearly marked as the older case.
- For any version-sensitive step, tell the reader how to check their installed version and confirm
  it before proceeding.
- Do not present a deprecated path as current. Teach the current form and mention the old one only
  as a migration note. A subject's `AUTHORING-NOTES.md` pins the exact version facts that subject
  targets.

## Structure of a guide

Every numbered guide follows the same shape so the reader knows what to expect:

- An H1 title (`#`) naming the guide. This becomes the document title in the HTML build.
- A short "What you'll be able to do" opening, two or three sentences, stating the concrete
  capability the reader gains. No preamble beyond that.
- Named sections with real `##` (and `###`) headings, in teaching order. Each section is
  self-contained enough that the reader can navigate straight to it by heading.
- A "Verify it worked" subsection near the end of each major task, giving the exact command to run
  and the expected output (or the key line to look for), so the reader can confirm success from the
  shell without sighted help.
- A "Sources" section at the foot listing the doc sections, URLs, and `research/` files the guide is
  grounded in.

## Adding a new guide or recipe (the wiring checklist)

Most defects a reader hits are not in the new content itself; they are the seams a new file creates
with the rest of the subject. When you add a numbered guide, do all of these in the same change,
then run `bun run check`:

- Footer chain: give the new file a `Previous:` and a `Next:` link, and update its neighbour on the
  other side so both directions point at each other. A new file inserted anywhere must not break
  that forward-and-back spine. The two endpoints of the spine are declared in the subject's
  `subject.toml` (`nav.no_prev` and `nav.no_next`).
- README reading order: add the new file to the reading-order list in the subject's `README.md`, in
  the right place.
- Glossary: add any term the file uses as if defined to `GLOSSARY.md`, in alphabetical order, and
  link it on first use.
- Any subject-specific lint: a subject may define line-lint rules in its `subject.toml` (for example
  Proxmox's storage-id rule). Honour them, and read the subject's `AUTHORING-NOTES.md` for the rest.

The deterministic parts of this list (the footer chain, the ascii `->` arrow, and any subject lint
rule) are checked mechanically by `tools/checks.ts`, which `bun run check` runs. The rest are
judgement calls the gate cannot make for you.

## Sources

- The subject's `CONTEXT.md` - its glossary of roles and artifact vocabulary.
- The subject's `GLOSSARY.md` - the canonical term definitions every guide reuses.
- The subject's `AUTHORING-NOTES.md` - its domain-specific safety callouts, version facts, and lint
  conventions.
- `ADDING-A-SUBJECT.md` at the repository root - how a subject is laid out and wired into the shared
  tooling.
