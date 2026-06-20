// Discover and parse the subjects that make up the learn corpus.
//
// `learn` is a multi-subject teaching corpus: each subject is a self-contained
// folder under subjects/ with its own guides, glossary, and (optionally) ADRs and
// research. A subject declares how it is built and checked in a `subject.toml`
// manifest at its root, so the shared tooling (build-html.ts, checks.ts, check.ts)
// never hardcodes anything about a particular subject. To add a subject you drop a
// folder with a manifest under subjects/; nothing in the tooling changes.
//
// A manifest looks like this (TOML, parsed with smol-toml):
//
//     name = "Proxmox VE Zero-to-Hero"
//     content_dirs = ["guides", "docs/adr"]   # built to HTML and glyph-scanned
//     lint_dirs = ["guides"]                   # convention-linted (nav, arrows, [[lint]])
//
//     [nav]
//     no_prev = ["guides/00-orientation.md"]   # numbered files that need no Previous
//     no_next = ["guides/22-when-things-break.md"]
//
//     [[lint]]
//     id = "storage-id"
//     message = 'use the active "local-btrfs" storage, not the disabled "local"'
//     patterns = ['--rootfs\\s+local:', '\\blocal:vztmpl']
//
// Paths in the manifest are subject-relative and use forward slashes; the nav
// endpoints are matched against each file's subject-relative path.

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';

const MANIFEST = 'subject.toml';

/** Raised when a subject manifest is missing or malformed. */
export class SubjectError extends Error {}

/** True if `p` is an existing regular file. */
export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** True if `p` is an existing directory. */
export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** A subject-defined line lint: any pattern matching a line is one finding. */
export interface LintRule {
  readonly id: string;
  readonly message: string;
  readonly patterns: readonly RegExp[];
}

/** One parsed subject manifest plus the directory it lives in. */
export class Subject {
  constructor(
    readonly slug: string, // directory name under subjects/, e.g. "proxmox"
    readonly name: string, // human-readable title from the manifest
    readonly root: string, // absolute path to subjects/<slug>
    readonly contentDirs: readonly string[], // built to HTML and glyph-scanned
    readonly lintDirs: readonly string[], // convention-linted
    readonly noPrev: ReadonlySet<string>, // subject-relative md paths that need no "Previous:"
    readonly noNext: ReadonlySet<string>, // subject-relative md paths that need no "Next:"
    readonly lintRules: readonly LintRule[],
  ) {}

  contentPaths(): string[] {
    return this.contentDirs.map((d) => join(this.root, d));
  }

  lintPaths(): string[] {
    return this.lintDirs.map((d) => join(this.root, d));
  }
}

/**
 * Coerce a manifest field to an array (treating an absent field as empty), or throw a
 * SubjectError naming the field. This keeps a mistyped manifest -- e.g.
 * `content_dirs = "guides"` instead of `["guides"]` -- reported as a helpful schema
 * error rather than crashing with a raw TypeError from a later `.map()`.
 */
function asArray(value: unknown, manifest: string, field: string): unknown[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new SubjectError(`${manifest}: '${field}' must be an array`);
  }
  return value;
}

/**
 * Read a manifest path-list field as clean forward-slash, no-leading-slash strings, or
 * throw a field-named SubjectError. Validating each entry is a string (rather than
 * coercing via String()) keeps a mistake like `content_dirs = [1]` an actionable schema
 * error instead of a silent "1" that only fails later as a missing directory.
 */
function normPaths(value: unknown, manifest: string, field: string): string[] {
  return asArray(value, manifest, field).map((entry) => {
    if (typeof entry !== 'string') {
      throw new SubjectError(`${manifest}: '${field}' entries must be strings`);
    }
    const segments = entry
      .replaceAll('\\', '/')
      .split('/')
      .filter((s) => s.length > 0);
    if (segments.length === 0) {
      throw new SubjectError(`${manifest}: '${field}' entries must not be empty`);
    }
    // Keep manifest paths inside the subject directory: reject "." / ".." traversal so
    // a malformed or hostile manifest cannot point the build/lint/link checks at, say,
    // ../docs or the repo root.
    if (segments.some((s) => s === '.' || s === '..')) {
      throw new SubjectError(
        `${manifest}: '${field}' entries must stay within the subject (no '.' or '..'): ${entry}`,
      );
    }
    return segments.join('/');
  });
}

function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

function assertInsideSubject(
  subjectDir: string,
  entries: readonly string[],
  manifest: string,
  field: string,
): void {
  const subjectReal = realpathSync(subjectDir).replaceAll('\\', '/');
  for (const entry of entries) {
    const path = join(subjectDir, entry);
    if (!isDir(path)) {
      continue;
    }
    const real = realpathSync(path).replaceAll('\\', '/');
    if (!within(subjectReal, real)) {
      throw new SubjectError(`${manifest}: '${field}' entry escapes subject via symlink: ${entry}`);
    }
  }
}

/** Parse the subject.toml in `subjectDir` into a Subject, or throw SubjectError. */
export function loadSubject(subjectDir: string): Subject {
  const manifest = join(subjectDir, MANIFEST);
  if (!isFile(manifest)) {
    throw new SubjectError(`no ${MANIFEST} in ${subjectDir}`);
  }
  let data: Record<string, unknown>;
  try {
    data = parseToml(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
  } catch (exc) {
    throw new SubjectError(`cannot parse ${manifest}: ${String(exc)}`);
  }

  const name = data.name;
  if (typeof name !== 'string' || !name.trim()) {
    throw new SubjectError(`${manifest}: 'name' must be a non-empty string`);
  }

  const contentDirs = normPaths(data.content_dirs, manifest, 'content_dirs');
  if (contentDirs.length === 0) {
    throw new SubjectError(`${manifest}: 'content_dirs' must list at least one directory`);
  }
  const lintDirs =
    data.lint_dirs !== undefined ? normPaths(data.lint_dirs, manifest, 'lint_dirs') : contentDirs;

  if (
    data.nav !== undefined &&
    (typeof data.nav !== 'object' || data.nav === null || Array.isArray(data.nav))
  ) {
    throw new SubjectError(`${manifest}: 'nav' must be a table`);
  }
  const nav = (data.nav as Record<string, unknown> | undefined) ?? {};
  const unknownNav = Object.keys(nav).filter((key) => key !== 'no_prev' && key !== 'no_next');
  if (unknownNav.length > 0) {
    throw new SubjectError(
      `${manifest}: unknown [nav] key(s): ${unknownNav.join(', ')} (allowed: no_prev, no_next)`,
    );
  }
  const noPrev = new Set(normPaths(nav.no_prev, manifest, 'nav.no_prev'));
  const noNext = new Set(normPaths(nav.no_next, manifest, 'nav.no_next'));

  const rules: LintRule[] = [];
  for (const raw of asArray(data.lint, manifest, 'lint')) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new SubjectError(`${manifest}: each [[lint]] entry must be a table`);
    }
    const entry = raw as Record<string, unknown>;
    const rawId = entry.id;
    const rawMessage = entry.message;
    if (rawId !== undefined && typeof rawId !== 'string') {
      throw new SubjectError(`${manifest}: each [[lint]] entry's 'id' must be a string`);
    }
    if (rawMessage !== undefined && typeof rawMessage !== 'string') {
      throw new SubjectError(`${manifest}: each [[lint]] entry's 'message' must be a string`);
    }
    const rid = rawId ?? 'lint';
    const message = rawMessage ?? 'convention violation';
    let compiled: RegExp[];
    try {
      compiled = asArray(entry.patterns, manifest, `lint '${rid}' patterns`).map((p) => {
        if (typeof p !== 'string') {
          throw new SubjectError(`${manifest}: lint '${rid}' patterns must be strings`);
        }
        return new RegExp(p);
      });
    } catch (exc) {
      if (exc instanceof SubjectError) {
        throw exc;
      }
      throw new SubjectError(`${manifest}: bad regex in lint '${rid}': ${String(exc)}`);
    }
    if (compiled.length === 0) {
      throw new SubjectError(`${manifest}: lint '${rid}' must list at least one pattern`);
    }
    rules.push({ id: rid, message, patterns: compiled });
  }

  assertInsideSubject(subjectDir, contentDirs, manifest, 'content_dirs');
  assertInsideSubject(subjectDir, lintDirs, manifest, 'lint_dirs');

  return new Subject(
    basename(subjectDir),
    name.trim(),
    subjectDir,
    contentDirs,
    lintDirs,
    noPrev,
    noNext,
    rules,
  );
}

/** Every subject under repoRoot/subjects that has a manifest, sorted by slug. */
export function discover(repoRoot: string): Subject[] {
  const base = join(repoRoot, 'subjects');
  if (!isDir(base)) {
    throw new SubjectError(`no subjects/ directory under ${repoRoot}`);
  }
  const names = readdirSync(base).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const subjects: Subject[] = [];
  for (const name of names) {
    const child = join(base, name);
    if (isDir(child) && isFile(join(child, MANIFEST))) {
      subjects.push(loadSubject(child));
    }
  }
  if (subjects.length === 0) {
    throw new SubjectError(`no subjects with a ${MANIFEST} found under ${base}`);
  }
  return subjects;
}
