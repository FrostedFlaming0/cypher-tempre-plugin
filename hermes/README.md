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

Hermes's `post_llm_call` and `subagent_stop` hooks are observers: they can
record an adherence failure but cannot re-enter the model loop. Consequently,
the plugin provides automatic wearing and best-effort enforcement, not the
hard bounded Stop gate available in Claude Code. The injected per-turn primer
remains responsible for seal-then-stream behavior.
