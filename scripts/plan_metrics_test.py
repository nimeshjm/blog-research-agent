#!/usr/bin/env python3
"""Mutation self-test for scripts/plan_metrics.py. See issue #29, and
scripts/review-checks.test.mjs, which this file ports the harness shape of.

The extractor passing on HEAD proves nothing, because HEAD has exactly one
degenerate feature (001-scheduled-research-drafts, whose own docstring note in
plan_metrics.py explains why it is deliberately unmeasurable: intent.md and
spec.md landed in one bootstrap commit, and its issues postdate that commit).
A checker that always reports "unmeasurable, no lead time, no churn" would
pass against HEAD whether or not any of its guards actually work. So every row
below copies the whole repo tree (including .git - real history is what
resolve_creation()/git_path_history() walk) into a fresh temp directory and
either mutates its git history directly (new commits, a git mv, a stubbed `gh`
on PATH) or, for row 0, changes nothing at all. Row 0 exists specifically to
prove the harness itself is not vacuously green before any other row's PASS is
trusted.

Each row then runs plan_metrics.py --json against its own copy and asserts on
specific fields of specific feature records (via `find`) using the
`expect_*` helpers, which append an OK/FAIL note to the row's own notes list
instead of raising - one row's failed assertion must not stop the rest of that
row's assertions from running, and must not abort the suite. Rows are
otherwise independent: a failure in row N never touches row N+1's fixture,
because each gets its own fresh copy of REPO_ROOT.

Why every git call here is hermetic
    Two separate routes let a row write through to the *real* repository, and
    both were live in this file until issue #31's fix was ported across from
    review-checks.test.mjs. First, in a linked worktree `.git` is a one-line
    `gitdir:` pointer rather than a directory, so copying the tree verbatim
    leaves every row's sandbox aimed at the shared gitdir and every `git commit`
    landing on the live branch of the worktree the suite was launched from - see
    copy_tree(). Second, git exports GIT_DIR (and GIT_WORK_TREE, GIT_INDEX_FILE,
    ...) to its hooks, and those override discovery outright, so under the
    pre-push hook every git call would target the real repository no matter its
    cwd - see env_without_git_vars(). Row 10 proves the first; the
    fingerprint backstop in main() catches any future regression of either.

Why `git commit -am` never appears here
    `-am` only stages files git already tracks; it silently skips untracked
    new files, which is exactly what every row's fixture is made of (a brand
    new features/002-*/intent.md). `commit()` below always runs `git add -A`
    first.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from typing import Any, Callable

# ---------------------------------------------------------------------------
# Module constants
# ---------------------------------------------------------------------------

# This file lives at <repo>/scripts/plan_metrics_test.py, so the repo root is
# two levels up from its own absolute path.
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The script under test, invoked as a subprocess (never imported) so that this
# harness exercises the exact same CLI surface CI does.
PLAN_METRICS = os.path.join(REPO_ROOT, "scripts", "plan_metrics.py")

# Directories copy_tree() prunes entirely rather than descending into. Matched
# at the exact relative path shown (not by substring), the same rule
# review-checks.test.mjs's copyTree filter uses.
#   - node_modules, .wrangler: build/tooling output, never read by git history
#     walks and irrelevant to every row here.
#   - .venv: 26 MB, and copy_tree() runs once per row - CLAUDE.md's own advice
#     to put the opentelemetry deps for plan_metrics.py's --emit path in a
#     venv means one shows up here as soon as anyone follows it.
COPY_TREE_SKIP_TOP_LEVEL = frozenset({"node_modules", ".wrangler", ".venv"})

# .claude/worktrees specifically (not all of .claude): an unrelated nested git
# worktree can live there on this machine, and copying it would confuse the
# git commands rows run against the copy (it is a *second*, independent
# working tree, not history belonging to this repo's .git).
COPY_TREE_SKIP_RELATIVE = frozenset({os.path.join(".claude", "worktrees")})

# The files git keeps per worktree rather than in the common dir. Everything
# else a row needs - objects, refs, packed-refs, config - is shared and comes
# across with the common dir. `commondir` and `gitdir` are deliberately absent:
# copying either one re-links the sandbox to the real repository and silently
# reintroduces the bug copy_tree()'s linked-worktree branch exists to prevent.
PER_WORKTREE_GIT_FILES = ("HEAD", "index", "ORIG_HEAD", "config.worktree")

# Every commit() call needs a real author/committer identity. A machine that
# has never run `git config --global user.email` (plausible for a fresh CI
# runner) would otherwise fail every commit in this suite, so the identity is
# supplied as explicit env vars rather than relying on any global git config.
GIT_TEST_IDENTITY = {
    "GIT_AUTHOR_NAME": "T",
    "GIT_AUTHOR_EMAIL": "t@t",
    "GIT_COMMITTER_NAME": "T",
    "GIT_COMMITTER_EMAIL": "t@t",
}

# The 40-line rename fixture rows 4a/4b/4c share. These fractions (0, 26, 40 of
# 40 lines rewritten in the same commit as a `git mv`) are validated, not
# guessed: 0% and 26% (65%) both correctly pair under plan_metrics.py's
# -M25% `--follow` threshold; 26% specifically also fails to pair under git's
# *default* 50% threshold, which is what makes 4b the row that actually
# exercises FOLLOW_SIMILARITY rather than duplicating 4a. 40 (100%) has no
# similarity signal left for git to pair on at any threshold. Do not change
# these numbers without re-validating the pairing behaviour directly - see
# plan_metrics.py's own module docstring for the measured table.
RENAME_FIXTURE_TOTAL_LINES = 40
RENAME_FIXTURE_REWRITE_FRACTIONS = {"pure": 0, "partial": 26, "full": 40}


# ---------------------------------------------------------------------------
# Filesystem / git plumbing
# ---------------------------------------------------------------------------


def env_without_git_vars() -> "dict[str, str]":
    """`os.environ` with the whole GIT_* family removed.

    git exports GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and friends to its hooks,
    and those override repository discovery outright: inherited into a child,
    they point every `git` call at the real repository regardless of its cwd.
    That reproduces only from a hook - running this suite by hand is clean -
    which is exactly what makes it worth stripping rather than trusting.

    Taken as a whole family for the same reason run_metrics() strips GITHUB_*
    as a family: enumerating the ones that matter today is a list that rots.
    """
    return {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}


def git_path(root: str, flag: str) -> "str | None":
    """`git rev-parse <flag>` in `root` as an absolute path, or None if git
    cannot answer (no git, or not a repository)."""
    result = subprocess.run(
        ["git", "rev-parse", "--path-format=absolute", flag],
        cwd=root,
        capture_output=True,
        text=True,
        env=env_without_git_vars(),
    )
    return result.stdout.strip() if result.returncode == 0 else None


def is_linked_worktree(root: str) -> bool:
    """True when `<root>/.git` is a gitdir *pointer file* rather than a
    directory, which is what git writes in a linked worktree."""
    return os.path.isfile(os.path.join(root, ".git"))


def copy_tree(src: str, dest: str) -> None:
    """Copy the whole repo tree from `src` to `dest`, including `.git` (every
    row needs real, walkable history), skipping COPY_TREE_SKIP_TOP_LEVEL and
    COPY_TREE_SKIP_RELATIVE entirely rather than merely not-recursing-into-them
    after the fact - shutil.copytree's `ignore` callback prunes the walk
    before it descends, so a 26 MB `.venv` is never even opened.

    Each row's sandbox has to be a *self-contained* repository: rows commit,
    `git mv` and rewrite history, and plan_metrics.py reads all of it back out.
    Copying the tree verbatim gives that in an ordinary checkout, where `.git`
    is a directory.

    In a linked worktree it does not. There `.git` is a one-line
    `gitdir: /repo/.git/worktrees/<name>` pointer, so a verbatim copy leaves
    every sandbox pointing at the real shared gitdir and every row's `git` call
    operating on the real repository - each fixture's commits landing on the
    live branch of the worktree this suite was launched from, and rows
    colliding with each other's history. That is issue #31 arriving in this
    file rather than in review-checks.test.mjs, whose copyTree() this mirrors.

    So when the source is a linked worktree, skip the pointer and materialise a
    standalone `.git` from the common dir, taking HEAD and the index from the
    worktree's own gitdir so the row still sees the state it was launched on.
    Row 10 proves that branch; assert_real_repo_untouched() in the runner is
    the backstop if it ever regresses.
    """
    linked = is_linked_worktree(src)

    def _ignore(current_dir: str, names: "list[str]") -> "set[str]":
        ignored: "set[str]" = set()
        for name in names:
            rel = os.path.relpath(os.path.join(current_dir, name), src)
            if rel in COPY_TREE_SKIP_TOP_LEVEL or rel in COPY_TREE_SKIP_RELATIVE:
                ignored.add(name)
            elif linked and rel == ".git":
                ignored.add(name)
        return ignored

    shutil.copytree(src, dest, ignore=_ignore)
    if not linked:
        return

    common_dir = git_path(src, "--git-common-dir")
    own_dir = git_path(src, "--git-dir")
    if not common_dir or not own_dir:
        raise RuntimeError(
            f"{src} has a gitdir pointer but git could not resolve it "
            f"(common={common_dir}, own={own_dir})"
        )

    dest_git = os.path.join(dest, ".git")

    def _ignore_worktrees(current_dir: str, names: "list[str]") -> "set[str]":
        # `worktrees/` holds the per-worktree gitdirs of every linked worktree,
        # each pointing back out at its own checkout. None of it belongs in a
        # standalone copy.
        return {
            name
            for name in names
            if os.path.relpath(os.path.join(current_dir, name), common_dir) == "worktrees"
        }

    shutil.copytree(common_dir, dest_git, ignore=_ignore_worktrees)

    for name in PER_WORKTREE_GIT_FILES:
        source = os.path.join(own_dir, name)
        target = os.path.join(dest_git, name)
        # Removing when the worktree has none is the half that matters: the
        # common dir carries the *main* checkout's HEAD and index, and
        # inheriting those would be a quieter version of the same bug.
        if os.path.exists(source):
            shutil.copyfile(source, target)
        elif os.path.exists(target):
            os.remove(target)


def write_file(root: str, rel: str, text: str) -> None:
    """Write `text` (UTF-8) to `<root>/<rel>`, creating parent directories as
    needed. Every fixture file a row writes goes through this one call site."""
    full = os.path.join(root, rel)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8") as handle:
        handle.write(text)


def git(root: str, args: "list[str]", extra_env: "dict[str, str] | None" = None) -> str:
    """Run `git <args>` in `root` (never inheriting GIT_*; see
    env_without_git_vars()), returning stdout. Raises with the real
    stderr on any non-zero exit: unlike plan_metrics.py's own run_git() (which
    treats a git failure as "nothing to report" downstream), a git command
    failing while a row is *building* its fixture is a broken test, not a
    finding, and must not be swallowed.
    """
    # Always start from a GIT_*-free environment, then let `extra_env` put back
    # the GIT_* vars a caller actually means (commit()'s pinned dates and
    # identity). Inheriting the family wholesale would let a hook's GIT_DIR
    # redirect this call at the real repository - see env_without_git_vars().
    env = env_without_git_vars()
    if extra_env:
        env.update(extra_env)
    result = subprocess.run(
        ["git", *args], cwd=root, capture_output=True, text=True, env=env
    )
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed in {root}: {result.stderr}")
    return result.stdout


def commit(root: str, message: str, when: str) -> None:
    """`git add -A` (see the module docstring's note on why never `-am`)
    followed by a commit whose AUTHOR and COMMITTER dates are both pinned to
    `when` (an ISO8601 string like "2026-02-01T00:00:00Z"). Pinning both
    matters: plan_metrics.py reads t1/spec_committed_at off the author date
    and post_spec_edits off the committer date (see its module docstring's
    "Why post_spec_edits mixes an author date and a committer date"), so
    leaving either one on the wall clock would make timing assertions
    (row 1's `== 24.0`) flaky instead of exact.
    """
    git(root, ["add", "-A"])
    git(
        root,
        ["commit", "-q", "-m", message],
        extra_env={
            "GIT_AUTHOR_DATE": when,
            "GIT_COMMITTER_DATE": when,
            **GIT_TEST_IDENTITY,
        },
    )


def write_gh_stub(
    root: str, feature_num: str, issues: "list[dict[str, Any]]"
) -> "dict[str, str]":
    """Write an executable stub `gh` into `<root>/.fake-bin/gh` that answers
    `gh issue list --label feature:<feature_num> ...` with `issues` as a JSON
    array, and every OTHER feature label with an empty array, then exits 0.
    Mirrors scripts/review-checks.test.mjs's row 13 stub-gh-on-PATH pattern.

    Scoping by feature_num matters: every row's copied tree still carries
    features/001-scheduled-research-drafts, so plan_metrics.py fetches issues
    for feature 001 too (see its module docstring's "Why GitHub issues are
    fetched once per feature and filtered client-side" note - one
    `gh issue list --label feature:<NNN>` call per feature). An unscoped stub
    that answered every call identically would hand feature 001 the SAME
    fabricated gate:intent issue built for this row's feature under test,
    silently doubling rollup counts like accepted_count. Matching the literal
    substring "feature:<feature_num>" against the whole argv (a shell `case`
    on "$*") is enough, since plan_metrics.py's only call shape is
    `--label feature:<NNN>`, never a compound label expression.

    Returns the `extra_env` dict a caller passes to run_metrics() so that
    `gh`, which plan_metrics.py invokes by bare name (see its module
    docstring), resolves to this stub first via ordinary PATH lookup.
    """
    bin_dir = os.path.join(root, ".fake-bin")
    os.makedirs(bin_dir, exist_ok=True)
    gh_path = os.path.join(bin_dir, "gh")
    payload = json.dumps(issues)
    label = f"feature:{feature_num}"
    with open(gh_path, "w", encoding="utf-8") as handle:
        handle.write("#!/bin/sh\n")
        handle.write('case "$*" in\n')
        handle.write(f"  *{label}*) printf '%s' '{payload}' ;;\n")
        handle.write("  *) printf '%s' '[]' ;;\n")
        handle.write("esac\n")
        handle.write("exit 0\n")
    os.chmod(gh_path, 0o755)
    return {"PATH": bin_dir + os.pathsep + os.environ.get("PATH", "")}


def run_metrics(
    root: str,
    extra_args: "tuple[str, ...]" = (),
    extra_env: "dict[str, str] | None" = None,
) -> "dict[str, Any]":
    """Run `plan_metrics.py --root <root> --json <extra_args>` as a subprocess
    and return its parsed stdout.

    Uses `sys.executable`, never the bare string "python3": on this machine
    bare `python3` is 3.9.6, and plan_metrics.py hard-exits 2 below 3.14, so
    the entire suite would fail on a version guard rather than on anything
    this test is actually meant to check.

    Strips every GITHUB_* and GIT_* var from the child's environment before
    applying `extra_env`, for the same hermeticity reason
    scripts/review-checks.test.mjs's runChecker() does: this suite must behave
    identically on a laptop and inside the outer CI job that might itself be
    running under GITHUB_ACTIONS=true.

    Raises RuntimeError - carrying the child's real stdout AND stderr, so a
    plan_metrics.py crash surfaces as its own traceback rather than as an
    opaque JSONDecodeError from this function - if stdout isn't valid JSON, or
    if the process exited non-zero despite printing JSON.
    """
    cmd = [sys.executable, PLAN_METRICS, "--root", root, "--json", *extra_args]
    # GIT_* as well as GITHUB_*: plan_metrics.py shells out to git, so a hook's
    # inherited GIT_DIR would point the extractor at the real repository rather
    # than at `--root`. See env_without_git_vars().
    env = {k: v for k, v in env_without_git_vars().items() if not k.startswith("GITHUB_")}
    if extra_env:
        env.update(extra_env)
    result = subprocess.run(cmd, capture_output=True, text=True, env=env)
    try:
        parsed = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"plan_metrics.py did not print valid JSON (exit {result.returncode}).\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}"
        ) from exc
    if result.returncode != 0:
        raise RuntimeError(
            f"plan_metrics.py exited {result.returncode} despite printing JSON.\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}"
        )
    return parsed


def find(report: "dict[str, Any]", feature_prefix: str) -> "dict[str, Any] | None":
    """Pull one feature record out of report['features'] by name prefix (e.g.
    "002" matches "002-synth"). None if no matching record exists."""
    for feature in report.get("features", []):
        if feature.get("feature", "").startswith(feature_prefix):
            return feature
    return None


# ---------------------------------------------------------------------------
# Assertion helpers - append an OK/FAIL note, never raise, return the result
# ---------------------------------------------------------------------------


def expect_eq(notes: "list[str]", label: str, actual: Any, expected: Any) -> bool:
    """Assert actual == expected. Returns the boolean so a row can fold it
    into its own running `ok` without early-exiting - every assertion in a row
    still executes and reports, even after an earlier one has already
    failed."""
    ok = actual == expected
    if ok:
        notes.append(f"OK: {label} == {expected!r}")
    else:
        notes.append(f"FAIL: {label} expected {expected!r}, got {actual!r}")
    return ok


def expect_absent(notes: "list[str]", label: str, mapping: "dict[str, Any]", key: str) -> bool:
    """Assert `key` is not a key in `mapping` at all - absent, not
    present-with-value-None. build_feature() never emits an explicit null for
    an undefined field (see plan_metrics.py's module docstring); a present key
    with any value, including 0 or False, fails this."""
    ok = key not in mapping
    if ok:
        notes.append(f"OK: {label} is absent")
    else:
        notes.append(f"FAIL: {label} expected absent, got {mapping[key]!r}")
    return ok


def expect_present(notes: "list[str]", label: str, mapping: "dict[str, Any]", key: str) -> bool:
    """Assert `key` is a key in `mapping`, regardless of its value."""
    ok = key in mapping
    if ok:
        notes.append(f"OK: {label} is present ({mapping[key]!r})")
    else:
        notes.append(f"FAIL: {label} expected to be present, was absent")
    return ok


def expect_close(
    notes: "list[str]", label: str, actual: "float | None", expected: float, tol: float = 1e-6
) -> bool:
    """Float assertion within `tol`, for values reached via floating-point
    division where exact equality would be fragile. Row 1's lead_time_hours is
    deliberately NOT run through this - it lands on exactly 24.0 by
    construction and is asserted with expect_eq instead, to keep that
    assertion exact rather than a tolerance range."""
    ok = actual is not None and abs(actual - expected) <= tol
    if ok:
        notes.append(f"OK: {label} ~= {expected!r} (got {actual!r})")
    else:
        notes.append(f"FAIL: {label} expected ~= {expected!r} (tol {tol}), got {actual!r}")
    return ok


def expect_true(notes: "list[str]", label: str, condition: bool) -> bool:
    """Assert an arbitrary, already-evaluated boolean condition - for checks
    that don't reduce to a single actual/expected pair, e.g. "no negative
    number appears anywhere in this record"."""
    if condition:
        notes.append(f"OK: {label}")
    else:
        notes.append(f"FAIL: {label}")
    return condition


def _contains_negative_number(value: Any) -> bool:
    """Recursively scan a JSON-shaped value (a feature record, or any part of
    one) for a negative int/float leaf. `bool` is deliberately excluded even
    though Python's `bool` is an `int` subclass - True/False are never a
    magnitude and must not trip this."""
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return value < 0
    if isinstance(value, dict):
        return any(_contains_negative_number(v) for v in value.values())
    if isinstance(value, list):
        return any(_contains_negative_number(v) for v in value)
    return False


# ---------------------------------------------------------------------------
# Rename fixture (rows 4a/4b/4c)
# ---------------------------------------------------------------------------


def _build_rename_fixture(root: str, rewritten: int) -> None:
    """Build the features/002-old -> features/002-new rename fixture: a
    40-line intent.md is added and committed at 2026-01-01, then `git mv`'d to
    the renumbered directory and committed again at 2026-03-01, rewriting the
    first `rewritten` of its 40 lines in that same rename commit (see
    RENAME_FIXTURE_REWRITE_FRACTIONS for the validated values this is ever
    called with).
    """
    original_lines = [
        f"original line {i} about the intent" for i in range(RENAME_FIXTURE_TOTAL_LINES)
    ]
    write_file(root, "features/002-old/intent.md", "\n".join(original_lines) + "\n")
    commit(root, "add intent", "2026-01-01T00:00:00Z")

    git(root, ["mv", "features/002-old", "features/002-new"])
    rewritten_lines = list(original_lines)
    for i in range(rewritten):
        rewritten_lines[i] = f"TOTALLY different row {i}"
    write_file(root, "features/002-new/intent.md", "\n".join(rewritten_lines) + "\n")
    commit(root, "renumber", "2026-03-01T00:00:00Z")


def _check_t1_source(notes: "list[str]", feature: "dict[str, Any]", expected: str) -> bool:
    """Assert intent_t1_source directly. The field is always present -
    "follow" or "follow-unresolved" - never absent, even when the feature is
    otherwise unmeasurable (see plan_metrics.py's module docstring / the
    build_report() docstring's note on why)."""
    return expect_eq(notes, "intent_t1_source", feature.get("intent_t1_source"), expected)


# ---------------------------------------------------------------------------
# Rows
# ---------------------------------------------------------------------------


def row_0(root: str) -> "tuple[bool, list[str]]":
    """Baseline: HEAD's real content and history, no mutation at all. Proves
    the harness itself is not vacuously green before any other row's PASS is
    trusted - see the module docstring's opening paragraph."""
    notes: "list[str]" = []
    report = run_metrics(root, extra_args=("--no-github",))
    notes.append("OK: run_metrics succeeded (implies exit 0)")

    feature = find(report, "001")
    if feature is None:
        notes.append("FAIL: feature 001 not found in report")
        return False, notes

    ok = True
    ok = expect_eq(notes, "001.measurable", feature.get("measurable"), False) and ok
    ok = expect_eq(notes, "001.t0_source", feature.get("t0_source"), "none") and ok
    ok = expect_absent(notes, "001.lead_time_hours", feature, "lead_time_hours") and ok
    # 001's artifacts share the bootstrap commit, which withholds its lead time -
    # but 706ea65 edited intent.md afterwards, so its churn is real and must be
    # reported. Asserted as ">= 1 and present" rather than an exact count on
    # purpose: this row reads the live repo, and the next edit to that file would
    # otherwise turn a correct number into a red row.
    churn = feature.get("intent_post_spec_edits")
    ok = (
        expect_true(
            notes,
            f"001.intent_post_spec_edits is present and >= 1 (got {churn!r}) - the "
            "shared first commit withholds the lead time, not the churn",
            isinstance(churn, int) and not isinstance(churn, bool) and churn >= 1,
        )
        and ok
    )
    ok = (
        expect_true(
            notes,
            "no feature record whose name starts with '_' anywhere in the report",
            all(not f.get("feature", "").startswith("_") for f in report.get("features", [])),
        )
        and ok
    )
    return ok, notes


def row_1(root: str) -> "tuple[bool, list[str]]":
    """features/002-synth: intent.md, then spec.md, then an intent.md edit -
    three separate commits with exact hour-precision timestamps, so
    lead_time_hours and intent_post_spec_edits both compute off real history
    rather than off wall-clock. Runs WITH github (no --no-github): a stubbed
    `gh` on PATH answers one feature:002 issue filed exactly 24h before the
    intent commit.
    """
    notes: "list[str]" = []
    write_file(root, "features/002-synth/intent.md", "intent v1\n")
    commit(root, "add intent", "2026-02-01T00:00:00Z")
    write_file(root, "features/002-synth/spec.md", "spec v1\n")
    commit(root, "add spec", "2026-02-03T00:00:00Z")
    write_file(root, "features/002-synth/intent.md", "intent v1\nedited after spec\n")
    commit(root, "edit intent after spec started", "2026-02-05T00:00:00Z")

    extra_env = write_gh_stub(
        root,
        "002",
        [
            {
                "number": 101,
                "createdAt": "2026-01-31T00:00:00Z",
                "state": "OPEN",
                "stateReason": None,
                "labels": [],
            }
        ],
    )
    report = run_metrics(root, extra_args=(), extra_env=extra_env)
    feature = find(report, "002")
    if feature is None:
        notes.append("FAIL: feature 002 not found in report")
        return False, notes

    ok = True
    # Exact, not a tolerance range: 2026-01-31T00:00:00Z -> 2026-02-01T00:00:00Z
    # is exactly 24 hours by construction.
    ok = expect_eq(notes, "002.lead_time_hours", feature.get("lead_time_hours"), 24.0) and ok
    ok = (
        expect_eq(notes, "002.intent_post_spec_edits", feature.get("intent_post_spec_edits"), 1)
        and ok
    )
    ok = expect_eq(notes, "002.measurable", feature.get("measurable"), True) and ok
    ok = expect_eq(notes, "002.t0_source", feature.get("t0_source"), "issue") and ok
    return ok, notes


def row_2(root: str) -> "tuple[bool, list[str]]":
    """features/002-synth with intent.md AND spec.md added in the SAME commit, then
    one later edit to intent.md.

    Sharing a first commit suppresses the *lead time* (see row 3 for why - the
    guards are about t0) but must NOT suppress the churn count. spec_t0 is a real
    timestamp even when it equals t1, and an intent edit after it is real rework.
    Feature 001 is the live case: bootstrap commit 7c14ea0 carries both artifacts
    and 706ea65 edited intent.md afterwards, which is precisely what the board's
    MAX(sdlc.intent.post_spec_edits) > 0 trigger watches for. Issue #29 originally
    specified omitting it here; that was wrong and this row is what pins the
    correction."""
    notes: "list[str]" = []
    write_file(root, "features/002-synth/intent.md", "intent v1\n")
    write_file(root, "features/002-synth/spec.md", "spec v1\n")
    commit(root, "add intent and spec together", "2026-02-01T00:00:00Z")
    write_file(root, "features/002-synth/intent.md", "intent v1\nrevised\n")
    commit(root, "revise the intent after the spec", "2026-02-04T00:00:00Z")

    report = run_metrics(root, extra_args=("--no-github",))
    feature = find(report, "002")
    if feature is None:
        notes.append("FAIL: feature 002 not found in report")
        return False, notes

    ok = True
    ok = expect_eq(notes, "002.measurable", feature.get("measurable"), False) and ok
    ok = (
        expect_eq(
            notes,
            "002.intent_post_spec_edits (counted despite the shared first commit)",
            feature.get("intent_post_spec_edits"),
            1,
        )
        and ok
    )
    ok = (
        expect_absent(notes, "002.lead_time_hours", feature, "lead_time_hours")
        and ok
    )
    ok = (
        expect_eq(
            notes,
            "002.intent_committed_at == 002.spec_committed_at",
            feature.get("intent_committed_at"),
            feature.get("spec_committed_at"),
        )
        and ok
    )
    return ok, notes


def row_3(root: str) -> "tuple[bool, list[str]]":
    """intent.md committed 2026-02-01; the stubbed gh issue was filed a month
    LATER (2026-03-01) - t0 postdates t1, so lead time would be negative if
    computed naively. measurable must be False, lead_time_hours must be
    absent, and no negative number may appear anywhere in the record -
    feature 001's own unmeasurable rationale (see plan_metrics.py's module
    docstring), exercised directly against a synthetic fixture rather than
    read off HEAD."""
    notes: "list[str]" = []
    write_file(root, "features/002-synth/intent.md", "intent v1\n")
    commit(root, "add intent", "2026-02-01T00:00:00Z")

    extra_env = write_gh_stub(
        root,
        "002",
        [
            {
                "number": 102,
                "createdAt": "2026-03-01T00:00:00Z",
                "state": "OPEN",
                "stateReason": None,
                "labels": [],
            }
        ],
    )
    report = run_metrics(root, extra_args=(), extra_env=extra_env)
    feature = find(report, "002")
    if feature is None:
        notes.append("FAIL: feature 002 not found in report")
        return False, notes

    ok = True
    ok = expect_eq(notes, "002.measurable", feature.get("measurable"), False) and ok
    ok = expect_absent(notes, "002.lead_time_hours", feature, "lead_time_hours") and ok
    ok = (
        expect_true(
            notes,
            "no negative number anywhere in 002's record",
            not _contains_negative_number(feature),
        )
        and ok
    )
    return ok, notes


def row_4a(root: str) -> "tuple[bool, list[str]]":
    """features/002-old -> features/002-new: a pure `git mv`, zero content
    change. --follow pairs this at ANY similarity threshold, git's own 50%
    default included, so this row is the control: it must resolve to the true
    2026-01-01 creation commit, never the 2026-03-01 rename commit."""
    notes: "list[str]" = []
    _build_rename_fixture(root, rewritten=RENAME_FIXTURE_REWRITE_FRACTIONS["pure"])
    report = run_metrics(root, extra_args=("--no-github",))
    feature = find(report, "002")
    if feature is None:
        notes.append("FAIL: feature 002 not found in report")
        return False, notes

    ok = True
    ok = (
        expect_eq(
            notes,
            "002.intent_committed_at (rename did not become the creation)",
            feature.get("intent_committed_at"),
            "2026-01-01T00:00:00Z",
        )
        and ok
    )
    ok = _check_t1_source(notes, feature, "follow") and ok
    return ok, notes


def row_4b(root: str) -> "tuple[bool, list[str]]":
    """features/002-old -> features/002-new: `git mv` + 26/40 (65%) lines
    rewritten in that same rename commit. This is the row that actually
    exercises plan_metrics.py's FOLLOW_SIMILARITY (-M25%): at git's own 50%
    default the pairing fails and the answer comes out wrong
    (2026-03-01); at -M25% it is still correctly paired back to the true
    2026-01-01 creation. See plan_metrics.py's module docstring for the
    measured table this fraction is taken from."""
    notes: "list[str]" = []
    _build_rename_fixture(root, rewritten=RENAME_FIXTURE_REWRITE_FRACTIONS["partial"])
    report = run_metrics(root, extra_args=("--no-github",))
    feature = find(report, "002")
    if feature is None:
        notes.append("FAIL: feature 002 not found in report")
        return False, notes

    ok = True
    ok = (
        expect_eq(
            notes,
            "002.intent_committed_at (still resolves through the 65%-rewritten rename)",
            feature.get("intent_committed_at"),
            "2026-01-01T00:00:00Z",
        )
        and ok
    )
    ok = _check_t1_source(notes, feature, "follow") and ok
    return ok, notes


def row_4c(root: str) -> "tuple[bool, list[str]]":
    """features/002-old -> features/002-new: `git mv` + all 40/40 (100%) lines
    rewritten - unresolvable by any similarity threshold, since git has no
    signal left to pair the rename on at all. The extractor's job here is not
    to guess a date; it's to know it can't and say so: intent_t1_source ==
    "follow-unresolved" and measurable forced False, never a confident wrong
    date."""
    notes: "list[str]" = []
    _build_rename_fixture(root, rewritten=RENAME_FIXTURE_REWRITE_FRACTIONS["full"])
    report = run_metrics(root, extra_args=("--no-github",))
    feature = find(report, "002")
    if feature is None:
        notes.append("FAIL: feature 002 not found in report")
        return False, notes

    ok = True
    ok = _check_t1_source(notes, feature, "follow-unresolved") and ok
    ok = expect_eq(notes, "002.measurable", feature.get("measurable"), False) and ok
    return ok, notes


def row_5(root: str) -> "tuple[bool, list[str]]":
    """features/002-synth containing only plan.md - no intent.md at all.
    discover_features() requires intent.md on disk; a feature directory
    without one is silently skipped, not an error, and the run must still
    exit 0."""
    notes: "list[str]" = []
    write_file(root, "features/002-synth/plan.md", "plan only, no intent.md yet\n")
    commit(root, "add plan only", "2026-02-01T00:00:00Z")

    report = run_metrics(root, extra_args=("--no-github",))
    notes.append("OK: run_metrics succeeded (implies exit 0)")
    ok = expect_eq(notes, "002 absent (no intent.md yet)", find(report, "002"), None)
    return ok, notes


def row_6(root: str) -> "tuple[bool, list[str]]":
    """features/_template already exists on HEAD, untouched, holding its own
    intent.md. No mutation needed - this row proves the three-digit-prefix
    anchor actually excludes it, using the real fixture rather than a
    synthetic stand-in."""
    notes: "list[str]" = []
    report = run_metrics(root, extra_args=("--no-github",))
    ok = expect_true(
        notes,
        "no feature record whose name starts with '_'",
        all(not f.get("feature", "").startswith("_") for f in report.get("features", [])),
    )
    return ok, notes


def row_7(root: str) -> "tuple[bool, list[str]]":
    """features/002-synth/intent.md committed, no spec.md at all - distinct
    from row 2's "same commit" case: here there is no spec.md to even define
    post-spec churn against, so intent_post_spec_edits must be absent, and
    specifically not 0 - a 0 there would claim "no rework happened" instead of
    the true state, "no data exists"."""
    notes: "list[str]" = []
    write_file(root, "features/002-synth/intent.md", "intent v1\n")
    commit(root, "add intent, no spec", "2026-02-01T00:00:00Z")

    report = run_metrics(root, extra_args=("--no-github",))
    feature = find(report, "002")
    if feature is None:
        notes.append("FAIL: feature 002 not found in report")
        return False, notes

    ok = True
    ok = (
        expect_absent(notes, "002.intent_post_spec_edits", feature, "intent_post_spec_edits")
        and ok
    )
    ok = (
        expect_true(
            notes,
            "002.intent_post_spec_edits is not literally 0",
            feature.get("intent_post_spec_edits") != 0,
        )
        and ok
    )
    return ok, notes


def row_8(root: str) -> "tuple[bool, list[str]]":
    """Two stubbed issues: a feature:002 issue plus a second, gate:intent
    -labelled issue closed COMPLETED. Exercises the accepted path end to end -
    per-feature intent_outcome and the repo-wide rollup counts and
    survival_rate."""
    notes: "list[str]" = []
    write_file(root, "features/002-synth/intent.md", "intent v1\n")
    commit(root, "add intent", "2026-02-01T00:00:00Z")

    extra_env = write_gh_stub(
        root,
        "002",
        [
            {
                "number": 201,
                "createdAt": "2026-01-31T00:00:00Z",
                "state": "OPEN",
                "stateReason": None,
                "labels": [],
            },
            {
                "number": 202,
                "createdAt": "2026-01-31T01:00:00Z",
                "state": "CLOSED",
                "stateReason": "COMPLETED",
                "labels": [{"name": "gate:intent"}],
            },
        ],
    )
    report = run_metrics(root, extra_args=(), extra_env=extra_env)
    feature = find(report, "002")
    if feature is None:
        notes.append("FAIL: feature 002 not found in report")
        return False, notes

    ok = True
    ok = expect_eq(notes, "002.intent_outcome", feature.get("intent_outcome"), "accepted") and ok
    rollup = report.get("rollup", {})
    ok = expect_eq(notes, "rollup.accepted_count", rollup.get("accepted_count"), 1) and ok
    ok = expect_eq(notes, "rollup.survival_rate", rollup.get("survival_rate"), 1.0) and ok
    return ok, notes


def row_9(root: str) -> "tuple[bool, list[str]]":
    """Same as row 8, but the gate:intent issue is closed NOT_PLANNED instead
    of COMPLETED - exercises the rejected path: intent_outcome, rejected_count,
    and a survival_rate of 0.0 rather than an absent one."""
    notes: "list[str]" = []
    write_file(root, "features/002-synth/intent.md", "intent v1\n")
    commit(root, "add intent", "2026-02-01T00:00:00Z")

    extra_env = write_gh_stub(
        root,
        "002",
        [
            {
                "number": 301,
                "createdAt": "2026-01-31T00:00:00Z",
                "state": "OPEN",
                "stateReason": None,
                "labels": [],
            },
            {
                "number": 302,
                "createdAt": "2026-01-31T01:00:00Z",
                "state": "CLOSED",
                "stateReason": "NOT_PLANNED",
                "labels": [{"name": "gate:intent"}],
            },
        ],
    )
    report = run_metrics(root, extra_args=(), extra_env=extra_env)
    feature = find(report, "002")
    if feature is None:
        notes.append("FAIL: feature 002 not found in report")
        return False, notes

    ok = True
    ok = expect_eq(notes, "002.intent_outcome", feature.get("intent_outcome"), "rejected") and ok
    rollup = report.get("rollup", {})
    ok = expect_eq(notes, "rollup.rejected_count", rollup.get("rejected_count"), 1) and ok
    ok = expect_eq(notes, "rollup.survival_rate", rollup.get("survival_rate"), 0.0) and ok
    return ok, notes


def row_10(root: str) -> "tuple[bool, list[str]]":
    """Proves copy_tree()'s linked-worktree branch, which is dead code anywhere
    `.git` is a directory - CI included, so it would rot unnoticed and only be
    missed the next time someone runs this suite from a worktree.

    That is not hypothetical. Before the fix this row guards, running
    `npm run test:plan-metrics` from a linked worktree gave every sandbox a
    `.git` still pointing at the shared gitdir, so each fixture's `git commit`
    landed on the live branch of the worktree the suite was launched from: 36
    synthetic commits on a real branch, and rows failing on each other's
    history rather than on anything plan_metrics.py did. Same shape as issue
    #31, one file over.

    Hermetic with respect to the real repository, and more so than
    review-checks.test.mjs's equivalent row: the linked worktree is added to
    *this row's own throwaway copy*, never to REPO_ROOT, so nothing here can
    touch the checkout even if every assertion below fails.
    """
    notes: "list[str]" = []
    worktree = root + "-wt"
    sandbox = root + "-wt-sandbox"

    git(root, ["worktree", "add", "--detach", "--quiet", worktree, "HEAD"])
    if not is_linked_worktree(worktree):
        notes.append(
            f"FAIL: expected {worktree}/.git to be a gitdir pointer file - "
            "the row proves nothing without one"
        )
        return False, notes
    notes.append("OK: the source worktree's .git is a gitdir pointer file")

    copy_tree(worktree, sandbox)
    ok = True

    sandbox_git = os.path.join(sandbox, ".git")
    if not os.path.isdir(sandbox_git):
        notes.append(
            "FAIL: sandbox .git is not a directory - it is still the pointer, so "
            "every row would run against the source repository"
        )
        return False, notes
    notes.append("OK: sandbox owns its gitdir (.git is a directory, not a pointer)")

    resolved = git_path(sandbox, "--git-dir")
    if resolved is None or not os.path.realpath(resolved).startswith(
        os.path.realpath(sandbox)
    ):
        notes.append(
            f"FAIL: sandbox gitdir resolved to {resolved}, outside {sandbox}"
        )
        ok = False
    else:
        notes.append("OK: git resolves the sandbox gitdir inside the sandbox")

    if os.path.exists(os.path.join(sandbox_git, "worktrees")):
        notes.append(
            "FAIL: sandbox .git carries a worktrees/ dir, whose entries point back "
            "out at real checkouts"
        )
        ok = False
    else:
        notes.append("OK: sandbox .git carries no worktrees/ back-pointers")

    # The source worktree is detached, so a HEAD inherited from the common dir
    # would name a branch instead - the quieter half of the same bug.
    head = subprocess.run(
        ["git", "symbolic-ref", "--quiet", "HEAD"],
        cwd=sandbox,
        capture_output=True,
        text=True,
        env=env_without_git_vars(),
    )
    if head.returncode == 0:
        notes.append(
            f"FAIL: sandbox HEAD is {head.stdout.strip()}, but the source worktree "
            "is detached - HEAD was inherited from the common dir"
        )
        ok = False
    else:
        notes.append("OK: HEAD came from the worktree, not the common dir")

    # A sandbox that cannot take a commit is not a fixture, however well its
    # gitdir resolves - every other row's first act is to write a file and
    # commit it. The write is not optional: `git commit` on an unchanged tree
    # exits non-zero with "nothing to commit" on *stdout* and an empty stderr,
    # which reads exactly like a hook refusing the commit.
    write_file(sandbox, "features/002-sandbox/intent.md", "# sandbox\n")
    commit(sandbox, "sandbox is writable", "2026-04-01T00:00:00Z")
    notes.append("OK: sandbox accepts a commit of its own")
    return ok, notes


ROWS: "list[tuple[str, Callable[[str], tuple[bool, list[str]]]]]" = [
    ("baseline (no mutation) - proves the harness itself is not vacuously green", row_0),
    (
        "features/002-synth: intent -> spec -> post-spec intent edit (3 commits); "
        "gh stub issue filed 24h before intent",
        row_1,
    ),
    (
        "features/002-synth: intent.md and spec.md in one commit, then a later "
        "intent edit - churn still counted",
        row_2,
    ),
    (
        "features/002-synth: intent committed before the stubbed issue was filed "
        "(would-be negative lead time)",
        row_3,
    ),
    ("features/002-old -> 002-new: pure git mv, 0/40 lines rewritten", row_4a),
    (
        "features/002-old -> 002-new: git mv + 26/40 (65%) lines rewritten in the "
        "same commit",
        row_4b,
    ),
    (
        "features/002-old -> 002-new: git mv + 40/40 (100%) lines rewritten - "
        "unresolvable",
        row_4c,
    ),
    ("features/002-synth containing only plan.md, no intent.md", row_5),
    ("features/_template untouched on HEAD - proves the digit-prefix anchor excludes it", row_6),
    ("features/002-synth/intent.md committed, no spec.md at all", row_7),
    ("gh stub: feature:002 issue + a gate:intent issue closed COMPLETED", row_8),
    ("gh stub: feature:002 issue + a gate:intent issue closed NOT_PLANNED", row_9),
    (
        "copy_tree gives a linked worktree a sandbox that owns its gitdir "
        "(issue #31, this file's copy of it)",
        row_10,
    ),
]


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------


def real_repo_fingerprint() -> "str | None":
    """HEAD, the current ref and the porcelain status of the *real* repository,
    as one comparable string. None when git cannot answer, which is not a
    failure - it just means there is nothing to protect."""
    env = env_without_git_vars()

    def run(args: "list[str]") -> "subprocess.CompletedProcess[str]":
        return subprocess.run(
            ["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, env=env
        )

    head = run(["rev-parse", "HEAD"])
    # symbolic-ref exits non-zero on a detached HEAD, which is a state, not an
    # error, so its return code is deliberately not checked.
    ref = run(["symbolic-ref", "--quiet", "HEAD"])
    status = run(["status", "--porcelain"])
    if head.returncode != 0 or status.returncode != 0:
        return None
    return json.dumps(
        {
            "head": head.stdout.strip(),
            "ref": ref.stdout.strip(),
            "status": status.stdout,
        }
    )


def assert_real_repo_untouched(before: "str | None", row_label: str) -> None:
    """Fail the whole run the moment a row writes through to the real
    repository, rather than letting the pollution surface as unrelated failures
    on every row after it. That indirection is what made issue #31 slow to
    read, and what made its recurrence in this file slow to read again."""
    if before is None:
        return
    after = real_repo_fingerprint()
    if after == before:
        return
    print(f"\n[HERMETICITY FAIL] {row_label} mutated the real repository at {REPO_ROOT}")
    print(f"    before: {before}")
    print(f"    after:  {after}")
    print("    Stopping: every later row would report failures caused by this,")
    print("    not by its own mutation. See issue #31 and copy_tree() above.")
    sys.exit(1)


def main() -> int:
    """Run every row against its own fresh copy of REPO_ROOT, print a
    `Row N: <name>` header, each note indented, and `-> PASS`/`-> FAIL` per
    row, then a final tally line. Returns the process exit code: 0 iff every
    row passed."""
    failures = 0
    baseline = real_repo_fingerprint()
    tmp_root = tempfile.mkdtemp(prefix="plan-metrics-test-")
    try:
        for index, (name, row_fn) in enumerate(ROWS):
            row_dir = os.path.join(tmp_root, f"row-{index}")
            copy_tree(REPO_ROOT, row_dir)
            print(f"\nRow {index}: {name}")
            try:
                ok, notes = row_fn(row_dir)
            except Exception as exc:  # noqa: BLE001 - a row's own failure must be
                # reported and the suite must continue, not crash outright; see
                # run_metrics()'s docstring for why this message already carries
                # the child process's real traceback via its captured stderr
                # rather than surfacing as an opaque exception type here.
                ok = False
                notes = [f"FAIL: {exc}"]
            for note in notes:
                for line in str(note).splitlines():
                    print(f"    {line}")
            print(f"    -> {'PASS' if ok else 'FAIL'}")
            if not ok:
                failures += 1
            assert_real_repo_untouched(baseline, f"Row {index}")
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)

    total = len(ROWS)
    if failures == 0:
        print(f"\nall {total} rows behaved as expected")
    else:
        print(f"\n{failures}/{total} rows FAILED")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
