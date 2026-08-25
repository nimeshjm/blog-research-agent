#!/usr/bin/env python3
"""
issue_comment.py - post a turn summary to the GitHub issue named in the git branch.

Wired to the Stop hook in .claude/settings.json, so it runs once every time Claude
finishes responding. Branch names follow CONVENTIONS.md (`<issue>-<slug>`, optionally
`<type>/<issue>-<slug>`), so the issue number is read off the branch and a Markdown
comment summarising the turn is posted with `gh issue comment`.

What it publishes, and what it deliberately does not:

  - the request, the assistant's closing reasoning, tool NAMES and counts, and changed
    file paths with line counts;
  - never a bash command string, never command output, never a thinking block.

That boundary is the reason this is safe to point at a public repo. REVIEW.md pass 2
forbids secret values reaching a log; this repo holds .dev.vars on disk and runs most
work through Bash, so publishing command text would be a direct route for one to escape.

Everything fails soft: any error is swallowed and the hook exits 0. A hook that breaks
the session is worse than a missing comment.

Usage:
  issue_comment.py              read the Stop payload on stdin and post
  issue_comment.py --dry-run    print the comment instead of posting it
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from collections import deque

# GitHub rejects comments longer than 65,536 characters.
COMMENT_LIMIT = 60_000
# How far back through the transcript to walk looking for the turn boundary.
MAX_TRANSCRIPT_LINES = 400

# `7-fix-binding` or `fix/7-fix-binding`. Anchored on purpose: an unanchored \b(\d+)-
# would read `2026` out of a date-prefixed branch and comment on the wrong issue.
BRANCH_ISSUE_RE = re.compile(r'^(?:[a-z][a-z0-9]*/)?(\d+)(?:-|$)')

# A pasted document should not become the whole comment.
REQUEST_LIMIT = 2_000

# Harness-injected context can ride along inside a user turn. It is not the request, and
# it carries config and environment text that has no business on a public issue.
REMINDER_RE = re.compile(r'(?s)<system-reminder>.*?</system-reminder>')


def scrub(text: str) -> str:
    """Remove injected harness context from anything on its way into a comment."""
    return REMINDER_RE.sub('', text).strip()


def git(cwd: str, *args: str) -> str:
    """Run a git command, returning stdout or '' on any failure."""
    try:
        r = subprocess.run(
            ['git', *args], cwd=cwd or None,
            capture_output=True, text=True, timeout=5,
        )
        return r.stdout.strip() if r.returncode == 0 else ''
    except (OSError, subprocess.TimeoutExpired):
        return ''


def branch_issue(cwd: str) -> tuple[str, str]:
    """Return (branch, issue_number). issue_number is '' when the branch names none."""
    branch = git(cwd, 'branch', '--show-current')
    m = BRANCH_ISSUE_RE.match(branch)
    return branch, (m.group(1) if m else '')


def issue_exists(cwd: str, number: str) -> bool:
    """Confirm the issue is real before commenting on it.

    Second line of defence behind the anchored regex: a branch that happens to start
    with digits should fail closed rather than comment on an unrelated issue.
    """
    try:
        r = subprocess.run(
            ['gh', 'issue', 'view', number, '--json', 'number'],
            cwd=cwd or None, capture_output=True, text=True, timeout=20,
        )
        return r.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _text_blocks(content) -> list[str]:
    """Text from a message's content, which is either a string or a block list."""
    if isinstance(content, str):
        return [content]
    if not isinstance(content, list):
        return []
    return [
        b.get('text', '') for b in content
        if isinstance(b, dict) and b.get('type') == 'text'
    ]


def _is_noise(text: str) -> bool:
    """Slash-command plumbing and injected context are not the user's request."""
    t = text.lstrip()
    return (
        t.startswith('<command-')
        or t.startswith('<local-command')
        or t.startswith('<system-reminder')
        or t.startswith('Caveat:')
    )


def read_turn(path: str) -> dict:
    """Walk the transcript newest-first back to the user message that opened the turn.

    Collects the request, the assistant's last text block (its closing reasoning), and
    a count per tool name. Thinking blocks and tool inputs are read past deliberately.
    """
    turn = {'user_prompt': '', 'final_text': '', 'tools': {}}
    try:
        with open(path, encoding='utf-8') as f:
            lines = deque(f, maxlen=MAX_TRANSCRIPT_LINES)
    except OSError:
        return turn

    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if entry.get('isMeta'):
            continue

        etype = entry.get('type')
        content = (entry.get('message') or {}).get('content')

        if etype == 'assistant':
            for block in content if isinstance(content, list) else []:
                if not isinstance(block, dict):
                    continue
                if block.get('type') == 'text' and not turn['final_text']:
                    turn['final_text'] = scrub(block.get('text', ''))
                elif block.get('type') == 'tool_use':
                    name = block.get('name', '')
                    turn['tools'][name] = turn['tools'].get(name, 0) + 1
        elif etype == 'user':
            texts = [
                scrub(t) for t in _text_blocks(content)
                if t.strip() and not _is_noise(t)
            ]
            texts = [t for t in texts if t]
            if texts:
                turn['user_prompt'] = texts[0][:REQUEST_LIMIT]
                break

    return turn


def working_tree(cwd: str) -> list[str]:
    """Changed files with line counts, read from git rather than from tool inputs.

    Tallying Edit/Write inputs misses everything done through Bash - which in this repo
    is most of it - so ask git instead.
    """
    lines: list[str] = []
    stat = git(cwd, 'diff', '--numstat', 'HEAD')
    for row in stat.splitlines():
        parts = row.split('\t')
        if len(parts) == 3:
            added, removed, path = parts
            lines.append(f'- `{path}`: +{added} / -{removed}')
    untracked = git(cwd, 'ls-files', '--others', '--exclude-standard')
    for path in untracked.splitlines():
        lines.append(f'- `{path}`: new, untracked')
    return lines


def format_comment(turn: dict, branch: str, changes: list[str]) -> str:
    parts = ['## Claude Code turn summary\n', f'**Branch:** `{branch}`\n']

    if turn['user_prompt']:
        parts.append(f'**Request:** {turn["user_prompt"]}\n')

    if turn['final_text']:
        parts.append('### Reasoning\n')
        parts.append(f'{turn["final_text"]}\n')

    if turn['tools']:
        parts.append('### Tools called\n')
        for name, n in sorted(turn['tools'].items(), key=lambda kv: -kv[1]):
            parts.append(f'- {name} ({n}x)')
        parts.append('')

    if changes:
        parts.append('### Working tree\n')
        parts.extend(changes)
        parts.append('')

    comment = '\n'.join(parts)
    if len(comment) > COMMENT_LIMIT:
        comment = comment[:COMMENT_LIMIT] + '\n\n_[truncated]_'
    return comment


def _state_file(cwd: str, number: str) -> str:
    """Where the last-posted digest for this issue lives. Under .git/, never committed."""
    git_dir = git(cwd, 'rev-parse', '--git-dir')
    if not git_dir:
        return ''
    if not os.path.isabs(git_dir):
        git_dir = os.path.join(cwd, git_dir)
    return os.path.join(git_dir, 'claude-issue-log', f'{number}.sha')


def already_posted(cwd: str, number: str, comment: str) -> bool:
    """True when this exact body was the last one *successfully* posted for this issue.

    Stop also fires on /clear, resume, and compact, which would otherwise replay a
    near-identical comment. Read-only on purpose: the digest is recorded by post(), so a
    failed `gh` call cannot poison the dedupe and silently swallow the next comment.
    """
    path = _state_file(cwd, number)
    if not path:
        return False
    digest = hashlib.sha256(comment.encode('utf-8')).hexdigest()
    try:
        with open(path, encoding='utf-8') as f:
            return f.read().strip() == digest
    except OSError:
        return False


def post(cwd: str, number: str, comment: str) -> None:
    """Post the comment, recording its digest only once gh confirms it landed."""
    try:
        r = subprocess.run(
            ['gh', 'issue', 'comment', number, '--body-file', '-'],
            cwd=cwd or None, input=comment,
            capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return
    if r.returncode != 0:
        return

    path = _state_file(cwd, number)
    if not path:
        return
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(hashlib.sha256(comment.encode('utf-8')).hexdigest())
    except OSError:
        pass


def main() -> int:
    dry_run = '--dry-run' in sys.argv
    try:
        payload = json.loads(sys.stdin.read() or '{}')
    except ValueError:
        payload = {}

    cwd = payload.get('cwd') or os.getcwd()
    branch, number = branch_issue(cwd)
    if not number:
        if dry_run:
            print(f'no issue number in branch {branch!r}; hook would no-op', file=sys.stderr)
        return 0

    turn = read_turn(payload.get('transcript_path', ''))
    comment = format_comment(turn, branch, working_tree(cwd))

    if dry_run:
        print(comment)
        return 0

    if not issue_exists(cwd, number):
        return 0
    if already_posted(cwd, number, comment):
        return 0
    post(cwd, number, comment)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:  # never break the session over a comment
        sys.exit(0)
