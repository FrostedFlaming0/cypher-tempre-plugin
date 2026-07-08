/**
 * The Cypher Tempre context engine for OpenClaw.
 *
 * Implements the ContextEngine contract (openclaw src/context-engine/types.ts)
 * with `ownsCompaction: true`: assembly IS the context policy, and compaction
 * never summarizes.
 *
 *   assemble  — windowFit(messages, min(ceiling, runtime budget, override)):
 *               pinned first turn + most recent keepTurns turns; evicts the
 *               minimum number of oldest middle turns. Returns the constant
 *               PRIMER as systemPromptAddition.
 *   compact   — "below threshold" no-op while the assembled view fits. Only
 *               when the runtime reveals a SMALLER true budget (provider
 *               overflow) does it tighten a per-session budget override so
 *               the next assemble evicts the minimum extra oldest turns.
 *               It never touches the transcript and never summarizes.
 *   ingest    — no-op (the session manager persists messages; the timechain
 *               is the durable memory and lives outside the host).
 *
 * The on-disk session transcript is NEVER modified: only the per-run model
 * view is shaped.
 */
import { windowFit } from "./window.js"
import { buildPrimer, ENGINE_ID, resolveConfig } from "./priming.js"

/** Tighten factor applied when the runtime reveals a smaller true budget. */
const OVERFLOW_TIGHTEN = 0.85

export function createEngine(pluginConfig = {}) {
  const cfg = resolveConfig(pluginConfig)
  const primer = cfg.primer ? buildPrimer(cfg.skillDir) : undefined

  /** sessionId -> tightened budget learned from overflow-triggered compact() */
  const budgetOverride = new Map()
  /** sessionId -> estimatedTokens of the last assembled view */
  const lastAssembled = new Map()

  return {
    info: {
      id: ENGINE_ID,
      name: "Cypher Tempre pinned window",
      version: "0.1.0",
      ownsCompaction: true,
    },

    async ingest() {
      return { ingested: false }
    },

    async assemble({ sessionId, messages, tokenBudget }) {
      const budgets = [cfg.tokenCeiling]
      if (Number.isFinite(tokenBudget) && tokenBudget > 0) budgets.push(tokenBudget)
      const override = budgetOverride.get(sessionId)
      if (Number.isFinite(override) && override > 0) budgets.push(override)

      const fitted = windowFit(messages, {
        keepTurns: cfg.keepTurns,
        budget: Math.min(...budgets),
        evictionBatch: cfg.evictionBatch,
      })
      lastAssembled.set(sessionId, fitted.estimatedTokens)

      return {
        messages: fitted.messages,
        estimatedTokens: fitted.estimatedTokens,
        // Constant string: a stable, cache-friendly system prompt prefix.
        ...(primer ? { systemPromptAddition: primer } : {}),
      }
    },

    async compact({ sessionId, tokenBudget, force, currentTokenCount }) {
      const assembled = lastAssembled.get(sessionId)
      const target = Number.isFinite(tokenBudget) && tokenBudget > 0 ? tokenBudget : cfg.tokenCeiling

      const fits = assembled != null && assembled <= target
      if (fits || assembled == null) {
        // Assembly already bounds every run; nothing to summarize, ever.
        // "below threshold" / "nothing to compact" are recognized harmless
        // skip classes in the host's compaction-reason classifier.
        return {
          ok: true,
          compacted: false,
          reason: force
            ? "nothing to compact: windowed assembly keeps context bounded per run"
            : "below threshold",
        }
      }

      // The runtime revealed a budget smaller than our assembled view
      // (typically a provider context-overflow retry). Tighten the override
      // so the NEXT assemble evicts the minimum extra oldest turns. The
      // pinned floor (first, previous, current) still never drops.
      const tightened = Math.floor(Math.min(assembled, target) * OVERFLOW_TIGHTEN)
      budgetOverride.set(sessionId, tightened)
      return {
        ok: true,
        compacted: true,
        reason: "window tightened; oldest non-pinned turns evict at next assembly",
        result: {
          tokensBefore: Number.isFinite(currentTokenCount) ? currentTokenCount : assembled,
          tokensAfter: tightened,
        },
      }
    },

    async dispose() {
      budgetOverride.clear()
      lastAssembled.clear()
    },
  }
}
