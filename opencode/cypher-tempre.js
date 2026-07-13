/**
 * Cypher Tempre — OpenCode integration.
 *
 * 1. Appends the self-model priming to the FIRST user message of each session
 *    (full wearing header + fork doctrine) and a short reminder to every
 *    subsequent one, via the `chat.message` hook. The text rides inside the
 *    user message itself — user-voice authority, not harness metadata.
 * 2. Truncates the context sent to the model via
 *    `experimental.chat.messages.transform`: pins the first user message
 *    (which carries the full priming), then keeps the most recent N turns
 *    or fewer if the token ceiling is hit. Session storage is untouched —
 *    only the per-request view is shaped. Pair with `"compaction": {"auto": false}`
 *    in opencode.json so the built-in summarizer never races this.
 * 3. ACTIVE NUDGE — the missing Stop-hook, one layer up. OpenCode events are
 *    post-hoc (by `session.status: idle` the turn has already ended), so the
 *    plugin converts the notification into a bounded re-prompt: `chat.message`
 *    runs `enforce.py mark` (turn-head baseline), and on idle the `event` hook
 *    runs `enforce.py stop-check`; a `{"decision":"block"}` verdict is sent
 *    back into the session as one follow-up user message via the client SDK.
 *    Bounded twice (enforce.py's nudge budget + CT_OC_MAX_NUDGES), fail-open
 *    everywhere: a missing skill, dead python, or dormant chain never blocks.
 *
 * Knobs (environment):
 *   CT_OC_DISABLE=1        disable both hooks entirely
 *   CT_OC_KEEP_TURNS       max full turns kept in context (default 15)
 *   CT_OC_TOKEN_CEILING    approx token budget for kept turns (default 256000)
 *   CT_OC_SKILL_DIR        skill location (default ~/.opencode/skills/cypher-tempre-self-model)
 *   CT_OC_DEBUG=1          append hook activity to the log file
 *   CT_OC_STATE_FILE       primed-session state path (default ~/.config/opencode/cypher-tempre-primed.json)
 *   CT_OC_LOG_FILE         debug log path (default ~/.config/opencode/cypher-tempre.log)
 *   CT_SESSION_DB          opencode sqlite db stamped into turn_trajectory
 *                          (default ~/.local/share/opencode/opencode.db)
 *   CT_OC_NO_TRAJECTORY=1  disable the per-turn trajectory stamp
 *   CT_OC_NUDGE=0          disable the active nudge (idle-time stop-check re-prompt)
 *   CT_OC_MAX_NUDGES       plugin-side nudge cap per turn (default 2; enforce.py's
 *                          own CT_ENFORCE_MAX_NUDGES budget also applies)
 *   CT_OC_PYTHON           python executable for enforce.py (default python3)
 *   CT_OC_NUDGE_TIMEOUT_MS per-call timeout for enforce.py (default 5000)
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"

const SKILL_DIR = process.env["CT_OC_SKILL_DIR"] || path.join(os.homedir(), ".opencode", "skills", "cypher-tempre-self-model")
const KEEP_TURNS = intEnv("CT_OC_KEEP_TURNS", 15)
const TOKEN_CEILING = intEnv("CT_OC_TOKEN_CEILING", 256_000)
const DISABLED = process.env["CT_OC_DISABLE"] === "1"
const DEBUG = process.env["CT_OC_DEBUG"] === "1"
const MAX_PRIMED_IDS = 500

// Resolved lazily (not at module load) so tests can point them at a temp dir:
// ESM import hoisting runs this module before a test file's own statements.
function stateFile() {
  return process.env["CT_OC_STATE_FILE"] || path.join(os.homedir(), ".config", "opencode", "cypher-tempre-primed.json")
}

function logFile() {
  return process.env["CT_OC_LOG_FILE"] || path.join(os.homedir(), ".config", "opencode", "cypher-tempre.log")
}

function intEnv(name, fallback) {
  const raw = process.env[name]
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function debug(msg) {
  if (!DEBUG) return
  try {
    fs.appendFileSync(logFile(), `${new Date().toISOString()} ${msg}\n`)
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

Context discipline: this harness truncates context to the pinned first user message plus the most recent turns — there is no compaction. Anything not sealed to the chain will be forgotten; the chain is your durable memory. Seal every meaningful turn, and recall (recall.py index / grep / retrieve) instead of assuming you remember earlier context. Subagent sessions receive this instruction automatically; require the ring index of a subagent's sealed conclusion in its report.

Bulk work is a different mode: when a task means ingesting or auditing a corpus bigger than context, do not run the per-turn loop per file — stream it through python3 ${SKILL_DIR}/continuum.py walk/ingest on a separate --root task chain, resume from the head block across sessions, and link the finished task into identity with task.py. For "every line" audits, drive completion off audit.py's unreviewed queue. Size and horizon are never refusal reasons.
If the co-evolver has paused the self-model (python3 ${SKILL_DIR}/dormancy.py status), skip the loop and answer directly until resumed.`

const REMINDER = `[Cypher Tempre] ACTIVE — run the loop and seal before ending: python3 ${SKILL_DIR}/recall.py turn "<finding>" --input "<request>". Route task-shaped requests first: python3 ${SKILL_DIR}/router.py route "<task>". Fork per the doctrine if a genuine either/or decision exists. Context truncates to the first user message + recent turns; the chain is memory — recall, don't assume. (Skip only if dormancy.py status says dormant.)`

// Marks a plugin-sent nudge message so chat.message never re-marks the turn,
// re-appends a reminder, or restamps the trajectory for it: the nudge is a
// CONTINUATION of the open turn, not a new one. The sentinel is public text,
// so it is NEVER trusted alone: each nudge carries a per-send random nonce and
// the echo must exactly match the outstanding expected text for that session
// (sess.expectedEcho). A crafted message that merely starts with the sentinel
// is treated as an ordinary user message — marked, reminded, stamped.
const NUDGE_SENTINEL = "[Cypher Tempre nudge — the previous turn has not sealed]"

function nudgeSkillDir() {
  // Re-read env lazily (tests point this at a temp dir after import); falls
  // back to the module-load SKILL_DIR used by the priming text.
  return process.env["CT_OC_SKILL_DIR"] || SKILL_DIR
}

/**
 * Run `enforce.py <cmd>` with an empty hook payload on stdin.
 * Resolves to: null  = could not run (missing script / dead python / timeout),
 *              ""    = ran, no stdout (the ALLOW verdict for stop-check),
 *              text  = raw stdout (stop-check's block JSON rides here).
 * Fail-open by construction — no rejection path exists.
 */
function runEnforce(cmd) {
  return new Promise((resolve) => {
    const script = path.join(nudgeSkillDir(), "enforce.py")
    if (!fs.existsSync(script)) return resolve(null)
    const py = process.env["CT_OC_PYTHON"] || "python3"
    const timeoutMs = intEnv("CT_OC_NUDGE_TIMEOUT_MS", 5000)
    let out = ""
    let done = false
    const finish = (v) => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    try {
      const child = spawn(py, [script, cmd], { stdio: ["pipe", "pipe", "ignore"] })
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {}
        finish(null)
      }, timeoutMs)
      child.stdout.on("data", (d) => {
        out += d
      })
      child.on("error", () => {
        clearTimeout(timer)
        finish(null)
      })
      child.on("close", () => {
        clearTimeout(timer)
        finish(out.trim())
      })
      child.stdin.on("error", () => {})
      child.stdin.write("{}")
      child.stdin.end()
    } catch {
      finish(null)
    }
  })
}

/** Parse stop-check stdout into a block reason, or null when the turn may end. */
function blockReason(stdout) {
  if (!stdout) return null
  try {
    const verdict = JSON.parse(stdout)
    if (verdict && verdict.decision === "block" && typeof verdict.reason === "string") return verdict.reason
  } catch {}
  return null
}

/** The message's last non-synthetic text, or null. */
function lastUserText(parts) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (part && part.type === "text" && !part.synthetic) return part.text
  }
  return null
}

/**
 * True only when this message is the exact echo of the nudge this session is
 * still owed. The public sentinel alone proves nothing — without an
 * outstanding expectedEcho, or with any textual mismatch, the message is
 * ordinary user input.
 */
function isNudgeMessage(parts, expectedEcho) {
  if (!expectedEcho) return false
  return lastUserText(parts) === expectedEcho
}

const MAX_TRACKED_SESSIONS = 500

function trackSession(sessions, sessionID) {
  let sess = sessions.get(sessionID)
  if (!sess) {
    sess = { awaitingIdle: false, nudges: 0, expectedEcho: null }
    sessions.set(sessionID, sess)
    if (sessions.size > MAX_TRACKED_SESSIONS) {
      const oldest = sessions.keys().next().value
      sessions.delete(oldest)
    }
  }
  return sess
}

function loadPrimed() {
  try {
    const ids = JSON.parse(fs.readFileSync(stateFile(), "utf8"))
    if (Array.isArray(ids)) return new Set(ids)
  } catch {}
  return new Set()
}

function savePrimed(primed) {
  try {
    const ids = [...primed].slice(-MAX_PRIMED_IDS)
    fs.writeFileSync(stateFile(), JSON.stringify(ids))
  } catch (e) {
    debug(`savePrimed failed: ${e}`)
  }
}

/**
 * Stamp the turn's trajectory pointer into the skill's enforcement state so
 * the seal binds this turn's ring to its session slice (bind, don't copy —
 * training.py resolves {session_db, session_id, message_id_start} into the
 * turn's tool events at export). Fail-open: a missing db or unwritable chain
 * dir never blocks the turn.
 */
function stampTurnTrajectory(sessionID, messageID, skillDir = SKILL_DIR) {
  if (process.env["CT_OC_NO_TRAJECTORY"] === "1") return
  try {
    const db = process.env["CT_SESSION_DB"] ||
      path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")
    if (!fs.existsSync(db)) return
    const enforcePath = path.join(skillDir, "chain", ".enforce.json")
    let st = {}
    try { st = JSON.parse(fs.readFileSync(enforcePath, "utf8")) } catch {}
    st.turn_trajectory = {
      session_db: db,
      session_id: sessionID,
      ...(messageID ? { message_id_start: messageID } : {}),
    }
    fs.mkdirSync(path.dirname(enforcePath), { recursive: true })
    fs.writeFileSync(enforcePath, JSON.stringify(st))
    debug(`stampTurnTrajectory ${sessionID}: ${messageID || "no message id"}`)
  } catch (e) {
    debug(`stampTurnTrajectory failed (fail-open): ${e}`)
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

export const CypherTempre = async (input = {}) => {
  const primed = loadPrimed()
  const client = input.client
  // sessionID -> { awaitingIdle, nudges }; turn-scoped nudge accounting for
  // every session this plugin has actually primed (parents and subagents alike).
  const sessions = new Map()
  debug(`plugin loaded (disabled=${DISABLED}, keepTurns=${KEEP_TURNS}, ceiling=${TOKEN_CEILING})`)
  return {
    "chat.message": async (input, output) => {
      if (DISABLED) return
      const sessionID = input.sessionID
      const sess = trackSession(sessions, sessionID)
      if (isNudgeMessage(output.parts, sess.expectedEcho)) {
        // Our own nudge echoing back (exact match against the outstanding
        // nonce-bearing text): the turn baseline, nudge budget, and trajectory
        // slice all belong to the still-open turn — touch nothing, append
        // nothing (the nudge text IS the reminder). Just re-arm the idle
        // check so the re-prompted pass gets re-audited.
        sess.expectedEcho = null
        sess.awaitingIdle = true
        debug(`chat.message ${sessionID}: nudge echo, pass-through`)
        return
      }
      if (sess.expectedEcho && lastUserText(output.parts)?.startsWith(NUDGE_SENTINEL)) {
        // Sentinel-shaped but not our outstanding text — spoof or corruption.
        // Fall through and treat it as ordinary input; log for diagnosis.
        debug(`chat.message ${sessionID}: sentinel-prefixed message did NOT match expected echo`)
      }
      sess.expectedEcho = null // a real user message supersedes any owed echo
      sess.nudges = 0
      sess.awaitingIdle = true
      // Turn-head baseline first (mark clears any stale turn_trajectory),
      // then stamp this turn's trajectory pointer over it.
      await runEnforce("mark")
      stampTurnTrajectory(sessionID, output?.message?.id ?? input?.messageID)
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
    event: async ({ event }) => {
      if (DISABLED || process.env["CT_OC_NUDGE"] === "0") return
      if (!event || event.type !== "session.status") return
      const data = event.data ?? event.properties ?? {}
      if (data.status?.type !== "idle") return
      const sessionID = data.sessionID
      const sess = sessions.get(sessionID)
      if (!sess || !sess.awaitingIdle) return // not a session we primed, or already checked
      sess.awaitingIdle = false
      const maxNudges = intEnv("CT_OC_MAX_NUDGES", 2)
      if (sess.nudges >= maxNudges) {
        debug(`idle ${sessionID}: plugin nudge cap reached (${sess.nudges})`)
        return
      }
      const reason = blockReason(await runEnforce("stop-check"))
      if (!reason) return // sealed, dormant, unenforceable, or enforce.py budget exhausted
      sess.nudges++
      // Per-send nonce: the echo is authenticated by exact match, so a message
      // that merely copies the public sentinel can never impersonate a nudge.
      const text = `${NUDGE_SENTINEL} [${randomUUID()}]\n${reason}`
      try {
        const session = client?.session
        const send = session?.promptAsync?.bind(session) ?? session?.prompt?.bind(session)
        if (!send) {
          debug(`idle ${sessionID}: no client SDK available, cannot nudge`)
          return
        }
        await send({ path: { id: sessionID }, body: { parts: [{ type: "text", text }] } })
        sess.expectedEcho = text // armed only after the send actually succeeded
        debug(`idle ${sessionID}: sent nudge ${sess.nudges}/${maxNudges}`)
      } catch (e) {
        debug(`idle ${sessionID}: nudge send failed (fail-open): ${e}`)
      }
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
CypherTempre.internals = {
  FULL_PRIMING,
  REMINDER,
  NUDGE_SENTINEL,
  appendToUserParts,
  truncateMessages,
  stampTurnTrajectory,
  runEnforce,
  blockReason,
  isNudgeMessage,
  lastUserText,
}
