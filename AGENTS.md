# AGENTS.md

This file is for coding agents and maintainers who use the local workflow conventions. Human
contributors can start with [README.md](README.md) and [ADDING-A-SUBJECT.md](ADDING-A-SUBJECT.md);
the sections below describe agent-facing process surfaces.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature>/` in this repo (no remote). See
`docs/agents/issue-tracker.md`.

### Triage labels

Default triage vocabulary - each label string equals its canonical role name. See
`docs/agents/triage-labels.md`.

### Domain docs

Per-subject: each subject under `subjects/` carries its own `CONTEXT.md` (its glossary of roles and
vocabulary) and `docs/adr/` (its architecture decision records). Grounding for a change lives in the
subject you are editing. See `docs/agents/domain.md`.
