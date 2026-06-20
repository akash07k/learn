// Local quality gate for the learn corpus. Run from anywhere:
//
//     bun run check        (or: bun run tools/check.ts)
//
// It does four things across every subject under subjects/ and exits non-zero if
// any of them fails:
//   1. Builds the accessible HTML with pandoc (tools/build-html.ts).
//   2. Scans the Markdown sources for banned glyphs a screen reader cannot read.
//   3. Verifies every internal link in the built HTML resolves (file + #fragment).
//   4. Lints each subject's Markdown for the recurring convention breaks adversarial
//      reviews kept re-finding (broken Previous/Next chain, "->" arrows, and any
//      subject-defined line lint such as Proxmox's storage-id rule).
//
// The build lives in tools/build-html.ts, subject discovery in tools/subjects.ts,
// and the checks in tools/checks.ts; this script is just the orchestrator. The whole
// gate is TypeScript on Bun (pandoc is the only external tool).

import { dirname, join } from 'node:path';
import { build, BuildError } from './build-html.ts';
import {
  type Finding,
  findConventionIssues,
  findGlyphIssues,
  findLinkIssues,
  mdFiles,
} from './checks.ts';
import { discover, SubjectError } from './subjects.ts';

const ROOT = dirname(import.meta.dir);

// Authored Markdown at the repo root that is not part of any subject but should
// still be screen-reader clean.
const ROOT_DOCS = ['README.md', 'AUTHORING-CONVENTIONS.md', 'ADDING-A-SUBJECT.md', 'AGENTS.md'];

function runBuild(): boolean {
  console.log('== build ==');
  try {
    build(ROOT);
  } catch (exc) {
    if (exc instanceof BuildError || exc instanceof SubjectError) {
      console.error(`BUILD FAILED: ${exc.message}`);
      return false;
    }
    throw exc;
  }
  return true;
}

function main(): number {
  process.chdir(ROOT); // so reported paths are clean and relative

  let discovered;
  try {
    discovered = discover(ROOT);
  } catch (exc) {
    if (exc instanceof SubjectError) {
      console.error(`SUBJECT DISCOVERY FAILED: ${exc.message}`);
      return 1;
    }
    throw exc;
  }

  let failed = !runBuild();

  console.log('\n== banned-glyph scan ==');
  const glyphRoots = [
    ...discovered.flatMap((s) => s.contentPaths()),
    ...ROOT_DOCS.map((name) => join(ROOT, name)),
  ];
  const glyphs = findGlyphIssues(mdFiles(glyphRoots));
  if (glyphs.length > 0) {
    for (const finding of glyphs) {
      console.log(finding.toString());
    }
    console.log('GLYPH CHECK FAILED');
    failed = true;
  } else {
    console.log('glyph check clean');
  }

  console.log('\n== internal link check (html) ==');
  const { findings: linkFindings, checked } = findLinkIssues(join(ROOT, 'html'));
  for (const finding of linkFindings) {
    console.log(finding.toString());
  }
  console.log(`----\nchecked ${checked} internal links; ${linkFindings.length} broken.`);
  if (linkFindings.length > 0) {
    console.log('LINK CHECK FAILED');
    failed = true;
  }

  console.log('\n== convention check (nav chain, ascii arrows, subject lints) ==');
  const conventionFindings: Finding[] = [];
  for (const subject of discovered) {
    conventionFindings.push(...findConventionIssues(subject));
  }
  if (conventionFindings.length > 0) {
    for (const finding of conventionFindings) {
      console.log(finding.toString());
    }
    console.log(`----\n${conventionFindings.length} convention issue(s) found.`);
    console.log('CONVENTION CHECK FAILED');
    failed = true;
  } else {
    console.log('convention check clean');
  }

  console.log('');
  if (failed) {
    console.error('GATE FAILED');
    return 1;
  }
  console.log('GATE PASSED');
  return 0;
}

process.exit(main());
