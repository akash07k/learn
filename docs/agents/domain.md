# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the
codebase.

This repo is **multi-subject**: each subject is a self-contained folder under `subjects/` with its
own `CONTEXT.md` (the subject's ubiquitous-language glossary) and its own `docs/adr/`. There is no
root `CONTEXT.md` and no root `docs/adr/`; domain docs are always scoped to a subject.

## Before exploring, read these

First determine which subject you're working in (the `subjects/<slug>/` directory that contains the
files you're about to touch), then read that subject's docs:

- **`subjects/<slug>/CONTEXT.md`** - the subject's glossary and ubiquitous language.
- **`subjects/<slug>/docs/adr/`** - read ADRs that touch the area you're about to work in.

If you're touching more than one subject, read each one's docs. If any of these files don't exist,
**proceed silently**. Don't flag their absence; don't suggest creating them upfront. The producer
skill (`/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

## File structure

Multi-subject repo (this repo):

```text
/
subjects/
subjects/proxmox/
subjects/proxmox/CONTEXT.md
subjects/proxmox/docs/adr/
subjects/proxmox/docs/adr/0001-some-decision.md
subjects/proxmox/docs/adr/0002-another-decision.md
subjects/<other-subject>/
subjects/<other-subject>/CONTEXT.md
subjects/<other-subject>/docs/adr/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a
test name), use the term as defined in the relevant subject's `subjects/<slug>/CONTEXT.md`. Don't
drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in that subject's glossary yet, that's a signal - either you're
inventing language the project doesn't use (reconsider) or there's a real gap (note it for
`/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR in the subject you're working in, surface it explicitly
rather than silently overriding:

> _Contradicts ADR-0007 (some decision) - but worth reopening because…_
