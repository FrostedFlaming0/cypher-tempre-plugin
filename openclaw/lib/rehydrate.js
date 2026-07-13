/**
 * First-turn rehydration for the OpenClaw adapter.
 *
 * Fetches the recent-memory digest (the last ~7 sealed cognitive turns) from
 * the skill's `enforce.py rehydrate` — a read-only command that prints plain
 * text and never touches enforcement state. The PRIMER must stay a CONSTANT
 * systemPromptAddition for prompt-cache stability, so the digest instead rides
 * the `agent_turn_prepare` appendContext near the user message — and only on
 * the FIRST prepared turn of each session this process sees: recency restores
 * continuity a fresh session cannot recall its way back to, but re-injecting
 * it every turn would bloat the window the engine manages.
 *
 * Fail-open everywhere: a missing skill, dead python, dormant chain, or
 * timeout resolves to null and the turn proceeds with the reminder alone.
 * One attempt per session — a failed fetch is not retried on later turns, so
 * a broken python costs one bounded wait, not one per turn.
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const MAX_TRACKED_SESSIONS = 500

function timeoutMs() {
  const raw = process.env["CT_OCLAW_REHYDRATE_TIMEOUT_MS"]
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000
}

/**
 * Run `enforce.py rehydrate` in skillDir.
 * Resolves to the digest text, or null (missing script / dead python /
 * timeout / empty digest). No rejection path exists.
 */
export function fetchDigest(skillDir) {
  return new Promise((resolve) => {
    const script = path.join(skillDir, "enforce.py")
    if (!fs.existsSync(script)) return resolve(null)
    const py = process.env["CT_OCLAW_PYTHON"] || "python3"
    let out = ""
    let done = false
    const finish = (v) => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    try {
      const child = spawn(py, [script, "rehydrate"], { stdio: ["ignore", "pipe", "ignore"] })
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {}
        finish(null)
      }, timeoutMs())
      child.stdout.on("data", (d) => {
        out += d
      })
      child.on("error", () => {
        clearTimeout(timer)
        finish(null)
      })
      child.on("close", () => {
        clearTimeout(timer)
        finish(out.trim() || null)
      })
    } catch {
      finish(null)
    }
  })
}

/**
 * Per-process once-per-session gate. Returns true exactly once per key;
 * unkeyed sessions (no sessionKey/sessionId in ctx) never rehydrate — better
 * a missed digest than one re-injected on every turn.
 */
export function createSessionGate() {
  const seen = new Set()
  return (key) => {
    if (!key || seen.has(key)) return false
    seen.add(key)
    if (seen.size > MAX_TRACKED_SESSIONS) {
      const oldest = seen.values().next().value
      seen.delete(oldest)
    }
    return true
  }
}
