/**
 * Cypher Tempre — OpenClaw integration.
 *
 * Registers two things:
 *
 * 1. A CONTEXT ENGINE ("cypher-tempre-window", select via
 *    plugins.slots.contextEngine) that replaces summarizing compaction with a
 *    pinned window: the first turn plus the most recent `keepTurns` turns
 *    (default 15) up to `tokenCeiling` (default 256k). The first turn and the
 *    previous turn never drop. Eviction removes the minimum number of oldest
 *    turns only. The engine also carries the PRIMER as a constant
 *    systemPromptAddition on every run.
 *
 * 2. An `agent_turn_prepare` hook that appends a short per-turn REMINDER near
 *    the user message (config `reminder: false` or CT_OCLAW_DISABLE=1 to
 *    turn off). The FIRST prepared turn of each session also carries the
 *    recent-memory digest (`enforce.py rehydrate` — the last ~7 sealed
 *    cognitive turns) so a fresh session is rehydrated, not merely primed.
 *    The digest is per-run content, so it rides here rather than the
 *    cache-stable PRIMER; first turn only, so it never bloats the window.
 *
 * Knobs (plugins.entries["cypher-tempre"].config, or environment):
 *   keepTurns      / CT_OCLAW_KEEP_TURNS       max recent turns kept (default 15)
 *   tokenCeiling   / CT_OCLAW_TOKEN_CEILING    context token ceiling (default 256000)
 *   evictionBatch  / CT_OCLAW_EVICTION_BATCH   evict oldest turns in batches (default 1)
 *   primer         (bool, default true)        systemPromptAddition primer
 *   reminder       (bool, default true)        per-turn reminder
 *   rehydrate      (bool, default true)        first-turn recent-memory digest
 *                  (CT_OCLAW_REHYDRATE=0 to disable; CT_OCLAW_REHYDRATE_TIMEOUT_MS,
 *                   CT_OCLAW_PYTHON for the enforce.py shell-out)
 *   skillDir       / CT_OCLAW_SKILL_DIR        skill location (default ~/.openclaw/skills/cypher-tempre-self-model)
 *   CT_OCLAW_DISABLE=1                         disable reminder + primer + digest (engine still windows)
 */
import { createEngine } from "./lib/engine.js"
import { buildReminder, ENGINE_ID, PLUGIN_ID, resolveConfig } from "./lib/priming.js"
import { createSessionGate, fetchDigest } from "./lib/rehydrate.js"

function pluginConfigFrom(ctx, event) {
  return ctx?.pluginConfig ?? event?.context?.pluginConfig ?? {}
}

// A plain definition object: the loader reads `register` off the default
// export directly (definePluginEntry is only a typing/normalization helper,
// and importing the SDK would break loading under transpilers without
// top-level await — observed with the host's jiti load path).
export default {
  id: PLUGIN_ID,
  name: "Cypher Tempre",
  description:
    "Timechain self-model wearing for OpenClaw: pinned-window context engine (no summarizing compaction) plus primer/reminder auto-append.",
  register(api) {
    api.registerContextEngine(ENGINE_ID, (factoryCtx) => {
      const entries = factoryCtx?.config?.plugins?.entries
      return createEngine(entries?.[PLUGIN_ID]?.config ?? {})
    })

    const firstTurnOfSession = createSessionGate()
    api.on("agent_turn_prepare", async (event, ctx) => {
      const cfg = resolveConfig(pluginConfigFrom(ctx, event))
      if (cfg.disabled) return
      const parts = []
      if (cfg.rehydrate && firstTurnOfSession(ctx?.sessionKey ?? ctx?.sessionId)) {
        const digest = await fetchDigest(cfg.skillDir)
        if (digest) parts.push(digest)
      }
      if (cfg.reminder) parts.push(buildReminder(cfg.skillDir))
      if (!parts.length) return
      return { appendContext: parts.join("\n\n") }
    })
  },
}
