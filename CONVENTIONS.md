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
  usually three PRs.
- Every PR gets the passes in `REVIEW.md`, in order.

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
