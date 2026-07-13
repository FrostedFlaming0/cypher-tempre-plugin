# openclaw-cypher-tempre

Cypher Tempre self-model integration for [OpenClaw](https://github.com/openclaw/openclaw).
Pairs with the `cypher-tempre-self-model` skill (install it from the genesis repo's
`skills/openclaw/` package; default location `~/.openclaw/skills/cypher-tempre-self-model`).

Two pieces, one plugin:

1. **A pinned-window context engine** (`cypher-tempre-window`) that replaces
   summarizing compaction. Every model run sees: the **first turn** (never
   drops) plus the most recent **`keepTurns`** turns (default 15) under a
   **`tokenCeiling`** (default 256k). The **previous turn and current turn
   never drop**. When the window is exceeded, only the minimum number of
   oldest non-pinned turns are evicted — the "16th turn" drops, nothing is
   summarized, and the on-disk transcript is never modified. The full wearing
   **primer** rides `systemPromptAddition` on every run (a constant string,
   so the system-prompt prefix stays prompt-cache-friendly).
2. **A per-turn reminder** appended near the user message via the
   `agent_turn_prepare` hook. The **first prepared turn of each session** also
   carries the **recent-memory digest** (`enforce.py rehydrate` — the last ~7
   sealed cognitive turns) in the same slot, so a fresh session is rehydrated,
   not merely primed. The digest is per-run content, so it rides here instead
   of the cache-stable primer; first turn only, fail-open (a missing skill,
   dead python, or dormant chain just means no digest).

`compact()` is owned by the engine and never summarizes: while the assembled
view fits, it reports the host-recognized `"below threshold"` /
`"nothing to compact"` skip; if a provider overflow reveals a smaller true
budget, it tightens a per-session budget override so the next assembly evicts
the minimum extra oldest turns.

## Install

```bash
openclaw plugins install -l /path/to/cypher-tempre-plugin/openclaw
```

Then select the engine and enable the plugin in `openclaw.json`:

```json5
{
  plugins: {
    slots: { contextEngine: "cypher-tempre-window" },
    entries: {
      "cypher-tempre": {
        enabled: true,
        config: {
          keepTurns: 15,        // recent turns kept (including current)
          tokenCeiling: 256000, // approx token ceiling for assembled context
          evictionBatch: 1,     // >1 trades a few turns of context for prompt-cache retention
          primer: true,         // constant primer via systemPromptAddition
          reminder: true,       // short per-turn reminder via agent_turn_prepare
          rehydrate: true,      // first-turn recent-memory digest (enforce.py rehydrate)
          // skillDir: "/custom/path/to/cypher-tempre-self-model",
        },
      },
    },
  },
}
```

Environment overrides: `CT_OCLAW_KEEP_TURNS`, `CT_OCLAW_TOKEN_CEILING`,
`CT_OCLAW_EVICTION_BATCH`, `CT_OCLAW_SKILL_DIR`, `CT_OCLAW_REHYDRATE=0`
(digest off; `CT_OCLAW_REHYDRATE_TIMEOUT_MS` / `CT_OCLAW_PYTHON` tune the
shell-out), and `CT_OCLAW_DISABLE=1` (turns off primer + reminder + digest;
the engine still windows).

### If you pin `plugins.allow`

OpenClaw's gateway warning suggests pinning trust via `plugins.allow`. That
list is an **exclusive allow-list**: once it is non-empty, any discovered
(non-bundled) plugin missing from it is **silently skipped at load — including
this one**. If you pin it, include every Cypher Tempre plugin id you use, plus
any other non-bundled plugins:

```json5
{ plugins: { allow: ["cypher-tempre", "cypher-tempre-enforcement"] } }
```

Leaving `plugins.allow` empty is also fine — the warning is informational. The
failure mode of an incomplete list is silent: the agent simply stops wearing
the skill (no primer, no per-turn reminder, no pinned window, no seal
enforcement) with no error.

## Semantics

- Turns group at user-message boundaries, so `tool_use`/`toolResult` pairs
  never split across the window edge.
- Eviction policy (one code path for assembly and compaction): pin first,
  previous, and current turns; evict the minimum number of oldest evictable
  turns until both `keepTurns` and the token budget hold.
- Conversations of three turns or fewer always pass through untouched — the
  pinned floor is an invariant, never a target.
- `evictionBatch > 1` rounds eviction up in batches so the window slides less
  often; with the default `1`, once a session passes `keepTurns` the window
  slides every turn, which breaks the provider prompt-cache prefix at the
  slide point each turn. That is the correct default for maximum context
  retention; raise it only if cache economics matter more than a few extra
  turns of context.
- A single pinned turn larger than the provider window cannot be fixed by
  eviction; the engine reports honestly rather than summarizing.

## Test

```bash
node --test test.mjs
```

No dependencies; the tests stub the plugin API and exercise the engine and
windowing logic directly.
