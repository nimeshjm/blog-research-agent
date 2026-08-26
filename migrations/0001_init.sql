-- 0001_init: the four tables from
-- features/001-scheduled-research-drafts/spec.md -> Design -> Data model.
--
-- Transcribed, not designed. The schema was settled at the stage 2 gate (#1);
-- this migration only puts it in the database. Where a column choice looks
-- surprising, the reason is in spec.md rather than here.
--
-- `IF NOT EXISTS` throughout: `wrangler d1 migrations apply` records what it has
-- run, so a second apply is a no-op anyway - but the remote database was created
-- before this file existed, so re-running against a hand-touched database should
-- not be the thing that fails.

-- The curated queue. Queue-first: a run drains the oldest `queued` row and only
-- proposes its own topic when there is none (spec req. 2).
CREATE TABLE IF NOT EXISTS topics (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  angle      TEXT,
  status     TEXT NOT NULL CHECK (status IN ('queued','in_progress','done','rejected')),
  origin     TEXT NOT NULL CHECK (origin IN ('human','agent')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The cross-run dedupe key (spec req. 4). Queried in one batched pass in
-- `shortlist`, chunked at 100 bound parameters per query against D1's 50-query
-- invocation budget - never once per candidate.
CREATE TABLE IF NOT EXISTS seen_urls (
  url        TEXT PRIMARY KEY,
  title      TEXT,
  source     TEXT NOT NULL,
  first_seen TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Exactly one row per run whatever the outcome (spec req. 9). `neurons_spent` is
-- what makes the budget requirement auditable after the fact rather than only in
-- a trace with three days of retention.
CREATE TABLE IF NOT EXISTS runs (
  instance_id   TEXT PRIMARY KEY,
  topic_id      INTEGER REFERENCES topics(id),
  status        TEXT NOT NULL,
  neurons_spent INTEGER NOT NULL DEFAULT 0,
  sources_used  INTEGER NOT NULL DEFAULT 0,
  pr_url        TEXT,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT
);

CREATE TABLE IF NOT EXISTS drafts (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id  TEXT NOT NULL REFERENCES runs(instance_id),
  slug    TEXT NOT NULL,
  title   TEXT NOT NULL,
  pr_url  TEXT,
  state   TEXT NOT NULL
);
