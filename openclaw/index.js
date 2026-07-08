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
 *    turn off).
 *
 * Knobs (plugins.entries["cypher-tempre"].config, or environment):
 *   keepTurns      / CT_OCLAW_KEEP_TURNS       max recent turns kept (default 15)
 *   tokenCeiling   / CT_OCLAW_TOKEN_CEILING    context token ceiling (default 256000)
 *   evictionBatch  / CT_OCLAW_EVICTION_BATCH   evict oldest turns in batches (default 1)
 *   primer         (bool, default true)        systemPromptAddition primer
 *   reminder       (bool, default true)        per-turn reminder
 *   skillDir       / CT_OCLAW_SKILL_DIR        skill location (default ~/.openclaw/skills/cypher-tempre-self-model)
 *   CT_OCLAW_DISABLE=1                         disable reminder + primer (engine still windows)
 */
import { createEngine } from "./lib/engine.js"
import { buildReminder, ENGINE_ID, PLUGIN_ID, resolveConfig } from "./lib/priming.js"

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

    api.on("agent_turn_prepare", (event, ctx) => {
      const cfg = resolveConfig(pluginConfigFrom(ctx, event))
      if (cfg.disabled || !cfg.reminder) return
      return { appendContext: buildReminder(cfg.skillDir) }
    })
  },
}
