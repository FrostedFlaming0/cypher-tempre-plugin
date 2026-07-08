/**
 * Pinned-window context assembly — the pure core of the OpenClaw context engine.
 *
 * Policy (one code path, used by assemble() and compact() alike):
 *   - Messages group into TURNS at user-role boundaries; everything that follows
 *     a user message (assistant, toolResult, custom, bashExecution, branchSummary)
 *     belongs to that turn, so tool_use/toolResult pairs never split.
 *   - The FIRST turn is pinned: it never drops (it carries the original task).
 *   - The PREVIOUS turn and the CURRENT turn are pinned: they never drop,
 *     even when the result stays over budget.
 *   - Eviction removes the MINIMUM number of OLDEST evictable turns — the
 *     16th-oldest first — until the tail fits both keepTurns and the token
 *     budget. The pinned floor is an invariant, never a target.
 *   - `evictionBatch` > 1 optionally evicts in batches so the window slides
 *     less often (prompt-cache retention); default 1 = exact minimum.
 *
 * Nothing here mutates the input. Session storage is untouched by design —
 * this shapes the per-run model view only.
 */

/** Roles that begin a new turn. Everything else attaches to the open turn. */
const TURN_STARTER_ROLE = "user"

/** Rough token estimate, mirroring the OpenCode adapter (chars/4 + overhead). */
export function estimateTokens(msg) {
  try {
    return Math.ceil(JSON.stringify(msg).length / 4) + 20
  } catch {
    return 20
  }
}

/**
 * Group messages into { prefix, turns } where `prefix` is everything before
 * the first user message and each turn is a [start, end) index range.
 */
export function groupTurns(messages) {
  const turns = []
  let firstUser = -1
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === TURN_STARTER_ROLE) {
      if (firstUser === -1) firstUser = i
      turns.push({ start: i, end: messages.length })
      if (turns.length > 1) turns[turns.length - 2].end = i
    }
  }
  return { prefixEnd: firstUser === -1 ? messages.length : firstUser, turns }
}

/**
 * Fit `messages` to the window. Returns { messages, estimatedTokens, dropped }.
 * Returns the input array itself (dropped: 0) when nothing needs to change.
 *
 * opts: { keepTurns, budget, evictionBatch }
 *   keepTurns      — max turns kept in the tail window (including current)
 *   budget         — token ceiling for the WHOLE assembled context
 *   evictionBatch  — evict oldest tail turns in multiples of this (default 1)
 */
export function windowFit(messages, opts = {}) {
  const keepTurns = positiveInt(opts.keepTurns, 15)
  const budget = positiveInt(opts.budget, 256_000)
  const evictionBatch = positiveInt(opts.evictionBatch, 1)

  const { turns } = groupTurns(messages)

  // Not enough turns for any eviction: first, previous, and current turns
  // are all pinned, so windows of <= 3 turns pass through untouched.
  if (turns.length <= 3) {
    return { messages, estimatedTokens: messages.reduce((s, m) => s + estimateTokens(m), 0), dropped: 0 }
  }

  const pinnedHead = messages.slice(0, turns[0].end) // prefix + first turn
  const pinnedHeadCost = pinnedHead.reduce((s, m) => s + estimateTokens(m), 0)

  // Walk back from the last turn, always keeping the final two turns
  // (previous + current), then extending while both constraints hold.
  const turnCosts = turns.map((t) => {
    let cost = 0
    for (let i = t.start; i < t.end; i++) cost += estimateTokens(messages[i])
    return cost
  })

  const lastIdx = turns.length - 1
  let tailStart = lastIdx - 1 // previous + current: never dropped
  let tailCost = turnCosts[lastIdx] + turnCosts[lastIdx - 1]
  let tailCount = 2

  for (let k = lastIdx - 2; k >= 1; k--) {
    // turns[0] is pinned separately; candidates are turns[1..lastIdx-2]
    const cost = turnCosts[k]
    if (tailCount + 1 > keepTurns) break
    if (pinnedHeadCost + tailCost + cost > budget) break
    tailStart = k
    tailCost += cost
    tailCount++
  }

  // Batched eviction: round the number of evicted middle turns UP to a
  // multiple of evictionBatch so the window slides less often. Never evicts
  // into the pinned floor (tailStart is capped at lastIdx - 1).
  if (evictionBatch > 1 && tailStart > 1) {
    const evicted = tailStart - 1
    const rounded = Math.ceil(evicted / evictionBatch) * evictionBatch
    tailStart = Math.min(lastIdx - 1, 1 + rounded)
  }

  if (tailStart <= 1) {
    // Window covers every turn after the pinned head: nothing to evict.
    return { messages, estimatedTokens: messages.reduce((s, m) => s + estimateTokens(m), 0), dropped: 0 }
  }

  const kept = [...pinnedHead, ...messages.slice(turns[tailStart].start)]
  let keptCost = pinnedHeadCost
  for (let k = tailStart; k <= lastIdx; k++) keptCost += turnCosts[k]
  return { messages: kept, estimatedTokens: keptCost, dropped: tailStart - 1 }
}

function positiveInt(value, fallback) {
  const parsed = typeof value === "string" ? parseInt(value, 10) : value
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}
