// Format the corpus Markdown with the Prettier API (prose reflow to width 100).
//
// Prettier owns Markdown here; oxfmt owns code. We call the Prettier *API*, not the
// CLI: in this Bun environment the Prettier CLI does not hard-wrap Markdown prose
// even with --prose-wrap always, but the API does. Options come from .prettierrc.json
// (proseWrap: always, printWidth: 100, embeddedLanguageFormatting: off, so the code
// inside fenced blocks is never rewritten and the teaching samples stay byte-exact).
//
//     bun run tools/format-md.ts                 # format every tracked .md in place
//     bun run tools/format-md.ts --check         # report unformatted files, exit 1
//     bun run tools/format-md.ts [FILES...]      # format only the given files
//     bun run tools/format-md.ts --check a.md    # check only the given files
//
// With no file arguments it formats every tracked .md (via `git ls-files`), which
// excludes node_modules, html/, and tmp/ for free. Lefthook passes the staged files.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';

/** Decode a spawnSync stdout/stderr buffer to a UTF-8 string. */
function decode(buf: Uint8Array | null): string {
  return new TextDecoder().decode(buf ?? new Uint8Array());
}

/** Run a git command, returning its stdout or throwing with its stderr. */
function git(args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (exit ${result.exitCode}): ${decode(result.stderr).trim()}`,
    );
  }
  return decode(result.stdout);
}

/**
 * Every tracked .md file in the repo, as absolute paths so they resolve regardless of
 * the current directory (git ls-files prints repo-root-relative paths, but readFileSync
 * resolves against cwd). git ls-files honours .gitignore, so node_modules/, html/, and
 * tmp/ are excluded for free.
 */
function trackedMarkdown(): string[] {
  const root = git(['rev-parse', '--show-toplevel']).trim();
  return git(['-C', root, 'ls-files', '*.md'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((rel) => join(root, rel));
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const files = argv.filter((arg) => !arg.startsWith('--'));
  const targets = (files.length > 0 ? files : trackedMarkdown()).filter((f) => f.endsWith('.md'));

  let changed = 0;
  const unformatted: string[] = [];

  for (const file of targets) {
    const source = readFileSync(file, 'utf8');
    const config = (await resolveConfig(file)) ?? {};
    const formatted = await format(source, { ...config, parser: 'markdown', filepath: file });
    if (formatted === source) {
      continue;
    }
    if (check) {
      unformatted.push(file);
    } else {
      writeFileSync(file, formatted, 'utf8');
      changed++;
      console.log(`formatted ${file}`);
    }
  }

  if (check) {
    if (unformatted.length > 0) {
      console.error(`${unformatted.length} Markdown file(s) need formatting:`);
      for (const file of unformatted) {
        console.error(`  ${file}`);
      }
      console.error('Run: bun run format');
      return 1;
    }
    console.log(`all ${targets.length} Markdown file(s) properly formatted`);
    return 0;
  }

  console.log(`formatted ${changed} of ${targets.length} Markdown file(s)`);
  return 0;
}

process.exit(await main());
