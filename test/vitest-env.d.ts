// Ambient module declarations for `cloudflare:test` (env, applyD1Migrations,
// SELF, ...). Only test/**/*.ts needs these - see tsconfig.json's `include`.
/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Test files run *inside* the Workers runtime (not Node), so `node:fs` only
// sees a virtualised `/bundle` containing the module graph - reading
// migrations/0001_init.sql at runtime 404s. Vite's `?raw` suffix inlines the
// file's text into the bundle at transform time instead, which needs this
// declaration since it isn't a plain `.sql` module.
declare module '*.sql?raw' {
  const content: string;
  export default content;
}
