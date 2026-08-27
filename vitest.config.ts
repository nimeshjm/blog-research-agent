import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Runs the suite against real Workers bindings rather than mocked globals -
 * pointed at wrangler.toml so `env` in a test matches what the Worker sees.
 *
 * The `[ai]` binding is the one exception, and it has to be stripped out of
 * the config the pool reads. Workers AI "will never have a local simulator"
 * (vitest-pool-workers' own words for it): declaring it forces an
 * authenticated remote connection at pool startup, unconditionally, whether
 * or not a test ever calls it - the usual `remoteBindings`/binding-level
 * `remote` off-switches don't apply to this resource type. CI holds no
 * Cloudflare credentials (ci.yml is deliberately secret-free), and there is
 * no supported way to merge a binding away after `wrangler.configPath` loads
 * it (`miniflare: { ai: undefined }` throws inside the pool's own merge
 * code - tried first). CLAUDE.md already records that this binding has no
 * local simulation, so `test/llm.test.ts` never needs it: `Llm` is exercised
 * against a stub `Env` instead. Stripping the block here, from the real file,
 * at config-load time, is what keeps this a one-source-of-truth setup rather
 * than a second wrangler.toml to keep in sync by hand.
 */
function wranglerConfigWithoutAiBinding(): string {
  // Relative to the process cwd, which is the repo root for every entry
  // point that loads this file (`npm test`, the pre-push hook, CI).
  const original = readFileSync('wrangler.toml', 'utf8');
  const lines = original.split('\n');
  const out: string[] = [];
  let skippingAiSection = false;
  let foundAiSection = false;
  for (const line of lines) {
    if (/^\[ai\]\s*$/.test(line)) {
      skippingAiSection = true;
      foundAiSection = true;
      continue;
    }
    if (skippingAiSection && /^\[/.test(line)) skippingAiSection = false;
    if (skippingAiSection) continue;

    // `main` (and any other wrangler.toml path field) is resolved by wrangler
    // relative to the *config file's own directory* - fine for the real
    // wrangler.toml at the repo root, but this copy is written into a fresh
    // mkdtemp() directory below, so a relative `main = "src/index.ts"` would
    // resolve to a path that does not exist there. Rewritten to an absolute
    // path back to the real repo root so the pool can still load the entry
    // point. Only bites a test that touches a real binding requiring the
    // worker to boot (e.g. D1) - test/llm.test.ts never surfaced this
    // because it stubs `Env` entirely rather than using `cloudflare:test`'s
    // real one.
    const mainMatch = /^main\s*=\s*"([^"]+)"\s*$/.exec(line);
    const mainPath = mainMatch?.[1];
    if (mainPath !== undefined) {
      out.push(`main = ${JSON.stringify(resolve(process.cwd(), mainPath))}`);
      continue;
    }
    out.push(line);
  }
  if (!foundAiSection) {
    // Fail loud rather than silently handing the pool a config that still
    // carries [ai] - the failure mode otherwise is `npm test` suddenly
    // demanding Cloudflare credentials, which reads as flaky CI rather than
    // as wrangler.toml having moved or renamed the section this strips.
    throw new Error(
      'vitest.config.ts: wrangler.toml no longer has an [ai] section to strip - see the comment above wranglerConfigWithoutAiBinding()',
    );
  }

  const dir = mkdtempSync(join(tmpdir(), 'vitest-wrangler-'));
  const outPath = join(dir, 'wrangler.toml');
  writeFileSync(outPath, out.join('\n'));
  return outPath;
}

export default defineConfig({
  // Vitest's own default glob (**/*.test.*) also matches
  // scripts/review-checks.test.mjs (a plain-Node script, run via `node`, not
  // this pool - it imports node:child_process) and its copies under
  // .claude/worktrees/*/. Scoped to this suite's own directory so those
  // don't get picked up and fail under the Workers runtime.
  test: {
    include: ['test/**/*.test.ts'],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: wranglerConfigWithoutAiBinding() },
    }),
  ],
});
