// Source-level quality checks for the corpus.
//
// This module is the single home for the three text checks the gate runs after the
// HTML build (orchestrated by check.ts):
//
//   * glyph        -- Markdown sources must not contain glyphs a screen reader
//                     cannot read cleanly (arrows, box-drawing, block elements,
//                     emoji / dingbats). ASCII "--" and prose em-dashes are fine.
//   * links        -- every internal link in the built HTML resolves: the target
//                     file exists, and any #fragment matches a real id/name.
//   * conventions  -- the recurring, crisp-rule convention breaks that adversarial
//                     reviews kept re-finding: a broken Previous/Next footer chain,
//                     a literal "->" in prose, and any subject-defined line lint
//                     (such as Proxmox's storage-id rule) from subject.toml.
//
// The glyph and link checks are subject-agnostic and take plain paths. The
// convention check is driven by a Subject (from subjects.ts): the nav endpoints and
// the line-lint rules come from that subject's manifest, so nothing about any one
// subject is hardcoded here. Each check returns a list of Finding objects so
// check.ts can call them directly. The module is also runnable standalone:
//
//     bun tools/checks.ts glyph [DIRS...]      # default: all subjects' content
//     bun tools/checks.ts links [HTML_ROOT]    # default: html
//     bun tools/checks.ts conventions [SLUG]   # default: all subjects

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { discover, isDir, isFile, type Subject } from './subjects.ts';

/** One problem found by a check: a human-readable location and message. */
export class Finding {
  constructor(
    readonly location: string,
    readonly message: string,
  ) {}

  toString(): string {
    return `${this.location}: ${this.message}`;
  }
}

/** Path relative to the current directory, with forward slashes for clean output. */
function rel(path: string): string {
  try {
    return relative(process.cwd(), path).replaceAll('\\', '/');
  } catch {
    return path.replaceAll('\\', '/');
  }
}

/** Split text into lines the way Python's str.splitlines does for our inputs. */
function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/** Every .md file under the given roots, sorted for stable output. */
export function mdFiles(roots: string[]): string[] {
  const found: string[] = [];
  const glob = new Bun.Glob('**/*.md');
  for (const root of roots) {
    if (isDir(root)) {
      for (const p of glob.scanSync({ cwd: root, absolute: true, onlyFiles: true })) {
        found.push(p.replaceAll('\\', '/'));
      }
    } else if (root.endsWith('.md') && existsSync(root)) {
      found.push(root.replaceAll('\\', '/'));
    }
  }
  return found.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// --------------------------------------------------------------------------- //
// 1. glyph                                                                     //
// --------------------------------------------------------------------------- //

// Arrows (2190-21FF), box-drawing + block + geometric shapes (2500-25FF),
// misc symbols + dingbats (2600-27BF), misc symbols and arrows (2B00-2BFF), and the
// astral emoji / pictograph block (1F000-1FAFF: emoticons, transport, supplemental
// symbols, etc.). Built programmatically, with the `u` flag so the non-BMP range is
// matched by code point (not by surrogate halves), keeping this file pure ASCII.
const BANNED_RANGES: readonly [number, number][] = [
  [0x2190, 0x21ff],
  [0x2500, 0x25ff],
  [0x2600, 0x27bf],
  [0x2b00, 0x2bff],
  [0x1f000, 0x1faff],
];
const BANNED_CLASS = BANNED_RANGES.map(
  ([lo, hi]) => `\\u{${lo.toString(16)}}-\\u{${hi.toString(16)}}`,
).join('');
const BANNED_GLYPHS = new RegExp(`[${BANNED_CLASS}]`, 'u');

export function findGlyphIssues(files: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const path of files) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (exc) {
      findings.push(new Finding(rel(path), `could not read file: ${String(exc)}`));
      continue;
    }
    const lines = splitLines(text);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (BANNED_GLYPHS.test(line)) {
        const bad = [...new Set([...line].filter((c) => BANNED_GLYPHS.test(c)))].toSorted();
        const codes = bad
          .map((c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`)
          .join(' ');
        findings.push(
          new Finding(`${rel(path)}:${i + 1}`, `banned glyph(s) ${codes}: ${line.trim()}`),
        );
      }
    }
  }
  return findings;
}

// --------------------------------------------------------------------------- //
// 2. links                                                                     //
// --------------------------------------------------------------------------- //

const ATTR = /\b([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function attrValues(html: string, wanted: string): string[] {
  const values: string[] = [];
  for (const m of html.matchAll(ATTR)) {
    if (m[1].toLowerCase() !== wanted) {
      continue;
    }
    values.push(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return values;
}

function decodeOrKeep(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function normPath(pathPart: string): string {
  const noQuery = pathPart.split('?')[0] ?? '';
  if (noQuery === '') {
    return '';
  }
  try {
    return decodeURI(noQuery);
  } catch {
    return noQuery;
  }
}

function normFrag(fragment: string): string {
  return decodeOrKeep(fragment);
}

function idsOf(path: string, cache: Map<string, Set<string>>): Set<string> {
  const cached = cache.get(path);
  if (cached) {
    return cached;
  }
  const ids = new Set<string>();
  try {
    const text = readFileSync(path, 'utf8');
    for (const id of attrValues(text, 'id')) {
      ids.add(id);
      ids.add(decodeOrKeep(id));
    }
    for (const name of attrValues(text, 'name')) {
      ids.add(name);
      ids.add(decodeOrKeep(name));
    }
  } catch {
    // unreadable target: treat as having no ids
  }
  cache.set(path, ids);
  return ids;
}

function normalizeForContainment(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function within(parent: string, child: string): boolean {
  const normalizedParent = normalizeForContainment(parent);
  const normalizedChild = normalizeForContainment(child);
  return (
    normalizedChild === normalizedParent ||
    normalizedChild.startsWith(
      normalizedParent.endsWith('/') ? normalizedParent : `${normalizedParent}/`,
    )
  );
}

function realPath(path: string): string {
  return realpathSync(path).replaceAll('\\', '/');
}

/** Return broken findings plus the number of internal links checked. */
export function findLinkIssues(htmlRoot: string): { findings: Finding[]; checked: number } {
  const findings: Finding[] = [];
  if (!isDir(htmlRoot)) {
    findings.push(new Finding(rel(htmlRoot), 'html root does not exist (run the build first)'));
    return { findings, checked: 0 };
  }

  const idCache = new Map<string, Set<string>>();
  const rootResolved = resolve(htmlRoot).replaceAll('\\', '/');
  const rootReal = realPath(rootResolved);
  let checked = 0;
  const glob = new Bun.Glob('**/*.html');
  const htmls = [...glob.scanSync({ cwd: htmlRoot, absolute: true, onlyFiles: true })]
    .map((p) => p.replaceAll('\\', '/'))
    .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  for (const html of htmls) {
    let text: string;
    try {
      text = readFileSync(html, 'utf8');
    } catch (exc) {
      findings.push(new Finding(rel(html), `could not read file: ${String(exc)}`));
      continue;
    }
    for (const href of attrValues(text, 'href')) {
      if (href === '' || href.startsWith('//') || SCHEME.test(href)) {
        continue;
      }
      const hashIdx = href.indexOf('#');
      const pathPart = normPath(hashIdx === -1 ? href : href.slice(0, hashIdx));
      const frag = normFrag(hashIdx === -1 ? '' : href.slice(hashIdx + 1));
      checked++;
      let target: string;
      if (pathPart === '') {
        target = html;
      } else {
        target = resolve(dirname(html), pathPart).replaceAll('\\', '/');
        if (!within(rootResolved, target)) {
          findings.push(new Finding(rel(html), `broken target to ${href} (escapes html root)`));
          continue;
        }
        if (!existsSync(target)) {
          findings.push(new Finding(rel(html), `broken target to ${href} (file missing)`));
          continue;
        }
        if (!isFile(target)) {
          findings.push(new Finding(rel(html), `broken target to ${href} (not a file)`));
          continue;
        }
        const realTarget = realPath(target);
        if (!within(rootReal, realTarget)) {
          findings.push(new Finding(rel(html), `broken target to ${href} (escapes html root)`));
          continue;
        }
      }
      if (frag && !idsOf(target, idCache).has(frag)) {
        findings.push(
          new Finding(rel(html), `broken anchor to ${href} (no id '${frag}' in target)`),
        );
      }
    }
  }
  return { findings, checked };
}

// --------------------------------------------------------------------------- //
// 3. conventions                                                              //
// --------------------------------------------------------------------------- //

const NUMBERED = /^\d\d-/;
const FENCE = /^\s*(?:```|~~~)/;
const INLINE_CODE = /`[^`]*`/g;
const NEXT = /(?:^|\|\s*)Next:/;

/**
 * Lint a subject's authored Markdown: nav chain, ascii arrows, and the subject's
 * own line-lint rules (e.g. Proxmox's storage-id rule).
 */
export function findConventionIssues(subject: Subject): Finding[] {
  const findings: Finding[] = [];
  for (const path of mdFiles(subject.lintPaths())) {
    let lines: string[];
    try {
      lines = splitLines(readFileSync(path, 'utf8'));
    } catch (exc) {
      findings.push(new Finding(rel(path), `could not read file: ${String(exc)}`));
      continue;
    }

    const relPath = relative(subject.root, path).replaceAll('\\', '/');
    const isNumbered = NUMBERED.test(basename(path));

    let inFence = false;
    let prevLine = 0;
    let nextLine = 0;

    for (let i = 0; i < lines.length; i++) {
      const lineno = i + 1;
      const line = lines[i];
      if (FENCE.test(line)) {
        inFence = !inFence;
        continue;
      }

      // Subject line lints (e.g. storage ids) run on every line, because the
      // patterns they catch live in commands inside code fences.
      for (const rule of subject.lintRules) {
        if (rule.patterns.some((pat) => pat.test(line))) {
          findings.push(
            new Finding(`${rel(path)}:${lineno}`, `${rule.id}: ${rule.message}: ${line.trim()}`),
          );
        }
      }

      if (inFence) {
        continue;
      }

      // Footer nav links and ascii arrows are prose. Detect the footer only here,
      // after the in-fence guard, so a "Previous:"/"Next:" string inside a code fence
      // cannot satisfy the nav-chain check and hide a genuinely missing footer.
      if (line.startsWith('Previous:')) {
        prevLine = lineno;
      }
      if (NEXT.test(line)) {
        nextLine = lineno;
      }

      const prose = line.replace(INLINE_CODE, '');
      if (prose.includes('->')) {
        findings.push(
          new Finding(
            `${rel(path)}:${lineno}`,
            `ascii-arrow: write "to" or "then" in prose, not "->": ${line.trim()}`,
          ),
        );
      }
    }

    if (isNumbered) {
      if (!subject.noPrev.has(relPath) && prevLine === 0) {
        const anchor = nextLine || lines.length || 1;
        findings.push(
          new Finding(`${rel(path)}:${anchor}`, 'nav-chain: footer is missing a "Previous:" link'),
        );
      }
      if (!subject.noNext.has(relPath) && nextLine === 0) {
        const anchor = prevLine || lines.length || 1;
        findings.push(
          new Finding(`${rel(path)}:${anchor}`, 'nav-chain: footer is missing a "Next:" link'),
        );
      }
    }
  }

  return findings;
}

// --------------------------------------------------------------------------- //
// standalone CLI                                                              //
// --------------------------------------------------------------------------- //

function repoRoot(): string {
  return dirname(import.meta.dir);
}

function cliMain(argv: string[]): number {
  if (argv.length === 0) {
    console.error('usage: checks.ts {glyph [DIRS...] | links [HTML_ROOT] | conventions [SLUG]}');
    return 2;
  }
  const [command, ...rest] = argv;
  const root = repoRoot();

  if (command === 'glyph') {
    const roots = rest.length > 0 ? rest : discover(root).flatMap((s) => s.contentPaths());
    const findings = findGlyphIssues(mdFiles(roots));
    for (const finding of findings) {
      console.log(finding.toString());
    }
    console.log(
      findings.length > 0 ? `${findings.length} glyph issue(s) found.` : 'glyph check clean',
    );
    return findings.length > 0 ? 1 : 0;
  }

  if (command === 'links') {
    const htmlRoot = rest[0] ?? resolve(root, 'html');
    const { findings, checked } = findLinkIssues(htmlRoot);
    for (const finding of findings) {
      console.log(finding.toString());
    }
    console.log(`checked ${checked} internal links; ${findings.length} broken.`);
    return findings.length > 0 ? 1 : 0;
  }

  if (command === 'conventions') {
    const wanted = rest[0];
    const findings: Finding[] = [];
    for (const subject of discover(root)) {
      if (wanted && subject.slug !== wanted) {
        continue;
      }
      findings.push(...findConventionIssues(subject));
    }
    for (const finding of findings) {
      console.log(finding.toString());
    }
    console.log(
      findings.length > 0
        ? `${findings.length} convention issue(s) found.`
        : 'convention check clean',
    );
    return findings.length > 0 ? 1 : 0;
  }

  console.error(`unknown command: ${command}`);
  return 2;
}

if (import.meta.main) {
  process.exit(cliMain(process.argv.slice(2)));
}
