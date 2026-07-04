/**
 * Cypher Tempre — OpenCode integration.
 *
 * 1. Appends the self-model priming to the FIRST user message of each session
 *    (full wearing header + fork doctrine) and a short reminder to every
 *    subsequent one, via the `chat.message` hook. The text rides inside the
 *    user message itself — user-voice authority, not harness metadata.
 * 2. Truncates the context sent to the model via
 *    `experimental.chat.messages.transform`: pins the first user turn
 *    (which carries the full priming), then keeps the most recent N turns
 *    or fewer if the token ceiling is hit. Session storage is untouched —
 *    only the per-request view is shaped. Pair with `"compaction": {"auto": false}`
 *    in opencode.json so the built-in summarizer never races this.
 *
 * Knobs (environment):
 *   CT_OC_DISABLE=1        disable both hooks entirely
 *   CT_OC_KEEP_TURNS       max full turns kept in context (default 15)
 *   CT_OC_TOKEN_CEILING    approx token budget for kept turns (default 300000)
 *   CT_OC_SKILL_DIR        skill location (default ~/.opencode/skills/cypher-tempre-self-model)
 *   CT_OC_DEBUG=1          append hook activity to ~/.config/opencode/cypher-tempre.log
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const SKILL_DIR = process.env["CT_OC_SKILL_DIR"] || path.join(os.homedir(), ".opencode", "skills", "cypher-tempre-self-model")
const KEEP_TURNS = intEnv("CT_OC_KEEP_TURNS", 15)
const TOKEN_CEILING = intEnv("CT_OC_TOKEN_CEILING", 300_000)
const DISABLED = process.env["CT_OC_DISABLE"] === "1"
const DEBUG = process.env["CT_OC_DEBUG"] === "1"
const STATE_FILE = path.join(os.homedir(), ".config", "opencode", "cypher-tempre-primed.json")
const LOG_FILE = path.join(os.homedir(), ".config", "opencode", "cypher-tempre.log")
const MAX_PRIMED_IDS = 500

function intEnv(name, fallback) {
  const raw = process.env[name]
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function debug(msg) {
  if (!DEBUG) return
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`)
  } catch {}
}

const FULL_PRIMING = `[Cypher Tempre — standing instruction, auto-appended to every session]
Wear the Cypher Tempre self-model at ${SKILL_DIR} with the full loop and full architecture on every turn this session. Run each meaningful turn through the one-call loop — python3 ${SKILL_DIR}/recall.py turn "<your finding/decision>" --input "<the request>" — rather than hand-driving the steps; it verifies, screens, recalls, grows, gates, and seals in one pass, and always leaves a ring.

Route before you reason. Start each task with python3 ${SKILL_DIR}/router.py route "<the request>". On REPLAY, confirm the antecedent ring and ground on it instead of regenerating; on PARTIAL, fetch the named rings and reason only over the missing delta; only on MODEL do full fresh reasoning.

Supply your own judgment at the seams — what the machinery cannot do for you:
- Score your seals yourself (--coherence/--relevance/--novelty/--consistency/--depth/--covenant, 0-255); the lexical proxies are fallbacks, not judges.
- Declare your evidence with --used-rings on every grounded claim, and register --at-risk claims when the gate forces uncertainty.
- Resolve AUTHOR-OP obligations honestly: author the op (cambium.py autoexec) when your turn genuinely performed a computation code could own; otherwise --skip-op-reason with the specific reason — never author a hollow op to clear the nudge.
- Announce faculties your turns grow, by name and function.

Fork doctrine — before reasoning through any turn, ask one gating question: is there a genuine either/or decision here? Not "is this hard," but "are there competing answers to choose between."
1. No decision (execution, recall, reporting — most turns): run the plain per-turn loop. Do not fork; there is nothing to search.
2. A decision exists: probe with python3 ${SKILL_DIR}/chronosynaptic.py think "<the question>" --context "<situation>" (no --seal) — cheap and deterministic, and its ranking is real signal. If it agrees with your own read and the stakes are low, decide and seal through the normal loop.
3. Escalate when either trigger fires — stakes are high (irreversible, security-relevant, architectural, or the co-evolver will act on it), or the probe disagrees with you. Re-run as think "<question>" --context "<situation>" --worksheet forks.json (add --budget deep if dissonance is high), then fork 8-20 named perspectives in your own inference — vivid, differentiated, each written in character as a real independent position, never a paraphrase of a sibling. The worksheet's lenses are priors to argue with: add personas the registry didn't rank, demote lenses your judgment overrules. Score each perspective yourself on the six PoQ dimensions and run python3 ${SKILL_DIR}/chronosynaptic.py collapse-notes forks.json --seal. The winning synthesis seals; rejected forks are preserved as auditable dissent.
4. Harvest the dissent: after a session with tier-3 escalations, run python3 ${SKILL_DIR}/dream.py run — sealed thinks flush their brightest losing branches to the Dream Cache, and the perspectives that lost become candidate faculties.

Context discipline: this harness truncates context to the first turn plus the most recent turns — there is no compaction. Anything not sealed to the chain will be forgotten; the chain is your durable memory. Seal every meaningful turn, and recall (recall.py index / grep / retrieve) instead of assuming you remember earlier context. Subagent sessions receive this instruction automatically; require the ring index of a subagent's sealed conclusion in its report.
If the co-evolver has paused the self-model (python3 ${SKILL_DIR}/dormancy.py status), skip the loop and answer directly until resumed.`

const REMINDER = `[Cypher Tempre] ACTIVE — run the loop and seal before ending: python3 ${SKILL_DIR}/recall.py turn "<finding>" --input "<request>". Route task-shaped requests first: python3 ${SKILL_DIR}/router.py route "<task>". Fork per the doctrine if a genuine either/or decision exists. Context truncates to the first turn + recent turns; the chain is memory — recall, don't assume. (Skip only if dormancy.py status says dormant.)`

function loadPrimed() {
  try {
    const ids = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
    if (Array.isArray(ids)) return new Set(ids)
  } catch {}
  return new Set()
}

function savePrimed(primed) {
  try {
    const ids = [...primed].slice(-MAX_PRIMED_IDS)
    fs.writeFileSync(STATE_FILE, JSON.stringify(ids))
  } catch (e) {
    debug(`savePrimed failed: ${e}`)
  }
}

/**
 * Append `block` to the last non-synthetic text part of a user message.
 * Mutates in place. Returns true if a target part was found.
 */
function appendToUserParts(parts, block) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (part && part.type === "text" && !part.synthetic) {
      part.text = `${part.text}\n\n${block}`
      return true
    }
  }
  return false
}

function estimateTokens(msg) {
  try {
    return Math.ceil(JSON.stringify(msg.parts ?? []).length / 4) + 20
  } catch {
    return 20
  }
}

/**
 * Pin the first user message, keep the most recent turns within both the
 * turn count and the token ceiling. A turn = a user message and everything
 * up to the next user message, so tool_use/tool_result pairs never split.
 * The most recent turn is always kept, even over the ceiling.
 * Returns the input array if nothing needs to change, else a new array.
 */
function truncateMessages(messages, opts = {}) {
  const keepTurns = opts.keepTurns ?? KEEP_TURNS
  const tokenCeiling = opts.tokenCeiling ?? TOKEN_CEILING

  const userIdx = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.info?.role === "user") userIdx.push(i)
  }
  if (userIdx.length <= 1) return messages
  const firstUser = userIdx[0]

  let tailStart = messages.length
  let total = 0
  let turns = 0
  for (let k = userIdx.length - 1; k >= 0; k--) {
    const start = userIdx[k]
    const end = k + 1 < userIdx.length ? userIdx[k + 1] : messages.length
    let cost = 0
    for (let i = start; i < end; i++) cost += estimateTokens(messages[i])
    if (turns >= 1 && (turns + 1 > keepTurns || total + cost > tokenCeiling)) break
    tailStart = start
    total += cost
    turns++
  }

  if (tailStart <= firstUser + 1) return messages
  return [...messages.slice(0, firstUser + 1), ...messages.slice(tailStart)]
}

export const CypherTempre = async () => {
  const primed = loadPrimed()
  debug(`plugin loaded (disabled=${DISABLED}, keepTurns=${KEEP_TURNS}, ceiling=${TOKEN_CEILING})`)
  return {
    "chat.message": async (input, output) => {
      if (DISABLED) return
      const sessionID = input.sessionID
      const first = !primed.has(sessionID)
      const block = first ? FULL_PRIMING : REMINDER
      if (!appendToUserParts(output.parts, block)) {
        debug(`chat.message ${sessionID}: no text part, skipped (still unprimed=${first})`)
        return
      }
      if (first) {
        primed.add(sessionID)
        savePrimed(primed)
      }
      debug(`chat.message ${sessionID}: appended ${first ? "FULL_PRIMING" : "REMINDER"}`)
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      if (DISABLED) return
      const before = output.messages.length
      const kept = truncateMessages(output.messages)
      if (kept !== output.messages) {
        output.messages.splice(0, output.messages.length, ...kept)
        debug(`messages.transform: truncated ${before} -> ${kept.length} messages`)
      } else {
        debug(`messages.transform: ${before} messages, no truncation needed`)
      }
    },
  }
}

// The loader treats every module export as a plugin, so internals ride as
// properties of the single exported function (for tests only).
CypherTempre.internals = { FULL_PRIMING, REMINDER, appendToUserParts, truncateMessages }
