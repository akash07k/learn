import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'bun:test';
import { SubjectError, loadSubject } from './subjects.ts';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('loadSubject rejects manifest path traversal in content_dirs', () => {
  const root = tempDir('learn-subjects-traversal-');
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'subject.toml'),
      ['name = "Demo"', 'content_dirs = ["../outside"]'].join('\n'),
      'utf8',
    );

    expect(() => loadSubject(root)).toThrow(SubjectError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadSubject defaults lint_dirs to content_dirs and compiles lint patterns', () => {
  const root = tempDir('learn-subjects-valid-');
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'subject.toml'),
      [
        'name = "Demo"',
        'content_dirs = ["guides"]',
        '',
        '[[lint]]',
        'id = "no-arrow"',
        'message = "no arrows"',
        "patterns = ['''->''']",
      ].join('\n'),
      'utf8',
    );

    const subject = loadSubject(root);
    expect(subject.contentDirs).toEqual(['guides']);
    expect(subject.lintDirs).toEqual(['guides']);
    expect(subject.lintRules).toHaveLength(1);
    expect(subject.lintRules[0]?.patterns[0]?.test('a -> b')).toBeTrue();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadSubject rejects path traversal in nav.no_prev', () => {
  const root = tempDir('learn-subjects-nav-traversal-');
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'subject.toml'),
      [
        'name = "Demo"',
        'content_dirs = ["guides"]',
        '',
        '[nav]',
        'no_prev = ["../outside.md"]',
      ].join('\n'),
      'utf8',
    );

    expect(() => loadSubject(root)).toThrow(SubjectError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadSubject rejects unknown nav keys', () => {
  const root = tempDir('learn-subjects-nav-keys-');
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'subject.toml'),
      [
        'name = "Demo"',
        'content_dirs = ["guides"]',
        '',
        '[nav]',
        'no_previous = ["guides/00.md"]',
      ].join('\n'),
      'utf8',
    );

    expect(() => loadSubject(root)).toThrow(SubjectError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadSubject rejects symlinked content_dirs that escape subject root', () => {
  const root = tempDir('learn-subjects-symlink-');
  const outside = tempDir('learn-subjects-outside-');
  try {
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(root, 'guides'));
    writeFileSync(
      join(root, 'subject.toml'),
      ['name = "Demo"', 'content_dirs = ["guides"]'].join('\n'),
    );

    expect(() => loadSubject(root)).toThrow(SubjectError);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
