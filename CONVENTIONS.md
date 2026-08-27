# Conventions

How work is named, tracked, and recorded in this repo. `CLAUDE.md` carries the
architecture and platform rules; this file carries the process ones.

## Work items

[GitHub issues on this repo](https://github.com/nimeshjm/blog-research-agent/issues) are
the work-item tracker. **Issues are authoritative for work items; the markdown artifacts
in `features/` stay authoritative for stage gates.** Where the two disagree, the artifact
wins and the issue is wrong.

- Every unit of work gets an issue before it is started, labelled `feature:NNN`.
- The per-step breakdown of a feature build belongs in that feature's `plan.md`, not in
  issues. A build is one tracking issue; filing an issue per step authors stage 3 in the
  tracker and skips the gate.
- `blocked` means waiting on an earlier stage gate or prerequisite, and the body names
  which. `deferred` means agreed but not now, and the body names the trigger to revisit.
  `free-tier` mirrors `REVIEW.md` pass 1.
- `[gate]` has so far been a **title** convention, not a label: `[gate] Approve spec.md
  for feature 001`, `[gate] Write plan.md for feature 001`. `gate:intent` is the first
  actual label of its kind, on issues titled `[gate] Approve intent.md for feature NNN`.
  Closed `COMPLETED` means the intent was accepted into Stage 2; closed `NOT_PLANNED`
  means it was rejected; open means pending. **This issue is the accept/reject record the
  intent survival-rate metric reads, so closing it by hand with the wrong reason corrupts
  the metric** — the one exception to "do not close issues by hand" below, because here
  the close reason is itself the record.
- Do not restate an issue's status in prose in the markdown. Link to the issue list.

## Branch names

**Every working branch starts with its issue number.**

```
<issue>-<slug>              7-d1-binding-mismatch
<type>/<issue>-<slug>       fix/7-d1-binding-mismatch
```

- `<issue>` is the GitHub issue number, with no `#`.
- `<slug>` is kebab-case, lowercase, and short. It is a label for humans; the number is
  what carries the meaning.
- `<type>`, when used, is one lowercase word — `fix`, `feat`, `docs`, `chore`.
- **A branch never starts with a date.** `2026-08-25-something` would read as issue 2026.
  This is the one thing that must not be broken: the turn log below extracts the issue
  number from the front of the branch name.
- No work happens on `main`. A branch with no issue number is a branch whose work is not
  tracked, and the turn log silently skips it.

`research/<yyyy-mm-dd>-<slug>` is a different thing and is not affected by any of this —
that is the branch pattern the agent writes in the **blog** repo, not here.

## Commits and pull requests

- The pull request body closes its issue with `Closes #N`. Do not close issues by hand;
  the merge should do it, so the issue and the commit that resolved it stay linked.
- One issue per pull request wherever it is reasonable. A PR that closes three issues is
  usually three PRs. (The reverse — several PRs against the same issue, stacked — is
  fine and covered below; that is not the same as one PR closing several issues.)
- Every PR gets the passes in `REVIEW.md`, in order.

### Stacked pull requests

A feature built as a stack of PRs — each based on the previous one rather than on
`main` — still has every branch in the stack starting with the same issue number, per
the branch-name rule above. That collides with `Closes #N`: only the **last** PR in the
stack may close the tracking issue, because an earlier one carrying `Closes #N` would
close it with the rest of the stack still unwritten.

So every PR in the stack except the last carries this instead, verbatim, somewhere in
its body:

```
Part 2 of 4 of #47
```

- `N` (this PR's position) and `M` (the stack's length) are both required and are
  validated as `1 <= N <= M` — a swapped or nonsensical ordinal (`Part 5 of 2`, `Part 0
  of 3`) does not satisfy the check.
- `#<issue>` must match the issue number the stack's branches carry. Mentioning the
  issue elsewhere in the body does not count — the marker has to be this exact,
  deliberate phrase, or `pr-body-not-empty` still fails the PR.
- The **last** PR in the stack is an ordinary PR: it drops the `Part N of M` marker and
  carries `Closes #N` like any other.

There is a second, quieter way to close the tracking issue too early, which the
`Part N of M` marker does not protect against. GitHub's auto-close keywords are
**case-insensitive**, so an ordinary English sentence in an intermediate PR's body —
"pass 2 adds the span and closes #42" — closes the issue the moment *that* PR merges,
with the rest of the stack still unwritten. `pr-body-not-empty` cannot catch it: it
looks for the exact string `Closes #N`, which a lowercase `closes #42` is not. So in an
intermediate PR's body, never put a closing keyword (`close`/`closes`/`closed`,
`fix`/`fixes`/`fixed`, `resolve`/`resolves`/`resolved`) immediately before an issue
reference, in any casing. Write "is the PR that closes the tracking issue" instead, and
grep the body before posting it.

`gh stack submit --auto` (the `github/gh-stack` extension) is a reasonable way to push a
stack and open its PRs, with one thing to know: it has no flag for a PR body. For a
single-commit branch it seeds the body from the commit message, otherwise from the
humanised branch name — so **CI starts against a body that has not been written yet**, and
`pr-body-not-empty` fails on any PR whose commit message does not happen to contain the
exact marker. Set the real bodies with `gh pr edit <n> --body-file <path>` immediately
after submitting, then re-run the failed job. `--body-file -` is still forbidden — see
`CLAUDE.md`'s "Repeated mistakes". Note also that `gh pr merge` does not work on a stack;
it is `gh stack merge --yes`, which merges bottom-to-top atomically.

`pr-body-not-empty` (`scripts/review-checks.mjs`, documented in `REVIEW.md`) enforces
this mechanically.

## Model delegation

Non-trivial work on this repo is split across three model roles, deliberately, in this
order. The split exists because the three jobs fail differently: orchestration fails by
misreading the design, implementation fails by writing the wrong code, and verification
fails by believing a green test run.

- **Orchestrate with Opus.** Read the issue, read the code it touches, check the issue's
  factual claims against the tree *before* delegating — this repo's issues carry measured
  evidence (blob hashes, commit shas, timing tables) that can go stale between filing and
  implementation. Write the brief. Own the git surface: branch, commits, and the pull
  request are never delegated, because that is where `CONVENTIONS.md` is violated
  (branch-number rule, `Closes #N`, the stdin trap in "Repeated mistakes").
- **Implement with Sonnet**, via the `Agent` tool with `model: "sonnet"`, one pass per
  coherent slice of the issue's own **Sequencing** section — not one per file, and not
  one giant pass. Each brief carries the exact identifiers (function names, field names,
  attribute names) the next pass will build on, so a later pass never has to rediscover
  what an earlier one chose. Passes that share state run **serially**.
- **Verify with Opus.** Not "the suite is green" — that is the implementer's own claim
  and it is the weakest evidence available. Verification re-derives the numbers from git
  by hand, and for anything guarded by a mutation-table row (`test:plan-metrics`,
  `test:checks`, `test:ast`) it **removes each new guard in turn and confirms the row goes
  red**. A row that passes with its guard removed is dead, and a dead row is the exact
  failure mode those suites exist to prevent.

The orchestrator states which role produced what in the pull request body, so a reviewer
knows which claims were re-derived and which were taken from a subagent.

## The turn log

Every time Claude finishes responding, a Stop hook posts a summary of that turn as a
comment on the issue named in the current branch. The intent is that the reasoning behind
a change ends up on the work item rather than only in a session transcript that nobody
reads again.

- Hook: `.claude/hooks/issue_comment.py`, wired in `.claude/settings.json`.
- It **no-ops** when the branch carries no issue number, when the issue does not exist,
  and when the comment would be byte-identical to the last one it posted for that issue
  (Stop also fires on `/clear`, resume, and compact).
- It posts: the request, the assistant's closing reasoning, tool **names** and counts,
  and changed file paths with line counts read from `git`.
- It never posts: a bash command string, command output, or a thinking block. This repo
  is **public** and holds `.dev.vars` on disk, so that boundary is what keeps `REVIEW.md`
  pass 2 intact. Do not widen it.
- It fails soft. Any error is swallowed and the hook exits 0; a missing comment is better
  than a broken session.

Preview what it would post without posting:

```bash
echo "{\"cwd\":\"$PWD\",\"transcript_path\":\"<path to session .jsonl>\"}" \
  | python3 .claude/hooks/issue_comment.py --dry-run
```

Transcripts live in `~/.claude/projects/-Users-<you>-repos-blog-research-agent/`.
To turn the log off, delete the `Stop` block from `.claude/settings.json`.
