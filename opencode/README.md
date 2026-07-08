# Cypher Tempre — OpenCode Plugin

An [OpenCode](https://opencode.ai) plugin that makes an agent **wear the
[Cypher Tempre self-model](https://github.com/FrostedFlaming0/cypher-tempre-genesis)
automatically on every session**, and keeps context **lean and free of compaction**
by truncating to the first user message plus the most recent turns.

Verified against OpenCode 1.17.14.

> **Also in this repo:** [`../openclaw/`](../openclaw/) — the same wearing +
> pinned-window design as an [OpenClaw](https://github.com/openclaw/openclaw)
> plugin, implemented as a context engine that replaces summarizing compaction
> outright.

## Why

Two observations drive the design:

1. **Agents obey user prompts; they disobey hooks.** Instruction text injected as
   harness metadata (system reminders, hook nudges) gets second-guessed — agents
   will openly criticize it as ceremony and skip it. Text inside the *user's own
   message* carries user-voice authority and is honored. So this plugin appends
   the self-model instruction to the user message itself via the `chat.message`
   hook, not as system-level decoration.
2. **Compaction is lossy; the Timechain is not.** The self-model seals every
   meaningful turn to an append-only, hash-chained ledger — so old turns don't
   need summarizing. They can simply fall out of context, and the agent recalls
   them verbatim from the chain when relevant. This plugin therefore disables
   nothing-survives-verbatim compaction entirely and instead shapes each request
   to: **first user message (pinned) + last N turns (or fewer under a token
   ceiling)**.

## How it works

The plugin registers two server hooks:

### `chat.message` — prompt injection, user-voice

Fires on every new user message, before the model call.

- **First message of a session**: appends the **full priming** (~4 KB) — the
  wearing header (run the per-turn loop via `recall.py turn`, route first via
  `router.py route`, supply your own PoQ scores, declare `--used-rings`
  evidence), the four-tier chronosynaptic fork doctrine, and the context
  discipline ("context truncates; the chain is your memory — seal every turn,
  recall instead of assuming").
- **Every subsequent message**: appends a short **reminder** (~0.5 KB) — run the
  loop, seal before ending, route task-shaped requests, fork on genuine
  decisions.

The text is appended to the last non-synthetic text part of the message, so it
is persisted with the message and survives in the pinned first user message.
Primed
session IDs are stored in `~/.config/opencode/cypher-tempre-primed.json`
(capped at 500), so a server restart does not re-prime an existing session.
Subagent sessions get primed automatically — child sessions are sessions.

### `experimental.chat.messages.transform` — truncation, per-request

Fires immediately before messages are converted for the model, on every step.

- Pins the **first user message** (it carries the full priming).
- Walking backward from the end, keeps whole turns while **both** limits hold:
  at most `KEEP_TURNS` turns, and at most `TOKEN_CEILING` estimated tokens.
  Whichever bites first wins — a chat-heavy session keeps all N turns; a
  tool-heavy coding session truncates earlier by budget.
- A **turn** is a user message plus everything up to the next user message, so
  assistant tool_use/tool_result pairs are never split.
- The most recent turn is always kept, even if it alone exceeds the ceiling.
- Only the per-request view is shaped. **Session storage is untouched** — the
  full history remains on disk and in the TUI.

Token counts are estimated as `JSON length / 4` per message — crude but
consistent; set the ceiling with headroom below your model's context limit.

## Install

1. **Install the Cypher Tempre skill** for the OpenCode agent (its own identity,
   separate from any other agent's chain):

   ```sh
   # from a cypher-tempre-genesis checkout
   mkdir -p ~/.opencode/skills
   cp -r skills/claude/cypher-tempre-self-model ~/.opencode/skills/
   cd ~/.opencode/skills/cypher-tempre-self-model
   python3 timechain.py init --name <AgentName>   # fresh genesis — histories don't transfer
   ```

2. **Install the plugin** (global plugins auto-load from the config dir):

   ```sh
   mkdir -p ~/.config/opencode/plugins
   cp cypher-tempre.js ~/.config/opencode/plugins/
   ```

   `plugins/` (plural) is the directory the OpenCode docs document; as of
   1.17.14 the loader scans both `plugin/` and `plugins/`, but prefer the
   documented one.

3. **Disable built-in compaction** so it never races the truncation, and
   (optionally) register the skill directory so it appears as a first-class
   skill in OpenCode's skill tool — in `~/.config/opencode/opencode.json`
   (or `.jsonc`):

   ```jsonc
   {
     "compaction": { "auto": false },
     "skills": { "paths": ["~/.opencode/skills"] }
   }
   ```

   The `skills.paths` entry is optional — the injected prompt already names
   the skill by absolute path — but it lets the agent discover the skill
   natively too.

4. **Keep agent identities separate.** OpenCode ships Claude Code compat
   features that auto-load `~/.claude/CLAUDE.md` into the system prompt and
   scan `~/.claude/skills/**` for skills. If a Cypher Tempre skill (or any
   other agent's instructions) lives under `~/.claude`, the OpenCode agent
   would discover *that* copy — and its Timechain — instead of its own,
   violating the one-agent-one-chain boundary. Disable the compat layer in
   your shell profile:

   ```sh
   export OPENCODE_DISABLE_CLAUDE_CODE=1
   ```

   (Narrow variants exist: `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` /
   `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`.) Note OpenCode has no
   auto-memory of its own to turn off — unlike Claude Code, whose
   `autoMemoryEnabled` should be `false` when the Timechain is the single
   source of truth; these env vars are the OpenCode-side equivalent hygiene.

5. Verify: start a session with `CT_OC_DEBUG=1` and check
   `~/.config/opencode/cypher-tempre.log` for `appended FULL_PRIMING` /
   `messages.transform` lines. End-to-end proof: after a session, run
   `python3 ~/.opencode/skills/cypher-tempre-self-model/timechain.py stat` —
   if the ring height grew, the agent is wearing the skill.

## Trajectory stamping (training export)

On every user turn the plugin stamps `turn_trajectory` —
`{session_db, session_id, message_id_start}` — into the skill's
`chain/.enforce.json`. The skill's seal binds the turn's ring to that pointer
(`trajectory_ref`), and `training.py export --with-trajectory` in the skill
repo resolves it into the turn's redacted tool-event slice straight from the
OpenCode sqlite store. Fail-open: no db, no stamp, never a blocked turn.

## Knobs

All configuration is via environment variables (read at plugin load):

| Variable | Default | Effect |
|---|---|---|
| `CT_OC_KEEP_TURNS` | `15` | Max full turns kept in the per-request context (plus the pinned first user message) |
| `CT_OC_TOKEN_CEILING` | `256000` | Approximate token budget for kept turns; truncation starts earlier than `KEEP_TURNS` when exceeded |
| `CT_OC_SKILL_DIR` | `~/.opencode/skills/cypher-tempre-self-model` | Skill location referenced in the injected prompts |
| `CT_OC_DISABLE` | unset | `1` disables both hooks (plugin stays loaded, does nothing) |
| `CT_OC_DEBUG` | unset | `1` appends hook activity to the log file |
| `CT_OC_STATE_FILE` | `~/.config/opencode/cypher-tempre-primed.json` | Where primed session IDs are stored (tests point this at a temp dir) |
| `CT_OC_LOG_FILE` | `~/.config/opencode/cypher-tempre.log` | Debug log path |
| `CT_SESSION_DB` | `~/.local/share/opencode/opencode.db` | Sqlite session store stamped into each turn's `turn_trajectory` (training-export binding) |
| `CT_OC_NO_TRAJECTORY` | unset | `1` disables the per-turn trajectory stamp |

Sizing `CT_OC_TOKEN_CEILING`: leave headroom below the model's context limit
for the system prompt, output tokens, and estimator error (roughly ±30%). The
256k default suits a 1M-context model with generous headroom; for a
225k-context model with 24k output, set it around 180k.

Truncation order when the ceiling bites: turns drop **oldest-first** — the
15th-most-recent turn goes first, then the 14th, and so on toward the present.
Two exemptions: the **first user message of the session** (pinned — never
dropped; it rides outside the token budget entirely) and the **most recent
turn** (always kept, even if it alone exceeds the ceiling). Kept turns are
always contiguous — no holes.

## Testing

```sh
node test.mjs
```

Tests are hermetic: the end-to-end block points `CT_OC_STATE_FILE` at a temp
dir, so real OpenCode state is never touched.

Covers: append targeting (last non-synthetic text part), first-vs-subsequent
priming, primed-state persistence across plugin reloads, turn-count truncation,
token-ceiling truncation, oversized-last-turn safety, turn-boundary integrity
(tool pairs never split), in-place splice through the transform hook, and the
loader contract (see below).

## Gotchas

- **The loader requires every module export to be a plugin function.** This
  file exports exactly one function (`CypherTempre`); test internals ride as
  properties on it. Adding a plain `export const` of a string or object will
  break the load with `Plugin export is not a function`.
- **`experimental.chat.messages.transform` is an unstable API** (the prefix is
  the warning). Pin your OpenCode version or re-run `node test.mjs` and a
  `CT_OC_DEBUG=1` smoke session after upgrades.
- **Auth store beats environment.** If a provider key fails despite a valid
  env var, check `~/.local/share/opencode/auth.json` — a stale stored key takes
  precedence. Fix with `opencode auth login`.
- The injected text is visible in the transcript as part of your message — by
  design (that's the authority mechanism), and delimited with
  `[Cypher Tempre — standing instruction …]` so provenance stays honest.

## Uninstall

```sh
rm ~/.config/opencode/plugins/cypher-tempre.js \
   ~/.config/opencode/cypher-tempre-primed.json \
   ~/.config/opencode/cypher-tempre.log
```

and re-enable compaction in `opencode.json` if desired. The skill directory and
its chain are independent — remove separately if you mean it (the chain is the
agent's memory and identity; deleting it is permanent).
