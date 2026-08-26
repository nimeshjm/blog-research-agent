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

**`n = 0` today.** Feature 001's artifacts all landed in one bootstrap commit and its
issues were filed about a minute later, so 001 reports `unmeasurable` — never `0`. A
0-hour lead time on a board would read as a triumph. Real numbers start at feature 002.

Run `npm run plan:metrics` to see it locally; the daily `sdlc-metrics.yml` workflow is
what publishes it. Renumbering a feature directory is safe — the extractor follows
renames.

## Index

| # | Feature | Stage |
|---|---|---|
| 001 | [scheduled-research-drafts](001-scheduled-research-drafts/) | At the stage 3 gate: `intent.md` and `spec.md` written, `plan.md` not. [Open issues](https://github.com/nimeshjm/blog-research-agent/issues?q=is%3Aissue+is%3Aopen+label%3Afeature%3A001) |
