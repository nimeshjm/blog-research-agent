#!/usr/bin/env node
// The decidable half of REVIEW.md, made mechanical. See issue #25.
//
// Usage: node scripts/review-checks.mjs [--root DIR] [--pr N] [--json]
//
// This script used to implement all 18 mechanical checks with a hand-rolled
// `ts.createSourceFile` walker. As of the ast-grep migration (see
// `sgconfig.yml` / `rules/*.yml`), everything an off-the-shelf structural
// matcher can express moved there instead:
//
//   ai-run-only-in-llm, tracing-import-seam, no-bare-step-do,
//   no-hardcoded-model-id, no-hardcoded-urls, no-secret-in-console,
//   scheduled-stays-thin
//
// `no-credential-literals` was deleted outright, not moved: GitHub secret
// scanning push protection is already enabled on this public repo and
// blocks pushes carrying credential-shaped literals server-side, which is
// strictly stronger than a local regex re-implementing the same idea.
//
// What's left here is the irreducible remainder: checks that need
// cross-file aggregation, callee resolution through a runtime-bound seam,
// a dynamic read out of another source file, git plumbing, or GitHub API
// calls - none of which a structural/syntactic matcher alone can do.
//
// Zero new dependencies: `typescript` is an existing devDep, used only for
// `ts.createSourceFile` (syntactic parsing - no type-checker, no program).
//
// Every check is a table entry { id, pass, severity, run(ctx) } returning
// findings of { file, line, message }. Findings are grouped by REVIEW.md
// pass for humans; --json emits a machine-readable summary for
// scripts/review-checks.test.mjs. Exit code is 1 iff any `Important`
// severity check has a non-empty, non-skipped finding set.
import ts from 'typescript';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let root = process.cwd();
  let pr = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = argv[++i];
    else if (argv[i] === '--pr') pr = argv[++i];
    else if (argv[i] === '--json') json = true;
  }
  return { root: path.resolve(root), pr, json };
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function runGit(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

function isGitRepo(root) {
  return runGit(root, ['rev-parse', '--is-inside-work-tree']).ok;
}

function walkFiles(root) {
  const out = [];
  const SKIP = new Set(['node_modules', '.git', '.wrangler', 'dist']);
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
  walk(root);
  return out;
}

function listTrackedFiles(root) {
  if (isGitRepo(root)) {
    const r = runGit(root, ['ls-files']);
    if (r.ok) return r.stdout.split('\n').filter(Boolean);
  }
  return walkFiles(root);
}

// ---------------------------------------------------------------------------
// Branch resolution - CI-safe.
//
// On a `pull_request` GitHub Actions run, actions/checkout leaves the
// workspace on a detached merge ref: `git branch --show-current` prints
// nothing. Reading `GITHUB_HEAD_REF` (set by Actions to the PR's source
// branch on `pull_request` events) gives back the real branch name instead
// of treating the run as branch-less, so `branch-carries-issue` still
// meaningfully validates PR branches in CI rather than merely not crashing.
// Detached HEAD with no head ref available (e.g. a local `git checkout
// <sha>`) skips cleanly - it is not a failure, there is nothing to check.
// ---------------------------------------------------------------------------

function currentBranch(root) {
  if (process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_HEAD_REF) {
    return process.env.GITHUB_HEAD_REF;
  }
  const r = runGit(root, ['branch', '--show-current']);
  if (!r.ok) return null; // git unavailable or not a repo
  return r.stdout.trim(); // '' on detached HEAD
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

/** Parses a file's text with `ts.createSourceFile` - syntax only, no types. */
function parse(relPath, text) {
  const kind = relPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, kind);
}

function line(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function isLoop(node) {
  return (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
}

/** True when `node` is a CallExpression shaped `<...objName>.<propName>(...)`. */
function isPropCall(node, objName, propName) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text !== propName) return false;
  const obj = callee.expression;
  if (ts.isIdentifier(obj)) return obj.text === objName;
  if (ts.isPropertyAccessExpression(obj)) return obj.name.text === objName;
  return false;
}

/**
 * Identifiers bound as `const X = tracerFor(...)`, anywhere under `src/`.
 * Deliberately global rather than per-file: "any identifier initialized
 * from a `tracerFor(...)` call" per the issue, not "named `traceStep`".
 * A rename of the *binding* (`traceStep` -> anything) cannot break this -
 * only a rename of the `tracerFor` callee itself can (see the mutation
 * test's `tracerFor`-rename row).
 */
function collectTracerBoundNames(sourceFiles) {
  const names = new Set();
  for (const sf of sourceFiles) {
    function visit(node) {
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === 'tracerFor' &&
        ts.isIdentifier(node.name)
      ) {
        names.add(node.name.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
  }
  return names;
}

/**
 * Step-name callees only: `step.do`, `tracedStep`, and any tracerFor-bound
 * identifier. Deliberately excludes bare `traced(...)` - a plain span is
 * not a Workflow step and never touches `step.do`'s replay key.
 */
function classifyStepNameCall(node, tracerBoundNames) {
  if (isPropCall(node, 'step', 'do')) {
    return { kind: 'step.do', nameArg: node.arguments[0] };
  }
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    if (callee.text === 'tracedStep') return { kind: 'tracedStep', nameArg: node.arguments[1] };
    if (tracerBoundNames.has(callee.text)) {
      return { kind: 'tracerBound', nameArg: node.arguments[0] };
    }
  }
  return null;
}

/**
 * Attrs-carrying callees: `traced` (arg 2), `tracedStep` (arg 3), and any
 * tracerFor-bound identifier (arg 2). Includes bare `traced(...)` on
 * purpose - `llm.ts`'s `chat` span and `index.ts`'s
 * `research-workflow-create` span both carry attrs this way.
 */
function classifyAttrsCall(node, tracerBoundNames) {
  const callee = node.expression;
  if (!ts.isIdentifier(callee)) return null;
  if (callee.text === 'traced') return { kind: 'traced', attrsArg: node.arguments[1] };
  if (callee.text === 'tracedStep') return { kind: 'tracedStep', attrsArg: node.arguments[2] };
  if (tracerBoundNames.has(callee.text)) return { kind: 'tracerBound', attrsArg: node.arguments[1] };
  return null;
}

/** Step-name text -> prefix before the first `:` (whole string if there is none). */
function stepNamePrefix(text) {
  const i = text.indexOf(':');
  return i === -1 ? text : text.slice(0, i);
}

const DYNAMIC_STEP_PREFIXES = new Set(['gather', 'summarize']);
const INFERENCE_STEP_PREFIXES = new Set(['summarize', 'synthesize']);

/**
 * Resolves the literal (or template) step name carried by a `nameArg` node.
 * Returns { text, isTemplate } or null when the name isn't statically
 * resolvable (e.g. a plain variable, as in `step.do(name, ...)` inside
 * `tracedStep`'s own definition).
 */
function resolveStepName(nameArg) {
  if (!nameArg) return null;
  if (ts.isStringLiteralLike(nameArg) && !ts.isTemplateExpression(nameArg)) {
    return { text: nameArg.text, isTemplate: false };
  }
  if (ts.isTemplateExpression(nameArg)) {
    return { text: nameArg.head.text, isTemplate: true };
  }
  return null;
}

// ===========================================================================
// Checks
// ===========================================================================

const checks = [];

// --- Pass 1: free-tier (the decidable slice) --------------------------------

checks.push({
  id: 'inference-loop-has-break',
  pass: 1,
  severity: 'Important',
  run(ctx) {
    const rel = 'src/workflow.ts';
    const sf = ctx.getSourceFile(rel);
    if (!sf) return [{ file: rel, line: 0, message: `${rel} not found - nothing to check` }];

    /** Does `node`'s own body contain a break not swallowed by a nested loop/switch/function? */
    function containsOwnBreak(node) {
      let found = false;
      function visit(n) {
        if (found) return;
        if (ts.isBreakStatement(n) && !n.label) {
          found = true;
          return;
        }
        if (isLoop(n) || ts.isSwitchStatement(n) || ts.isFunctionLike(n)) return; // their own break, not ours
        ts.forEachChild(n, visit);
      }
      ts.forEachChild(node, visit); // don't let the loop node itself count as "nested"
      return found;
    }

    /** Any step call anywhere under `node`, full descent (into callbacks too). */
    function inferenceStepPrefixesUsed(node) {
      const prefixes = new Set();
      function visit(n) {
        if (ts.isCallExpression(n)) {
          const call = classifyStepNameCall(n, ctx.tracerBoundNames);
          if (call) {
            const resolved = resolveStepName(call.nameArg);
            if (resolved) prefixes.add(stepNamePrefix(resolved.text));
          }
        }
        ts.forEachChild(n, visit);
      }
      ts.forEachChild(node, visit);
      return prefixes;
    }

    const findings = [];
    (function visit(node) {
      if (isLoop(node)) {
        const prefixes = inferenceStepPrefixesUsed(node);
        const needsBreak = [...prefixes].some((p) => INFERENCE_STEP_PREFIXES.has(p));
        if (needsBreak && !containsOwnBreak(node)) {
          findings.push({
            file: rel,
            line: line(sf, node),
            message: 'loop carries an inference step (summarize/synthesize) with no break - can exceed NEURON_BUDGET_PER_RUN',
          });
        }
      }
      ts.forEachChild(node, visit);
    })(sf);
    return findings;
  },
});

// --- Pass 2: secrets ---------------------------------------------------------
//
// `no-credential-literals` (a local regex over every tracked file, looking
// for credential-shaped strings) was deleted here rather than moved to
// ast-grep: GitHub secret scanning push protection is already enabled on
// this public repo and rejects a push carrying a credential server-side,
// which is strictly stronger than either implementation. `no-secret-in-console`
// moved to an ast-grep rule instead - it's a plain structural match.

checks.push({
  id: 'dev-vars-untracked',
  pass: 2,
  severity: 'Important',
  run(ctx) {
    if (!isGitRepo(ctx.root)) {
      return [{ file: '.dev.vars', line: 0, message: 'SKIP: not a git repository', skip: true }];
    }
    const findings = [];
    const tracked = runGit(ctx.root, ['ls-files', '--', '.dev.vars', '.dev.vars.*']);
    if (tracked.ok && tracked.stdout.trim() !== '') {
      findings.push({ file: '.dev.vars', line: 0, message: '.dev.vars (or a variant) is tracked by git' });
    }
    const ignored = runGit(ctx.root, ['check-ignore', '-q', '.dev.vars']);
    if (!ignored.ok) {
      findings.push({ file: '.dev.vars', line: 0, message: '.dev.vars is not covered by .gitignore' });
    }
    // A shallow clone (actions/checkout's default: fetch-depth 1) has almost no
    // history to search, so `git log --all` here would silently find nothing and
    // green-light the exact failure mode this clause exists to catch ("never
    // committed" is the check that costs something, per the issue). Report that
    // explicitly rather than reusing a false PASS - full history is available
    // locally and in the pre-push hook, which is where this clause actually bites.
    const shallow = runGit(ctx.root, ['rev-parse', '--is-shallow-repository']);
    if (shallow.ok && shallow.stdout.trim() === 'true') {
      findings.push({
        file: '.dev.vars',
        line: 0,
        message: 'SKIP: shallow clone - cannot search full history for a past commit of .dev.vars; enforced fully by the pre-push hook',
        skip: true,
      });
    } else {
      const everAdded = runGit(ctx.root, [
        'log', '--all', '--diff-filter=A', '--pretty=format:%H', '--', '.dev.vars', '.dev.vars.*',
      ]);
      if (everAdded.ok && everAdded.stdout.trim() !== '') {
        findings.push({ file: '.dev.vars', line: 0, message: '.dev.vars (or a variant) was committed at some point in history' });
      }
    }
    return findings;
  },
});

checks.push({
  id: 'wrangler-vars-are-not-secrets',
  pass: 2,
  severity: 'Important',
  run(ctx) {
    const rel = 'wrangler.toml';
    const text = ctx.readTextFile(rel);
    if (text === null) return [{ file: rel, line: 0, message: `${rel} not found - nothing to check` }];
    const findings = [];
    let inVars = false;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();
      if (trimmed.startsWith('#') || trimmed === '') continue;
      const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
      if (sectionMatch) {
        inVars = sectionMatch[1] === 'vars';
        continue;
      }
      if (!inVars) continue;
      const kv = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (!kv) continue;
      const key = kv[1];
      if (/(TOKEN|SECRET|KEY|PASSWORD|PAT|CREDENTIAL)$/.test(key)) {
        findings.push({ file: rel, line: i + 1, message: `[vars].${key} looks like a secret name - secrets go via \`wrangler secret put\`` });
      }
    }
    return findings;
  },
});

const FORBIDDEN_VALUE_PROPS = new Set([
  'message', 'stack', 'url', 'text', 'content', 'prompt', 'body', 'html',
  'summary', 'title', 'messages', 'response', 'completion',
]);
const ATTR_LITERAL_PREFIX_RE = /^agent\.|^gen_ai\./;
const ALLOWED_LITERAL_KEYS = new Set(['error.type']);

/**
 * A key is only "resolvable" when it could plausibly be one of the ATTR_*
 * constants - a bare loop variable (`for (const [k, v] of ...)`, the
 * generic passthrough in `traced()`'s own definition) is not a specific
 * attribute assignment to judge, so it is skipped rather than flagged.
 */
function keyInfoOf(node, attrConstantNames) {
  if (!node) return null;
  if (ts.isIdentifier(node)) {
    if (!(attrConstantNames.has(node.text) || /^ATTR_/.test(node.text))) return null;
    return { kind: 'ident', name: node.text };
  }
  if (ts.isPropertyAccessExpression(node)) {
    if (!(attrConstantNames.has(node.name.text) || /^ATTR_/.test(node.name.text))) return null;
    return { kind: 'ident', name: node.name.text };
  }
  if (ts.isStringLiteralLike(node) && !ts.isTemplateExpression(node)) return { kind: 'literal', text: node.text };
  return null; // unresolved - not checked, per "resolvable PropertyAssignments only"
}

function keyIsAllowlisted(keyInfo, attrConstantNames) {
  if (keyInfo.kind === 'ident') return attrConstantNames.has(keyInfo.name) || /^ATTR_/.test(keyInfo.name);
  return ALLOWED_LITERAL_KEYS.has(keyInfo.text) || ATTR_LITERAL_PREFIX_RE.test(keyInfo.text);
}

function valueIsForbidden(valueNode) {
  let forbidden = false;
  function visit(n) {
    if (forbidden || !n) return;
    if (ts.isPropertyAccessExpression(n) && FORBIDDEN_VALUE_PROPS.has(n.name.text.toLowerCase())) {
      forbidden = true;
      return;
    }
    if (ts.isIdentifier(n) && FORBIDDEN_VALUE_PROPS.has(n.text.toLowerCase())) {
      forbidden = true;
      return;
    }
    ts.forEachChild(n, visit);
  }
  visit(valueNode);
  return forbidden;
}

checks.push({
  id: 'span-attributes-allowlisted',
  pass: 2,
  severity: 'Important',
  run(ctx) {
    const findings = [];
    let sites = 0;

    for (const rel of ctx.srcFiles) {
      const sf = ctx.getSourceFile(rel);
      (function visit(node) {
        if (ts.isCallExpression(node)) {
          // setAttribute(key, value) - looked at directly, regardless of callee.
          if (
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'setAttribute' &&
            node.arguments.length >= 2
          ) {
            const keyInfo = keyInfoOf(node.arguments[0], ctx.attrConstantNames);
            if (keyInfo) {
              sites++;
              if (!keyIsAllowlisted(keyInfo, ctx.attrConstantNames)) {
                findings.push({
                  file: rel,
                  line: line(sf, node),
                  message: `setAttribute key not allowlisted (must be an ATTR_* constant, 'error.type', or agent./gen_ai. prefixed)`,
                });
              } else if (valueIsForbidden(node.arguments[1])) {
                findings.push({
                  file: rel,
                  line: line(sf, node),
                  message: 'setAttribute value references a forbidden property (message/url/prompt/etc.)',
                });
              }
            }
            // unresolved key (e.g. the generic `for (const [k, v] of ...)` loop
            // in trace.ts's own `traced()`) is skipped, not flagged - it is not
            // a specific attribute assignment to judge.
          }

          // attrs object literal passed to traced / tracedStep / a tracerFor-bound identifier.
          const attrsCall = classifyAttrsCall(node, ctx.tracerBoundNames);
          if (attrsCall && attrsCall.attrsArg && ts.isObjectLiteralExpression(attrsCall.attrsArg)) {
            for (const prop of attrsCall.attrsArg.properties) {
              if (ts.isSpreadAssignment(prop)) continue; // day-one FP #4
              if (!ts.isPropertyAssignment(prop)) continue;
              const keyNode = ts.isComputedPropertyName(prop.name) ? prop.name.expression : prop.name;
              const keyInfo = keyInfoOf(keyNode, ctx.attrConstantNames);
              if (!keyInfo) continue; // unresolved key - not checked
              sites++;
              if (!keyIsAllowlisted(keyInfo, ctx.attrConstantNames)) {
                findings.push({
                  file: rel,
                  line: line(sf, prop),
                  message: `attrs key not allowlisted (must be an ATTR_* constant, 'error.type', or agent./gen_ai. prefixed)`,
                });
              } else if (valueIsForbidden(prop.initializer)) {
                findings.push({
                  file: rel,
                  line: line(sf, prop),
                  message: 'attrs value references a forbidden property (message/url/prompt/etc.)',
                });
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      })(sf);
    }

    if (sites < 8) {
      findings.push({
        file: 'src/lib/trace.ts',
        line: 0,
        message: `sentinel: only ${sites} span-attribute sites resolved, expected >= 8 - the matcher likely stopped matching`,
      });
    }
    return findings;
  },
});

// --- Pass 3: step correctness ------------------------------------------------

function resolveAllStepNameCalls(ctx) {
  const results = [];
  for (const rel of ctx.srcFiles) {
    const sf = ctx.getSourceFile(rel);
    (function visit(node) {
      if (ts.isCallExpression(node)) {
        const call = classifyStepNameCall(node, ctx.tracerBoundNames);
        if (call) {
          const resolved = resolveStepName(call.nameArg);
          if (resolved) results.push({ rel, sf, node, ...resolved });
        }
      }
      ts.forEachChild(node, visit);
    })(sf);
  }
  return results;
}

checks.push({
  id: 'step-names-unique',
  pass: 3,
  severity: 'Important',
  run(ctx) {
    const calls = resolveAllStepNameCalls(ctx);
    const findings = [];
    if (calls.length < 11) {
      findings.push({
        file: 'src/workflow.ts',
        line: 0,
        message: `sentinel: only ${calls.length} step-name calls resolved, expected >= 11 - the matcher likely stopped matching`,
      });
    }
    const seen = new Map(); // name -> first occurrence
    for (const c of calls) {
      if (c.isTemplate) continue; // dynamic names checked for prefix collisions below, not exact-name dupes
      const prior = seen.get(c.text);
      if (prior) {
        findings.push({
          file: c.rel,
          line: line(c.sf, c.node),
          message: `duplicate step name '${c.text}' (first seen at ${prior.rel}:${line(prior.sf, prior.node)})`,
        });
      } else {
        seen.set(c.text, c);
      }
      if (DYNAMIC_STEP_PREFIXES.has(c.text)) {
        findings.push({
          file: c.rel,
          line: line(c.sf, c.node),
          message: `literal step name '${c.text}' collides with the dynamic prefix '${c.text}:*'`,
        });
      }
    }
    return findings;
  },
});

checks.push({
  id: 'step-names-static',
  pass: 3,
  severity: 'Important',
  run(ctx) {
    const calls = resolveAllStepNameCalls(ctx);
    const findings = [];
    if (calls.length < 11) {
      findings.push({
        file: 'src/workflow.ts',
        line: 0,
        message: `sentinel: only ${calls.length} step-name calls resolved, expected >= 11 - the matcher likely stopped matching`,
      });
    }
    for (const c of calls) {
      if (!c.isTemplate) continue;
      const prefix = stepNamePrefix(c.text);
      if (!DYNAMIC_STEP_PREFIXES.has(prefix)) {
        findings.push({
          file: c.rel,
          line: line(c.sf, c.node),
          message: `template step name '${c.text}...' has prefix '${prefix}', not in the allowlist (gather, summarize) - needs human review`,
        });
      }
    }
    return findings;
  },
});

// --- Pass 4: spec conformance (the decidable slice) --------------------------

checks.push({
  id: 'base-branch-not-a-write-target',
  pass: 4,
  severity: 'Important',
  run(ctx) {
    const findings = [];
    for (const rel of ctx.srcFiles) {
      if (rel === 'src/lib/types.ts') continue; // the Env field declaration
      const sf = ctx.getSourceFile(rel);
      const text = ctx.readTextFile(rel);
      const usesIt = text.includes('BLOG_BASE_BRANCH');
      if (!usesIt) continue;
      const coOccursWithRefsHeads = text.includes('refs/heads');

      (function visit(node) {
        if (ts.isIdentifier(node) && node.text === 'BLOG_BASE_BRANCH') {
          let ok = false;
          let p = node.parent;
          while (p) {
            if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
              ok = p.name.text === 'base';
              break;
            }
            if (ts.isObjectLiteralExpression(p) || ts.isCallExpression(p)) break;
            p = p.parent;
          }
          if (!ok || coOccursWithRefsHeads) {
            findings.push({
              file: rel,
              line: line(sf, node),
              message: 'BLOG_BASE_BRANCH used outside a `base:` property, or alongside refs/heads - possible write target',
            });
          }
        }
        if (
          (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
          ts.isIdentifier(node.name) &&
          (node.name.text === 'branch' || node.name.text === 'ref')
        ) {
          const initText = ts.isPropertyAssignment(node) ? node.initializer.getText(sf) : node.name.text;
          if (initText.includes('BLOG_BASE_BRANCH')) {
            findings.push({ file: rel, line: line(sf, node), message: `BLOG_BASE_BRANCH used as a '${node.name.text}:' property value` });
          }
        }
        if (
          isPropCall(node, 'fetch', 'PUT') ||
          (ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === 'fetch' &&
            node.getText(sf).includes('/contents/') &&
            (node.getText(sf).includes("'PUT'") || node.getText(sf).includes('"PUT"') || node.getText(sf).includes("'PATCH'") || node.getText(sf).includes('"PATCH"')))
        ) {
          if (text.includes('BLOG_BASE_BRANCH')) {
            findings.push({ file: rel, line: line(sf, node), message: 'PUT/PATCH to /contents/ in a file that also references BLOG_BASE_BRANCH' });
          }
        }
        ts.forEachChild(node, visit);
      })(sf);
    }
    return findings;
  },
});

// --- Pass 5: reuse (the decidable slice) -------------------------------------

checks.push({
  id: 'budget-read-from-env',
  pass: 5,
  severity: 'Nit',
  run(ctx) {
    const rel = 'src/workflow.ts';
    const sf = ctx.getSourceFile(rel);
    if (!sf) return [{ file: rel, line: 0, message: `${rel} not found - nothing to check` }];
    let found = false;
    (function visit(node) {
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === 'NEURON_BUDGET_PER_RUN' &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'env'
      ) {
        found = true;
      }
      ts.forEachChild(node, visit);
    })(sf);
    if (!found) {
      return [{ file: rel, line: 0, message: 'NEURON_BUDGET_PER_RUN is not read from `*.env` in src/workflow.ts' }];
    }
    return [];
  },
});

// --- CONVENTIONS-derived widening (not REVIEW.md bullets) -------------------

checks.push({
  id: 'branch-carries-issue',
  pass: 'CONVENTIONS',
  severity: 'Important',
  run(ctx) {
    const branch = currentBranch(ctx.root);
    if (branch === null) return [{ file: '(branch)', line: 0, message: 'SKIP: git unavailable', skip: true }];
    if (branch === '') return [{ file: '(branch)', line: 0, message: 'SKIP: detached HEAD, no branch to check', skip: true }];
    if (branch === 'main') {
      return [{ file: '(branch)', line: 0, message: 'on `main` - no work happens on main (CONVENTIONS.md)' }];
    }
    if (!/^(\w+\/)?\d+-/.test(branch)) {
      return [{ file: '(branch)', line: 0, message: `branch '${branch}' does not start with an issue number` }];
    }
    return [];
  },
});

checks.push({
  id: 'pr-body-not-empty',
  pass: 'CONVENTIONS',
  severity: 'Important',
  run(ctx) {
    if (!ctx.pr) return [{ file: '(pr)', line: 0, message: 'SKIP: no --pr given', skip: true }];
    const gh = spawnSync('gh', ['api', `repos/{owner}/{repo}/pulls/${ctx.pr}`, '--jq', '.body'], {
      cwd: ctx.root,
      encoding: 'utf8',
    });
    if (gh.status !== 0) {
      return [{ file: '(pr)', line: 0, message: 'SKIP: gh unavailable or call failed', skip: true }];
    }
    const body = (gh.stdout ?? '').trim();
    if (body === '') return [{ file: '(pr)', line: 0, message: `PR #${ctx.pr} has an empty body` }];
    const branch = currentBranch(ctx.root);
    const issueMatch = branch ? branch.match(/^(?:\w+\/)?(\d+)-/) : null;
    if (issueMatch && !body.includes(`Closes #${issueMatch[1]}`)) {
      return [{ file: '(pr)', line: 0, message: `PR #${ctx.pr} body does not contain 'Closes #${issueMatch[1]}'` }];
    }
    return [];
  },
});

// ===========================================================================
// Runner
// ===========================================================================

function buildContext(root, pr) {
  const files = listTrackedFiles(root);
  const srcFiles = files.filter((f) => f.startsWith('src/') && f.endsWith('.ts'));

  const textCache = new Map();
  function readTextFile(rel) {
    if (textCache.has(rel)) return textCache.get(rel);
    let text = null;
    try {
      const buf = fs.readFileSync(path.join(root, rel));
      if (buf.includes(0)) throw new Error('binary');
      text = buf.toString('utf8');
    } catch {
      text = null;
    }
    textCache.set(rel, text);
    return text;
  }

  const sfCache = new Map();
  function getSourceFile(rel) {
    if (sfCache.has(rel)) return sfCache.get(rel);
    const text = readTextFile(rel);
    const sf = text === null ? null : parse(rel, text);
    sfCache.set(rel, sf);
    return sf;
  }

  const sourceFiles = srcFiles.map(getSourceFile).filter(Boolean);
  const tracerBoundNames = collectTracerBoundNames(sourceFiles);

  const traceSf = getSourceFile('src/lib/trace.ts');
  const attrConstantNames = new Set();
  if (traceSf) {
    (function visit(node) {
      if (
        ts.isVariableStatement(node) &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text.startsWith('ATTR_')) {
            attrConstantNames.add(decl.name.text);
          }
        }
      }
      ts.forEachChild(node, visit);
    })(traceSf);
  }

  return { root, srcFiles, readTextFile, getSourceFile, tracerBoundNames, attrConstantNames, pr };
}

const PASS_TITLES = {
  1: 'Pass 1 - Free-tier limit violations',
  2: 'Pass 2 - Secret handling',
  3: 'Pass 3 - Workflow step correctness',
  4: 'Pass 4 - Spec conformance',
  5: 'Pass 5 - Simplification and reuse',
  CONVENTIONS: 'CONVENTIONS-derived (widening beyond REVIEW.md)',
};

function main() {
  const { root, pr, json } = parseArgs(process.argv.slice(2));
  const ctx = buildContext(root, pr);

  const results = checks.map((check) => {
    let findings;
    try {
      findings = check.run(ctx);
    } catch (err) {
      findings = [{ file: '', line: 0, message: `checker threw: ${err?.message ?? err}` }];
    }
    const skipped = findings.length > 0 && findings.every((f) => f.skip);
    const status = skipped ? 'skip' : findings.length > 0 ? 'fail' : 'pass';
    return { ...check, findings: skipped ? [] : findings, status };
  });

  const exitCode = results.some((r) => r.severity === 'Important' && r.status === 'fail') ? 1 : 0;

  if (json) {
    console.log(JSON.stringify({ results: results.map(({ id, pass, severity, status, findings }) => ({ id, pass, severity, status, findings })), exitCode }));
  } else {
    const byPass = new Map();
    for (const r of results) {
      if (!byPass.has(r.pass)) byPass.set(r.pass, []);
      byPass.get(r.pass).push(r);
    }
    for (const [pass, list] of byPass) {
      console.log(`\n${PASS_TITLES[pass] ?? pass}`);
      for (const r of list) {
        const tag = r.status === 'pass' ? 'PASS' : r.status === 'skip' ? 'SKIP' : 'FAIL';
        console.log(`  [${tag}] ${r.id} (${r.severity})`);
        for (const f of r.findings) {
          console.log(`      ${f.file}:${f.line}  ${f.message}`);
        }
      }
    }
    console.log(`\n${exitCode === 0 ? 'review:checks green' : 'review:checks FAILED'}`);
  }

  process.exit(exitCode);
}

main();
