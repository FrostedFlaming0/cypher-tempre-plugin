# Cypher Tempre — host plugins

Host-side plugins that make an agent **wear the
[Cypher Tempre self-model](https://github.com/FrostedFlaming0/cypher-tempre-genesis/tree/feat/composability-and-op-trigger)
automatically**. The skill gives an agent a Timechain: an append-only,
hash-chained ledger of its own cognitive turns — persistent, tamper-evident
memory and identity, a Proof-of-Qualia conscience gate, and faculties that
grow with experience. These plugins make the wearing automatic and keep the
host's context management from fighting the chain.

The OpenCode and OpenClaw plugins provide three complementary behaviors:

1. **Primer, automatically.** The full wearing instruction (run the per-turn
   loop, route before reasoning, seal every meaningful turn) is injected at
   the start of every session — no manual prompting.
2. **Reminder, every turn.** A short nudge rides each subsequent turn so long
   sessions never drift out of the loop.
3. **Windowed context instead of compaction.** Summarizing compaction is
   lossy exactly where the chain needs fidelity — so it is replaced with a
   pinned window: the **first turn** plus the most recent **N turns**
   (default 15) under a **token ceiling** (default 256k). The first turn and
   the previous turn never drop; eviction only removes the minimum number of
   oldest turns. Old turns don't need summarizing: the agent seals every
   meaningful turn to its chain and recalls them verbatim when relevant.

The Hermes plugin uses native lifecycle events for startup rehydration,
per-turn priming/marking, and adherence observation. Hermes does not currently
expose a general continuation-capable Stop hook, so it does not claim hard
Stop parity or replace context compaction.

The pairing is the point: each plugin makes the agent wear the skill and
that dropped context is *recoverable* (sealed rings, `recall.py`), while the
skill gives the dropped-from-context past a durable, verifiable home. Neither
alone achieves persistent identity; together the context window becomes a
sliding view over a permanent memory.

## The plugins

| Directory | Host | Mechanism |
|---|---|---|
| [`opencode/`](opencode/) | [OpenCode](https://opencode.ai) | `chat.message` user-voice injection + `experimental.chat.messages.transform` truncation |
| [`openclaw/`](openclaw/) | [OpenClaw](https://github.com/openclaw/openclaw) | Context engine (`plugins.slots.contextEngine`, `ownsCompaction`) + `agent_turn_prepare` reminder |
| [`hermes/`](hermes/) | [Hermes Agent](https://github.com/NousResearch/hermes-agent) | Native session/pre-LLM hooks for startup rehydration, per-turn marking, and adherence observation |

See each directory's README for install steps, knobs, and host-specific
semantics. The JavaScript plugins are dependency-free ESM; the Hermes adapter
is stdlib-only Python.

## Install the skill first

Each host agent needs its own skill install (and its own chain — fresh
genesis; histories don't transfer between agents):

```sh
# from a cypher-tempre-genesis checkout — pick the host's skill package
cp -r skills/claude/cypher-tempre-self-model  ~/.opencode/skills/    # OpenCode
cp -r skills/openclaw/cypher-tempre-self-model ~/.openclaw/skills/   # OpenClaw
cp -r skills/hermes/cypher-tempre-self-model ~/.hermes/skills/       # Hermes

cd <installed skill dir>
python3 timechain.py init --name <AgentName>   # once — fresh genesis
```

Per-host skill packages (claude, codex, hermes, nanoclaw, openclaw) live in the
genesis repo under
[`skills/`](https://github.com/FrostedFlaming0/cypher-tempre-genesis/tree/feat/composability-and-op-trigger/skills).

## License

MIT
