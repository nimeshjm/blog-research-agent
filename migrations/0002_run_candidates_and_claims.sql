-- 0002_run_candidates_and_claims: per-run candidate scratch space and topic
-- reclaim, shaped by features/002-gather-without-accumulation/plan.md, "2.
-- Migration and query layer - PR 2" (spec.md's own CREATE TABLE for
-- run_candidates predates published_ms and created_at below; it is
-- corrected to match in PR 3).
--
-- `published_ms` is the epoch-ms `applyGatherWindow` already parses, NULL for
-- an undated item, carried through rather than recomputed - it exists so
-- `shortlist` can order newest-first in SQL instead of re-parsing every
-- candidate's date in JS.
--
-- `created_at` makes pruning self-contained: a prune does not join `runs`,
-- so a run that never wrote a `runs` row still gets its scratch rows
-- collected.
--
-- `ALTER TABLE` has no `IF NOT EXISTS`, unlike `CREATE TABLE run_candidates`
-- below and everything in 0001: SQLite doesn't support it on `ALTER TABLE`.
-- That's fine here - unlike 0001, this migration has never been applied
-- anywhere, so a hand-run second apply should fail loudly rather than look
-- like a silent no-op.

CREATE TABLE IF NOT EXISTS run_candidates (
  run_id       TEXT    NOT NULL,
  url          TEXT    NOT NULL,
  title        TEXT,
  published_at TEXT,
  published_ms INTEGER,
  source_name  TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, url)
);

ALTER TABLE topics ADD COLUMN claimed_at TEXT;
