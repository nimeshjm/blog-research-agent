-- 0003_drafts_run_id_unique: a conflict target for the #116 review sweep's
-- `INSERT ... ON CONFLICT(run_id) DO UPDATE` (recordDraftReview, src/lib/d1.ts).
-- The sweep writes at most one row per run and must be idempotent across
-- sweeps and across a Workflow replay, so it needs a unique key to upsert on.
--
-- Safe to apply against the existing table: `drafts` has never had a writer
-- (issue #116 established this - `grep -rn "INTO drafts" src/` finds
-- nothing), so no existing row can violate uniqueness.
--
-- `drafts.state` has no `CHECK` constraint, so the new state values
-- ('open'/'merged'/'declined'/'unavailable') need no migration of their own.

CREATE UNIQUE INDEX IF NOT EXISTS drafts_run_id ON drafts(run_id);
