# Adding a subject

A subject is a self-contained folder under `subjects/` that teaches one area. The shared tooling
discovers subjects by looking for a `subject.toml` manifest, so adding a subject never requires
touching `tools/`. This guide walks through it.

## 1. Copy the template

Copy `subjects/_template/` to `subjects/<your-subject>/`, using a short, lowercase slug for the
folder name (for example `ansible`, `rust`, `postgres`). The slug becomes the subject's URL segment
in the built site (`html/<slug>/...`).

The template ships a minimal, gate-clean subject you can build on:

- `subject.toml` - the manifest (see below).
- `CONTEXT.md` - the glossary of roles and vocabulary for the subject.
- `guides/README.md` - the subject's index and reading order.
- `guides/GLOSSARY.md` - the canonical term definitions.
- `guides/00-welcome.md` and `guides/01-first-task.md` - two numbered guides that demonstrate the
  Previous/Next footer chain.

## 2. Edit the manifest

Open `subjects/<your-subject>/subject.toml` and set:

- `name` - the human-readable title, shown on the `html/index.html` landing page.
- `content_dirs` - the subject-relative directories built to HTML and scanned for banned glyphs.
  Most subjects need just `["guides"]`; add `"docs/adr"` if the subject keeps architecture decision
  records its guides cross-link to.
- `lint_dirs` - the directories convention-linted (nav chain, ascii arrows, and any `[[lint]]`
  rules). Usually `["guides"]`. A `research/` directory, if you keep one, is reference-only: list it
  in neither. If omitted, `lint_dirs` defaults to the same value as `content_dirs`.
- `[nav]` `no_prev` / `no_next` - the two endpoints of the Previous/Next spine, as subject-relative
  paths. The first guide needs no `Previous:` and the last needs no `Next:`; name them here so the
  nav-chain check allows the gap.

Numbered guides are detected by a leading two-digit prefix (`00-`, `01-`, and so on). Every numbered
guide must carry a `Previous:` and a `Next:` footer link except at the declared endpoints.
Non-numbered files (the `README.md`, the `GLOSSARY.md`, cheatsheets) are exempt from the chain.

## 3. Add subject-specific lint rules (optional)

A subject can enforce its own crisp, mechanical rules with `[[lint]]` blocks in the manifest. Each
block is one rule: an `id`, a `message`, and a list of regex `patterns`. Any line matching any
pattern in any linted file is one finding. Write the patterns as TOML multi-line literal strings
(`'''...'''`) so regex backslashes survive verbatim.

The Proxmox subject is the worked example: its `storage-id` rule (in
`subjects/proxmox/subject.toml`) flags any use of the disabled `local:` storage. If your subject has
a recurring "always write X, never Y" rule that a regex can catch, add it here so the gate enforces
it.

## 4. Record domain conventions (optional)

If the subject has safety callouts, version facts, or other domain-specific authoring rules, put
them in an `AUTHORING-NOTES.md` at the subject's root. The repository-root
`AUTHORING-CONVENTIONS.md` stays subject-agnostic; `AUTHORING-NOTES.md` is where the concrete, named
traps and version pins for one subject live. See `subjects/proxmox/AUTHORING-NOTES.md` for an
example.

## 5. Write the guides

Follow `AUTHORING-CONVENTIONS.md` at the repository root: write for a screen-reader reader, teach
with exact commands and file paths, give a "Verify it worked" check, and end each guide with a
"Sources" section. Keep the vocabulary identical to the subject's `GLOSSARY.md` and `CONTEXT.md`.

## 6. Build and check

From the repository root:

```bash
bun run check
```

This builds every subject, then runs the banned-glyph scan, the internal-link check, and the
per-subject convention lint. Fix anything it reports until it prints `GATE PASSED`. Your subject now
appears on the `html/index.html` landing page and is covered by the gate, with no change to the
shared tooling.

Before you open a pull request or ask for review, run the CI-parity gate too:

```bash
bun run ci:local
```

That adds JavaScript linting, formatting checks, Markdown linting, typechecking, and tests around
the build/check gate.
