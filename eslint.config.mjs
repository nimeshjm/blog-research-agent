// Flat ESLint config. Mirrors the seam discipline elsewhere in this repo:
// minimal surface, no preset noise. `tsconfig.json` already runs `strict`,
// `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters` — a
// `recommended`/`strict` preset here would add lint noise without adding a
// blocking guarantee tsconfig doesn't already give us. We extend
// `tseslint.configs.base` only: it registers the parser and the
// `@typescript-eslint` plugin without turning on any rules, and we opt
// in to exactly the rules REVIEW.md pass 3 needs.
//
// Closes REVIEW.md pass 3's deferred bullet: "No unhandled rejection that
// would retry an already-successful side effect." Workflow steps are
// retried (see src/lib/trace.ts), so a dropped `await` on a step that
// opens a PR or inserts a row silently re-runs a side effect that already
// succeeded. That needs type information plain ast-grep can't get, hence
// ESLint's type-aware rules instead of another ast-grep rule.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `.claude/worktrees` holds git worktrees of this same repo, each with its
    // own tsconfig.json. Without this, `projectService` finds two candidate
    // TSConfigRootDirs and refuses to guess, so `lint:ts` fails for everyone
    // with a worktree checked out - and the pre-push hook then dies before
    // reaching the gates after it. Ignoring the path is the fix; setting
    // `tsconfigRootDir` is not (see the note below on why it stays unset).
    ignores: ['node_modules', '.wrangler', 'dist', '.claude/worktrees'],
  },
  {
    // Matches tsconfig.json's `include`. Nothing outside src/ is part of
    // the tsconfig project the type-aware parser resolves against anyway.
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        // Type-aware linting: resolves each file's tsconfig on the fly
        // instead of a hand-maintained `project` path.
        projectService: true,
        // Deliberately NOT set: `tsconfigRootDir: import.meta.dirname`.
        // Leaving this at its default (process.cwd()) is load-bearing:
        // the proof that these rules actually fire runs this config
        // against a *copy* of the tree in a temp dir, with cwd pointed
        // at that temp dir. Pinning tsconfigRootDir to this repo's path
        // would make `projectService` resolve *this* repo's tsconfig
        // even when running against the copy, and the proof would
        // silently pass against the wrong files. Do not "fix" this.
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
);
