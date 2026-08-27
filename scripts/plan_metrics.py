#!/usr/bin/env python3
"""
plan_metrics.py - Stage 1 (Plan) and Stage 2 (Design) SDLC extractor: git (+ GitHub for
Stage 1 only) -> OTLP -> Honeycomb.

See issue #29 for the Stage 1 (Plan) design and issue #42 for Stage 2 (Design). This
docstring carries the decisions that aren't obvious from the code alone - the things a
future reader (or reviewer) would otherwise have to re-derive or, worse, "fix".

Why reuse otel_span.py instead of writing a second emitter
    `scripts/otel_span.py` is vendored verbatim from `nimeshjm/claude-otel-hooks`
    (see that file's own header for the pinned commit). It already solves OTLP
    config, protobuf export, and the "process exits before the batch flushes" bug
    via `SimpleSpanProcessor`. `import otel_span` and call `emit_spans(specs)`.
    Do not edit that file; do not reimplement its plumbing here.

Why the emission is one idempotent daily snapshot, not a one-shot transition
    Every run is a *full re-statement* of current state for every feature. There is
    deliberately no `--since`, no "only emit on change" logic, and no backfill. A
    once-only "intent committed" event would have no recovery path if the network
    blips or the backend 5xxes on the one day it mattered - that feature's lead time
    would be lost forever. A daily re-snapshot means a missed day is just picked up
    by the next one, and every board widget aggregates with MAX()/GROUP BY over a
    short window, so repeats are free.

Why three span names, siblings not parent-child
    `sdlc.plan.snapshot` (one per feature) and `sdlc.plan.rollup` (one per run) are
    emitted as independent root spans in a single `emit_spans(specs)` call, with no
    `session_id`/`turn_id` - that's the exact "standalone root span" degradation
    `otel_span.emit_spans` already implements when `turn_id` is empty. Every board
    widget queries by `name` alone; a parent-child link would buy nothing and would
    cost explicit context propagation plus span end-ordering for no benefit.

    #42 adds a third, `sdlc.design.snapshot` (one per feature), in the same sibling
    shape and the same `emit_spans(specs)` call - not extra attributes bolted onto
    `sdlc.plan.snapshot`. The reason is the same one that justifies two names instead
    of one: every widget queries by `name` alone, so folding Stage 2's fields onto the
    Stage 1 span would force every Stage 1 query to also filter Design's attributes
    back out, or vice versa. A separate name is what lets "Design lead time" and
    "Intent lead time" stay two independent, unconfusable queries.

Why spans are stamped `now` with near-zero duration, and lead time is an attribute
    `otel_span.py` accepts explicit `start_time_ns`/`end_time_ns`, so backdating a
    span to when the intent actually landed is *possible* - but the playbook's own
    baseline cadence is multi-week, and that's exactly the regime where an ingest
    window for old timestamps becomes a live question for the backend. Emitting the
    lead time as a plain numeric attribute (`sdlc.plan.lead_time_hours`) instead of a
    span duration sidesteps that risk entirely: P50/P95/HEATMAP work on any numeric
    field regardless of when the span itself was created.

Why feature 001 reports unmeasurable rather than 0
    All six of feature 001's artifacts landed in one bootstrap commit (`7c14ea0`),
    and its `feature:001` issues were filed roughly 75 seconds *after* that commit.
    Its lead *time* is genuinely undefined (the issue-derived t0 postdates the
    intent commit -> a negative "lead time"), so `lead_time_hours` is withheld: a
    0-hour lead time on a board reads as a triumph, not as "no data", and the guards
    below exist so a fabricated zero can never reach Honeycomb. Its post-spec
    *churn* is a different matter and is reported - see the note in
    `compute_git_facts` on why sharing one commit suppresses the lead time but not
    the edit count. Real lead-time numbers start at feature 002.

Why `--emit` fails loud where the vendored hooks fail soft
    `otel_span.emit_spans` is deliberately fire-and-forget: export failure is
    swallowed, and `_OTEL_AVAILABLE` silently goes False when the `opentelemetry`
    packages are missing. That is correct for a Claude Code hook - a broken session
    is worse than a missing span - and wrong for a scheduled CI job, where a job
    that goes green on a bad Honeycomb key leaves a board that silently stops
    updating with nobody watching. So `--emit` adds its own preconditions (endpoint
    set, `opentelemetry` importable, a live OTLP preflight) and exits non-zero the
    moment any of them fails. Do not loosen `otel_span.py` itself to match - the
    hooks' fail-soft behaviour is load-bearing for interactive sessions.

Why the git walk uses `--follow -M25%`, and reads post-image blobs off `--raw`
    `features/README.md` mandates renumbering, so a feature directory can be
    renamed after it's created - and the rename commit can also rewrite the file's
    contents (e.g. resolving open questions in intent.md at the same time it's
    renumbered). `--follow`'s rename detector uses git's ordinary similarity
    threshold (50% by default), and once a rename's content changes enough to fall
    below that threshold, the detector declines to pair old-path -> new-path, the
    follow chain loses the trail, and the commit `resolve_filled()` picks as
    "filled" is truncated at the rename - understating the fill date (or, for
    `count_edits_after`'s history walk, silently dropping pre-rename commits) by
    the whole gap between the true commit and the rename.
    Measured directly (true creation 2026-01-01, `git mv` + rewrite on 2026-03-01):

        rename commit contents          | default -M | -M25%           | orphan D?
        ---------------------------------|-----------|-----------------|----------
        pure `git mv`, no content change | correct   | correct         | no
        `git mv` + 65% lines rewritten   | WRONG     | correct         | no (paired)
        `git mv` + 100% rewritten        | wrong     | wrong, unresolvable | yes

    `-M25%` lowers the pairing threshold enough to correctly resolve the 65% case.
    It does not (cannot) resolve 100%-rewritten renames - git has no signal left to
    pair on - but that failure mode is now *detectable*: when `--follow` can't pair
    a rename, the resulting commit's diff still carries an orphaned `D`
    on some *other* `features/*/<artifact>` in the very same commit (the deletion
    half of the unpaired rename). `resolve_filled()` below checks for exactly
    that and reports `t1_source = "follow-unresolved"` instead of `"follow"`; the
    caller then refuses to trust the date and reports the feature unmeasurable
    rather than emit a number that might be wrong by weeks. `-M25%` did not
    false-pair against `features/_template/intent.md` in manual testing, so the
    low threshold is safe on this tree. `FOLLOW_SIMILARITY` is always passed as
    that one named constant, never a literal, so the two git-log invocations that
    need it (`resolve_filled()` and `git_path_history()`) cannot drift apart.

    `resolve_filled()` reads each commit's post-image blob sha directly off the
    `--raw --no-abbrev` diff line, never off `git rev-parse <sha>:<rel_path>`.
    Under `--follow`, `rel_path` is the path's *current* name, and a commit that
    predates a rename has no blob at that path at all - `rev-parse` on it returns
    nothing, indistinguishable from "path didn't exist yet", which would make
    every pre-rename commit silently unreadable and the whole feature read as
    first-filled only at the rename. Reading the post-image off the log walk
    itself sidesteps the lookup: the walk already names the blob for every
    commit, pre- and post-rename alike. `--no-abbrev` (equivalently
    `--full-index`) is required for a different reason: without it, git
    abbreviates the raw blob shas, they never equal a 40-character template sha
    from `template_blob_shas()`, the set comparison never matches, and every
    artifact reads as filled at its first commit - silently reverting to plain
    first-add behaviour with no error to notice it by. The synthetic pinned-date
    row in `plan_metrics_test.py` that asserts an exact `design_lead_time_hours`
    is what catches this: drop `--no-abbrev` and that row's number goes to `0.0`.

    Known false positive, accepted deliberately: a commit that renames one feature
    directory *and* creates a different feature's intent.md in the same commit
    also carries an orphaned `D` (the old feature's path, unrelated to the new
    feature) and would mark the new feature `follow-unresolved` even though its
    own `t1` was never in doubt. This fails in the conservative direction -
    `measurable: false` and no number emitted, rather than a wrong number - which
    is the correct side to be wrong on, so it ships as-is.

Why `t1` is template divergence, not first add
    `features/README.md` mandates "Copy `_template/` to start a feature", so every
    artifact can - and, on the only feature that exists, does - first appear in
    one commit as an unfilled template copy. Measured directly: each of
    `features/_template/{intent,spec,plan}.md` has exactly one historical blob,
    all three introduced in the same bootstrap commit (`7c14ea0`). At that
    commit, `features/001-scheduled-research-drafts/`'s `intent.md` and
    `spec.md` already differ from their template blobs (so both correctly read
    as "filled" there), but its `plan.md` blob at `7c14ea0` is byte-identical to
    `features/_template/plan.md`'s - it is still the template - and first
    diverges only at `ae1e86c` (2026-08-26). A first-add anchor would call
    `7c14ea0` "the plan commit" and every number built on that date would be
    wrong by a day. `t1 = filled_at(path)`, computed by `resolve_filled()`, is
    instead the author date of the first commit whose blob at that path is
    outside the *historical set* of blobs `features/_template/<name>` has ever
    had - "historical set", not "the template as of that commit" or "the
    template now": the template can itself be edited after a feature copies from
    it, and either point-in-time comparison would then declare an untouched copy
    "filled" the moment the template changes under it. `template_blob_shas()`
    computes that set once per artifact name (three names, not per feature -
    templates change rarely, so a `git log --all` plus one `rev-parse` per
    historical revision is cheap) and memoises it in a module-level cache keyed
    by `(root, artifact_name)`.

Why `count_edits_after` excludes the anchor commit by sha
    `ae1e86c` is `001`'s `plan.md`-filling commit, and in that same commit also
    edits `spec.md`. Measured directly: its AUTHOR date is
    2026-08-26T20:28:30Z; its COMMITTER date is 2026-08-26T20:30:14Z, almost two
    minutes later - the signature of a rebase that moved the commit in history
    without touching what it actually did. Under a naive "committer date
    strictly after the anchor's author date" rule, that gap makes the anchor
    commit count itself as rework: its own committer date is after its own
    author date, which is the anchor it is being compared to. Whether that
    self-count fires then depends on whether the commit happened to get rebased
    - a metric that moves on rebase state is measuring clock skew, not rework.
    `count_edits_after()` takes an optional `anchor_sha` and excludes any commit
    whose sha matches it, so the anchor commit is never counted as evidence of
    edits after itself, rebased or not.

Why `count_edits_after` mixes an author date and a committer date
    Both stages of this measure the same shape: commits touching one artifact
    whose *committer* date is strictly after another artifact's *anchor*, an
    *author* date (`spec_t0` for Stage 1's intent churn, `plan_filled_at` for
    Stage 2's spec churn). That's deliberate, not a typo to "fix" to one clock:
    author date is when the anchor artifact's content was actually written (the
    right anchor for "after the anchor started"), while committer date is when a
    commit actually landed in history - including rebases and amends - which is
    the right clock for "was this edit real churn that happened after that
    point in the recorded history". `count_edits_after()` is shared by both
    stages specifically so they cannot drift apart on this.

Why there is no `sdlc.design.rollup`
    `sdlc.plan.rollup` exists because Stage 1 has something to aggregate that no
    single feature carries: accepted/rejected/open counts and a survival rate
    computed across all of them. Stage 2 has no analogue.
    `design_lead_time_hours` and `spec_post_plan_edits` are already per-feature
    numbers with no accepted/rejected/survival-style question to ask across
    features - a rollup here would just restate counts already visible on the
    per-feature panels (a count of how many features are measurable, a sum of
    churn across unrelated features), which is a span with nothing to say. Add
    one later, deliberately, if a real cross-feature Stage 2 question shows up
    (e.g. "how many features have reached the Stage 3 gate") - do not add it
    now just because Stage 1 has one; a symmetrical-looking file is not the
    goal.

Why GitHub issues are fetched once per feature and filtered client-side
    `gh issue list --label a --label b` is an AND, not an OR. Asking for
    `feature:NNN` and `gate:intent` in one call would return only issues that carry
    *both* labels - almost always none - and silently starve `t0` of every
    `feature:NNN` issue that isn't also the gate issue. So each feature gets one
    `gh issue list --label feature:NNN` call, and `gate:intent` is found by
    filtering the results in Python. `gh` is invoked by bare name (never an
    absolute path) so normal `PATH` resolution applies - that's also what lets a
    test harness put a stub `gh` earlier on `PATH` to exercise this path
    hermetically (see `plan_metrics_test.py`; the pattern mirrors
    `scripts/review-checks.test.mjs`'s stub-`gh`-on-`PATH` row rather than adding a
    bespoke env-var bypass here).

Why `sdlc.issue` names the `gate:intent` issue, not just any `feature:NNN` issue
    Many issues can carry one `feature:NNN` label - `t0` deliberately reads the
    earliest of *all* of them, per the per-feature table above, and
    `sdlc.t0.source` already records where that came from. But a bare "issue
    number" attribute needs one specific referent to be useful on a board, and the
    `gate:intent` issue is the only one of the bunch that's also the accept/reject
    record `sdlc.intent.outcome` is read from - so `sdlc.issue`/`issue` points at
    it specifically, letting a board click straight from a snapshot span to the
    record that produced its outcome. It is omitted entirely when no `gate:intent`
    issue exists yet, never backfilled with some other issue's number.

Why `sdlc.repo` is a module literal, not `otel_span.get_git_context()`
    That helper deliberately drops non-SSH remotes to avoid ever exporting a
    credential embedded in an HTTPS URL. GitHub Actions checks out over HTTPS, so
    in CI it returns `{}` and any span attribute derived from it would silently go
    missing exactly where this script runs on schedule. `REPO_SLUG` below is a
    plain string instead.

Why `--t0-from-sessions` exists and stays off by default
    Issue `createdAt` is a durable, server-side timestamp, but it is only a proxy
    for the playbook's actual leading indicator: time from the *first
    conversation* to a committed intent. `claude-otel-hooks` mirrors every Claude
    Code session to `~/.claude/projects/<repo-slug>/*.jsonl` on the machine that ran
    it, which is the genuine first-conversation signal - but it only exists
    locally, never in CI, and reading it back from Honeycomb instead would need a
    query key with different (broader) privileges than the ingest key this script
    is trusted with. So this flag scans that local directory, and only ever
    *sharpens* a feature's `t0` (never worsens it): it is repo-wide rather than
    per-feature by construction (one JSONL tree per project, not per feature), so
    it is only applied to the lexicographically-first feature, and only when the
    earliest local session timestamp for this repo actually predates the
    issue-derived `t0`. Absent the directory, this falls back to the issue
    timestamp silently - `--t0-from-sessions` is a local nicety, not a requirement.

Why the OTLP preflight treats HTTP 400 as success, and only 401/403 as failure
    The preflight's only job is proving the endpoint and credential are good
    *before* spending a whole run on a computation whose export would otherwise
    fail invisibly. It POSTs an empty body, which is a valid (if empty)
    `ExportTraceServiceRequest`, so nothing is ingested either way. Honeycomb is
    confirmed (tested directly) to return 401 for a bad `x-honeycomb-team` against
    an empty body - that is the credential failure this exists to catch. Whether a
    *good* key returns 2xx for a zero-byte protobuf body is not something this repo
    can verify before the real ingest key is handed over, and some strict OTLP
    receivers reject an empty/malformed payload with `400` regardless of whether
    auth succeeded. Treating "anything but 401/403" as failure would make the
    preflight itself the outage: a legitimate credential could 400 on this
    synthetic empty body and the daily job would exit non-zero forever, which is
    exactly the silently-dead-board failure mode this script exists to prevent -
    except now it's this script causing it. So the verdict is deliberately narrow:
    401/403 (`HTTPError`, read via `.code` - `HTTPError` is itself a response
    object, not just an exception) means the credential is bad and the job stops;
    a connection error, DNS failure, or timeout means the endpoint is unreachable
    and the job stops; everything else - 400 included, and any 2xx - is treated as
    "auth and reachability are fine" and the run proceeds to the real export.

Why `OTEL_SERVICE_NAME` is assigned, never `setdefault`
    `otel_span.py` reads `service.name` from `OTEL_SERVICE_NAME`, defaulting to
    `"claude-code"` - the dataset the interactive hooks already own. If this
    process inherits an ambient `OTEL_SERVICE_NAME` from the user's own Claude Code
    hook environment (entirely plausible: same machine, same shell), a
    `setdefault` would leave that ambient value in place and every SDLC span from
    this run would land silently in the wrong Honeycomb dataset, mixed in with
    interactive session telemetry. An unconditional assignment is the only way to
    guarantee `blog-research-agent-sdlc` every time `--emit` runs.

Namespace note
    CLAUDE.md's Observability rules (`agent.*` / `gen_ai.*` attributes only,
    `tracerFor`/`tracedStep` as the only span seam) govern the *Worker* service.
    This script is a separate CI job emitting a separate `sdlc.*` namespace to a
    separate dataset; it does not import `cloudflare:workers` and is not subject to
    that rule. `rules/span-attributes-allowlisted` only walks `src/**` and never
    sees this file.

Dependencies
    Stdlib only, on Python 3.14+. `otel_span` and `opentelemetry` are imported
    lazily, inside the `--emit` code path, so `--json`/table output and
    `plan_metrics_test.py` need zero third-party packages installed.

CLI
    python3 scripts/plan_metrics.py [--root DIR] [--json] [--emit]
                                     [--no-github] [--t0-from-sessions]

    Default is compute-and-print. `--emit` is the only path that ships spans.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from typing import Any

if sys.version_info < (3, 14):
    print(
        "plan_metrics.py requires Python 3.14+ (found "
        f"{sys.version_info.major}.{sys.version_info.minor}). "
        "On this machine, bare `python3` is 3.9.6; run with "
        "`/opt/homebrew/bin/python3.14 scripts/plan_metrics.py` instead, or put "
        "that directory ahead of the system one on PATH.",
        file=sys.stderr,
    )
    sys.exit(2)

# Identifies this repo in the JSON `repo` field and the `sdlc.repo` span attribute.
# A literal, not `git remote get-url` - see the "Why sdlc.repo is a module literal"
# note in the module docstring.
REPO_SLUG = "nimeshjm/blog-research-agent"

# Honeycomb dataset name (== OTEL service.name). Kept distinct from "claude-code",
# which claude-otel-hooks' interactive hooks already own - a Honeycomb board can
# pull widgets from both datasets.
DATASET_NAME = "blog-research-agent-sdlc"

# Matches "001-scheduled-research-drafts" but not "_template" - anchored on the
# three-digit numeric prefix `features/README.md` mandates, not on any name
# blocklist, so a differently-named non-feature directory is excluded the same way.
FEATURE_DIR_RE = re.compile(r"^\d{3}-")

# git's --follow rename-pairing similarity threshold. Lowered from git's 50%
# default to 25% so a renumbering commit that also rewrites a meaningful chunk of
# intent.md's content still gets paired with its origin - see the module
# docstring's measured table. The trailing '%' is required: `-M25` without it is a
# different (and here wrong) argument shape to git.
FOLLOW_SIMILARITY = "-M25%"

# A `D` on some *other* feature's copy of the same artifact inside the commit
# resolve_filled() picked as "filled" - the signature of a rename --follow could
# not pair (see the module docstring). Compiled per artifact basename
# (intent.md / spec.md / plan.md) and memoised in _ORPHAN_D_RE_CACHE below, so
# the guard covers all three artifacts rather than being hardcoded to one.
_ORPHAN_D_RE_CACHE: "dict[str, re.Pattern[str]]" = {}


# This runs once a day from CI, not in a hot loop or an interactive session, so
# there is no cost to being generous with subprocess/network timeouts here.
GIT_TIMEOUT_SECONDS = 30
GH_TIMEOUT_SECONDS = 30
PREFLIGHT_TIMEOUT_SECONDS = 10


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------


def parse_iso(timestamp: str) -> datetime.datetime:
    """Parse an ISO8601 timestamp (with or without a trailing 'Z') to aware UTC.

    Both git's `%aI`/`%cI` (e.g. "2026-08-25T18:04:47+01:00") and GitHub's
    `createdAt`/Claude Code's session `timestamp` (e.g.
    "2026-08-26T13:01:50Z"/"2026-08-25T19:26:31.627Z") parse through this one path,
    normalised to UTC so every comparison and subtraction in this script compares
    like with like regardless of the source's original offset.
    """
    return datetime.datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone(
        datetime.timezone.utc
    )


def to_iso_z(moment: datetime.datetime) -> str:
    """Render an aware datetime as ISO8601 UTC with a 'Z' suffix, for JSON/span output."""
    return moment.astimezone(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def now_utc() -> datetime.datetime:
    """The current instant, aware, in UTC. A thin wrapper so every "now" in this
    module goes through one call site."""
    return datetime.datetime.now(datetime.timezone.utc)


# ---------------------------------------------------------------------------
# git plumbing
# ---------------------------------------------------------------------------


def run_git(root: str, *args: str) -> "str | None":
    """Run `git <args>` in `root`. Returns stdout, or None on any failure (missing
    git, non-zero exit, timeout) - callers treat all of those identically, since
    none of them changes what there is to report: nothing."""
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=GIT_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    return result.stdout


# template_blob_shas() cache: {(root, artifact_name): {blob_sha, ...}}. Module-
# level and never invalidated within a process - see template_blob_shas()'s own
# docstring for why that's safe (this script runs once per process, and the
# whole point of memoising is that a feature's template rarely changes).
def _orphan_d_re(artifact_name: str) -> "re.Pattern[str]":
    """The orphaned-`D` regex for one artifact basename (e.g. "intent.md"),
    compiled once and cached. Behaviour for "intent.md" is byte-identical to
    the previous hardcoded ORPHAN_D_RE."""
    pattern = _ORPHAN_D_RE_CACHE.get(artifact_name)
    if pattern is None:
        pattern = re.compile(rf"^D\tfeatures/[^/]+/{re.escape(artifact_name)}$")
        _ORPHAN_D_RE_CACHE[artifact_name] = pattern
    return pattern


_TEMPLATE_BLOB_CACHE: "dict[tuple[str, str], set[str]]" = {}


def template_blob_shas(root: str, artifact_name: str) -> "set[str]":
    """Every blob sha `features/_template/<artifact_name>` has EVER had, as a
    set - not the template as of any one point in time. Memoised per
    `(root, artifact_name)` in `_TEMPLATE_BLOB_CACHE`, since this is called once
    per feature per artifact and the underlying history barely ever changes.

    Why a set and not a single "the template" lookup: see the module
    docstring's "Why `t1` is template divergence, not first add" note. A
    feature's copy can be byte-identical to some *earlier* version of the
    template even after the template itself has since been edited, and only
    the full historical set catches that.

    Implementation: `git log --all` for every commit that ever touched the
    path, then `git rev-parse <sha>:<path>` per revision - the template path
    itself is never renamed, so there's no `--follow`/rename concern here, only
    for the per-feature copies `resolve_filled()` resolves. Empty set (not an
    error) when the template path has no history at all; every commit then
    reads as "filled", which is the right degradation - nothing to compare
    against means nothing can be withheld as "still the template".
    """
    key = (root, artifact_name)
    cached = _TEMPLATE_BLOB_CACHE.get(key)
    if cached is not None:
        return cached

    path = f"features/_template/{artifact_name}"
    output = run_git(root, "log", "--all", "--format=%H", "--", path)
    shas: "set[str]" = set()
    if output:
        for rev in output.split("\n"):
            rev = rev.strip()
            if not rev:
                continue
            blob = run_git(root, "rev-parse", f"{rev}:{path}")
            if blob:
                shas.add(blob.strip())

    _TEMPLATE_BLOB_CACHE[key] = shas
    return shas


def _parse_raw_log(output: str) -> "list[dict[str, Any]]":
    """Parse the output of:

        git log --follow -M25% --raw --no-abbrev \\
            --format='C%x09%H%x09%aI%x09%an' -- <path>

    into one record per commit that touched `path`, in git's own (newest-first)
    order: {sha, author_date, author_name, post_image}. `post_image` is the
    post-image blob sha read directly off the raw diff line - see the module
    docstring's note on why this, and not `git rev-parse <sha>:<path>`, is the
    only correct way to get it under `--follow`. A rename status line
    (`R100\\t<old>\\t<new>`) still has exactly five space-separated fields before
    the tab - `<old_mode> <new_mode> <old_sha> <new_sha> <status>` - so this
    never needs to special-case it. Commits with no raw line at all (seen for
    merge commits touching this path) are dropped: `post_image` stays None and
    the record is filtered out below.
    """
    records: "list[dict[str, Any]]" = []
    current: "dict[str, Any] | None" = None
    for raw_line in output.split("\n"):
        if raw_line.startswith("C\t"):
            fields = raw_line.split("\t")
            if len(fields) != 4:
                continue
            _, sha, author_date, author_name = fields
            current = {
                "sha": sha,
                "author_date": author_date,
                "author_name": author_name,
                "post_image": None,
            }
            records.append(current)
        elif raw_line.startswith(":"):
            if current is None or current["post_image"] is not None:
                continue
            meta, _, _rest = raw_line[1:].partition("\t")
            parts = meta.split()
            if len(parts) != 5:
                continue
            _old_mode, _new_mode, _old_blob, new_blob, _status = parts
            current["post_image"] = new_blob
        # blank separator lines and anything else: ignore.
    return [r for r in records if r["post_image"] is not None]


def resolve_filled(root: str, rel_path: str) -> "tuple[datetime.datetime, str, str, str] | None":
    """Resolve the commit that first FILLS `rel_path` - the first commit,
    walked oldest-first across renames, whose post-image blob at that path is
    outside `template_blob_shas()` for that artifact's basename. See the
    module docstring's "Why `t1` is template divergence, not first add" note
    for why this replaced a plain "first add" resolution.

    Returns (author_date, author_name, sha, t1_source), or None when the path
    has never been committed, or has been committed but every commit's blob is
    still in the template's historical set (never actually filled in). A
    deletion (all-zero post-image) is skipped rather than treated as "filled" -
    there is no content there to compare.

    `t1_source` is "follow" when the resolution looks trustworthy, or
    "follow-unresolved" when an orphaned `D` on a *different* feature's copy of
    the *same artifact* turns up in the same commit - the signature of a
    rename `--follow` could not pair even at `-M25%` (see the module
    docstring). Callers must not trust the returned date when
    `t1_source == "follow-unresolved"`.
    """
    artifact_name = os.path.basename(rel_path)
    template_shas = template_blob_shas(root, artifact_name)

    output = run_git(
        root, "log", "--follow", FOLLOW_SIMILARITY, "--raw", "--no-abbrev",
        "--format=C%x09%H%x09%aI%x09%an", "--", rel_path,
    )
    if not output:
        return None
    records = _parse_raw_log(output)
    if not records:
        return None

    zero_sha = "0" * 40
    orphan_re = _orphan_d_re(artifact_name)

    for record in reversed(records):  # git logs newest-first; walk oldest-first
        post_image = record["post_image"]
        if post_image == zero_sha or post_image in template_shas:
            continue

        sha = record["sha"]
        t1_source = "follow"
        show_output = run_git(root, "show", "--name-status", "--format=", sha, "--", "features/")
        if show_output:
            for line in show_output.split("\n"):
                if orphan_re.match(line):
                    t1_source = "follow-unresolved"
                    break

        return parse_iso(record["author_date"]), record["author_name"], sha, t1_source

    return None


def _parse_name_status_log(output: str) -> "list[dict[str, Any]]":
    """Parse the output of:

        git log --follow -M25% --name-status \\
            --format='C%x09%H%x09%aI%x09%cI%x09%an' -- <path>

    into one record per commit that touched `path`: {sha, author_date,
    committer_date, author_name, status}. `status` is a single letter (A/M/D/R/...)
    - a rename status line is `R100\\t<old>\\t<new>` (three tab-separated fields,
    versus two for A/M/D), so this only ever reads the status letter itself and
    never assumes a fixed split length. When a commit somehow carries more than one
    status line for this path, the first one wins; a second is not expected with a
    single pathspec and would just be noise for this script's purposes.
    """
    records: "list[dict[str, Any]]" = []
    current: "dict[str, Any] | None" = None
    for raw_line in output.split("\n"):
        if raw_line.startswith("C\t"):
            fields = raw_line.split("\t")
            if len(fields) != 5:
                continue
            _, sha, author_date, committer_date, author_name = fields
            current = {
                "sha": sha,
                "author_date": author_date,
                "committer_date": committer_date,
                "author_name": author_name,
                "status": None,
            }
            records.append(current)
        elif raw_line.strip() == "":
            continue
        else:
            if current is None or current["status"] is not None:
                continue
            current["status"] = raw_line.split("\t", 1)[0][0]
    return [r for r in records if r["status"] is not None]


def git_path_history(root: str, rel_path: str) -> "list[dict[str, Any]]":
    """The full `--follow -M25% --name-status` history of `rel_path`, parsed into
    records - every commit that ever touched it, across renames. Empty list if the
    path has never been committed (or on any git failure). Used only to enumerate
    committer dates for `count_edits_after`; `t1`/`filled_at` itself comes from
    `resolve_filled()`, not from this list."""
    output = run_git(
        root, "log", "--follow", FOLLOW_SIMILARITY, "--name-status",
        "--format=C%x09%H%x09%aI%x09%cI%x09%an", "--", rel_path,
    )
    if output is None:
        return []
    return _parse_name_status_log(output)


def count_edits_after(
    history: "list[dict[str, Any]]",
    anchor: datetime.datetime,
    anchor_sha: "str | None" = None,
) -> int:
    """Commits in `history` whose COMMITTER date is strictly after `anchor` (an
    AUTHOR-date datetime), excluding the commit whose sha == `anchor_sha`.

    Shared by both stages - Stage 1's intent-post-spec-edits and Stage 2's
    spec-post-plan-edits both call this with their own `(history, anchor,
    anchor_sha)` triple, so the two counts cannot silently drift onto two
    different definitions of "after". See the module docstring's "Why
    `count_edits_after` mixes an author date and a committer date" and "Why
    `count_edits_after` excludes the anchor commit by sha" notes for why the
    two clocks and the sha exclusion are both deliberate, not bugs.
    """
    return sum(
        1
        for r in history
        if r["sha"] != anchor_sha and parse_iso(r["committer_date"]) > anchor
    )


def compute_git_facts(root: str, feature_dir: str) -> "dict[str, Any] | None":
    """Everything this script can learn from git alone for one feature directory -
    both Stage 1 (Plan) and Stage 2 (Design) facts.

    Returns None when intent.md has never been FILLED (never committed, or
    committed but still byte-identical to some historical template blob - see
    `resolve_filled()`). A committed-but-still-template intent.md starts no
    clock; that is the whole point of the anchor redefinition documented in the
    module docstring.
    """
    intent_rel = "/".join(("features", feature_dir, "intent.md"))
    spec_rel = "/".join(("features", feature_dir, "spec.md"))
    plan_rel = "/".join(("features", feature_dir, "plan.md"))

    intent_filled = resolve_filled(root, intent_rel)
    if intent_filled is None:
        return None
    t1, intent_author, intent_sha, t1_source = intent_filled

    facts: "dict[str, Any]" = {
        "t1": t1,
        "intent_sha": intent_sha,
        "intent_author": intent_author,
        "t1_source": t1_source,
        # Stage 1 (existing, now filled-based).
        "spec_committed_at": None,
        "spec_sha": None,
        "spec_t1_source": None,
        "post_spec_edits": None,
        # Stage 2 (Design) - new.
        "design_lead_time_hours": None,
        "design_measurable": False,
        "plan_filled_at": None,
        "plan_sha": None,
        "design_anchor_source": "none",
        "spec_post_plan_edits": None,
    }

    spec_filled = resolve_filled(root, spec_rel)
    if spec_filled is not None:
        spec_t1, _spec_author, spec_sha, spec_t1_source = spec_filled
        facts["spec_committed_at"] = spec_t1
        facts["spec_sha"] = spec_sha
        facts["spec_t1_source"] = spec_t1_source
        # Counted whether or not intent.md and spec.md share their first FILLED
        # commit. Issue #29 said to omit churn in the same-commit case on the
        # grounds that it is "undefined too", but that conflates two
        # independent things: the *lead time* is undefined there (see
        # `design_measurable` below), the churn is not. spec_t1 is a real
        # timestamp either way, and "intent commits strictly after it" is a
        # real count either way. Feature 001 is the case that settled it: its
        # artifacts share the bootstrap commit, and 706ea65 then edited
        # intent.md the next day. That is exactly the rework the board's
        # `MAX(sdlc.intent.post_spec_edits) > 0` trigger exists to catch, and
        # omitting it would hide the one signal that means anything at n=1.
        # post_spec_edits stays None only when spec.md is never filled - the
        # case that genuinely has no baseline to measure from.
        intent_records = git_path_history(root, intent_rel)
        facts["post_spec_edits"] = count_edits_after(intent_records, spec_t1, anchor_sha=spec_sha)

        # design_lead_time_hours / design_measurable both need spec_t1, so they
        # live inside this branch - see issue #42's unmeasurable guards, mirrored
        # exactly here:
        #   - spec.md not filled: design_measurable stays its False default below.
        #   - intent.md and spec.md first FILLED in the same commit (001's real
        #     case): same_commit.
        #   - design_lead_time_hours < 0 (spec filled before intent - possible
        #     when intent.md was copied as a template and filled later than the
        #     spec): the >= 0 check.
        #   - either artifact's t1_source == "follow-unresolved": unresolved.
        same_commit = spec_sha == intent_sha
        lead_time_hours = (spec_t1 - t1).total_seconds() / 3600.0
        facts["design_lead_time_hours"] = lead_time_hours
        unresolved = t1_source == "follow-unresolved" or spec_t1_source == "follow-unresolved"
        facts["design_measurable"] = (
            not same_commit and lead_time_hours >= 0 and not unresolved
        )

    # plan.md is resolved unconditionally, independent of whether spec.md is
    # filled: design_anchor_source names what plan.md itself is doing ("has it
    # diverged from the template"), not a joint fact about spec and plan, so a
    # feature with a filled plan.md but an unfilled spec.md (gate-skipping, but
    # real) must still report anchor_source == "plan-filled" rather than
    # silently misreporting "none" because spec wasn't filled yet.
    plan_filled = resolve_filled(root, plan_rel)
    if plan_filled is not None:
        plan_t1, _plan_author, plan_sha, _plan_t1_source = plan_filled
        facts["plan_filled_at"] = plan_t1
        facts["plan_sha"] = plan_sha
        facts["design_anchor_source"] = "plan-filled"
        # spec_post_plan_edits is a churn count ABOUT spec.md, so it stays None
        # (omitted) when spec.md itself has never been filled - there is no
        # spec to have been reworked, the same "no baseline to measure from"
        # reasoning post_spec_edits already applies above for a missing
        # spec.md, not a claim that a nonexistent spec had exactly 0 edits.
        # When spec.md HAS been filled, count_edits_after() on its history
        # returning 0 is a defined, real zero ("no edits after the anchor
        # exist"), not a fabricated one; see the module docstring's
        # anchor-sha-exclusion note for the general shape of that argument.
        if facts["spec_committed_at"] is not None:
            spec_history = git_path_history(root, spec_rel)
            facts["spec_post_plan_edits"] = count_edits_after(
                spec_history, plan_t1, anchor_sha=plan_sha
            )

    return facts


def discover_features(root: str) -> "list[str]":
    """Feature directory names under <root>/features matching ^\\d{3}- that contain
    an intent.md, sorted by directory name. `_template` (no digit prefix) and any
    numbered directory with no intent.md yet are excluded here, not flagged."""
    features_dir = os.path.join(root, "features")
    if not os.path.isdir(features_dir):
        return []
    names = []
    for entry in os.listdir(features_dir):
        full = os.path.join(features_dir, entry)
        if not os.path.isdir(full):
            continue
        if not FEATURE_DIR_RE.match(entry):
            continue
        if not os.path.isfile(os.path.join(full, "intent.md")):
            continue
        names.append(entry)
    return sorted(names)


# ---------------------------------------------------------------------------
# GitHub
# ---------------------------------------------------------------------------


def fetch_feature_issues(root: str, feature_num: str, use_github: bool) -> "list[dict[str, Any]]":
    """One `gh issue list --label feature:<NNN>` call. Returns [] uniformly on
    --no-github, a missing `gh`, a non-zero exit, or unparsable JSON - all four mean
    the same thing downstream: no GitHub signal for this feature. `gh` is invoked
    by bare name so ordinary PATH resolution applies (see the module docstring's
    note on why - this is also the test seam: a stub `gh` earlier on PATH)."""
    if not use_github:
        return []
    try:
        result = subprocess.run(
            [
                "gh", "issue", "list",
                "--repo", REPO_SLUG,
                "--label", f"feature:{feature_num}",
                "--state", "all",
                "--json", "number,createdAt,state,stateReason,labels",
            ],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=GH_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if result.returncode != 0:
        return []
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return []
    return data if isinstance(data, list) else []


def session_t0(root: str) -> "datetime.datetime | None":
    """Earliest `timestamp` among this repo's local Claude Code session records,
    read from `~/.claude/projects/<repo-slug>/*.jsonl` (slug = root with every '/'
    replaced by '-'). None if the directory doesn't exist or nothing matches - the
    caller falls back to the issue-derived t0 silently in that case.

    Repo-wide by construction (one JSONL tree per project directory, not per
    feature) - it is the caller's job to apply this only to the first feature and
    only when it beats that feature's issue-derived t0.
    """
    slug = root.replace("/", "-")
    session_dir = os.path.join(os.path.expanduser("~"), ".claude", "projects", slug)
    if not os.path.isdir(session_dir):
        return None
    try:
        entries = os.listdir(session_dir)
    except OSError:
        return None

    earliest: "datetime.datetime | None" = None
    for name in entries:
        if not name.endswith(".jsonl"):
            continue
        path = os.path.join(session_dir, name)
        try:
            with open(path, encoding="utf-8") as handle:
                for line in handle:
                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(record, dict):
                        continue
                    timestamp = record.get("timestamp")
                    cwd = record.get("cwd")
                    if not timestamp or cwd != root:
                        continue
                    try:
                        parsed = parse_iso(timestamp)
                    except ValueError:
                        continue
                    if earliest is None or parsed < earliest:
                        earliest = parsed
        except OSError:
            continue
    return earliest


# ---------------------------------------------------------------------------
# Per-feature assembly
# ---------------------------------------------------------------------------


def build_feature(
    root: str,
    feature_dir: str,
    use_github: bool,
    apply_session_t0: bool,
    cached_session_t0: "datetime.datetime | None",
) -> "dict[str, Any] | None":
    """Assemble one feature's report record - Stage 1 (Plan) and Stage 2
    (Design) fields both - or None if intent.md has never been filled yet (see
    compute_git_facts)."""
    facts = compute_git_facts(root, feature_dir)
    if facts is None:
        return None

    feature_num = feature_dir[:3]
    issues = fetch_feature_issues(root, feature_num, use_github)

    t0: "datetime.datetime | None" = None
    t0_source = "none"
    if issues:
        earliest_issue = min(issues, key=lambda i: parse_iso(i["createdAt"]))
        t0 = parse_iso(earliest_issue["createdAt"])
        t0_source = "issue"

    if apply_session_t0 and cached_session_t0 is not None:
        if t0 is None or cached_session_t0 < t0:
            t0 = cached_session_t0
            t0_source = "session"

    same_commit = facts["spec_sha"] is not None and facts["spec_sha"] == facts["intent_sha"]
    unresolved_t1 = facts["t1_source"] == "follow-unresolved"

    lead_time_hours: "float | None" = None
    if t0 is not None:
        lead_time_hours = (facts["t1"] - t0).total_seconds() / 3600.0

    measurable = (
        t0 is not None
        and lead_time_hours is not None
        and lead_time_hours >= 0
        and not same_commit
        and not unresolved_t1
    )

    # sdlc.issue / "issue" names the gate:intent issue specifically - see the
    # module docstring's "Why sdlc.issue names the gate:intent issue" note. t0
    # above deliberately still reads the earliest of *all* feature:NNN issues.
    issue_number: "int | None" = None
    outcome: "str | None" = None
    if issues:
        gate_issues = [
            i for i in issues
            if any(label.get("name") == "gate:intent" for label in i.get("labels", []))
        ]
        if gate_issues:
            gate = min(gate_issues, key=lambda i: parse_iso(i["createdAt"]))
            issue_number = gate.get("number")
            if gate.get("state") == "CLOSED" and gate.get("stateReason") == "COMPLETED":
                outcome = "accepted"
            elif gate.get("state") == "CLOSED" and gate.get("stateReason") == "NOT_PLANNED":
                outcome = "rejected"
            else:
                outcome = "open"
        else:
            # No [gate] issue filed yet for this feature's intent: undecided, i.e.
            # still "open" pending one being filed and closed. This is feature
            # 001's real state today - feature:001 issues exist, none is
            # gate:intent - and it correctly counts toward the rollup's
            # open_count rather than being omitted, since some feature:NNN
            # GitHub signal does exist. `issue` stays omitted: there is no
            # gate:intent issue to point at yet.
            outcome = "open"

    now = now_utc()

    record: "dict[str, Any]" = {"feature": feature_dir}
    if issue_number is not None:
        record["issue"] = issue_number
    record["measurable"] = measurable
    if t0 is not None:
        record["t0"] = to_iso_z(t0)
    record["t0_source"] = t0_source
    record["intent_author"] = facts["intent_author"]
    record["intent_committed_at"] = to_iso_z(facts["t1"])
    record["intent_age_days"] = (now - facts["t1"]).total_seconds() / 86400.0
    record["intent_t1_source"] = facts["t1_source"]
    if measurable:
        record["lead_time_hours"] = lead_time_hours
    if facts["spec_committed_at"] is not None:
        record["spec_committed_at"] = to_iso_z(facts["spec_committed_at"])
        # Present whenever spec_committed_at is - see build_report()'s docstring
        # key list.
        record["spec_t1_source"] = facts["spec_t1_source"]
        record["spec_age_days"] = (now - facts["spec_committed_at"]).total_seconds() / 86400.0
    if outcome is not None:
        record["intent_outcome"] = outcome
    if facts["post_spec_edits"] is not None:
        record["intent_post_spec_edits"] = facts["post_spec_edits"]

    # Stage 2 (Design). design_measurable and design_anchor_source are ALWAYS
    # present (like intent_t1_source above) so a reader can see *why* a feature
    # is unmeasurable rather than just that it is. design_lead_time_hours,
    # design_plan_filled_at and spec_post_plan_edits are omitted - key absent,
    # never null, never a fabricated 0 - exactly when their underlying fact is
    # undefined: no fabricated number reaches the report or a span.
    record["design_measurable"] = facts["design_measurable"]
    if facts["design_measurable"]:
        record["design_lead_time_hours"] = facts["design_lead_time_hours"]
    record["design_anchor_source"] = facts["design_anchor_source"]
    if facts["plan_filled_at"] is not None:
        record["design_plan_filled_at"] = to_iso_z(facts["plan_filled_at"])
    if facts["spec_post_plan_edits"] is not None:
        record["spec_post_plan_edits"] = facts["spec_post_plan_edits"]

    return record


def compute_rollup(features: "list[dict[str, Any]]") -> "dict[str, Any]":
    """One rollup counting every feature with a known `intent_outcome`, regardless
    of `measurable` - feature 001 is unmeasurable but its outcome ("open") is still
    real GitHub state, so it still counts toward open_count. survival_rate is
    computed here (not left for a query-time row-count division, which would
    silently change value on every re-run of the same historical data) and omitted
    entirely when there are zero decided (accepted+rejected) intents to divide by.
    """
    accepted = sum(1 for f in features if f.get("intent_outcome") == "accepted")
    rejected = sum(1 for f in features if f.get("intent_outcome") == "rejected")
    open_count = sum(1 for f in features if f.get("intent_outcome") == "open")
    rollup: "dict[str, Any]" = {
        "accepted_count": accepted,
        "rejected_count": rejected,
        "open_count": open_count,
    }
    denominator = accepted + rejected
    if denominator > 0:
        rollup["survival_rate"] = accepted / denominator
    return rollup


def build_report(root: str, use_github: bool, apply_session_t0: bool) -> "dict[str, Any]":
    """Build the full report.

    Top-level JSON shape (this is the contract plan_metrics_test.py asserts
    against - keep it stable):

        {
          "repo": "nimeshjm/blog-research-agent",
          "dataset": "blog-research-agent-sdlc",
          "generated_at": "<ISO8601Z>",
          "features": [ { "feature": "002-foo", "measurable": true, ... }, ... ],
          "rollup": { "accepted_count": 0, "rejected_count": 0, "open_count": 1 }
        }

    `features` is sorted by directory name. Each feature record's keys mirror the
    `sdlc.*` span attributes with the prefix dropped and '.' replaced by '_':

    Stage 1 (Plan): feature, issue, measurable, t0, t0_source, intent_author,
    intent_committed_at, intent_age_days, intent_t1_source, lead_time_hours,
    spec_committed_at, intent_outcome, intent_post_spec_edits.

    Stage 2 (Design): design_measurable, spec_t1_source, spec_age_days,
    design_lead_time_hours, design_plan_filled_at, design_anchor_source,
    spec_post_plan_edits. (spec_committed_at is shared with Stage 1, now
    filled-based for both.)

    Omitted means the key is absent, never null and never a fabricated 0 - see the
    module docstring's note on why feature 001 must report unmeasurable rather than
    a 0-hour lead time / 0 post-spec edits. `intent_t1_source`, `design_measurable`
    and `design_anchor_source` are the fields that are always present, even when
    unmeasurable: `intent_t1_source` is "follow" or "follow-unresolved", never
    absent, since it is what a reader would need to understand *why* a feature
    reports unmeasurable when the guard responsible is the rename-detection one
    rather than a missing t0; `design_measurable`/`design_anchor_source` play the
    same role for Stage 2 - a reader can always see why a feature's design lead
    time or churn number is missing, never just that it is.
    """
    feature_dirs = discover_features(root)
    cached_session = session_t0(root) if apply_session_t0 else None

    features: "list[dict[str, Any]]" = []
    for index, feature_dir in enumerate(feature_dirs):
        record = build_feature(
            root,
            feature_dir,
            use_github,
            apply_session_t0 and index == 0,
            cached_session,
        )
        if record is not None:
            features.append(record)

    return {
        "repo": REPO_SLUG,
        "dataset": DATASET_NAME,
        "generated_at": to_iso_z(now_utc()),
        "features": features,
        "rollup": compute_rollup(features),
    }


# ---------------------------------------------------------------------------
# --emit: OTLP preconditions + span construction
# ---------------------------------------------------------------------------


def _parse_otlp_headers(raw: str) -> "dict[str, str]":
    """Same splitting rule as otel_span._get_exporter, so the preflight check below
    and the real export made by emit_spans can never disagree about which header
    key is actually in play."""
    return dict(kv.split("=", 1) for kv in raw.split(",") if "=" in kv)


def _preflight(endpoint: str) -> "tuple[str, int | None]":
    """POST an empty body to {endpoint}/v1/traces with the same content-type and
    headers a real export would use. Returns (verdict, status):

      "ok"      - endpoint reachable and (as far as this probe can tell) the
                  credential is fine. Includes any 2xx *and* 400 - see the module
                  docstring's "Why the OTLP preflight treats HTTP 400 as success"
                  note: an empty protobuf body is expected to be rejected by a
                  strict server on payload grounds alone, which is not a
                  credential failure.
      "auth"    - HTTP 401 or 403: the credential itself is bad.
      "network" - connection error, DNS failure, or timeout: nothing to name.
    """
    url = f"{endpoint.rstrip('/')}/v1/traces"
    headers = {"content-type": "application/x-protobuf"}
    headers.update(_parse_otlp_headers(os.environ.get("OTEL_EXPORTER_OTLP_HEADERS", "")))
    request = urllib.request.Request(url, data=b"", headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=PREFLIGHT_TIMEOUT_SECONDS) as response:
            return "ok", response.status
    except urllib.error.HTTPError as exc:
        # HTTPError is itself a response object - .code is the real HTTP status,
        # not a generic exception with no status to read.
        if exc.code in (401, 403):
            return "auth", exc.code
        return "ok", exc.code
    except (urllib.error.URLError, OSError, TimeoutError):
        return "network", None


def _build_specs(report: "dict[str, Any]") -> "list[dict[str, Any]]":
    """One `sdlc.plan.snapshot` spec per feature, one `sdlc.design.snapshot` spec
    per feature, plus one `sdlc.plan.rollup` spec for the whole run - exactly the
    attribute names from issue #29 (Stage 1) and issue #42 (Stage 2), nothing
    extra. No `sdlc.design.rollup` - see the module docstring's "Why there is no
    `sdlc.design.rollup`" note; do not add one here to "match" the Stage 1 shape.
    """
    specs: "list[dict[str, Any]]" = []

    for feature in report["features"]:
        attrs: "dict[str, Any]" = {
            "sdlc.feature": feature["feature"],
            "sdlc.repo": report["repo"],
        }
        if "issue" in feature:
            attrs["sdlc.issue"] = feature["issue"]
        attrs["sdlc.measurable"] = feature["measurable"]
        if "t0" in feature:
            attrs["sdlc.t0"] = feature["t0"]
        attrs["sdlc.t0.source"] = feature["t0_source"]
        attrs["sdlc.intent.author"] = feature["intent_author"]
        attrs["sdlc.intent.committed_at"] = feature["intent_committed_at"]
        attrs["sdlc.intent.age_days"] = feature["intent_age_days"]
        attrs["sdlc.intent.t1_source"] = feature["intent_t1_source"]
        if "lead_time_hours" in feature:
            attrs["sdlc.plan.lead_time_hours"] = feature["lead_time_hours"]
        if "spec_committed_at" in feature:
            attrs["sdlc.spec.committed_at"] = feature["spec_committed_at"]
        if "intent_outcome" in feature:
            attrs["sdlc.intent.outcome"] = feature["intent_outcome"]
        if "intent_post_spec_edits" in feature:
            attrs["sdlc.intent.post_spec_edits"] = feature["intent_post_spec_edits"]
        specs.append({"name": "sdlc.plan.snapshot", "attributes": attrs})

        # Stage 2 (Design) - issue #42. Own span, own attribute names - see the
        # module docstring's "Why three span names" note. The mapping below is
        # exactly issue #42's table: design_measurable -> sdlc.measurable,
        # spec_committed_at -> sdlc.spec.committed_at, spec_t1_source ->
        # sdlc.spec.t1_source, spec_age_days -> sdlc.spec.age_days,
        # design_lead_time_hours -> sdlc.design.lead_time_hours,
        # design_plan_filled_at -> sdlc.design.plan_filled_at,
        # design_anchor_source -> sdlc.design.anchor_source,
        # spec_post_plan_edits -> sdlc.spec.post_plan_edits. Do NOT rename
        # `sdlc.design.plan_filled_at` to `sdlc.plan.filled_at` - that reads as
        # a Stage 1 field on a board (`sdlc.plan.*` names the Stage 1 *stage*;
        # `plan.md` is a Stage 3 *artifact* measured here as part of Stage 2).
        design_attrs: "dict[str, Any]" = {
            "sdlc.feature": feature["feature"],
            "sdlc.repo": report["repo"],
            "sdlc.measurable": feature["design_measurable"],
        }
        if "spec_committed_at" in feature:
            design_attrs["sdlc.spec.committed_at"] = feature["spec_committed_at"]
        if "spec_t1_source" in feature:
            design_attrs["sdlc.spec.t1_source"] = feature["spec_t1_source"]
        if "spec_age_days" in feature:
            design_attrs["sdlc.spec.age_days"] = feature["spec_age_days"]
        if "design_lead_time_hours" in feature:
            design_attrs["sdlc.design.lead_time_hours"] = feature["design_lead_time_hours"]
        if "design_plan_filled_at" in feature:
            design_attrs["sdlc.design.plan_filled_at"] = feature["design_plan_filled_at"]
        # Always present - a reader must always be able to see why a design
        # lead time / churn number is missing, never just that it is (mirrors
        # sdlc.intent.t1_source's role on the Stage 1 span above).
        design_attrs["sdlc.design.anchor_source"] = feature["design_anchor_source"]
        if "spec_post_plan_edits" in feature:
            design_attrs["sdlc.spec.post_plan_edits"] = feature["spec_post_plan_edits"]
        specs.append({"name": "sdlc.design.snapshot", "attributes": design_attrs})

    rollup = report["rollup"]
    rollup_attrs: "dict[str, Any]" = {
        "sdlc.intent.accepted_count": rollup["accepted_count"],
        "sdlc.intent.rejected_count": rollup["rejected_count"],
        "sdlc.intent.open_count": rollup["open_count"],
    }
    if "survival_rate" in rollup:
        rollup_attrs["sdlc.intent.survival_rate"] = rollup["survival_rate"]
    specs.append({"name": "sdlc.plan.rollup", "attributes": rollup_attrs})

    return specs


def run_emit(report: "dict[str, Any]") -> int:
    """Check every precondition, then ship one emit_spans() call. Non-zero exit,
    with a message naming the cause, on any failure - see the module docstring's
    note on why this differs from otel_span.py's own fail-soft default."""
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "")
    if not endpoint:
        print(
            "plan_metrics: --emit requires OTEL_EXPORTER_OTLP_ENDPOINT to be set",
            file=sys.stderr,
        )
        return 1

    try:
        import opentelemetry  # noqa: F401
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (  # noqa: F401
            OTLPSpanExporter,
        )
    except ImportError as exc:
        print(
            f"plan_metrics: opentelemetry is not importable under {sys.executable} "
            f"({exc}); pip install opentelemetry-sdk opentelemetry-exporter-otlp-proto-http",
            file=sys.stderr,
        )
        return 1

    if os.environ.get("OTEL_HOOKS_CONSOLE_EXPORT") != "1":
        verdict, status = _preflight(endpoint)
        if verdict == "network":
            print(
                "plan_metrics: preflight POST to the OTLP endpoint failed "
                "(network error / unreachable)",
                file=sys.stderr,
            )
            return 1
        if verdict == "auth":
            print(
                f"plan_metrics: preflight POST to the OTLP endpoint returned HTTP {status} "
                "(401/403 = bad credentials) - check OTEL_EXPORTER_OTLP_HEADERS",
                file=sys.stderr,
            )
            return 1
        # verdict == "ok": any other status, including 400, is treated as
        # success - see _preflight's docstring for why a 400 here is expected
        # and not a sign of a bad credential.

    # Assignment, not setdefault - see the module docstring's note on why an
    # ambient OTEL_SERVICE_NAME from the user's own Claude Code hooks must never
    # win here.
    os.environ["OTEL_SERVICE_NAME"] = DATASET_NAME
    print(f"plan_metrics: emitting to dataset {DATASET_NAME!r}", file=sys.stderr)

    import otel_span  # lazy: only the --emit path needs this, or opentelemetry at all

    otel_span.emit_spans(_build_specs(report))
    return 0


# ---------------------------------------------------------------------------
# Human-readable output
# ---------------------------------------------------------------------------


def print_table(report: "dict[str, Any]") -> None:
    print(f"repo:      {report['repo']}")
    print(f"dataset:   {report['dataset']}")
    print(f"generated: {report['generated_at']}")
    print()

    if not report["features"]:
        print("(no feature directories with a committed intent.md found)")
    else:
        for feature in report["features"]:
            lead = (
                f"{feature['lead_time_hours']:.2f}h" if "lead_time_hours" in feature else "n/a"
            )
            churn = feature.get("intent_post_spec_edits", "n/a")
            outcome = feature.get("intent_outcome", "n/a")
            print(
                f"  {feature['feature']:<40} "
                f"measurable={str(feature['measurable']):<5} "
                f"t0_source={feature['t0_source']:<7} "
                f"t1_source={feature['intent_t1_source']:<17} "
                f"lead_time={lead:<9} "
                f"outcome={outcome:<9} "
                f"post_spec_edits={churn}"
            )
            # Stage 2 (Design), on its own line - the Stage 1 line above is
            # already close to the width worth keeping readable in a terminal,
            # and design_anchor_source's values ("plan-filled"/"none") plus a
            # second lead_time/churn pair would push it well past that. See
            # issue #42's "print_table" scope note.
            design_lead = (
                f"{feature['design_lead_time_hours']:.2f}h"
                if "design_lead_time_hours" in feature
                else "n/a"
            )
            design_churn = feature.get("spec_post_plan_edits", "n/a")
            print(
                f"  {'':<40} "
                f"design_measurable={str(feature['design_measurable']):<5} "
                f"design_lead_time={design_lead:<9} "
                f"design_anchor_source={feature['design_anchor_source']:<12} "
                f"spec_post_plan_edits={design_churn}"
            )

    print()
    rollup = report["rollup"]
    survival = f"{rollup['survival_rate']:.2f}" if "survival_rate" in rollup else "n/a"
    print(
        f"rollup: accepted={rollup['accepted_count']} rejected={rollup['rejected_count']} "
        f"open={rollup['open_count']} survival_rate={survival}"
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args(argv: "list[str]") -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="plan_metrics.py",
        description=(
            "Stage 1 (Plan) and Stage 2 (Design) SDLC extractor: git (+ GitHub for "
            "Stage 1 only) -> optional OTLP export to Honeycomb. Default is "
            "compute-and-print; --emit is the only path that ships spans."
        ),
    )
    parser.add_argument(
        "--root", default=os.getcwd(), help="repo root to scan (default: cwd)"
    )
    parser.add_argument(
        "--json", action="store_true", help="print the report as JSON instead of a table"
    )
    parser.add_argument(
        "--emit",
        action="store_true",
        help="ship spans over OTLP; see the module docstring for preconditions",
    )
    parser.add_argument(
        "--no-github",
        action="store_true",
        help="skip all `gh` calls; every feature's t0 degrades to t0_source=none "
        "unless --t0-from-sessions hits",
    )
    parser.add_argument(
        "--t0-from-sessions",
        action="store_true",
        help="sharpen the first feature's t0 from local Claude Code session logs, "
        "when that beats the issue-derived t0 (local-only; see module docstring)",
    )
    return parser.parse_args(argv)


def main(argv: "list[str] | None" = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    root = os.path.abspath(args.root)

    report = build_report(
        root, use_github=not args.no_github, apply_session_t0=args.t0_from_sessions
    )

    if args.emit:
        return run_emit(report)

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print_table(report)
    return 0


# ---------------------------------------------------------------------------
# Board definition
# ---------------------------------------------------------------------------
#
# The "SDLC - Stage 1 Plan" board, as data. Nothing in this file reads PANELS:
# it is the board spec, kept next to the emitter so the two cannot drift, and
# the creation path is the same one `nimeshjm/claude-otel-hooks` uses for its
# own board - configure the Honeycomb MCP server, then prompt Claude to read
# PANELS and create the board. No management key, no API client here.
#
# Two things a hand-built board gets wrong and this list exists to pin down:
#
#   `time_range` is per panel and is load-bearing. Emission is one snapshot per
#   day (see the module docstring), so a panel left on Honeycomb's 2h default
#   renders empty for roughly 22 hours out of every 24 - a board that looks
#   broken rather than one that looks empty. Every window here is at least 1d.
#
#   Every per-feature panel aggregates with MAX() and groups by sdlc.feature.
#   A re-run, a retry or a `workflow_dispatch` puts several identical rows in
#   the same window on purpose; MAX() over one feature's rows is idempotent
#   where COUNT() or SUM() would multiply by the number of runs that day.
#
# Four of these panels are not on the board yet, and creating their columns by
# hand is the wrong way to get them there. This script omits
# `sdlc.plan.lead_time_hours` and `sdlc.intent.survival_rate` rather than emit a
# fabricated zero, so while those columns do not exist Honeycomb enforces that
# for us: a query naming one is rejected outright. Create the column through the
# Columns API and the rejection turns into a rendered `0` - COUNT is 0 but P50
# and MAX both come back 0, so an "Intent lead time" panel shows a flat zero-hour
# line and "Survival rate" a flat 0%. That is the exact misreading the omission
# exists to prevent; the loud failure was the safety net. Measured on this
# dataset 2026-08-26 after creating both columns as `float`.
#
# So: leave those four off the board until a measurable feature lands and the
# columns fill themselves on the next emit. The board carries their specs as a
# text panel until then.
#
# Column names below are exactly the attribute names `_build_specs` emits.
# `npm run plan:metrics -- --json` prints the report those are mapped from, so
# a name can be checked offline without emitting anything.

BOARD_NAME = "SDLC · Stage 1 Plan"

BOARD_DESCRIPTION = (
    "Stage 1 (Plan) indicators from the AI-native SDLC playbook: leading = time "
    "from work-item creation to a committed intent.md; lagging = intent survival "
    "and the intent.md edits made after spec.md started. Dataset "
    f"{DATASET_NAME}, refreshed by one daily snapshot from "
    ".github/workflows/sdlc-metrics.yml."
)

PANELS: "list[dict[str, Any]]" = [
    {
        "name": "Intent lead time",
        "description": (
            "Work-item creation to committed intent.md, over the features whose "
            "lead time is defined. The 24h marker is the target, not a "
            "threshold anything alerts on."
        ),
        "chart_type": "line",
        "time_range": "1d",
        "query": {
            "calculations": [
                {"op": "HEATMAP", "column": "sdlc.plan.lead_time_hours"},
                {"op": "P50", "column": "sdlc.plan.lead_time_hours"},
                {"op": "P95", "column": "sdlc.plan.lead_time_hours"},
            ],
            "filters": [
                {"column": "name", "op": "=", "value": "sdlc.plan.snapshot"},
                {"column": "sdlc.measurable", "op": "=", "value": True},
            ],
        },
        # chart_index 1 = the P50 calculation; a marker on the HEATMAP would
        # have nothing to sit against.
        "thresholds": [
            {
                "value": 24,
                "operation": "gt",
                "color": "yellow",
                "line_style": "dotted",
                "label": "24h",
                "chart_index": 1,
            }
        ],
    },
    {
        "name": "Recent intents only",
        "description": (
            "Same lead time, restricted to intents committed in the last 90 "
            "days. sdlc.intent.age_days is what recovers a trend from spans "
            "that are all stamped `now` - see the module docstring."
        ),
        "chart_type": "line",
        "time_range": "1d",
        "query": {
            "calculations": [
                {"op": "HEATMAP", "column": "sdlc.plan.lead_time_hours"},
                {"op": "P50", "column": "sdlc.plan.lead_time_hours"},
                {"op": "P95", "column": "sdlc.plan.lead_time_hours"},
            ],
            "filters": [
                {"column": "name", "op": "=", "value": "sdlc.plan.snapshot"},
                {"column": "sdlc.measurable", "op": "=", "value": True},
                {"column": "sdlc.intent.age_days", "op": "<", "value": 90},
            ],
        },
    },
    {
        "name": "Lead time by feature",
        "description": (
            "One row per feature. Features reporting measurable=false are "
            "absent by construction: no lead_time_hours attribute is emitted "
            "for them, so they cannot show as 0."
        ),
        "chart_type": "none",
        "display_style": "table",
        "time_range": "1d",
        "query": {
            "calculations": [{"op": "MAX", "column": "sdlc.plan.lead_time_hours"}],
            "filters": [
                {"column": "name", "op": "=", "value": "sdlc.plan.snapshot"},
                {"column": "sdlc.measurable", "op": "=", "value": True},
            ],
            "breakdowns": ["sdlc.feature"],
            "orders": [{"op": "MAX", "column": "sdlc.plan.lead_time_hours",
                        "order": "descending"}],
        },
    },
    {
        "name": "Intent funnel",
        "description": (
            "Accepted / rejected / open, read off the gate:intent issues. Raw "
            "counters, deliberately - a 7d window so a missed daily run still "
            "leaves the last known state on the board."
        ),
        "chart_type": "bar",
        "time_range": "7d",
        "query": {
            "calculations": [
                {"op": "MAX", "column": "sdlc.intent.accepted_count"},
                {"op": "MAX", "column": "sdlc.intent.rejected_count"},
                {"op": "MAX", "column": "sdlc.intent.open_count"},
            ],
            "filters": [{"column": "name", "op": "=", "value": "sdlc.plan.rollup"}],
        },
    },
    {
        "name": "Survival rate",
        "description": (
            "accepted / (accepted + rejected), computed in the script and "
            "emitted as a scalar. Expect noise: below ~5 decided intents one "
            "decision swings this between 0 and 1, and intents authored and "
            "approved by the same person make it near-tautological. Read the "
            "funnel counters above first."
        ),
        "chart_type": "line",
        "time_range": "90d",
        "query": {
            "calculations": [{"op": "MAX", "column": "sdlc.intent.survival_rate"}],
            "filters": [{"column": "name", "op": "=", "value": "sdlc.plan.rollup"}],
        },
    },
    {
        "name": "Post-spec intent churn",
        "description": (
            "intent.md commits landing after spec.md started, per feature. The "
            "one number here that means something at n=1: a non-zero bar is "
            "rework that a Stage 1 gate did not catch."
        ),
        "chart_type": "bar",
        "display_style": "combo",
        "time_range": "1d",
        "query": {
            "calculations": [{"op": "MAX", "column": "sdlc.intent.post_spec_edits"}],
            "filters": [{"column": "name", "op": "=", "value": "sdlc.plan.snapshot"}],
            "breakdowns": ["sdlc.feature"],
            "orders": [{"op": "MAX", "column": "sdlc.intent.post_spec_edits",
                        "order": "descending"}],
        },
        "thresholds": [
            {
                "value": 0,
                "operation": "gt",
                "color": "red",
                "line_style": "solid",
                "label": "rework",
            }
        ],
    },
]

PRESET_FILTERS = [
    {"column": "sdlc.feature", "alias": "Feature"},
    {"column": "sdlc.intent.outcome", "alias": "Outcome"},
    {"column": "sdlc.t0.source", "alias": "t0 source"},
]

# Created separately from the board - a trigger needs a recipient, which is an
# account-level choice this file has no business guessing. Frequency is daily
# because the data is: anything faster just re-reads the same snapshot.
TRIGGER = {
    "name": "Intent edited after its spec started",
    "description": (
        "An intent.md commit landed after spec.md's first commit for the same "
        "feature. That is the Stage 1 rework signal - the gate approved an "
        "intent that turned out not to be settled."
    ),
    "dataset": DATASET_NAME,
    "frequency": 86400,
    "query": {
        "calculations": [{"op": "MAX", "column": "sdlc.intent.post_spec_edits"}],
        "filters": [{"column": "name", "op": "=", "value": "sdlc.plan.snapshot"}],
        "breakdowns": ["sdlc.feature"],
    },
    "threshold": {"op": ">", "value": 0},
}


# ---------------------------------------------------------------------------
# Board definition - Stage 2 (Design), issue #42
# ---------------------------------------------------------------------------
#
# The "SDLC - Stage 2 Design" board, same convention as PANELS/BOARD_NAME/
# TRIGGER above: spec-in-file next to the emitter, nothing in this file reads
# it, created (when it is created) by pointing the Honeycomb MCP server at
# this list.
#
# Do NOT create this board yet - but the reason splits by panel, and issue #42
# understated that split, so it is corrected here rather than carried forward
# stale. Both Stage 2 numbers are per-feature (see the module docstring's "Why
# there is no `sdlc.design.rollup`" note), and today only one feature exists:
#
#   "Design lead time", "Recent designs only" and "Lead time by feature" all
#   query `sdlc.design.lead_time_hours`, which is NEVER emitted while every
#   feature is `design_measurable = false` - 001 is, by construction (its
#   intent and spec share a bootstrap commit). Creating that column by hand to
#   get these three panels to render reproduces #29's measured failure mode
#   exactly: P50/MAX come back a fabricated `0` instead of "no data". These
#   three wait for feature 002's spec to land.
#
#   "Post-plan spec churn" and "Build not started" query
#   `sdlc.spec.post_plan_edits` and `sdlc.design.anchor_source`, and BOTH are
#   real today: 001 emits `spec_post_plan_edits` (a real, positive count) and
#   `anchor_source = "plan-filled"` right now (`npm run plan:metrics -- --json`
#   proves it - see features/README.md's "Measuring stage 2" section for the
#   current number). These two panels are safe to put on the board today; they
#   are listed here rather than created early only to keep this board's rollout
#   as one change instead of two.
#
# Column names below are exactly the attribute names `_build_specs` emits for
# `sdlc.design.snapshot` - `npm run plan:metrics -- --json` prints the report
# those are mapped from.
#
# Every query below MUST filter on `name = sdlc.design.snapshot`: `sdlc.measurable`
# and `sdlc.feature` are emitted on the Stage 1 span too, with a different meaning
# on each, so a panel that forgets this filter silently mixes Stage 1 and Stage 2
# rows into one query rather than erroring. plan_metrics_test.py's
# panel/emitter-consistency row enforces this for every entry in this list; a
# panel hand-built in the Honeycomb UI later has no such guard, which is why it
# is written down here too.

BOARD_NAME_DESIGN = "SDLC · Stage 2 Design"

BOARD_DESCRIPTION_DESIGN = (
    "Stage 2 (Design) indicators from the AI-native SDLC playbook: leading = "
    "elapsed time between a filled intent.md and a filled spec.md; lagging = "
    "spec.md commits landing after plan.md first diverged from the template "
    "(requirements rework after a build started). Pure git - no `gh` call, no "
    f"label. Dataset {DATASET_NAME}, refreshed by the same daily snapshot as "
    "the Stage 1 board, from .github/workflows/sdlc-metrics.yml."
)

PANELS_DESIGN: "list[dict[str, Any]]" = [
    {
        "name": "Design lead time",
        "description": (
            "Filled intent.md to filled spec.md, over the features whose "
            "design lead time is defined. Empty until a measurable feature "
            "exists - see the comment above this list."
        ),
        "chart_type": "line",
        "time_range": "1d",
        "query": {
            "calculations": [
                {"op": "HEATMAP", "column": "sdlc.design.lead_time_hours"},
                {"op": "P50", "column": "sdlc.design.lead_time_hours"},
                {"op": "P95", "column": "sdlc.design.lead_time_hours"},
            ],
            "filters": [
                {"column": "name", "op": "=", "value": "sdlc.design.snapshot"},
                {"column": "sdlc.measurable", "op": "=", "value": True},
            ],
        },
    },
    {
        "name": "Recent designs only",
        "description": (
            "Same lead time, restricted to specs committed in the last 90 "
            "days. sdlc.spec.age_days is what recovers a trend from spans "
            "that are all stamped `now` - see the module docstring."
        ),
        "chart_type": "line",
        "time_range": "1d",
        "query": {
            "calculations": [
                {"op": "HEATMAP", "column": "sdlc.design.lead_time_hours"},
                {"op": "P50", "column": "sdlc.design.lead_time_hours"},
                {"op": "P95", "column": "sdlc.design.lead_time_hours"},
            ],
            "filters": [
                {"column": "name", "op": "=", "value": "sdlc.design.snapshot"},
                {"column": "sdlc.measurable", "op": "=", "value": True},
                {"column": "sdlc.spec.age_days", "op": "<", "value": 90},
            ],
        },
    },
    {
        "name": "Lead time by feature",
        "description": (
            "One row per feature. Features reporting design_measurable=false "
            "are absent by construction: no design.lead_time_hours attribute "
            "is emitted for them, so they cannot show as 0."
        ),
        "chart_type": "none",
        "display_style": "table",
        "time_range": "1d",
        "query": {
            "calculations": [{"op": "MAX", "column": "sdlc.design.lead_time_hours"}],
            "filters": [
                {"column": "name", "op": "=", "value": "sdlc.design.snapshot"},
                {"column": "sdlc.measurable", "op": "=", "value": True},
            ],
            "breakdowns": ["sdlc.feature"],
            "orders": [{"op": "MAX", "column": "sdlc.design.lead_time_hours",
                        "order": "descending"}],
        },
    },
    {
        "name": "Post-plan spec churn",
        "description": (
            "spec.md commits landing after plan.md first diverged from the "
            "template, per feature - real today, unlike the three lead-time "
            "panels above: a feature needs no design_measurable=true to have "
            "a plan-filled anchor and a churn count. A non-zero bar is "
            "rework that a Stage 2 gate did not catch; per features/README.md "
            "'when implementation reveals the spec was wrong, update spec.md "
            "in the same pull request', a non-zero count here is not "
            "automatically a process failure."
        ),
        "chart_type": "bar",
        "display_style": "combo",
        "time_range": "1d",
        "query": {
            "calculations": [{"op": "MAX", "column": "sdlc.spec.post_plan_edits"}],
            "filters": [{"column": "name", "op": "=", "value": "sdlc.design.snapshot"}],
            "breakdowns": ["sdlc.feature"],
            "orders": [{"op": "MAX", "column": "sdlc.spec.post_plan_edits",
                        "order": "descending"}],
        },
        "thresholds": [
            {
                "value": 0,
                "operation": "gt",
                "color": "red",
                "line_style": "solid",
                "label": "rework",
            }
        ],
    },
    {
        "name": "Build not started",
        "description": (
            "Count of features by design_anchor_source. Real today, like the "
            "churn panel above. Exists so an empty-looking churn panel reads "
            "as 'no builds have started yet' (anchor_source=none) rather than "
            "'no data' (a missing panel or a broken query) - the two look "
            "identical without this."
        ),
        "chart_type": "bar",
        "time_range": "1d",
        "query": {
            "calculations": [{"op": "COUNT"}],
            "filters": [{"column": "name", "op": "=", "value": "sdlc.design.snapshot"}],
            "breakdowns": ["sdlc.design.anchor_source"],
        },
    },
]

# Created separately from the board - same reason as TRIGGER above: a trigger
# needs a recipient, an account-level choice this file has no business
# guessing.
TRIGGER_DESIGN = {
    "name": "Spec edited after its plan started",
    "description": (
        "A spec.md commit landed after plan.md's first FILLED commit for the "
        "same feature. That is the Stage 2 rework signal - implementation "
        "revealed the spec was wrong after the build (plan.md) had already "
        "started. Real today, unlike the Stage 2 lead-time trigger this board "
        "does not yet have."
    ),
    "dataset": DATASET_NAME,
    "frequency": 86400,
    "query": {
        "calculations": [{"op": "MAX", "column": "sdlc.spec.post_plan_edits"}],
        "filters": [{"column": "name", "op": "=", "value": "sdlc.design.snapshot"}],
        "breakdowns": ["sdlc.feature"],
    },
    "threshold": {"op": ">", "value": 0},
}


if __name__ == "__main__":
    sys.exit(main())
