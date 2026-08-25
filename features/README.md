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

## Index

| # | Feature | Stage |
|---|---|---|
| 001 | [scheduled-research-drafts](001-scheduled-research-drafts/) | At the stage 3 gate: `intent.md` and `spec.md` written, `plan.md` not. [Open issues](https://github.com/nimeshjm/blog-research-agent/issues?q=is%3Aissue+is%3Aopen+label%3Afeature%3A001) |
