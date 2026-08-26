#!/usr/bin/env node
// Mutation self-test for scripts/review-checks.mjs. See issue #25.
//
// The checker passing on HEAD proves nothing - HEAD is already compliant.
// This test copies the tree (including .git, so git-backed checks like
// dev-vars-untracked and branch-carries-issue behave exactly as they do on
// the real repo) into a temp dir per row, applies one mutation, runs the
// checker with --root <tmp> --json, and asserts:
//   - every id in `expect` has status 'fail'
//   - every OTHER Important-severity id does NOT have status 'fail'
//     (Nit-severity ids are allowed to vary unless explicitly expected -
//     some mutations are only visible to a Nit check)
//
// Row 0 is the empty mutation: prove the harness itself reports all-green
// before trusting any row that claims a specific check fails.
//
// This table covers exactly the 10 checks review-checks.mjs still implements.
// The other 8 (moved to ast-grep, or dropped for `no-credential-literals` -
// see the comment in review-checks.mjs) have no rows here any more; their
// mutation coverage now lives in rule-tests/*.yml.
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
  const r = spawnSync('node', [CHECKER, '--root', root, '--json', ...extraArgs], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
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
      // .dev.vars already exists on disk (copied untracked, same as on the real
      // repo) - force it into the index the way a slip past .gitignore would.
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
