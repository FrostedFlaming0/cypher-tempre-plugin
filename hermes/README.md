# Cypher Tempre for Hermes

This plugin automatically primes every Hermes session with the Cypher Tempre
self-model, marks every user turn, injects bounded rehydration, and records
turn/subagent adherence through Hermes's native plugin hooks.

## Install

Install the Hermes skill first, then copy this directory and enable it:

```sh
cp -r hermes ~/.hermes/plugins/cypher-tempre
hermes plugins enable cypher-tempre
```

Restart Hermes after enabling the plugin. The default skill location is
`~/.hermes/skills/cypher-tempre-self-model`; override it with
`CT_HERMES_SKILL_DIR`. `CT_HERMES_CHAIN_ROOT` selects a separate writable chain
root, and `CT_HERMES_PYTHON` selects the Python executable.

Rehydration covers resumed sessions too: Hermes fires `on_session_start` only
for brand-new sessions, so the plugin also rehydrates from a session's first
`pre_llm_call` (once per session per process). Hook payloads forward only the
scalar fields `enforce.py` reads — never `conversation_history`.

Hermes's `post_llm_call` and `subagent_stop` hooks are observers: they can
record an adherence failure but cannot re-enter the model loop. Consequently,
the plugin provides automatic wearing and best-effort enforcement, not the
hard bounded Stop gate available in Claude Code. The injected per-turn primer
remains responsible for seal-then-stream behavior.

`__init__.py` is kept byte-identical with
`skills/hermes/cypher-tempre-self-model/hermes-plugin/__init__.py` in the
genesis repo; a parity test in each repo guards the sync.

## Pinned-window context engine (no compaction, only truncation)

The plugin ships a `ContextEngine` that replaces Hermes's summarizing
compressor with pure truncation, matching the OpenCode/OpenClaw plugins:
the system prompt and the first user message are pinned, the most recent
`CT_HERMES_KEEP_TURNS` turns (default 15) are kept under a
`CT_HERMES_TOKEN_CEILING` estimated-token budget (default 256000), the
newest turn always survives, and a turn — a user message plus everything up
to the next user message — is evicted whole, so tool call/result pairs never
split. Registration alone is inert; activate it with:

```sh
hermes config set context.engine cypher-tempre-window
```

When active, the per-session priming gains a context-discipline instruction
(truncated context is forgotten — seal to the chain and recall, don't
assume). Two Hermes-specific behaviors to know: truncation fires when tokens
cross Hermes's threshold (a lazy window — turns beyond 15 may linger until
token pressure), and Hermes rotates to a child session after each trim, which
this plugin handles by re-priming the new session id. Deactivate with
`hermes config set context.engine compressor`.

## Disable Hermes's competing self-improvement features

The skill is itself a governed self-improvement system (Cambium growth,
PoQ-gated seals), so disable Hermes's parallel mechanisms — both compete with
the chain and the background one also trips this plugin's hooks:

```yaml
# ~/.hermes/config.yaml
memory:
  memory_enabled: false          # the chain is the durable memory
skills:
  creation_nudge_interval: 0     # no silent background skill-review forks
```

With a positive interval (default 10), Hermes forks the agent after
tool-heavy turns, replays the conversation under the same session id, and
updates the skill library unprompted — an ungated, unsealed self-modification
that also fires `pre_llm_call`/`post_llm_call` like a real turn, clobbering
the enforcement baseline and leaving phantom adherence nudges. The skill
bundle's README documents the full mechanism and softer alternatives
(`skills.write_approval: true`).
