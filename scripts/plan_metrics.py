#!/usr/bin/env python3
"""
plan_metrics.py - Stage 1 (Plan) SDLC extractor: git + GitHub -> OTLP -> Honeycomb.

See issue #29 for the full design. This docstring carries the decisions that aren't
obvious from the code alone - the things a future reader (or reviewer) would otherwise
have to re-derive or, worse, "fix".

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

Why two span names, sibling not parent-child
    `sdlc.plan.snapshot` (one per feature) and `sdlc.plan.rollup` (one per run) are
    emitted as independent root spans in a single `emit_spans(specs)` call, with no
    `session_id`/`turn_id` - that's the exact "standalone root span" degradation
    `otel_span.emit_spans` already implements when `turn_id` is empty. Every board
    widget queries by `name` alone; a parent-child link would buy nothing and would
    cost explicit context propagation plus span end-ordering for no benefit.

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

Why the git walk uses `--follow -M25% --diff-filter=A`, not a plain `--follow`
    `features/README.md` mandates renumbering, so a feature directory can be
    renamed after it's created - and the rename commit can also rewrite the file's
    contents (e.g. resolving open questions in intent.md at the same time it's
    renumbered). `--follow`'s rename detector uses git's ordinary similarity
    threshold (50% by default), and once a rename's content changes enough to fall
    below that threshold, the detector declines to pair old-path -> new-path, the
    follow chain loses the trail, and the *rename* commit is mistaken for the
    *creation* commit - understating lead time by the whole gap between them.
    Measured directly (true creation 2026-01-01, `git mv` + rewrite on 2026-03-01):

        rename commit contents          | default -M | -M25%           | orphan D?
        ---------------------------------|-----------|-----------------|----------
        pure `git mv`, no content change | correct   | correct         | no
        `git mv` + 65% lines rewritten   | WRONG     | correct         | no (paired)
        `git mv` + 100% rewritten        | wrong     | wrong, unresolvable | yes

    `-M25%` lowers the pairing threshold enough to correctly resolve the 65% case.
    It does not (cannot) resolve 100%-rewritten renames - git has no signal left to
    pair on - but that failure mode is now *detectable*: when `--follow` can't pair
    a rename, the resulting "creation" commit's diff still carries an orphaned `D`
    on some *other* `features/*/intent.md` in the very same commit (the deletion
    half of the unpaired rename). `resolve_creation()` below checks for exactly
    that and reports `t1_source = "follow-unresolved"` instead of `"follow"`; the
    caller then refuses to trust the date and reports the feature unmeasurable
    rather than emit a number that might be wrong by weeks. `-M25%` did not
    false-pair against `features/_template/intent.md` in manual testing, so the
    low threshold is safe on this tree. With `-M25%` in place, `--diff-filter=A`
    is safe to use directly (it wasn't at the default threshold, because the
    unpaired-rename "add" entry the filter selects is exactly the wrong commit) -
    so the git-log invocation for `t1` is the simpler `--diff-filter=A` form, and a
    separate `--name-status` walk (no filter) supplies the full commit list
    `post_spec_edits` needs.

    Known false positive, accepted deliberately: a commit that renames one feature
    directory *and* creates a different feature's intent.md in the same commit
    also carries an orphaned `D` (the old feature's path, unrelated to the new
    feature) and would mark the new feature `follow-unresolved` even though its
    own `t1` was never in doubt. This fails in the conservative direction -
    `measurable: false` and no number emitted, rather than a wrong number - which
    is the correct side to be wrong on, so it ships as-is.

Why `post_spec_edits` mixes an author date and a committer date
    Per the spec: commits touching `intent.md` whose *committer* date is strictly
    after `spec_t0`, where `spec_t0` is spec.md's first-add commit's *author* date.
    That's deliberate, not a typo to "fix" to one clock: author date is when the
    spec's content was actually written (the right anchor for "after the spec
    started"), while committer date is when a commit actually landed in history -
    including rebases and amends - which is the right clock for "was this intent
    edit real churn that happened after that point in the recorded history".

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

# A `D` on some *other* feature's intent.md inside the commit resolve_creation()
# picked as an "add" - the signature of a rename --follow could not pair (see the
# module docstring). Anchored to intent.md specifically, matching what
# resolve_creation() is ever asked to resolve.
ORPHAN_D_RE = re.compile(r"^D\tfeatures/[^/]+/intent\.md$")

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


def resolve_creation(root: str, rel_path: str) -> "tuple[datetime.datetime, str, str, str] | None":
    """Resolve the commit that first adds `rel_path`, chasing renames.

    Returns (author_date, author_name, sha, t1_source), or None when the path has
    never been committed. `t1_source` is "follow" when the resolution looks
    trustworthy, or "follow-unresolved" when an orphaned `D` on a *different*
    feature's intent.md turns up in the same commit - the signature of a rename
    `--follow` could not pair even at `-M25%` (see the module docstring). Callers
    must not trust the returned date when `t1_source == "follow-unresolved"`.
    """
    output = run_git(
        root, "log", "--follow", FOLLOW_SIMILARITY, "--diff-filter=A",
        "--format=%H%x09%aI%x09%an", "--", rel_path,
    )
    if not output:
        return None
    lines = [line for line in output.split("\n") if line.strip()]
    if not lines:
        return None
    sha, author_date, author_name = lines[-1].split("\t", 2)  # oldest = last line

    t1_source = "follow"
    show_output = run_git(root, "show", "--name-status", "--format=", sha, "--", "features/")
    if show_output:
        for line in show_output.split("\n"):
            if ORPHAN_D_RE.match(line):
                t1_source = "follow-unresolved"
                break

    return parse_iso(author_date), author_name, sha, t1_source


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
    committer dates for `post_spec_edits`; `t1` itself comes from
    `resolve_creation()`, not from this list."""
    output = run_git(
        root, "log", "--follow", FOLLOW_SIMILARITY, "--name-status",
        "--format=C%x09%H%x09%aI%x09%cI%x09%an", "--", rel_path,
    )
    if output is None:
        return []
    return _parse_name_status_log(output)


def count_post_spec_edits(
    intent_records: "list[dict[str, Any]]", spec_t0: datetime.datetime
) -> int:
    """Commits touching intent.md whose COMMITTER date is strictly after spec_t0
    (spec.md's first-add commit's AUTHOR date). See the module docstring's note on
    why these are two different clocks on purpose."""
    return sum(1 for r in intent_records if parse_iso(r["committer_date"]) > spec_t0)


def compute_git_facts(root: str, feature_dir: str) -> "dict[str, Any] | None":
    """Everything this script can learn from git alone for one feature directory.

    Returns None when intent.md has never been committed (present on disk but not
    yet added to history - nothing to measure yet, not an error).
    """
    intent_rel = "/".join(("features", feature_dir, "intent.md"))
    spec_rel = "/".join(("features", feature_dir, "spec.md"))

    intent_creation = resolve_creation(root, intent_rel)
    if intent_creation is None:
        return None
    t1, intent_author, intent_sha, t1_source = intent_creation

    facts: "dict[str, Any]" = {
        "t1": t1,
        "intent_sha": intent_sha,
        "intent_author": intent_author,
        "t1_source": t1_source,
        "spec_committed_at": None,
        "spec_sha": None,
        "post_spec_edits": None,
    }

    spec_creation = resolve_creation(root, spec_rel)
    if spec_creation is not None:
        spec_t0, _spec_author, spec_sha, _spec_t1_source = spec_creation
        facts["spec_committed_at"] = spec_t0
        facts["spec_sha"] = spec_sha
        # Counted whether or not intent.md and spec.md share their first commit.
        # Issue #29 said to omit churn in the same-commit case on the grounds that
        # it is "undefined too", but that conflates two independent things: the
        # *lead time* is undefined there (see `measurable` below), the churn is
        # not. spec_t0 is a real timestamp either way, and "intent commits
        # strictly after it" is a real count either way. Feature 001 is the case
        # that settled it: its artifacts share the bootstrap commit, and 706ea65
        # then edited intent.md the next day. That is exactly the rework the
        # board's `MAX(sdlc.intent.post_spec_edits) > 0` trigger exists to catch,
        # and omitting it would hide the one signal that means anything at n=1.
        # post_spec_edits stays None only when there is no spec.md at all - the
        # case that genuinely has no baseline to measure from.
        intent_records = git_path_history(root, intent_rel)
        facts["post_spec_edits"] = count_post_spec_edits(intent_records, spec_t0)

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
    """Assemble one feature's report record, or None if it has no committed
    intent.md yet (see compute_git_facts)."""
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
    if outcome is not None:
        record["intent_outcome"] = outcome
    if facts["post_spec_edits"] is not None:
        record["intent_post_spec_edits"] = facts["post_spec_edits"]
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
    feature, issue, measurable, t0, t0_source, intent_author, intent_committed_at,
    intent_age_days, intent_t1_source, lead_time_hours, spec_committed_at,
    intent_outcome, intent_post_spec_edits.

    Omitted means the key is absent, never null and never a fabricated 0 - see the
    module docstring's note on why feature 001 must report unmeasurable rather than
    a 0-hour lead time / 0 post-spec edits. `intent_t1_source` is the one field
    that is always present, even when unmeasurable: it is "follow" or
    "follow-unresolved", never absent, since it is what a reader would need to
    understand *why* a feature reports unmeasurable when the guard responsible is
    the rename-detection one rather than a missing t0.
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
    """One sdlc.plan.snapshot spec per feature, plus one sdlc.plan.rollup spec -
    exactly the attribute names from issue #29, nothing extra."""
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
            "Stage 1 (Plan) SDLC extractor: git + GitHub -> optional OTLP export "
            "to Honeycomb. Default is compute-and-print; --emit is the only path "
            "that ships spans."
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


if __name__ == "__main__":
    sys.exit(main())
