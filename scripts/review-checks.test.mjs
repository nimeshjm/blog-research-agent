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
// The checker-based rows cover exactly the 11 checks review-checks.mjs still
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

function copyTree(src, dest) {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (s) => {
      const rel = path.relative(src, s);
      if (rel === 'node_modules' || rel.startsWith(`node_modules${path.sep}`)) return false;
      if (rel === '.wrangler' || rel.startsWith(`.wrangler${path.sep}`)) return false;
      // A local `.venv` is 26 MB and this copies the tree once per row.
      // scripts/plan_metrics.py's `--emit` path needs opentelemetry installed,
      // and CLAUDE.md tells you to put that in a venv, so one shows up here as
      // soon as anyone follows those instructions.
      if (rel === '.venv' || rel.startsWith(`.venv${path.sep}`)) return false;
      return true;
    },
  });
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
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
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
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GITHUB_')));
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
    name: 'strip the break from the summarize loop',
    expectFail: ['inference-loop-has-break'],
    mutate(dir) {
      mustReplace(
        dir,
        'src/workflow.ts',
        '      if (neuronsSpent + SUMMARY_NEURON_ESTIMATE > budget - SYNTHESIS_NEURON_RESERVE) break;\n\n',
        '',
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
        "import {\n  ATTR_NEURONS_BUDGET,",
        "import {\n  ATTR_NEURONS_BUDGET,\n  traced,",
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
        "import {\n  ATTR_NEURONS_BUDGET,",
        "import {\n  ATTR_NEURONS_BUDGET,\n  traced,",
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
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function statusMap(result) {
  const m = new Map();
  for (const r of result.results) m.set(r.id, r);
  return m;
}

function run() {
  let failures = 0;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'review-checks-test-'));

  for (const [i, row] of rows.entries()) {
    const dir = path.join(tmpRoot, `row-${i}`);
    copyTree(REPO_ROOT, dir);
    try {
      row.mutate(dir);
    } catch (err) {
      console.log(`[SETUP FAIL] row ${i}: ${row.name}\n    ${err.message}`);
      failures++;
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

    console.log(`\nRow ${i}: ${row.name}`);
    for (const note of notes) console.log(`    ${note}`);
    console.log(`    -> ${rowOk ? 'PASS' : 'FAIL'}`);
    if (!rowOk) failures++;
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? `all ${rows.length} rows behaved as expected` : `${failures}/${rows.length} rows FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
