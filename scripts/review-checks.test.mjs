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

function runChecker(root, extraArgs = []) {
  const r = spawnSync('node', [CHECKER, '--root', root, '--json', ...extraArgs], { encoding: 'utf8' });
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
    name: "add env.AI.run(...) to src/workflow.ts",
    expectFail: ['ai-run-only-in-llm'],
    mutate(dir) {
      mustReplace(
        dir,
        'src/workflow.ts',
        "async function loadSources(_env: Env): Promise<Source[]> {",
        "async function loadSources(_env: Env): Promise<Source[]> {\n  void _env.AI.run('x' as never, {} as never);",
      );
    },
  },
  {
    name: "import { tracing } from 'cloudflare:workers' in src/index.ts",
    expectFail: ['tracing-import-seam'],
    mutate(dir) {
      mustReplace(
        dir,
        'src/index.ts',
        "import { ATTR_INSTANCE_ID, traced } from './lib/trace';",
        "import { ATTR_INSTANCE_ID, traced } from './lib/trace';\nimport { tracing } from 'cloudflare:workers';\nvoid tracing;",
      );
    },
  },
  {
    name: "span.setAttribute(ATTR_TOPIC_ID, err.message)",
    expectFail: ['span-attributes-allowlisted'],
    mutate(dir) {
      mustReplace(
        dir,
        'src/workflow.ts',
        "      if (result !== null) span.setAttribute(ATTR_TOPIC_ID, result.id);",
        "      if (result !== null) span.setAttribute(ATTR_TOPIC_ID, result.id);\n      try { throw new Error('x'); } catch (err) { span.setAttribute(ATTR_TOPIC_ID, (err as Error).message); }",
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
    name: "hardcode '@cf/openai/gpt-oss-120b' in llm.ts",
    expectFail: ['no-hardcoded-model-id'],
    mutate(dir) {
      mustReplace(
        dir,
        'src/lib/llm.ts',
        "const DEFAULT_MAX_TOKENS = 2048;",
        "const DEFAULT_MAX_TOKENS = 2048;\nconst FALLBACK_MODEL_ID = '@cf/openai/gpt-oss-120b';\nvoid FALLBACK_MODEL_ID;",
      );
    },
  },
  {
    name: 'GITHUB_TOKEN = "ghp_..." under [vars]',
    expectFail: ['wrangler-vars-are-not-secrets', 'no-credential-literals'],
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
    name: "a bare step.do('x', ...) in workflow.ts",
    expectFail: ['no-bare-step-do'],
    mutate(dir) {
      mustReplace(
        dir,
        'src/workflow.ts',
        '  async run(event: WorkflowEvent<ResearchParams>, step: WorkflowStep): Promise<void> {',
        '  async run(event: WorkflowEvent<ResearchParams>, step: WorkflowStep): Promise<void> {\n    await step.do(\'x\', async () => {});',
      );
    },
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
    mutate(dir) {
      mustReplace(dir, 'src/lib/trace.ts', 'export function tracerFor(', 'export function tracerForRenamed(');
      mustReplace(dir, 'src/workflow.ts', 'tracerFor,\n} from', 'tracerForRenamed,\n} from');
      mustReplace(dir, 'src/workflow.ts', 'tracerFor(step, event)', 'tracerForRenamed(step, event)');
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
    // Row 11 alone can't tell "the spread was skipped" apart from "the call
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

    const result = runChecker(dir);
    const statuses = statusMap(result);

    let rowOk = true;
    const notes = [];

    for (const id of row.expectFail) {
      const r = statuses.get(id);
      if (!r || r.status !== 'fail') {
        rowOk = false;
        notes.push(`expected '${id}' to FAIL, got '${r?.status}'`);
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
