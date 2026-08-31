#!/usr/bin/env node
// Mutation self-test for scripts/review-checks.mjs. See issue #25.
//
// The checker passing on HEAD proves nothing - HEAD is already compliant.
// This test copies the tree (including .git, so git-backed checks like
// dev-vars-untracked and branch-carries-issue behave exactly as they do on
// the real repo) into a temp dir per row and applies one mutation. Most rows
// then run the checker with --root <tmp> --json, and assert:
//   - every id in `expect` has status 'fail'
//   - every OTHER Important-severity id does NOT have status 'fail'
//     (Nit-severity ids are allowed to vary unless explicitly expected -
//     some mutations are only visible to a Nit check)
// A `tool: 'eslint'` row instead runs the repo's own eslint.config.mjs
// against the temp copy and asserts on its exit code (and, for a non-zero
// expectation, that the specific rule named fired - see runEslint()).
//
// Row 0 is the empty mutation: prove the harness itself reports all-green
// before trusting any row that claims a specific check fails. The eslint
// rows get the same treatment (their own baseline row).
//
// The checker-based rows cover exactly the 12 checks review-checks.mjs still
// implements. The other 7 (moved to ast-grep, or dropped for
// `no-credential-literals` - see the comment in review-checks.mjs) have no
// rows here any more; their mutation coverage now lives in rule-tests/*.yml.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CHECKER = path.join(__dirname, 'review-checks.mjs');

// `cwd` is not enough to tell git which repository to act on. Git exports
// GIT_DIR (and GIT_WORK_TREE, GIT_INDEX_FILE, ...) to its hooks, and those
// override discovery outright - so under the pre-push hook, every `git` call in
// this file and in the checker would operate on the real repository no matter
// which directory it ran in. That is the same bug as the gitdir pointer below,
// arriving by a second route, and it reproduces only from a hook: `npm run
// test:checks` by hand is clean. Strip the whole GIT_* family for the same
// reason the GITHUB_* strip in runChecker takes the whole family.
function envWithoutGitVars() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
}

/** `git rev-parse <flag>` as an absolute path, or null if git cannot answer. */
function gitPath(dir, flag) {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', flag], {
    cwd: dir,
    encoding: 'utf8',
    env: envWithoutGitVars(),
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

// The files git keeps per worktree rather than in the common dir. Everything
// else a row needs - objects, refs, packed-refs, config - is shared and comes
// across with the common dir. `commondir` and `gitdir` are deliberately absent:
// copying either one re-links the sandbox to the real repository and silently
// reintroduces the bug this exists to prevent.
const PER_WORKTREE_GIT_FILES = ['HEAD', 'index', 'ORIG_HEAD', 'config.worktree'];

function isLinkedWorktree(dir) {
  const dotGit = path.join(dir, '.git');
  return fs.existsSync(dotGit) && fs.statSync(dotGit).isFile();
}

// Each row's sandbox has to be a *self-contained* repository: rows 2 and 11 run
// `git add -f` and `git checkout -b`, and the checker reads the index, the branch
// name and full history back out. Copying the tree verbatim gives that in an
// ordinary checkout, where `.git` is a directory.
//
// In a linked worktree it does not. There `.git` is a one-line
// `gitdir: /repo/.git/worktrees/<name>` pointer, so a verbatim copy leaves every
// sandbox pointing at the real shared gitdir and every row's `git` call operating
// on the real repository: row 2 staged `.dev.vars` in the live index and row 11
// moved the live HEAD onto `not-an-issue-branch`, neither of them undone, which
// then failed 14 later rows as `unexpected FAIL` (issue #31).
//
// So when the source is a linked worktree, skip the pointer and materialise a
// standalone `.git` from the common dir, taking HEAD and the index from the
// worktree's own gitdir so the row still sees the state it was launched on.
// `assertRealRepoUntouched` in the runner is the backstop if this ever regresses.
function copyTree(src, dest) {
  const linked = isLinkedWorktree(src);
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (s) => {
      const rel = path.relative(src, s);
      if (rel === 'node_modules' || rel.startsWith(`node_modules${path.sep}`)) return false;
      if (rel === '.wrangler' || rel.startsWith(`.wrangler${path.sep}`)) return false;
      // A local `.venv` is ~26 MB and this copies the tree once per row.
      // scripts/plan_metrics.py's `--emit` path needs opentelemetry installed,
      // and CLAUDE.md points at a venv for that, so one shows up here as soon
      // as anyone follows those instructions.
      if (rel === '.venv' || rel.startsWith(`.venv${path.sep}`)) return false;
      if (linked && rel === '.git') return false;
      return true;
    },
  });
  if (!linked) return;

  const commonDir = gitPath(src, '--git-common-dir');
  const ownDir = gitPath(src, '--git-dir');
  if (!commonDir || !ownDir) {
    throw new Error(`${src} has a gitdir pointer but git could not resolve it (common=${commonDir}, own=${ownDir})`);
  }
  const destGit = path.join(dest, '.git');
  fs.cpSync(commonDir, destGit, {
    recursive: true,
    // `worktrees/` holds the per-worktree gitdirs of every linked worktree,
    // each pointing back out at its own checkout. None of it belongs in a
    // standalone copy.
    filter: (s) => {
      const rel = path.relative(commonDir, s);
      return !(rel === 'worktrees' || rel.startsWith(`worktrees${path.sep}`));
    },
  });
  for (const name of PER_WORKTREE_GIT_FILES) {
    const from = path.join(ownDir, name);
    const to = path.join(destGit, name);
    // Removing when the worktree has none is the half that matters: the common
    // dir carries the *main* checkout's HEAD and index, and inheriting those
    // would be a quieter version of the same bug.
    if (fs.existsSync(from)) fs.copyFileSync(from, to);
    else fs.rmSync(to, { force: true });
  }
}

function readFile(dir, rel) {
  return fs.readFileSync(path.join(dir, rel), 'utf8');
}
function writeFile(dir, rel, text) {
  fs.writeFileSync(path.join(dir, rel), text);
}
function mustReplace(dir, rel, oldStr, newStr, { count = 1 } = {}) {
  const text = readFile(dir, rel);
  const occurrences = text.split(oldStr).length - 1;
  if (occurrences !== count) {
    throw new Error(`mustReplace: expected ${count} occurrence(s) of ${JSON.stringify(oldStr)} in ${rel}, found ${occurrences}`);
  }
  writeFile(dir, rel, text.split(oldStr).join(newStr));
}

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: envWithoutGitVars() });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${dir}: ${r.stderr}`);
  }
  return r.stdout;
}

function runChecker(root, extraArgs = [], extraEnv = {}) {
  // Strip every GITHUB_* var before forwarding to the child, rather than
  // passing `process.env` straight through. `currentBranch()` in
  // review-checks.mjs deliberately trusts GITHUB_HEAD_REF over `git branch
  // --show-current` whenever GITHUB_ACTIONS=true, because actions/checkout
  // leaves a `pull_request` run on a detached merge ref where git itself has
  // no branch name to give. That's correct for the checker running for real
  // in CI - but it means this *test harness*, when it is itself invoked by a
  // GitHub Actions job, inherits that job's own GITHUB_ACTIONS/GITHUB_HEAD_REF
  // and would forward them into every row's child process unless stopped.
  // Row 11 checks out a bad branch name *inside the temp copy*; with the
  // outer job's env leaking through, the checker would ignore that checkout
  // and report the outer runner's real PR branch instead - a false PASS that
  // reproduces only in CI and never on a laptop, which is exactly backwards
  // for a self-test whose entire point is to be trustworthy in both places.
  // Strip the whole GITHUB_* family, not just those two names, since more of
  // them could matter to future checks. A row that genuinely wants to
  // exercise the CI code path (assert `currentBranch()`'s GITHUB_HEAD_REF
  // branch) can still do so - `extraEnv` is applied after the strip, so it
  // sets GITHUB_* back deliberately for that one row's child only.
  // GIT_* goes too, and for a sharper reason than GITHUB_*: the checker runs
  // git against `--root <tmp>`, and an inherited GIT_DIR would point it at the
  // real repository instead. See envWithoutGitVars().
  const baseEnv = Object.fromEntries(
    Object.entries(envWithoutGitVars()).filter(([k]) => !k.startsWith('GITHUB_')),
  );
  const r = spawnSync('node', [CHECKER, '--root', root, '--json', ...extraArgs], {
    encoding: 'utf8',
    env: { ...baseEnv, ...extraEnv },
  });
  if (r.status === null) {
    throw new Error(`checker did not exit cleanly: ${r.error ?? r.stderr}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (err) {
    throw new Error(`checker did not print valid JSON.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  }
  return parsed;
}

// eslint.config.mjs's rules apply only to `src/**/*.ts`, so lint just that
// directory rather than the whole tree - the temp copy also carries
// scripts/, rule-tests/, etc. that the config doesn't select anyway, but
// there's no reason to make eslint walk them.
const ESLINT_CONFIG = path.join(REPO_ROOT, 'eslint.config.mjs');
const ESLINT_BIN = path.join(REPO_ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');

function runEslint(root) {
  // A fresh worktree has no `node_modules` of its own, and ESLINT_BIN is
  // resolved under REPO_ROOT. Say so, rather than letting node print a
  // MODULE_NOT_FOUND stack that reads like a defect in the row.
  if (!fs.existsSync(ESLINT_BIN)) {
    throw new Error(`eslint is not installed at ${ESLINT_BIN} - run \`npm install\` in ${REPO_ROOT} (a fresh worktree needs its own install, or a symlink to one)`);
  }
  // Run via `node <bin>`, not the `.bin/eslint` shim, and point `--config`
  // at *this repo's* eslint.config.mjs by absolute path: flat config
  // resolves plugins relative to the config file's own location, so
  // pointing at the repo's config is what lets resolution find the repo's
  // node_modules even though the temp copy (deliberately, see copyTree) has
  // none of its own. `cwd` is the temp dir, not REPO_ROOT - that's what
  // makes `projectService` (see the comment on `tsconfigRootDir` in
  // eslint.config.mjs) resolve the *temp* dir's tsconfig.json and lint the
  // mutated files, not this repo's.
  const r = spawnSync('node', [ESLINT_BIN, '--config', ESLINT_CONFIG, 'src'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (r.status === null) {
    throw new Error(`eslint did not exit cleanly: ${r.error ?? r.stderr}`);
  }
  return r;
}

// ---------------------------------------------------------------------------
// Mutation table
// ---------------------------------------------------------------------------

const rows = [
  {
    name: 'baseline (no mutation) - proves the harness itself is not vacuously green',
    expectFail: [],
    mutate() {},
  },
  {
    // Target moved from src/workflow.ts to src/summarize-workflow.ts on
    // 2026-08-31 (#75): the summarize loop this row exercises moved into a
    // SummarizeWorkflow child, the same way gather's own loop moved into
    // GatherWorkflow one PR earlier. `inference-loop-has-break` was widened
    // to scan every src file rather than only workflow.ts for exactly this
    // reason - a file-pinned check would have gone quietly vacuous instead
    // of catching the mutation below.
    name: 'strip the break from the summarize loop',
    expectFail: ['inference-loop-has-break'],
    mutate(dir) {
      mustReplace(
        dir,
        'src/summarize-workflow.ts',
        '    if (neuronsSpent + SUMMARY_NEURON_ESTIMATE > neuronBudget) break;\n\n',
        '',
      );
    },
  },
  // -------------------------------------------------------------------------
  // `cpu-premise-is-per-invocation` (requirement 11, see the comment in
  // review-checks.mjs) - proves the stale-phrase scan fires in prose and in
  // code, fires across a wrapped line break and not only within one line,
  // and that the sentinel is load-bearing on its own rather than decorative
  // alongside the stale-phrase scan.
  // -------------------------------------------------------------------------
  {
    name: 'reintroduce "10 ms ... per step" prose in a markdown file (CLAUDE.md)',
    expectFail: ['cpu-premise-is-per-invocation'],
    expectFindingMatch: {
      'cpu-premise-is-per-invocation': /stale per-step CPU premise/,
    },
    mutate(dir) {
      // Inserted as a new paragraph rather than overwriting the corrected
      // bullet at :62 - this row isolates the stale-phrase detector from the
      // sentinel (row below), so a failure here can only mean the detector
      // itself stopped matching.
      mustReplace(
        dir,
        'CLAUDE.md',
        '## Repeated mistakes',
        'Mutation-row probe: the budget is 10 ms per step.\n\n## Repeated mistakes',
      );
    },
  },
  {
    name: 'reintroduce the stale premise in a .ts comment (src/lib/feed.ts)',
    expectFail: ['cpu-premise-is-per-invocation'],
    expectFindingMatch: {
      'cpu-premise-is-per-invocation': /stale per-step CPU premise/,
    },
    mutate(dir) {
      mustReplace(
        dir,
        'src/lib/feed.ts',
        "import type { FeedItem, ParsedItem } from './types';",
        "import type { FeedItem, ParsedItem } from './types';\n\n// Mutation-row probe: 10 ms CPU per step.",
      );
    },
  },
  {
    name: 'reintroduce the stale premise wrapped across two lines - proves the sliding window, not a single-line grep',
    expectFail: ['cpu-premise-is-per-invocation'],
    expectFindingMatch: {
      'cpu-premise-is-per-invocation': /stale per-step CPU premise/,
    },
    mutate(dir) {
      // "10 ms" ends one line and "per step" opens the next, with nothing
      // between them but the line break the checker's two-line window
      // collapses to a single space - a single-line-only grep would miss
      // this entirely.
      mustReplace(
        dir,
        'CLAUDE.md',
        '## Repeated mistakes',
        'Mutation-row probe: the budget is 10 ms\nper step, split across a line break.\n\n## Repeated mistakes',
      );
    },
  },
  {
    name: 'strip enough corrected per-invocation assertions in feature 001 spec.md to drop below the sentinel',
    expectFail: ['cpu-premise-is-per-invocation'],
    expectFindingMatch: {
      'cpu-premise-is-per-invocation': /sentinel: only \d+ correct per-invocation assertions found/,
    },
    mutate(dir) {
      // Strips every corrected "per invocation" assertion this file carries
      // (4 of the 11 the sentinel counts) without touching the stale-phrase
      // detector's input at all - proves the sentinel fires on its own when
      // the tree simply stops asserting the corrected premise, rather than
      // riding along on the rows above.
      const rel = 'features/001-scheduled-research-drafts/spec.md';
      const text = readFile(dir, rel);
      const stripped = text.replace(/per[-\s]invocation/gi, 'per unit of work');
      if (stripped === text) {
        throw new Error(`expected at least one "per invocation" occurrence to strip in ${rel}`);
      }
      writeFile(dir, rel, stripped);
    },
  },
  {
    name: 'reintroduce the premise with no CPU figure at all ("its own CPU budget") in a .ts comment',
    expectFail: ['cpu-premise-is-per-invocation'],
    expectFindingMatch: {
      'cpu-premise-is-per-invocation': /stale per-step CPU premise/,
    },
    mutate(dir) {
      // The gap #75 found: every other alternative in CPU_STALE_RE needs a CPU
      // figure, so `src/index.ts` and `src/workflow.ts` asserted the retired
      // premise in prose for two features without firing anything. No "10 ms"
      // here on purpose - with the figure-less alternative removed from
      // CPU_STALE_RE this row goes green, which is what makes it a guard.
      mustReplace(
        dir,
        'src/lib/feed.ts',
        "import type { FeedItem, ParsedItem } from './types';",
        "import type { FeedItem, ParsedItem } from './types';\n\n// Mutation-row probe: each step gets its own CPU budget.",
      );
    },
  },
  {
    name: 'a subrequest per-step phrase next to a correct CPU figure must NOT fire (#77)',
    expectFail: [],
    mutate(dir) {
      // Verbatim the line that fired while feature 003's intent.md was being
      // written (#77): the CPU figure on it already says per-invocation, and
      // the per-step phrase belongs to CLAUDE.md's own 50-subrequest rule. The
      // 50-character window cannot tell which noun the per-step attaches to,
      // so the fix is to discard a match with a subrequest/neuron/query token
      // inside it. Remove CPU_STALE_OTHER_NOUN_RE and this row goes red - the
      // only direction of this check a row can assert, since the finding it
      // guards against is a false one.
      mustReplace(
        dir,
        'CLAUDE.md',
        '## Repeated mistakes',
        'Mutation-row probe: the\n10 ms-per-invocation CPU allocation, the 50-subrequest-per-step ceiling, and the\nneuron budget.\n\n## Repeated mistakes',
      );
    },
  },
  {
    name: 'force-track .dev.vars in the git index',
    expectFail: ['dev-vars-untracked'],
    mutate(dir) {
      // Write the file rather than relying on the copied tree already having
      // one. `.dev.vars` is gitignored, so it exists on a developer's disk and
      // nowhere else: a CI checkout has none, and `git add -f .dev.vars` there
      // fails with "pathspec did not match any files" - a SETUP FAIL, not the
      // finding this row is asserting. The row passed locally purely because
      // the file happened to be on disk. Same hermeticity rule as the GITHUB_*
      // strip in `runChecker`: a row must not depend on the environment it runs
      // in. Contents are a placeholder - `dev-vars-untracked` looks at the git
      // index and history, never at what the file says.
      writeFile(dir, '.dev.vars', 'PLACEHOLDER=not-a-real-secret\n');
      // Force it into the index the way a slip past .gitignore would.
      git(dir, ['add', '-f', '.dev.vars']);
    },
  },
  {
    name: 'GITHUB_TOKEN = "ghp_..." under [vars]',
    expectFail: ['wrangler-vars-are-not-secrets'],
    mutate(dir) {
      mustReplace(
        dir,
        'wrangler.toml',
        'NEURON_BUDGET_PER_RUN = "6000"',
        'NEURON_BUDGET_PER_RUN = "6000"\nGITHUB_TOKEN = "' + 'gh' + 'p_' + 'A'.repeat(36) + '"',
      );
    },
  },
  {
    name: 'span.setAttribute(ATTR_TOPIC_ID, err.message)',
    expectFail: ['span-attributes-allowlisted'],
    mutate(dir) {
      mustReplace(
        dir,
        'src/workflow.ts',
        '      if (result !== null) span.setAttribute(ATTR_TOPIC_ID, result.id);',
        "      if (result !== null) span.setAttribute(ATTR_TOPIC_ID, result.id);\n      try { throw new Error('x'); } catch (err) { span.setAttribute(ATTR_TOPIC_ID, (err as Error).message); }",
      );
    },
  },
  {
    name: 'spread-only attrs literal ({ ...base }) - nothing flagged',
    expectFail: [],
    mutate(dir) {
      mustReplace(
        dir,
        'src/workflow.ts',
        "    const topic = await traceStep('select-topic', {}, async (span) => {",
        "    await traced('spread-only-mutation-probe', { ...({ x: 1 }) }, async () => {});\n    const topic = await traceStep('select-topic', {}, async (span) => {",
      );
      // `traced` isn't imported in workflow.ts today - add it so the file still parses as intended.
      mustReplace(
        dir,
        'src/workflow.ts',
        "import {\n  ATTR_GATHER_CHILDREN,",
        "import {\n  ATTR_GATHER_CHILDREN,\n  traced,",
      );
    },
  },
  {
    // Row 5 alone can't tell "the spread was skipped" apart from "the call
    // was never matched in the first place" - both look like zero findings.
    // Add a forbidden property as the spread's sibling in the same object
    // literal: if the classifier recognized the call at all, this must still
    // be flagged even though the spread next to it is not.
    name: 'spread + a forbidden sibling property in the same attrs literal - only the sibling is flagged',
    expectFail: ['span-attributes-allowlisted'],
    mutate(dir) {
      mustReplace(
        dir,
        'src/workflow.ts',
        "    const topic = await traceStep('select-topic', {}, async (span) => {",
        "    await traced('spread-plus-forbidden-probe', { ...({ x: 1 }), [ATTR_TOPIC_ID]: ({ message: 'x' }).message }, async () => {});\n    const topic = await traceStep('select-topic', {}, async (span) => {",
      );
      mustReplace(
        dir,
        'src/workflow.ts',
        "import {\n  ATTR_GATHER_CHILDREN,",
        "import {\n  ATTR_GATHER_CHILDREN,\n  traced,",
      );
    },
  },
  {
    name: "duplicate 'shortlist' step name",
    expectFail: ['step-names-unique'],
    mutate(dir) {
      mustReplace(
        dir,
        'src/workflow.ts',
        "    const sources = await traceStep('load-sources', {}, async () => loadSources(this.env));",
        "    const sources = await traceStep('load-sources', {}, async () => loadSources(this.env));\n    await traceStep('shortlist', {}, async () => []);",
      );
    },
  },
  {
    name: "traceStep(`record:${topic.id}`, ...) - dynamic prefix not in the allowlist",
    expectFail: ['step-names-static'],
    mutate(dir) {
      mustReplace(
        dir,
        'src/workflow.ts',
        "    if (topic === null) {",
        "    await traceStep(`record:${topic?.id}`, {}, async () => {});\n    if (topic === null) {",
      );
    },
  },
  {
    name: 'BLOG_BASE_BRANCH read outside a `base:` property',
    expectFail: ['base-branch-not-a-write-target'],
    mutate(dir) {
      mustReplace(
        dir,
        'src/workflow.ts',
        '    const budget = Number(this.env.NEURON_BUDGET_PER_RUN);',
        '    const budget = Number(this.env.NEURON_BUDGET_PER_RUN);\n    void this.env.BLOG_BASE_BRANCH;',
      );
    },
  },
  {
    name: 'NEURON_BUDGET_PER_RUN no longer read from `*.env`',
    expectFail: ['budget-read-from-env'],
    mutate(dir) {
      mustReplace(
        dir,
        'src/workflow.ts',
        'Number(this.env.NEURON_BUDGET_PER_RUN)',
        'Number(6000)',
      );
    },
  },
  {
    name: "branch renamed off an issue-numbered name",
    expectFail: ['branch-carries-issue'],
    mutate(dir) {
      git(dir, ['checkout', '-b', 'not-an-issue-branch']);
    },
  },
  {
    name: 'PR body empty (gh stubbed so no live network/API call is made)',
    expectFail: ['pr-body-not-empty'],
    extraArgs: ['--pr', '999999'],
    mutate(dir) {
      const binDir = path.join(dir, '.fake-bin');
      fs.mkdirSync(binDir, { recursive: true });
      // A stub `gh` on PATH: always answers `pulls/<N> --jq .body` with an
      // empty body, so the row is deterministic and needs no network access
      // or real PR to exist.
      fs.writeFileSync(path.join(binDir, 'gh'), '#!/bin/sh\nprintf ""\nexit 0\n');
      fs.chmodSync(path.join(binDir, 'gh'), 0o755);
    },
    extraEnv(dir) {
      return { PATH: `${path.join(dir, '.fake-bin')}${path.delimiter}${process.env.PATH}` };
    },
  },
  {
    // Proves the new stacked-PR branch of pr-body-not-empty (issue #47):
    // an intermediate PR against issue 47 whose body carries the explicit
    // `Part N of M of #47` marker instead of `Closes #47` must NOT fail.
    // Without the fix this row fails, exactly like the pre-fix checker
    // failed every real intermediate PR in a stack - that's what makes this
    // a true positive rather than a vacuous pass. Checks out a branch
    // explicitly (as the rename row above does) rather than trusting
    // whatever branch the outer test run happens to be on.
    name: "PR body carries 'Part N of M of #47' instead of 'Closes #47' (legitimate intermediate stacked PR)",
    expectFail: [],
    // A note only asserts "not fail"; a stub `gh` that silently fell off
    // PATH would SKIP the check and still read as a pass there (issue #47's
    // own warning about a row that passes vacuously). Assert the exact
    // status so this row actually proves the accept branch ran and passed.
    expectStatus: { 'pr-body-not-empty': 'pass' },
    extraArgs: ['--pr', '999999'],
    mutate(dir) {
      git(dir, ['checkout', '-b', '47-stacked-row']);
      const binDir = path.join(dir, '.fake-bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(binDir, 'gh'), '#!/bin/sh\nprintf "Part 2 of 4 of #47"\nexit 0\n');
      fs.chmodSync(path.join(binDir, 'gh'), 0o755);
    },
    extraEnv(dir) {
      return { PATH: `${path.join(dir, '.fake-bin')}${path.delimiter}${process.env.PATH}` };
    },
  },
  {
    // The mirror of the row above: the marker is present and well-formed,
    // but names a different issue than the branch does. Must still fail -
    // proves the check ties the marker to the branch's own issue rather
    // than accepting any 'Part N of M of #<anything>' text. Asserts the
    // actual finding message, not just the status: an unrecognized-marker
    // FAIL and a wrong-issue FAIL look identical as a bare status, and the
    // point of this row is that the wrong-issue branch specifically fired.
    name: "PR body's 'Part N of M of #<issue>' marker names the wrong issue",
    expectFail: ['pr-body-not-empty'],
    expectFindingMatch: {
      'pr-body-not-empty': /names issue #99, not the branch's #47/,
    },
    extraArgs: ['--pr', '999999'],
    mutate(dir) {
      git(dir, ['checkout', '-b', '47-stacked-row-wrong-issue']);
      const binDir = path.join(dir, '.fake-bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(binDir, 'gh'), '#!/bin/sh\nprintf "Part 2 of 4 of #99"\nexit 0\n');
      fs.chmodSync(path.join(binDir, 'gh'), 0o755);
    },
    extraEnv(dir) {
      return { PATH: `${path.join(dir, '.fake-bin')}${path.delimiter}${process.env.PATH}` };
    },
  },
  {
    // Well-formed marker, right issue, but N > M - an invalid ordinal. Must
    // still fail - proves N/M are validated rather than accepted as-is.
    // Same reasoning as the row above for asserting the message, not just
    // the status.
    name: "PR body's 'Part N of M of #47' marker has N > M",
    expectFail: ['pr-body-not-empty'],
    expectFindingMatch: {
      'pr-body-not-empty': /invalid range \(need 1 <= N <= M\)/,
    },
    extraArgs: ['--pr', '999999'],
    mutate(dir) {
      git(dir, ['checkout', '-b', '47-stacked-row-bad-range']);
      const binDir = path.join(dir, '.fake-bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(binDir, 'gh'), '#!/bin/sh\nprintf "Part 5 of 2 of #47"\nexit 0\n');
      fs.chmodSync(path.join(binDir, 'gh'), 0o755);
    },
    extraEnv(dir) {
      return { PATH: `${path.join(dir, '.fake-bin')}${path.delimiter}${process.env.PATH}` };
    },
  },
  {
    // The issue's wording is "rename traceStep so the matcher stops
    // matching". Under an initializer-based resolver ("any identifier
    // initialized from a tracerFor(...) call"), consistently renaming the
    // *local binding* cannot break resolution - it isn't keyed on that
    // name. What the resolver is keyed on is the literal callee name
    // `tracerFor` itself. So this row renames the seam function
    // (`tracerFor` -> `tracerForRenamed`, definition + call site) rather
    // than the local `traceStep` binding: a legitimate future refactor of
    // the seam that the checker was not updated for. That is exactly the
    // scenario the sentinel minimum exists to catch.
    name: 'rename the tracerFor seam function (matcher stops resolving step-name calls)',
    expectFail: ['step-names-unique', 'step-names-static'],
    expectPassStillGreen: ['span-attributes-allowlisted'], // 12 non-tracerFor-bound sites remain, still >= 8
    // The rename doesn't create a duplicate or a bad template - it makes the
    // matcher stop resolving step-name calls at all (0 calls found), which
    // would otherwise mean an *empty* finding set and a false PASS. The FAIL
    // here must be the sentinel firing, not some other coincidental finding -
    // assert the actual message, not just the status.
    expectFindingMatch: {
      'step-names-unique': /sentinel: only \d+ step-name calls resolved/,
      'step-names-static': /sentinel: only \d+ step-name calls resolved/,
    },
    mutate(dir) {
      mustReplace(dir, 'src/lib/trace.ts', 'export function tracerFor(', 'export function tracerForRenamed(');
      mustReplace(dir, 'src/workflow.ts', 'tracerFor,\n} from', 'tracerForRenamed,\n} from');
      mustReplace(dir, 'src/workflow.ts', 'tracerFor(step, event)', 'tracerForRenamed(step, event)');
      // feature 003 (#75) gave GatherWorkflow its own tracerFor(step, event)
      // call in a second file - left unrenamed, its step-name calls alone
      // would still clear the sentinel and this row would stop proving what
      // its name says.
      mustReplace(
        dir,
        'src/gather-workflow.ts',
        "ATTR_GATHER_CHILD_INDEX, ATTR_SOURCES_GATHERED, tracerFor } from './lib/trace'",
        "ATTR_GATHER_CHILD_INDEX, ATTR_SOURCES_GATHERED, tracerForRenamed } from './lib/trace'",
      );
      mustReplace(dir, 'src/gather-workflow.ts', 'tracerFor(step, event)', 'tracerForRenamed(step, event)');
      // Extended 2026-08-31 (#75): SummarizeWorkflow is a third file with its
      // own tracerFor(step, event) call, the same staleness the comment
      // above already names - left unrenamed, its step-name calls alone
      // would still clear the sentinel.
      mustReplace(
        dir,
        'src/summarize-workflow.ts',
        "ATTR_SUMMARIZE_CHILD_INDEX, ATTR_SUMMARIZE_SKIP_REASON, tracerFor } from './lib/trace'",
        "ATTR_SUMMARIZE_CHILD_INDEX, ATTR_SUMMARIZE_SKIP_REASON, tracerForRenamed } from './lib/trace'",
      );
      mustReplace(dir, 'src/summarize-workflow.ts', 'tracerFor(step, event)', 'tracerForRenamed(step, event)');
    },
  },
  // -------------------------------------------------------------------------
  // `checks-and-docs-in-sync` (see issue #25 follow-up) - proves the three
  // clauses described in its comment in review-checks.mjs actually fire:
  // (1) every rules/<id>.yml has a paired rule-tests/<id>-test.yml, whose own
  // id: field agrees with the filename stem, (2) every REVIEW.md marker
  // names a rule/check that exists. (Clause 3, "nothing undocumented", isn't
  // given its own row: it can only be tripped by *removing* a backtick
  // mention from REVIEW.md, which is indistinguishable in spirit from the
  // marker mutation below and would just be exercising the same `allBack-
  // tickTokens` set from the other direction.)
  // -------------------------------------------------------------------------
  {
    name: 'delete rule-tests/no-bare-step-do-test.yml (rule with no matching test)',
    expectFail: ['checks-and-docs-in-sync'],
    mutate(dir) {
      fs.rmSync(path.join(dir, 'rule-tests', 'no-bare-step-do-test.yml'));
    },
  },
  {
    // A bogus marker is *added* alongside the real ones rather than
    // overwriting one, so this row can't accidentally also trip clause 3
    // (an id that stops being mentioned anywhere) - it isolates clause 2.
    name: 'REVIEW.md marker names a check id that does not exist',
    expectFail: ['checks-and-docs-in-sync'],
    mutate(dir) {
      mustReplace(
        dir,
        'REVIEW.md',
        '- `.dev.vars` must stay gitignored. (mechanical: `dev-vars-untracked`)',
        '- `.dev.vars` must stay gitignored. (mechanical: `dev-vars-untracked`)\n' +
          '- Mutation-table probe only, not a real bullet. (mechanical: `not-a-real-check`)',
      );
    },
  },
  {
    // Judgement call (see the review prompt for #25): clause 1 has two
    // independent failure modes - "no test file" (row above) and "test file
    // exists but the rule's own id: disagrees with its filename stem". The
    // second is worth its own row: a rule and its test can be paired by
    // filename while actually testing a *different* rule if the id: field
    // inside the yml drifts from the filename (e.g. a copy-paste of an
    // existing rule file renamed but not re-ided). That's a distinct bug
    // clause 1 exists specifically to catch, and the "no test file" row
    // above cannot exercise it - the mismatched rule here still has a
    // same-stem test file sitting right next to it.
    name: 'rule id: field disagrees with its own filename stem',
    expectFail: ['checks-and-docs-in-sync'],
    mutate(dir) {
      mustReplace(dir, 'rules/no-hardcoded-urls.yml', 'id: no-hardcoded-urls\n', 'id: no-hardcoded-urls-wrong\n');
    },
  },
  // -------------------------------------------------------------------------
  // eslint rows - a different shape (`tool: 'eslint'`) from everything
  // above: these don't run the checker at all, they run the repo's own
  // `eslint.config.mjs` against the temp copy and assert on its exit code.
  // See runEslint() for why cwd/--config are wired the way they are.
  //
  // Row 0 above exists to prove the checker-based rows aren't vacuously
  // green by running the harness unmutated first; do the same here before
  // trusting the mutated row below.
  // -------------------------------------------------------------------------
  {
    name: 'eslint baseline (no mutation) - proves the eslint runner itself is not vacuously green',
    tool: 'eslint',
    expectExitCode: 0,
    mutate() {},
  },
  {
    // `no-floating-promises` only flags a promise-producing call in
    // *statement position* - `const x = traceStep(...)` is an assignment
    // and the rule has nothing to say about it. Of the eleven `await
    // traceStep(` call sites in workflow.ts, only four are statement-
    // position (the four `record-*` outcome steps); this drops the `await`
    // from `record-success` specifically, not e.g. `select-topic`, whose
    // result is assigned to `topic` and would leave the rule silent - a
    // vacuous row that "passed" only because nothing was ever mutated into
    // its blind spot.
    name: 'drop the await on the record-success step (statement-position floating promise)',
    tool: 'eslint',
    expectExitCode: 'nonzero',
    // Non-zero alone isn't enough - eslint also exits non-zero on a config
    // resolution failure or a parse error, and either would make this row a
    // false PASS that proves nothing about no-floating-promises. Same
    // reasoning as row 13's sentinel: assert the rule that actually fired.
    expectStdoutContains: '@typescript-eslint/no-floating-promises',
    mutate(dir) {
      mustReplace(dir, 'src/workflow.ts', "await traceStep(\n      'record-success',", "traceStep(\n      'record-success',");
    },
  },
  {
    // Appended rather than inserted: the row indices above are referred to by
    // number, here and in issue #31.
    name: 'copyTree gives a linked worktree a sandbox that owns its gitdir (issue #31)',
    tool: 'worktree',
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

// What a leaking row can actually reach, and nothing wider. Deliberately not
// `for-each-ref` or `git branch`: another session may be committing in the
// shared checkout at the same time, and its work is not this harness's business
// to police. HEAD covers row 11's `checkout -b`; porcelain status covers row
// 2's staged `.dev.vars`.
function realRepoFingerprint() {
  const env = envWithoutGitVars();
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', env });
  const symref = spawnSync('git', ['symbolic-ref', '--quiet', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', env });
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8', env });
  if (head.status !== 0 || status.status !== 0) return null; // no git, or not a repo
  // symbolic-ref exits non-zero on a detached HEAD, which is a state, not an error.
  return JSON.stringify({ head: head.stdout.trim(), ref: symref.stdout.trim(), status: status.stdout });
}

/**
 * Fails the whole run the moment a row writes through to the real repository,
 * rather than letting the pollution surface as `unexpected FAIL` noise on every
 * row after it. That indirection is what made issue #31 take a while to read.
 */
function assertRealRepoUntouched(before, rowLabel) {
  if (before === null) return;
  const after = realRepoFingerprint();
  if (after === before) return;
  console.log(`\n[HERMETICITY FAIL] ${rowLabel} mutated the real repository at ${REPO_ROOT}`);
  console.log(`    before: ${before}`);
  console.log(`    after:  ${after}`);
  console.log('    Stopping: every later row would report unexpected failures caused by this,');
  console.log('    not by its own mutation. See issue #31 and copyTree() above.');
  process.exit(1);
}

// Proves the linked-worktree branch of copyTree, which is otherwise dead code
// anywhere `.git` is a directory - CI included, so it would rot unnoticed and
// only be missed the next time someone works in a worktree. Creates a real
// linked worktree, copies *that* into a sandbox, and asserts the sandbox owns
// its gitdir. Read-only with respect to the real repository: every assertion
// runs before anything would write, so a regression here reports rather than
// stomps.
function checkWorktreeContainment(tmpRoot) {
  const wt = path.join(tmpRoot, 'linked-worktree');
  const notes = [];
  git(REPO_ROOT, ['worktree', 'add', '--detach', '--quiet', wt, 'HEAD']);
  try {
    if (!isLinkedWorktree(wt)) {
      notes.push(`expected ${wt}/.git to be a gitdir pointer file - the row proves nothing without one`);
      return { ok: false, notes };
    }
    const sandbox = path.join(tmpRoot, 'linked-worktree-sandbox');
    copyTree(wt, sandbox);

    const resolved = gitPath(sandbox, '--absolute-git-dir');
    const root = fs.realpathSync(sandbox);
    if (!resolved || !fs.realpathSync(resolved).startsWith(root)) {
      notes.push(`sandbox gitdir resolved to ${resolved}, outside ${root} - rows would run against the real repository`);
      return { ok: false, notes };
    }
    notes.push(`OK: sandbox owns its gitdir (${path.relative(root, fs.realpathSync(resolved))})`);

    // HEAD came from the worktree, not from the common dir's copy: the source
    // worktree is detached, so a leaked HEAD would name the main checkout's branch.
    const symref = spawnSync('git', ['symbolic-ref', '--quiet', 'HEAD'], {
      cwd: sandbox,
      encoding: 'utf8',
      env: envWithoutGitVars(),
    });
    if (symref.status === 0) {
      notes.push(`sandbox HEAD is ${symref.stdout.trim()}, but the source worktree is detached - HEAD was inherited from the common dir`);
      return { ok: false, notes };
    }
    notes.push('OK: HEAD came from the worktree, not the common dir');

    // The two things the git-backed checks need, readable from the copy.
    if (git(sandbox, ['ls-files']).trim() === '') {
      notes.push('sandbox index lists no files - `git ls-files` checks would pass vacuously');
      return { ok: false, notes };
    }
    if (git(sandbox, ['log', '--all', '--oneline', '-1']).trim() === '') {
      notes.push('sandbox has no history - the `git log --all` clause of dev-vars-untracked would pass vacuously');
      return { ok: false, notes };
    }
    notes.push('OK: index and full history came across');
    return { ok: true, notes };
  } finally {
    git(REPO_ROOT, ['worktree', 'remove', '--force', wt]);
  }
}

function statusMap(result) {
  const m = new Map();
  for (const r of result.results) m.set(r.id, r);
  return m;
}

function run() {
  let failures = 0;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'review-checks-test-'));
  const fingerprint = realRepoFingerprint();

  for (const [i, row] of rows.entries()) {
    const dir = path.join(tmpRoot, `row-${i}`);
    if (row.tool !== 'worktree') copyTree(REPO_ROOT, dir);
    try {
      row.mutate?.(dir);
    } catch (err) {
      console.log(`[SETUP FAIL] row ${i}: ${row.name}\n    ${err.message}`);
      failures++;
      continue;
    }

    if (row.tool === 'worktree') {
      let result;
      try {
        result = checkWorktreeContainment(tmpRoot);
      } catch (err) {
        result = { ok: false, notes: [err.message] };
      }
      console.log(`\nRow ${i}: ${row.name}`);
      for (const note of result.notes) console.log(`    ${note}`);
      console.log(`    -> ${result.ok ? 'PASS' : 'FAIL'}`);
      if (!result.ok) failures++;
      assertRealRepoUntouched(fingerprint, `row ${i} (${row.name})`);
      continue;
    }

    if (row.tool === 'eslint') {
      const r = runEslint(dir);
      const wanted = row.expectExitCode === 0 ? '0' : 'non-zero';
      let rowOk = row.expectExitCode === 0 ? r.status === 0 : r.status !== 0;
      const notes = [];
      if (rowOk && row.expectStdoutContains) {
        if (r.stdout.includes(row.expectStdoutContains)) {
          notes.push(`OK: eslint exited ${r.status} and stdout mentions ${JSON.stringify(row.expectStdoutContains)}`);
        } else {
          rowOk = false;
          notes.push(`exited ${r.status} but stdout never mentions ${JSON.stringify(row.expectStdoutContains)} - non-zero for the wrong reason`);
        }
      } else if (rowOk) {
        notes.push(`OK: eslint exited ${r.status} as expected (wanted ${wanted})`);
      } else {
        notes.push(`expected eslint exit ${wanted}, got ${r.status}`);
      }
      console.log(`\nRow ${i}: ${row.name}`);
      for (const note of notes) console.log(`    ${note}`);
      if (!rowOk) {
        console.log(`    stdout: ${r.stdout}`);
        console.log(`    stderr: ${r.stderr}`);
      }
      console.log(`    -> ${rowOk ? 'PASS' : 'FAIL'}`);
      if (!rowOk) failures++;
      assertRealRepoUntouched(fingerprint, `row ${i} (${row.name})`);
      continue;
    }

    const extraArgs = row.extraArgs ?? [];
    const extraEnv = row.extraEnv ? row.extraEnv(dir) : {};
    const result = runChecker(dir, extraArgs, extraEnv);
    const statuses = statusMap(result);

    let rowOk = true;
    const notes = [];

    for (const id of row.expectFail) {
      const r = statuses.get(id);
      if (!r || r.status !== 'fail') {
        rowOk = false;
        notes.push(`expected '${id}' to FAIL, got '${r?.status}'`);
        continue;
      }
      const mustMatch = row.expectFindingMatch?.[id];
      if (mustMatch) {
        const hit = r.findings.some((f) => mustMatch.test(f.message));
        if (!hit) {
          rowOk = false;
          notes.push(`expected '${id}' finding to match ${mustMatch} - got ${JSON.stringify(r.findings.map((f) => f.message))}`);
          continue;
        }
        notes.push(`OK: '${id}' failed with a finding matching ${mustMatch}`);
      } else {
        notes.push(`OK: '${id}' failed as expected (${r.findings.length} finding(s))`);
      }
    }

    for (const r of result.results) {
      if (row.expectFail.includes(r.id)) continue;
      if (r.severity !== 'Important') continue; // Nit ids may vary incidentally
      if (r.status === 'fail') {
        rowOk = false;
        notes.push(`unexpected FAIL on '${r.id}': ${JSON.stringify(r.findings)}`);
      }
    }

    for (const id of row.expectPassStillGreen ?? []) {
      const r = statuses.get(id);
      notes.push(`note: '${id}' status is '${r?.status}' (sites unaffected by this mutation)`);
    }

    // Unlike expectPassStillGreen (a note only), this hard-asserts an exact
    // status. Exists because "not in expectFail" only rules out 'fail'
    // above - a check that quietly SKIPs (e.g. its `gh` stub falling off
    // PATH) would still read as a pass there. A row proving a new accept
    // branch fires needs the stronger claim: the check actually ran and
    // actually passed, not that it merely didn't fail.
    for (const [id, want] of Object.entries(row.expectStatus ?? {})) {
      const r = statuses.get(id);
      if (r?.status !== want) {
        rowOk = false;
        notes.push(`expected '${id}' status to be '${want}', got '${r?.status}'`);
      } else {
        notes.push(`OK: '${id}' status is '${want}'`);
      }
    }

    console.log(`\nRow ${i}: ${row.name}`);
    for (const note of notes) console.log(`    ${note}`);
    console.log(`    -> ${rowOk ? 'PASS' : 'FAIL'}`);
    if (!rowOk) failures++;
    assertRealRepoUntouched(fingerprint, `row ${i} (${row.name})`);
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? `all ${rows.length} rows behaved as expected` : `${failures}/${rows.length} rows FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
