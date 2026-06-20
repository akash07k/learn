import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'bun:test';
import { findConventionIssues, findLinkIssues, within } from './checks.ts';
import { Subject } from './subjects.ts';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('within treats filesystem roots as containing descendants', () => {
  expect(within('/', '/etc')).toBeTrue();
  expect(within('/', '/')).toBeTrue();
});

test('within compares Windows paths case-insensitively', () => {
  const parent = 'C:/Repo/html';
  const child =
    process.platform === 'win32' ? 'c:/repo/html/index.html' : 'C:/Repo/html/index.html';
  expect(within(parent, child)).toBeTrue();
});

test('findLinkIssues resolves single-quote, unquoted, query, and encoded fragment links', () => {
  const root = tempDir('learn-checks-links-');
  try {
    const htmlRoot = join(root, 'html');
    mkdirSync(htmlRoot, { recursive: true });
    writeFileSync(
      join(htmlRoot, 'index.html'),
      [
        "<a href='target.html#sec%201'>encoded fragment</a>",
        '<a href=target.html?from=index#raw>query plus anchor</a>',
        '<div id="self id"></div>',
        '<a href="#self%20id">self anchor</a>',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(htmlRoot, 'target.html'),
      '<h2 id="sec 1"></h2><a name=\'raw\'></a>',
      'utf8',
    );

    const result = findLinkIssues(htmlRoot);
    expect(result.checked).toBe(3);
    expect(result.findings).toHaveLength(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findLinkIssues reports missing target files for non-standard href quoting', () => {
  const root = tempDir('learn-checks-links-broken-');
  try {
    const htmlRoot = join(root, 'html');
    mkdirSync(htmlRoot, { recursive: true });
    writeFileSync(
      join(htmlRoot, 'index.html'),
      "<a href='missing.html#x'>missing</a>\n<a href=also-missing.html>missing2</a>",
      'utf8',
    );

    const result = findLinkIssues(htmlRoot);
    expect(result.checked).toBe(2);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]?.message).toContain('file missing');
    expect(result.findings[1]?.message).toContain('file missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findLinkIssues rejects targets that escape the built html root', () => {
  const root = tempDir('learn-checks-links-escape-');
  try {
    const htmlRoot = join(root, 'html');
    mkdirSync(htmlRoot, { recursive: true });
    writeFileSync(join(root, 'outside.html'), '<h1>Outside</h1>', 'utf8');
    writeFileSync(join(htmlRoot, 'index.html'), '<a href="../outside.html">outside</a>', 'utf8');

    const result = findLinkIssues(htmlRoot);
    expect(result.checked).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.message).toContain('escapes html root');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findLinkIssues rejects targets that resolve to directories', () => {
  const root = tempDir('learn-checks-links-directory-');
  try {
    const htmlRoot = join(root, 'html');
    mkdirSync(join(htmlRoot, 'section'), { recursive: true });
    writeFileSync(join(htmlRoot, 'index.html'), '<a href="section/">section</a>', 'utf8');

    const result = findLinkIssues(htmlRoot);
    expect(result.checked).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.message).toContain('not a file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findLinkIssues rejects symlinked targets that escape the built html root', () => {
  const root = tempDir('learn-checks-links-symlink-');
  try {
    const htmlRoot = join(root, 'html');
    mkdirSync(htmlRoot, { recursive: true });
    writeFileSync(join(root, 'outside.html'), '<h1>Outside</h1>', 'utf8');
    try {
      symlinkSync(join(root, 'outside.html'), join(htmlRoot, 'linked.html'), 'file');
    } catch (exc) {
      if (process.platform === 'win32') {
        return;
      }
      throw exc;
    }
    writeFileSync(join(htmlRoot, 'index.html'), '<a href="linked.html">outside</a>', 'utf8');

    const result = findLinkIssues(htmlRoot);
    expect(result.checked).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.message).toContain('escapes html root');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findConventionIssues flags ascii arrows and missing nav links for numbered guides', () => {
  const root = tempDir('learn-checks-conventions-');
  try {
    const guides = join(root, 'guides');
    mkdirSync(guides, { recursive: true });
    writeFileSync(join(guides, '01-test.md'), '# Test\n\nFlow -> next.\n', 'utf8');
    const subject = new Subject(
      'demo',
      'Demo',
      root,
      ['guides'],
      ['guides'],
      new Set(),
      new Set(),
      [],
    );

    const findings = findConventionIssues(subject);
    const messages = findings.map((f) => f.message);
    expect(messages.some((m) => m.includes('ascii-arrow'))).toBeTrue();
    expect(messages.some((m) => m.includes('missing a "Previous:" link'))).toBeTrue();
    expect(messages.some((m) => m.includes('missing a "Next:" link'))).toBeTrue();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
