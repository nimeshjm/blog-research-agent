#!/usr/bin/env python3
# ── VENDORED — DO NOT EDIT ────────────────────────────────────────────────────
# Upstream: nimeshjm/claude-otel-hooks, path .claude/hooks/otel_span.py
#           https://github.com/nimeshjm/claude-otel-hooks
# Taken at: b5f8ffb105cdd8e03d578fec40f08c958cee55c6
#
# Everything below this block is byte-for-byte upstream. Vendored rather than
# imported from ~/.claude/hooks/ because CI has no ~/.claude. Do not edit it:
# drift is the cost of vendoring, and the pinned SHA above is how you notice.
# To refresh, re-copy from that path at a newer commit and update the SHA.
#
# Two upstream behaviours scripts/plan_metrics.py works *around* rather than
# patching here — see that file's header for the reasoning:
#   - get_git_context() drops non-SSH remotes, so it adds git.origin/git.repo
#     locally and returns {} under a GitHub Actions HTTPS checkout.
#   - the Resource hardcodes gen_ai.system / gen_ai.provider.name = anthropic.
# ──────────────────────────────────────────────────────────────────────────────
"""
otel_span.py — shared helper used by every hook script.

Reads OTLP config from env vars (same ones Claude Code already uses for its
own built-in telemetry) and emits a single OTLP span over HTTP/protobuf.

No third-party deps beyond what ships with Python 3.8+, except for the
opentelemetry packages which are installed once (see README).

Install once:
    pip install opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
"""
from __future__ import annotations

import datetime
import hashlib
import os
import sys
import time
import json
import subprocess
from typing import IO, Any

# ── OTel imports ──────────────────────────────────────────────────────────────
try:
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import ConsoleSpanExporter, SimpleSpanProcessor
    from opentelemetry.sdk.trace.id_generator import RandomIdGenerator
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.trace import (
        NonRecordingSpan,
        SpanContext,
        SpanKind,
        StatusCode,
        TraceFlags,
        set_span_in_context,
    )
    _OTEL_AVAILABLE = True
except ImportError:
    _OTEL_AVAILABLE = False


def _get_exporter() -> "OTLPSpanExporter | None":
    if not _OTEL_AVAILABLE:
        return None
    if os.environ.get("OTEL_HOOKS_CONSOLE_EXPORT") == "1":
        return ConsoleSpanExporter()
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "").rstrip("/")
    if not endpoint:
        return None
    headers_raw = os.environ.get("OTEL_EXPORTER_OTLP_HEADERS", "")
    headers = dict(
        kv.split("=", 1) for kv in headers_raw.split(",") if "=" in kv
    )
    return OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces", headers=headers)


def derive_turn_ids(session_id: str, turn_id: str) -> "tuple[int, int]":
    """Deterministic (trace_id, root_span_id) for a turn.

    trace_id = first 16 bytes of sha256("{session_id}:{turn_id}"),
    root span_id = next 8 bytes. Zero ids are invalid in OTel, so map to 1.
    """
    digest = hashlib.sha256(f"{session_id}:{turn_id}".encode()).digest()
    trace_id = int.from_bytes(digest[:16], "big") or 1
    span_id = int.from_bytes(digest[16:24], "big") or 1
    return trace_id, span_id


class _PresetIdGenerator(RandomIdGenerator if _OTEL_AVAILABLE else object):
    """Returns the preset trace_id always, and the preset span_id exactly once
    (for the turn-root span); subsequent span ids are random (children)."""

    def __init__(self, trace_id: int, span_id: "int | None"):
        self._trace_id = trace_id
        self._span_id = span_id

    def generate_trace_id(self) -> int:
        return self._trace_id

    def generate_span_id(self) -> int:
        if self._span_id is not None:
            sid, self._span_id = self._span_id, None
            return sid
        return super().generate_span_id()

_STATE_DIR = os.path.expanduser("~/.cache/claude-hooks")


def _state_path(name: str) -> str:
    """Return the full path for a named state file in the per-user state dir."""
    return os.path.join(_STATE_DIR, name)


def _open_state_file(name: str) -> "IO[str]":
    """Open a state file for writing, safely against symlink pre-creation attacks.

    Uses O_NOFOLLOW so a pre-created symlink at the target path is refused
    rather than followed to an arbitrary destination.
    """
    os.makedirs(_STATE_DIR, mode=0o700, exist_ok=True)
    path = _state_path(name)
    flags = os.O_CREAT | os.O_WRONLY | os.O_TRUNC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags, 0o600)
    return os.fdopen(fd, "w")


def write_state(name: str, content: str) -> None:
    """Write a state file; failures are swallowed so hooks never block."""
    try:
        with _open_state_file(name) as f:
            f.write(content)
    except OSError:
        pass


def read_state(name: str) -> str:
    """Return a state file's contents (stripped), or "" if missing/unreadable."""
    try:
        with open(_state_path(name)) as f:
            return f.read().strip()
    except OSError:
        return ""


def pop_state(name: str) -> str:
    """Return a state file's contents and delete it; "" if missing/unreadable."""
    content = read_state(name)
    try:
        os.unlink(_state_path(name))
    except OSError:
        pass
    return content


def pop_state_int(name: str, default: int) -> int:
    """pop_state() parsed as int; `default` on missing/corrupt content."""
    try:
        return int(pop_state(name))
    except ValueError:
        return default


def tool_attrs(tool_name: str) -> dict[str, Any]:
    """Standard gen_ai.tool.* attributes for a tool name.

    MCP tools are named mcp__{server}__{action}; expose the parts so
    dashboards can group by server.
    """
    is_mcp = tool_name.startswith("mcp__")
    attrs: dict[str, Any] = {
        "gen_ai.tool.name": tool_name,
        "gen_ai.tool.type": "extension" if is_mcp else "function",
    }
    parts = tool_name.split("__")
    if is_mcp and len(parts) >= 3:
        attrs["gen_ai.tool.mcp_server"] = parts[1]
        attrs["gen_ai.tool.mcp_action"] = parts[2]
    return attrs


def log_debug(msg: str, component: str = "hook_stop") -> None:
    """Timestamped debug line to stderr and ~/.cache/claude-hooks/{component}.log."""
    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{component}] {msg}", file=sys.stderr)
    try:
        os.makedirs(_STATE_DIR, mode=0o700, exist_ok=True)
        with open(_state_path(f"{component}.log"), "a") as f:
            f.write(f"{ts} {msg}\n")
    except OSError:
        pass


def _is_ssh_remote(url: str) -> bool:
    """Return True only for SSH-shaped remotes (git@host:org/repo.git).

    HTTPS and other URL-scheme remotes may embed credentials in the URL, so we
    refuse to export them rather than risk a partial leak after redaction.
    """
    if "://" in url:
        return False
    at = url.find("@")
    colon = url.find(":")
    return 0 < at < colon


def get_git_context(cwd: str = "") -> dict[str, str]:
    """
    Returns git repo name and remote origin for the given working directory.
    Only emits attributes for SSH-shaped remotes; HTTPS and other origins are
    dropped entirely to prevent credential exfiltration via span attributes.
    """
    run_dir = cwd or os.getcwd()

    try:
        origin = subprocess.check_output(
            ["git", "remote", "get-url", "origin"],
            cwd=run_dir,
            stderr=subprocess.DEVNULL,
            timeout=2,
        ).decode().strip()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return {}

    if not _is_ssh_remote(origin):
        return {}

    repo_name = origin.rstrip("/")
    if repo_name.endswith(".git"):
        repo_name = repo_name[:-4]
    repo_name = repo_name.split(":")[-1].split("/")[-1]

    return {"git.origin": origin, "git.repo": repo_name}

def emit_spans(
    specs: "list[dict[str, Any]]",
    *,
    session_id: str = "",
    turn_id: str = "",
) -> None:
    """Emit one or more spans through a single TracerProvider.

    Each spec is a dict:
      name (str, required), attributes (dict, required),
      start_time_ns (int|None), end_time_ns (int|None),
      status_ok (bool, default True), error_message (str, default ""),
      error_type (str, default ""),
      turn_role: "root" | "child" | "standalone" (default "child")

    If turn_id is empty, every spec degrades to a standalone root span.
    If turn_id is set:
      - the "root" spec gets the derived (trace_id, span_id) via _PresetIdGenerator
      - "child" specs get a remote parent context pointing at the derived root
      - "standalone" specs get a random root as before
    """
    if not _OTEL_AVAILABLE:
        print(f"[otel_span] OTel not available — {len(specs)} span(s) not exported", file=sys.stderr)
        return
    exporter = _get_exporter()
    if exporter is None or not specs:
        return

    service_name = os.environ.get("OTEL_SERVICE_NAME", "claude-code")
    resource = Resource.create({
        "service.name": service_name,
        "gen_ai.system": "anthropic",        # deprecated; kept for back-compat
        "gen_ai.provider.name": "anthropic",  # current semconv name
    })

    parent_ctx = None
    id_generator = None
    if session_id and turn_id:
        trace_id, root_span_id = derive_turn_ids(session_id, turn_id)
        parent_ctx = set_span_in_context(NonRecordingSpan(SpanContext(
            trace_id=trace_id,
            span_id=root_span_id,
            is_remote=True,
            trace_flags=TraceFlags(0x01),
        )))
        if any(s.get("turn_role") == "root" for s in specs):
            id_generator = _PresetIdGenerator(trace_id, root_span_id)

    if id_generator is not None:
        provider = TracerProvider(resource=resource, id_generator=id_generator)
    else:
        provider = TracerProvider(resource=resource)
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer = provider.get_tracer("claude_code_hooks", "1.0.0")

    git_attrs = get_git_context(specs[0].get("attributes", {}).get("cwd", ""))
    now_ns = time.time_ns()

    # Root first: the preset span_id is consumed by the first parentless start_span.
    ordered = sorted(specs, key=lambda s: 0 if s.get("turn_role") == "root" else 1)
    for spec in ordered:
        attributes = {**git_attrs, **spec.get("attributes", {})}   # hook attrs win on collision

        # Sanitise: OTel attribute values must be str/int/float/bool or lists thereof
        clean: dict[str, Any] = {}
        for k, v in attributes.items():
            if isinstance(v, (str, int, float, bool)):
                clean[k] = v
            elif isinstance(v, (list, tuple)) and all(isinstance(x, (str, int, float, bool)) for x in v):
                clean[k] = list(v)
            elif v is None:
                clean[k] = ""
            else:
                clean[k] = str(v)

        if "session.id" in clean:
            clean["gen_ai.conversation.id"] = clean["session.id"]
        if "gen_ai.operation.name" in clean:
            # provider.name is the current semconv name (gen_ai.system is deprecated).
            clean.setdefault("gen_ai.provider.name", "anthropic")
            # Default to the top-level agent, but let spans (e.g. subagents) that
            # already set their own agent name keep it so the timeline can group them.
            clean.setdefault("gen_ai.agent.name", "Claude Code")

        start = spec.get("start_time_ns") or now_ns
        end = spec.get("end_time_ns") or now_ns
        role = spec.get("turn_role", "child")
        ctx = parent_ctx if (parent_ctx is not None and role == "child") else None

        span = tracer.start_span(
            spec["name"], context=ctx, kind=SpanKind.INTERNAL,
            start_time=start, attributes=clean,
        )
        if not spec.get("status_ok", True):
            error_message = spec.get("error_message", "")
            span.set_status(StatusCode.ERROR, error_message)
            span.add_event(
                "exception",
                {
                    "exception.type": spec.get("error_type", "") or "Error",
                    "exception.message": error_message,
                },
                timestamp=end,
            )
        else:
            span.set_status(StatusCode.OK)
        span.end(end_time=end)

    provider.force_flush(timeout_millis=3_000)
    provider.shutdown()


def emit_span(
    name: str,
    attributes: dict[str, Any],
    *,
    start_time_ns: int | None = None,
    end_time_ns: int | None = None,
    status_ok: bool = True,
    error_message: str = "",
    error_type: str = "",
    session_id: str = "",
    turn_id: str = "",
    turn_role: str = "child",
) -> None:
    """Fire-and-forget single span. Backwards compatible: callers that pass no
    session_id/turn_id get a standalone root span exactly as before."""
    emit_spans(
        [{
            "name": name, "attributes": attributes,
            "start_time_ns": start_time_ns, "end_time_ns": end_time_ns,
            "status_ok": status_ok, "error_message": error_message,
            "error_type": error_type, "turn_role": turn_role,
        }],
        session_id=session_id,
        turn_id=turn_id,
    )


def read_stdin() -> dict[str, Any]:
    """Read and parse the JSON that Claude Code sends on stdin."""
    try:
        return json.load(sys.stdin)
    except json.JSONDecodeError:
        print("[otel_span] stdin was not valid JSON; emitting empty-attrs span", file=sys.stderr)
        return {}


if __name__ == "__main__":
    # Quick smoke-test: python otel_span.py
    emit_span("test.hook", {"test": True, "note": "smoke test from otel_span.py"})
    print("Span emitted (or gracefully skipped).")
