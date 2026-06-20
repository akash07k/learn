// Enforce Conventional Commits (https://www.conventionalcommits.org/) on every
// commit message via the commit-msg Lefthook job. We start from the shared
// community ruleset and widen only the type list to include the descriptive
// types this repo already uses (scaffold, subjects, tooling) alongside the
// standard set, so existing-style messages keep passing.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'style',
        'refactor',
        'perf',
        'test',
        'build',
        'ci',
        'chore',
        'revert',
        'scaffold',
        'subjects',
        'tooling',
      ],
    ],
  },
};
