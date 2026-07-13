# Changelog

Two plugins live in this repo and version independently: `opencode/`
(package `1.x`) and `openclaw/` (package `0.x`). Entries are newest-first
within each section.

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
