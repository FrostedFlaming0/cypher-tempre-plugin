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

ENGINE_NAME = "cypher-tempre-window"

CONTEXT_DISCIPLINE = (
    "Context discipline: this session truncates context to the pinned first "
    "user message plus the most recent turns — there is no compaction. "
    "Anything not sealed to the chain will be forgotten; the chain is your "
    "durable memory. Seal every meaningful turn, and recall (recall.py "
    "index / grep / retrieve) instead of assuming you remember earlier "
    "context."
)

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


def _window_engine_selected() -> bool:
    """True when config.yaml selects this bundle's pinned-window engine."""
    try:
        import yaml

        home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")).expanduser()
        config = yaml.safe_load((home / "config.yaml").read_text()) or {}
        return (config.get("context") or {}).get("engine") == ENGINE_NAME
    except Exception:
        return False


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
    if _window_engine_selected():
        context = f"{context}\n\n{CONTEXT_DISCIPLINE}" if context else CONTEXT_DISCIPLINE
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


try:
    from agent.context_engine import ContextEngine as _ContextEngineBase
except Exception:  # outside a Hermes process (e.g. tests)
    _ContextEngineBase = object


class PinnedWindowEngine(_ContextEngineBase):
    """Pinned-window truncation: no compaction, ever.

    Pins the system prompt and the first user message, keeps the most recent
    ``CT_HERMES_KEEP_TURNS`` turns (a turn = a user message and everything up
    to the next user message, so tool call/result pairs never split) under a
    ``CT_HERMES_TOKEN_CEILING`` estimated-token budget, and always keeps the
    newest turn. Ports the OpenCode plugin's truncateMessages semantics onto
    Hermes's ContextEngine interface. Trigger timing is Hermes's: truncation
    fires when tokens cross the threshold (lazy window), not per request.

    Holds only plain-Python state, so Hermes's per-agent deepcopy is safe.
    """

    threshold_percent = 0.75

    def __init__(self) -> None:
        self.keep_turns = max(1, int(os.environ.get("CT_HERMES_KEEP_TURNS", "15") or 15))
        self.token_ceiling = max(1000, int(os.environ.get("CT_HERMES_TOKEN_CEILING", "256000") or 256000))
        self.last_prompt_tokens = 0
        self.last_completion_tokens = 0
        self.last_total_tokens = 0
        self.last_real_prompt_tokens = 0
        self.threshold_tokens = self.token_ceiling
        self.context_length = 0
        self.compression_count = 0
        self.protect_first_n = 1
        self.protect_last_n = 2

    @property
    def name(self) -> str:
        return ENGINE_NAME

    def update_from_response(self, usage: dict[str, Any]) -> None:
        self.last_prompt_tokens = int(usage.get("prompt_tokens") or 0)
        self.last_completion_tokens = int(usage.get("completion_tokens") or 0)
        self.last_total_tokens = int(usage.get("total_tokens") or 0)
        self.last_real_prompt_tokens = self.last_prompt_tokens

    def update_model(self, model: str, context_length: int, **_kwargs: Any) -> None:
        self.context_length = int(context_length or 0)
        derived = int(self.context_length * self.threshold_percent) if self.context_length else 0
        self.threshold_tokens = min(self.token_ceiling, derived) if derived else self.token_ceiling

    def should_compress(self, prompt_tokens: int = None) -> bool:
        return bool(prompt_tokens) and self.threshold_tokens > 0 and prompt_tokens >= self.threshold_tokens

    def has_content_to_compress(self, messages: list) -> bool:
        return len(self._truncate(messages)) < len(messages)

    def on_session_reset(self) -> None:
        self.last_prompt_tokens = 0
        self.last_completion_tokens = 0
        self.last_total_tokens = 0
        self.last_real_prompt_tokens = 0
        self.compression_count = 0

    @staticmethod
    def _estimate(message: dict[str, Any]) -> int:
        try:
            return len(json.dumps(message, default=str)) // 4 + 20
        except Exception:
            return 20

    def _window_budget(self) -> int:
        # Land comfortably under the trigger threshold so a trim never
        # immediately re-triggers; the turn cap usually dominates anyway.
        if self.threshold_tokens and self.threshold_tokens < self.token_ceiling:
            return max(1000, int(self.threshold_tokens * 0.6))
        return self.token_ceiling

    def _truncate(self, messages: list) -> list:
        user_idx = [i for i, m in enumerate(messages) if isinstance(m, dict) and m.get("role") == "user"]
        if len(user_idx) <= 1:
            return messages
        first_user = user_idx[0]
        budget = self._window_budget()

        tail_start = len(messages)
        total = 0
        turns = 0
        for k in range(len(user_idx) - 1, -1, -1):
            start = user_idx[k]
            end = user_idx[k + 1] if k + 1 < len(user_idx) else len(messages)
            cost = sum(self._estimate(messages[i]) for i in range(start, end))
            if turns >= 1 and (turns + 1 > self.keep_turns or total + cost > budget):
                break
            tail_start = start
            total += cost
            turns += 1

        if tail_start <= first_user + 1:
            return messages
        return list(messages[: first_user + 1]) + list(messages[tail_start:])

    def compress(self, messages: list, current_tokens: int = None, focus_topic: str = None, force: bool = False) -> list:
        result = self._truncate(messages)
        if len(result) < len(messages):
            self.compression_count += 1
        return result


def create_context_engine() -> Any:
    """Build the engine when running inside Hermes; None elsewhere."""
    if _ContextEngineBase is object:
        return None
    return PinnedWindowEngine()


def register(ctx: Any) -> None:
    ctx.register_hook("on_session_start", _session_start)
    ctx.register_hook("pre_llm_call", _pre_llm_call)
    ctx.register_hook("post_llm_call", _post_llm_call)
    ctx.register_hook("subagent_stop", _subagent_stop)
    # Optional pinned-window context engine — active only when config.yaml
    # sets context.engine: cypher-tempre-window. Registration alone is inert.
    try:
        engine = create_context_engine()
        if engine is not None and hasattr(ctx, "register_context_engine"):
            ctx.register_context_engine(engine)
    except Exception:
        pass
