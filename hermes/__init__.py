"""Hermes lifecycle adapter for automatic Cypher Tempre wearing."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
from typing import Any


DEFAULT_SKILL_ROOT = Path.home() / ".hermes" / "skills" / "cypher-tempre-self-model"
_session_context: dict[str, str] = {}


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
    except (OSError, TypeError, subprocess.SubprocessError):
        return None


def _additional_context(stdout: str) -> str:
    try:
        value = json.loads(stdout)
        return str(value.get("hookSpecificOutput", {}).get("additionalContext", "")).strip()
    except (TypeError, ValueError):
        return ""


def _session_start(**kwargs: Any) -> None:
    session_id = str(kwargs.get("session_id") or "")
    result = _run("enforce.py", "session-start", payload=kwargs)
    if result and result.returncode == 0:
        context = _additional_context(result.stdout)
        if context:
            _session_context[session_id] = context


def _pre_llm_call(**kwargs: Any) -> dict[str, str] | None:
    session_id = str(kwargs.get("session_id") or "")
    payload = dict(kwargs)
    payload["prompt"] = str(kwargs.get("user_message") or "")
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
    _run("enforce.py", "stop-check", payload=kwargs)


def _subagent_stop(**kwargs: Any) -> None:
    _run("enforce.py", "subagent-check", payload=kwargs)


def register(ctx: Any) -> None:
    ctx.register_hook("on_session_start", _session_start)
    ctx.register_hook("pre_llm_call", _pre_llm_call)
    ctx.register_hook("post_llm_call", _post_llm_call)
    ctx.register_hook("subagent_stop", _subagent_stop)
