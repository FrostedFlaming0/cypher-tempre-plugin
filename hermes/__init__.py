"""Hermes lifecycle adapter for automatic Cypher Tempre wearing.

Keep this file byte-identical to its sibling copy (a parity test in each repo
guards the sync when both checkouts are present):

  cypher-tempre-plugin:  hermes/__init__.py
  cypher-tempre-genesis: skills/hermes/cypher-tempre-self-model/hermes-plugin/__init__.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
from typing import Any


DEFAULT_SKILL_ROOT = Path.home() / ".hermes" / "skills" / "cypher-tempre-self-model"

# Sessions already rehydrated in this process, and startup context waiting to
# ride into each session's next pre_llm_call. Both are bounded so a long-lived
# gateway process cannot grow them without limit.
_primed_sessions: set[str] = set()
_session_context: dict[str, str] = {}
_MAX_PENDING_CONTEXT = 64
_MAX_PRIMED_SESSIONS = 4096

# Scalar fields forwarded to enforce.py. conversation_history is deliberately
# excluded: enforce.py never reads it, serializing whole histories is per-turn
# overhead, and one non-JSON-serializable message would abort _run and
# silently drop the turn's priming context.
_PAYLOAD_FIELDS = (
    "session_id",
    "task_id",
    "turn_id",
    "is_first_turn",
    "model",
    "platform",
    "sender_id",
)


def _skill_root() -> Path:
    return Path(os.environ.get("CT_HERMES_SKILL_DIR", DEFAULT_SKILL_ROOT)).expanduser().resolve()


def _chain_root() -> Path:
    configured = os.environ.get("CT_ENFORCE_ROOT") or os.environ.get("CT_HERMES_CHAIN_ROOT")
    return Path(configured).expanduser().resolve() if configured else _skill_root()


def _timeout() -> float:
    try:
        return max(0.25, min(float(os.environ.get("CT_HERMES_TIMEOUT", "8")), 30.0))
    except ValueError:
        return 8.0


def _payload(kwargs: dict[str, Any], **extra: str) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    for field in _PAYLOAD_FIELDS:
        value = kwargs.get(field)
        if isinstance(value, (str, int, float, bool)):
            payload[field] = value
    payload.update(extra)
    return payload


def _run(script: str, *args: str, payload: dict[str, Any] | None = None) -> subprocess.CompletedProcess[str] | None:
    path = _skill_root() / script
    if not path.is_file():
        return None
    env = os.environ.copy()
    env["CT_ENFORCE_ROOT"] = str(_chain_root())
    try:
        return subprocess.run(
            [os.environ.get("CT_HERMES_PYTHON", "python3"), str(path), *args, "--root", str(_chain_root())],
            input=json.dumps(payload or {}),
            text=True,
            capture_output=True,
            timeout=_timeout(),
            check=False,
            env=env,
            cwd=str(_skill_root()),
        )
    except (OSError, TypeError, ValueError, subprocess.SubprocessError):
        return None


def _additional_context(stdout: str) -> str:
    try:
        value = json.loads(stdout)
        return str(value.get("hookSpecificOutput", {}).get("additionalContext", "")).strip()
    except (TypeError, ValueError):
        return ""


def _remember_context(session_id: str, context: str) -> None:
    if len(_session_context) >= _MAX_PENDING_CONTEXT:
        _session_context.pop(next(iter(_session_context)))
    _session_context[session_id] = context


def _prime_session(session_id: str, payload: dict[str, Any]) -> None:
    """Run session-start rehydration once per session per process.

    A session is marked primed only on a clean exit, so a transient failure
    (timeout, skill missing mid-update, nonzero exit) is retried on the
    session's next turn instead of losing rehydration until process restart.
    A clean exit with empty context (e.g. a dormant chain) still counts as
    primed — re-running session-start every turn would gain nothing.
    """
    if session_id in _primed_sessions:
        return
    result = _run("enforce.py", "session-start", payload=payload)
    if not result or result.returncode != 0:
        return
    if len(_primed_sessions) >= _MAX_PRIMED_SESSIONS:
        _primed_sessions.clear()
    _primed_sessions.add(session_id)
    context = _additional_context(result.stdout)
    if context:
        _remember_context(session_id, context)


def _session_start(**kwargs: Any) -> None:
    _prime_session(str(kwargs.get("session_id") or ""), _payload(kwargs))


def _pre_llm_call(**kwargs: Any) -> dict[str, str] | None:
    session_id = str(kwargs.get("session_id") or "")
    # Hermes fires on_session_start only for brand-new sessions; a resumed
    # session reaches its first turn unprimed, so rehydrate from here too.
    _prime_session(session_id, _payload(kwargs))
    payload = _payload(kwargs, prompt=str(kwargs.get("user_message") or ""))
    result = _run("enforce.py", "user-prompt", payload=payload)
    parts: list[str] = []
    startup = _session_context.pop(session_id, "")
    if startup:
        parts.append(startup)
    if result and result.returncode == 0:
        prompt_context = _additional_context(result.stdout)
        if prompt_context:
            parts.append(prompt_context)
    return {"context": "\n\n".join(parts)} if parts else None


def _post_llm_call(**kwargs: Any) -> None:
    # Hermes observer hooks cannot continue the model loop.  Record the actual
    # verdict for telemetry, but leave seal-then-stream to the injected primer.
    _run("enforce.py", "stop-check", payload=_payload(kwargs))
    # A session whose startup context never rode a turn should not pin it.
    _session_context.pop(str(kwargs.get("session_id") or ""), None)


def _subagent_stop(**kwargs: Any) -> None:
    _run("enforce.py", "subagent-check", payload=_payload(kwargs))


def register(ctx: Any) -> None:
    ctx.register_hook("on_session_start", _session_start)
    ctx.register_hook("pre_llm_call", _pre_llm_call)
    ctx.register_hook("post_llm_call", _post_llm_call)
    ctx.register_hook("subagent_stop", _subagent_stop)
