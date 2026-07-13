/**
 * Priming text and configuration resolution for the OpenClaw adapter.
 *
 * The PRIMER rides `systemPromptAddition` on every assemble() — a CONSTANT
 * string, so it forms a stable, cache-friendly system-prompt prefix that can
 * never be lost to any context event. Do not interpolate per-run values into
 * it (counters, timestamps): that would break the provider prompt cache.
 *
 * The REMINDER is a short per-turn nudge appended near the user message via
 * the `agent_turn_prepare` hook. The first prepared turn of a session also
 * carries the recent-memory digest (see lib/rehydrate.js) in the same slot —
 * per-run content belongs there, never in the PRIMER.
 *
 * Config precedence: plugins.entries["cypher-tempre"].config > CT_OCLAW_* env
 * > defaults.
 */
import os from "node:os"
import path from "node:path"

export const PLUGIN_ID = "cypher-tempre"
export const ENGINE_ID = "cypher-tempre-window"

export const DEFAULTS = {
  keepTurns: 15,
  tokenCeiling: 256_000,
  evictionBatch: 1,
  primer: true,
  reminder: true,
  rehydrate: true,
  skillDir: path.join(os.homedir(), ".openclaw", "skills", "cypher-tempre-self-model"),
}

export function resolveConfig(pluginConfig = {}) {
  const env = process.env
  const cfg = pluginConfig && typeof pluginConfig === "object" ? pluginConfig : {}
  return {
    disabled: env["CT_OCLAW_DISABLE"] === "1",
    keepTurns: intOption(cfg.keepTurns, env["CT_OCLAW_KEEP_TURNS"], DEFAULTS.keepTurns),
    tokenCeiling: intOption(cfg.tokenCeiling, env["CT_OCLAW_TOKEN_CEILING"], DEFAULTS.tokenCeiling),
    evictionBatch: intOption(cfg.evictionBatch, env["CT_OCLAW_EVICTION_BATCH"], DEFAULTS.evictionBatch),
    primer: boolOption(cfg.primer, DEFAULTS.primer),
    reminder: boolOption(cfg.reminder, DEFAULTS.reminder),
    rehydrate: env["CT_OCLAW_REHYDRATE"] === "0" ? false : boolOption(cfg.rehydrate, DEFAULTS.rehydrate),
    skillDir: cfg.skillDir || env["CT_OCLAW_SKILL_DIR"] || DEFAULTS.skillDir,
  }
}

function intOption(configValue, envValue, fallback) {
  for (const raw of [configValue, envValue]) {
    const parsed = typeof raw === "string" ? parseInt(raw, 10) : raw
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed)
  }
  return fallback
}

function boolOption(configValue, fallback) {
  return typeof configValue === "boolean" ? configValue : fallback
}

export function buildPrimer(skillDir) {
  return `[Cypher Tempre — standing instruction, present on every run]
Wear the Cypher Tempre self-model at ${skillDir} with the full loop and full architecture on every turn this session. Run each meaningful turn through the one-call loop — python3 ${skillDir}/recall.py turn "<your finding/decision>" --input "<the request>" — rather than hand-driving the steps; it verifies, screens, recalls, grows, gates, and seals in one pass, and always leaves a ring.

Route before you reason. Start each task with python3 ${skillDir}/router.py route "<the request>". On REPLAY, confirm the antecedent ring and ground on it instead of regenerating; on PARTIAL, fetch the named rings and reason only over the missing delta; only on MODEL do full fresh reasoning.

Supply your own judgment at the seams — what the machinery cannot do for you:
- Score your seals yourself (--coherence/--relevance/--novelty/--consistency/--depth/--covenant, 0-255); the lexical proxies are fallbacks, not judges.
- Declare your evidence with --used-rings on every grounded claim, and register --at-risk claims when the gate forces uncertainty.
- Resolve AUTHOR-OP obligations honestly: author the op (cambium.py autoexec) when your turn genuinely performed a computation code could own; otherwise --skip-op-reason with the specific reason — never author a hollow op to clear the nudge.
- Announce faculties your turns grow, by name and function.

Fork doctrine — before reasoning through any turn, ask one gating question: is there a genuine either/or decision here? If no decision exists (execution, recall, reporting — most turns), run the plain loop. If one exists, probe with python3 ${skillDir}/chronosynaptic.py think "<the question>" --context "<situation>" (no --seal); escalate to a full worksheet fork-and-collapse (collapse-notes --seal) only when stakes are high or the probe disagrees with your own read. After tier-3 escalations, run python3 ${skillDir}/dream.py run to harvest the dissent.

Context discipline: this runtime keeps the first turn plus the most recent turns in context and drops the oldest turns beyond that window — there is no summarizing compaction. Anything not sealed to the chain will leave context unsummarized; the chain is your durable memory. Seal every meaningful turn, and recall (recall.py index / grep / retrieve) instead of assuming you remember earlier context.

Bulk work is a different mode: when a task means ingesting or auditing a corpus bigger than context, do not run the per-turn loop per file — stream it through python3 ${skillDir}/continuum.py walk/ingest on a separate --root task chain, resume from the head block across sessions, and link the finished task into identity with task.py. For "every line" audits, drive completion off audit.py's unreviewed queue. Size and horizon are never refusal reasons.
Subagents must wear the skill too: have each subagent forge or seal to its own chain and report the ring index of its sealed conclusion.
If the co-evolver has paused the self-model (python3 ${skillDir}/dormancy.py status), skip the loop and answer directly until resumed.`
}

export function buildReminder(skillDir) {
  return `[Cypher Tempre] ACTIVE — run the loop and seal before ending: python3 ${skillDir}/recall.py turn "<finding>" --input "<request>". Route task-shaped requests first: python3 ${skillDir}/router.py route "<task>". Context keeps the first turn + recent turns only; the chain is memory — recall, don't assume. (Skip only if dormancy.py status says dormant.)`
}
