// Render the corpus to accessible standalone HTML via pandoc.
//
// Every subject under subjects/ is built independently into html/<slug>/, mirroring
// the subject's own directory layout: a Proxmox guide at
// subjects/proxmox/guides/09-storage.md becomes html/proxmox/guides/09-storage.html,
// and its sibling ADR at subjects/proxmox/docs/adr/0002-...md becomes
// html/proxmox/docs/adr/0002-...html. Mirroring each subject's tree is what keeps
// the cross-links working, since a guide's relative link such as
// ../docs/adr/0002-... points at the same place in the built tree as in the source.
//
// A small html/index.html landing page links to each subject's home page. The
// shared pandoc assets (template, CSS, link filter) live in assets/ at the repo
// root and are used for every subject.
//
// Runnable standalone for a build-only pass:
//
//     bun tools/build-html.ts

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { discover, isDir, isFile, type Subject, SubjectError } from './subjects.ts';

const TITLE = /^#\s+(.*)/;

/** Raised when the HTML build cannot complete. */
export class BuildError extends Error {}

function titleOf(md: string): string {
  try {
    for (const line of readFileSync(md, 'utf8').split(/\r\n|\r|\n/)) {
      const match = TITLE.exec(line);
      if (match) {
        return match[1].trim();
      }
    }
  } catch {
    // fall through to the filename stem
  }
  return basename(md).replace(/\.md$/, '');
}

// Escape for HTML text and double-quoted attribute contexts (so a subject name or a
// home path containing &, <, >, ", or ' cannot break or inject into html/index.html).
function escape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** A subject-rooted html path (posix) to use as the subject's landing link. */
function homePage(subject: Subject): string | null {
  const first = subject.contentDirs[0];
  const base = join(subject.root, first);
  const readme = join(base, 'README.md');
  if (isFile(readme)) {
    return `${subject.slug}/${first}/README.html`;
  }
  const glob = new Bun.Glob('**/*.md');
  const pages = [...glob.scanSync({ cwd: base, absolute: true, onlyFiles: true })]
    .map((p) => p.replaceAll('\\', '/'))
    .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (pages.length === 0) {
    return null;
  }
  const rel = relative(subject.root, pages[0]).replaceAll('\\', '/').replace(/\.md$/, '.html');
  return `${subject.slug}/${rel}`;
}

function writeIndex(outDir: string, homes: [Subject, string | null][]): void {
  const items: string[] = [];
  for (const [subject, home] of homes) {
    const label = escape(subject.name);
    if (home) {
      items.push(`    <li><a href="${escape(home)}">${label}</a></li>`);
    } else {
      items.push(`    <li>${label}</li>`);
    }
  }
  const html =
    '<!doctype html>\n' +
    '<html lang="en">\n<head>\n  <meta charset="utf-8">\n' +
    '  <title>learn</title>\n</head>\n<body>\n' +
    '  <h1>learn</h1>\n' +
    '  <p>An accessible, shell-first learning corpus. Subjects:</p>\n' +
    '  <ul>\n' +
    items.join('\n') +
    '\n  </ul>\n' +
    '</body>\n</html>\n';
  writeFileSync(join(outDir, 'index.html'), html, 'utf8');
}

/**
 * Build every subject's Markdown to HTML. Returns the number of files built.
 *
 * When `incremental` is true, a page is rebuilt only if its output is missing or
 * older than its source Markdown or than any shared asset (template, CSS, or Lua
 * filter); up-to-date pages are skipped. This is an mtime comparison, so it does
 * not depend on git state. The full-build default (`incremental = false`) is what
 * the quality gate uses.
 */
export function build(repoRoot: string, outDir?: string, incremental = false): number {
  if (!Bun.which('pandoc')) {
    throw new BuildError('pandoc not found on PATH. Install pandoc and retry.');
  }

  const out = outDir ?? join(repoRoot, 'html');
  const assets = join(repoRoot, 'assets');
  const css = join(assets, 'pandoc-a11y.css');
  const template = join(assets, 'pandoc-template.html');
  const linkFilter = join(assets, 'md-links-to-html.lua');
  const a11yFilter = join(assets, 'a11y-enhance.lua');
  for (const required of [css, template, linkFilter, a11yFilter]) {
    if (!isFile(required)) {
      throw new BuildError(`required asset missing: ${required}`);
    }
  }

  // A page is stale if it is older than its source or than any shared asset, so an
  // edit to the template, CSS, or a Lua filter rebuilds every page in incremental mode.
  const assetMtime = Math.max(
    ...[css, template, linkFilter, a11yFilter].map((f) => statSync(f).mtimeMs),
  );

  const discovered = discover(repoRoot);
  let built = 0;
  let skipped = 0;
  const homes: [Subject, string | null][] = [];
  const glob = new Bun.Glob('**/*.md');

  for (const subject of discovered) {
    for (const contentDir of subject.contentDirs) {
      const base = join(subject.root, contentDir);
      if (!isDir(base)) {
        throw new BuildError(`${subject.slug}: content dir not found: ${contentDir}`);
      }
      const mds = [...glob.scanSync({ cwd: base, absolute: true, onlyFiles: true })]
        .map((p) => p.replaceAll('\\', '/'))
        .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      for (const md of mds) {
        const rel = relative(subject.root, md).replaceAll('\\', '/').replace(/\.md$/, '.html');
        const outPath = join(out, subject.slug, rel);
        if (incremental && isFile(outPath)) {
          const outMtime = statSync(outPath).mtimeMs;
          if (outMtime >= statSync(md).mtimeMs && outMtime >= assetMtime) {
            skipped++;
            continue;
          }
        }
        mkdirSync(dirname(outPath), { recursive: true });
        const cmd = [
          'pandoc',
          md,
          '--standalone',
          '--embed-resources',
          '--toc',
          '--toc-depth=3',
          '--section-divs',
          // Emit one HTML line per Markdown block; without this pandoc rewraps prose
          // at ~72 columns mid-sentence inside every <p>/<li>, which reads as stray
          // line breaks. Block structure is unchanged; only soft wrapping is removed.
          '--wrap=none',
          '--template',
          template,
          '--lua-filter',
          linkFilter,
          '--lua-filter',
          a11yFilter,
          '--metadata',
          'lang=en',
          '--metadata',
          `pagetitle=${titleOf(md)}`,
          '--css',
          css,
          '--output',
          outPath,
        ];
        const result = Bun.spawnSync(cmd, { stderr: 'pipe' });
        if (result.exitCode !== 0) {
          // Surface pandoc's own diagnostics (missing include, bad markdown, etc.);
          // without them a CI failure on one page is hard to diagnose.
          const stderr = new TextDecoder().decode(result.stderr ?? new Uint8Array()).trim();
          const detail = stderr ? `\n${stderr}` : '';
          throw new BuildError(
            `pandoc failed on ${subject.slug}/${rel} (exit ${result.exitCode})${detail}`,
          );
        }
        console.log(`built ${subject.slug}/${rel}`);
        built++;
      }
    }
    homes.push([subject, homePage(subject)]);
  }

  mkdirSync(out, { recursive: true });
  writeIndex(out, homes);
  const skippedNote = incremental ? `, skipped ${skipped} up-to-date` : '';
  console.log(
    `Done. Built ${built}${skippedNote} HTML file(s) for ${discovered.length} subject(s) into ${out}.`,
  );
  return built;
}

function main(): number {
  const incremental = process.argv.includes('--changed') || process.argv.includes('--incremental');
  try {
    build(dirname(import.meta.dir), undefined, incremental);
  } catch (exc) {
    if (exc instanceof BuildError || exc instanceof SubjectError) {
      console.error(`BUILD FAILED: ${exc.message}`);
      return 1;
    }
    throw exc;
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
