# Features

One directory per feature: `features/NNN-slug/`. Each carries the three artifacts from
[the AI-native SDLC playbook](https://claude.com/blog/the-ai-native-sdlc-playbook),
written in order, each one reviewed before the next is started.

```
features/NNN-slug/
  intent.md   Stage 1 - the problem, in the originator's words. What outcome, what
              constraints, what is explicitly out of scope. No solution design.
  spec.md     Stage 2 - requirements and design. Written from an approved intent.md.
              Data model, interfaces, acceptance criteria. No implementation detail.
  plan.md     Stage 3 - the implementation plan Claude produces in plan mode. Names the
              files it will touch, the order of work, and the tests that prove it done.
```

## Rules

- Copy `_template/` to start a feature. Renumber, do not reuse a number.
- **Do not skip forward.** An unfilled `spec.md` means the design has not been approved;
  an unfilled `plan.md` means implementation has not been approved. Do not write code for
  a feature whose `plan.md` is still the template.
- Each artifact is committed before the next stage begins, so git history records who
  approved what and when. That chain is the audit trail.
- When implementation reveals the spec was wrong, update `spec.md` in the same pull
  request. Do not let code and spec drift apart silently.
- Work items are tracked in [GitHub issues](https://github.com/nimeshjm/blog-research-agent/issues), labelled `feature:NNN`. These
  artifacts stay authoritative for stage gates; issues are authoritative for what is left
  to do. A build's task breakdown belongs in `plan.md`, not in issues. See
  [`CONVENTIONS.md`](../CONVENTIONS.md).

## Measuring stage 1

`scripts/plan_metrics.py` reads git and GitHub history and reports Stage 1 (Plan)
against the playbook's two indicators: leading — lead time from a `feature:NNN` issue to
a committed `intent.md` — and lagging — intent survival (accepted into Stage 2, rejected,
or still open) plus how many times `intent.md` is edited after `spec.md` first lands.

`t0` is the earliest `feature:NNN` issue's `createdAt`, so what this actually measures is
work-item creation → committed intent, a durable, server-side **proxy** for the
playbook's "first conversation", not that indicator itself. `--t0-from-sessions`
sharpens it on the author's machine by reading `~/.claude/projects/<slug>/*.jsonl`, and
degrades to the issue timestamp in CI. `sdlc.t0.source` records which one was used, so a
board never mixes the two silently.

**Feature 001 has no lead time.** Its artifacts all landed in one bootstrap commit and its
issues were filed about a minute later, so 001 reports `unmeasurable` — never `0`. A
0-hour lead time on a board would read as a triumph. Real lead-time numbers start at
feature 002.

**Feature 002's lead time is measurable but is not a design cycle.** It reports
`lead_time=0.03h`, and that number is an artifact of how it was produced: the
`feature:002` issue and the `intent.md` commit landed minutes apart inside a single agent
session, because the run that motivated the feature failed and was diagnosed in that same
session. Read it as "issue and intent were authored together", not as a two-minute plan
stage. 001 reports `unmeasurable` to keep a 0 off the board; 002 needs the opposite
footnote — the metric is working, the number is just small for a reason that is not
speed.

Its **churn** is a different matter and is reported. Sharing a first commit withholds the
lead time, not the edit count: `spec.md`'s timestamp is real either way, and an `intent.md`
commit after it is real rework. 001 already has one, which is the number the board's
post-spec-churn trigger watches.

Run `npm run plan:metrics` to see it locally; the daily `sdlc-metrics.yml` workflow is
what publishes it.

Renumbering a feature directory is safe, with one caveat worth knowing: the extractor
follows renames at a deliberately loose similarity threshold, because at git's default
50 % a renumbering that *also* rewrote the file would look like the creation commit and
understate lead time. If it still cannot pair the two, it reports
`sdlc.intent.t1_source = "follow-unresolved"` and declines to emit a lead time rather
than emitting a wrong one. So renumber freely; just avoid rewriting `intent.md` wholesale
in the same commit.

**The clock starts at template divergence, not at first commit.** "Copy `_template/` to
start a feature" (above) means an artifact's first commit is usually still the unfilled
template, not the moment work began — so `t1` for both stages is the author date of the
first commit whose content actually differs from every version `_template/<artifact>.md`
has ever had, not the artifact's first-add commit. Anchoring on first-add instead would
make every feature's lead time 0 by construction, since the copy and the creation commit
are the same commit.

## Measuring stage 2

`scripts/plan_metrics.py` also reports Stage 2 (Design) against the playbook's two
indicators: leading — elapsed time between `intent.md` being filled and `spec.md` being
filled, for the same feature — and lagging — `spec.md` commits landing after `plan.md`
first diverged from the template (requirements rework after a build started).

**Feature 002's design lead time carries the same footnote** as its Stage 1 number
above: `intent.md` and `spec.md` were written in one session at the requester's
direction, so `design_lead_time=0.03h` measures authoring order, not a design cycle.

Both come from **git alone**. No `gh` call, no label, no issue state — `--no-github`
yields complete Stage 2 output; only Stage 1's `t0` and `intent_outcome` degrade without
GitHub.

**Feature 001 has no design lead time.** Its `intent.md` and `spec.md` are both filled in
the same bootstrap commit, so — same rule as Stage 1's lead time — it reports
`design_measurable: false`, never a 0-hour design.

Its **post-plan spec churn** IS reported, and is real: three edits at the time of writing
(`npm run plan:metrics -- --json` shows the current number). `plan.md` diverged from the
template a day after the bootstrap commit, and `spec.md` was edited three times after
that — the step 3/4/5 build revising `spec.md` as implementation proceeded. That is
exactly what this file's own rule above — "when implementation reveals the spec was
wrong, update `spec.md` in the same pull request" — asks for, so a non-zero number here
is not automatically a process failure. Read it as the metric doing its job: surfacing
rework, not judging it.

## Index

| # | Feature | Stage |
|---|---|---|
| 001 | [scheduled-research-drafts](001-scheduled-research-drafts/) | Built: all five pull requests in `plan.md` written, closing [#3](https://github.com/nimeshjm/blog-research-agent/issues/3). [Open issues](https://github.com/nimeshjm/blog-research-agent/issues?q=is%3Aissue+is%3Aopen+label%3Afeature%3A001) |
| 002 | [gather-without-accumulation](002-gather-without-accumulation/) | Built: all six pull requests in `plan.md` written, closing [#61](https://github.com/nimeshjm/blog-research-agent/issues/61); intent gate [#62](https://github.com/nimeshjm/blog-research-agent/issues/62) closed `COMPLETED`. Merged and deployed at `c828e7d`, and every acceptance criterion holds **except 5** — a full 46-feed run still fails, which is what feature 003 exists for. [Open issues](https://github.com/nimeshjm/blog-research-agent/issues?q=is%3Aissue+is%3Aopen+label%3Afeature%3A002) |
| 003 | [run-to-completion](003-run-to-completion/) | Stage 2: `spec.md` written, awaiting approval; intent gate [#76](https://github.com/nimeshjm/blog-research-agent/issues/76) closed `COMPLETED`. `plan.md` is still the template. The Stage 2 measurement lives at [`probe/`](../probe/FINDINGS.md). Tracking [#75](https://github.com/nimeshjm/blog-research-agent/issues/75). [Open issues](https://github.com/nimeshjm/blog-research-agent/issues?q=is%3Aissue+is%3Aopen+label%3Afeature%3A003) |
