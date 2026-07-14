# Changelog

Three plugins live in this repo and version independently: `opencode/`
(package `1.x`), `openclaw/` (package `0.x`), and `hermes/` (package `0.x`).
Entries are newest-first within each section.

## Hermes plugin

### v0.3.1 — 2026-07-14

Window budget accounts for the pinned prefix (Codex review finding): the
tail-turn allowance is now 60% of the trigger threshold minus the estimated
cost of the pinned system prompt and first user message, so a reducible
transcript always lands below the trigger after one trim instead of
remaining oversized and turning every later truncation into a no-op (which
let Hermes churn preflight compression into a provider context-limit
error). The newest turn still always survives; a pinned prefix plus one
turn that together exceed the threshold is irreducible by design.
Regression tests cover the reducible-below-trigger guarantee (including a
large first user message), trim idempotence, and the irreducible case.

### v0.3.0 — 2026-07-14

Pinned-window context engine — the OpenCode/OpenClaw context discipline,
native on Hermes. `PinnedWindowEngine` implements Hermes's pluggable
`ContextEngine` interface with pure truncation (no compaction, no LLM
summaries): pin the system prompt and first user message, keep the newest
`CT_HERMES_KEEP_TURNS` turns (default 15) under a `CT_HERMES_TOKEN_CEILING`
budget (default 256k), always keep the newest turn, and evict whole turns so
tool call/result pairs never split. Registered automatically but inert until
`context.engine: cypher-tempre-window` is set in config. When active, the
session priming carries the context-discipline instruction (truncated
context is forgotten — seal and recall). Hermes-native trigger semantics:
the window is enforced lazily at the token threshold
(min(ceiling, 75% of model context)), and the post-trim session rotation is
handled by the existing re-prime path. Engine state is plain Python, safe
for Hermes's per-agent deepcopy. README documents activation, tuning, and
the differences from the per-request OpenCode window.

### v0.2.1 — 2026-07-14

Failed rehydration is retried (Codex review finding): a session is marked
primed only after `session-start` exits cleanly, so a transient failure —
timeout, skill missing mid-update, nonzero exit — retries on the session's
next turn instead of losing rehydration until the process restarts. A clean
exit with empty context (dormant chain) still counts as primed, so
`session-start` never re-runs every turn. Worst case while broken is one
extra bounded attempt per turn; a missing skill short-circuits on a stat
check with no subprocess.

### v0.2.0 — 2026-07-14

Resumed-session rehydration and hardened hook plumbing. `pre_llm_call` now
rehydrates any session it has not seen this process (Hermes fires
`on_session_start` only for brand-new sessions, so resumed sessions previously
reached their first turn unprimed). Hook payloads forward only the scalar
fields `enforce.py` reads — `conversation_history` is excluded, so a
non-serializable message can no longer abort the subprocess and silently drop
the turn's priming context. The startup-context and primed-session caches are
bounded, `post_llm_call` drops startup context that never rode a turn, and a
bad `CT_HERMES_TIMEOUT` falls back to 8s (clamped to 0.25–30s) instead of
silently disabling the plugin. `__init__.py` is now byte-identical with the
genesis bundle copy, guarded by a parity test in each repo.

### v0.1.0 — 2026-07-14

Initial Hermes lifecycle plugin: `on_session_start` startup rehydration,
`pre_llm_call` per-turn marking and priming, `post_llm_call` /
`subagent_stop` adherence observation. Observer post-turn hooks mean
best-effort enforcement, not a hard Stop gate.

## OpenCode plugin

### v1.2.0 — 2026-07-13

First-turn rehydration: the first user message of each session now carries
the recent-memory digest (`enforce.py rehydrate` — the newest ~7 sealed
cognitive turns) beside the full priming, so a fresh session is rehydrated,
not merely primed. Recency restores continuity (unfinished threads, standing
claims) that relevance recall cannot reach at turn 0. First message only;
fail-open through the existing `runEnforce` timeout path — a missing skill,
dead python, or dormant chain just means no digest.

### v1.1.1 — 2026-07-13

Nudge echoes are authenticated, not pattern-matched: each nudge carries a
per-send random nonce, and only an exact match against the session's
outstanding expected text is treated as our own nudge echoing back. A message
that merely copies the public sentinel is ordinary user input — marked,
reminded, and trajectory-stamped like any other.

### v1.1.0 — 2026-07-13

Active nudge — the missing Stop-hook, one layer up. OpenCode events are
post-hoc (by `session.status: idle` the turn has already ended), so the
plugin converts the notification into a bounded re-prompt: `chat.message`
runs `enforce.py mark` as the turn-head baseline; on idle, `enforce.py
stop-check` runs, and a block verdict is sent back into the session as one
follow-up user message via the client SDK. Bounded twice (enforce.py's nudge
budget plus `CT_OC_MAX_NUDGES`), fail-open everywhere. README companions:
single-active-session-per-chain constraint (subagent child sessions count)
and the note that chainless instrument sessions are not supported on
OpenCode.

### v1.0.x — 2026-07-04 → 2026-07-08

Initial releases: user-voice self-model priming appended to the first user
message (full wearing header + fork doctrine) with a short reminder on every
subsequent one; first-user-message-pinned context truncation (keep-turns +
token ceiling, default 256k, oldest-first clipping); hermetic tests via
`CT_OC_STATE_FILE`/`CT_OC_LOG_FILE`; `plugins/` install path;
`turn_trajectory` stamping for training-export binding; Continuum bulk-mode
note in the priming; identity-separation docs
(`OPENCODE_DISABLE_CLAUDE_CODE`); MIT license.

## OpenClaw plugin

### v0.2.0 — 2026-07-13

First-turn rehydration: the first prepared turn of each session carries the
recent-memory digest (`enforce.py rehydrate`) via `agent_turn_prepare`,
ahead of the per-turn reminder. The digest is per-run content, so it rides
near the user message while the PRIMER stays a constant, prompt-cache-stable
`systemPromptAddition`. Once per session (in-process gate; unkeyed sessions
never rehydrate — better a missed digest than one re-injected every turn),
one fetch attempt per session, fail-open. Knobs: config `rehydrate`,
`CT_OCLAW_REHYDRATE=0`, `CT_OCLAW_REHYDRATE_TIMEOUT_MS`, `CT_OCLAW_PYTHON`.

### v0.1.0 — 2026-07-08

Initial release: pinned-window context engine (`cypher-tempre-window`) that
replaces summarizing compaction — first turn pinned, most recent `keepTurns`
kept under a token ceiling, minimum-eviction of oldest turns, on-disk
transcript never modified; constant wearing PRIMER as
`systemPromptAddition`; per-turn REMINDER via `agent_turn_prepare`; plain
entry object (top-level await breaks the gateway's jiti load path); README
documents the `plugins.allow` exclusive-list trap (pin all or pin none).
