import test from "node:test"
import assert from "node:assert/strict"

import { estimateTokens, groupTurns, windowFit } from "./lib/window.js"
import { createEngine } from "./lib/engine.js"
import { buildPrimer, buildReminder, resolveConfig, ENGINE_ID } from "./lib/priming.js"
import entry from "./index.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function user(text) {
  return { role: "user", content: [{ type: "text", text }] }
}
function assistant(text) {
  return { role: "assistant", content: [{ type: "text", text }] }
}
function toolResult(text) {
  return { role: "toolResult", content: [{ type: "text", text }] }
}

/** Build n turns: each = user + assistant (+ optional toolResult). */
function conversation(n, { withTools = false, padding = "" } = {}) {
  const messages = []
  for (let i = 0; i < n; i++) {
    messages.push(user(`turn-${i} question ${padding}`))
    if (withTools) {
      messages.push(assistant(`turn-${i} tool call`))
      messages.push(toolResult(`turn-${i} tool output`))
    }
    messages.push(assistant(`turn-${i} answer ${padding}`))
  }
  return messages
}

function userTexts(messages) {
  return messages
    .filter((m) => m.role === "user")
    .map((m) => m.content[0].text.split(" ")[0])
}

// ---------------------------------------------------------------------------
// groupTurns
// ---------------------------------------------------------------------------

test("groupTurns: boundaries at user messages only; tool results attach to their turn", () => {
  const messages = conversation(3, { withTools: true })
  const { turns } = groupTurns(messages)
  assert.equal(turns.length, 3)
  for (const t of turns) {
    const slice = messages.slice(t.start, t.end)
    assert.equal(slice[0].role, "user")
    // No other user message inside the turn.
    assert.equal(slice.slice(1).filter((m) => m.role === "user").length, 0)
    // Tool pair stays inside.
    assert.ok(slice.some((m) => m.role === "toolResult"))
  }
})

test("groupTurns: prefix before first user message is identified", () => {
  const messages = [assistant("bootstrap"), ...conversation(2)]
  const { prefixEnd, turns } = groupTurns(messages)
  assert.equal(prefixEnd, 1)
  assert.equal(turns.length, 2)
})

// ---------------------------------------------------------------------------
// windowFit — turn-count semantics
// ---------------------------------------------------------------------------

test("windowFit: no eviction at or under keepTurns (input array returned untouched)", () => {
  const messages = conversation(16) // first + 15 tail = exactly the window
  const fitted = windowFit(messages, { keepTurns: 15, budget: 10_000_000 })
  assert.equal(fitted.messages, messages)
  assert.equal(fitted.dropped, 0)
})

test("windowFit: the 16th-oldest turn drops first, exactly one", () => {
  const messages = conversation(17) // first + 16 tail: one over
  const fitted = windowFit(messages, { keepTurns: 15, budget: 10_000_000 })
  assert.equal(fitted.dropped, 1)
  const kept = userTexts(fitted.messages)
  assert.equal(kept[0], "turn-0") // pinned first turn
  assert.equal(kept[1], "turn-2") // turn-1 (the oldest evictable) dropped
  assert.equal(kept.length, 16) // first + 15
})

test("windowFit: first, previous, and current turns never drop", () => {
  const messages = conversation(30)
  const fitted = windowFit(messages, { keepTurns: 3, budget: 10_000_000 })
  const kept = userTexts(fitted.messages)
  assert.ok(kept.includes("turn-0"))
  assert.ok(kept.includes("turn-28"))
  assert.ok(kept.includes("turn-29"))
})

test("windowFit: three turns or fewer always pass through even over budget", () => {
  const messages = conversation(3, { padding: "x".repeat(4000) })
  const fitted = windowFit(messages, { keepTurns: 15, budget: 100 })
  assert.equal(fitted.messages, messages)
  assert.equal(fitted.dropped, 0)
})

// ---------------------------------------------------------------------------
// windowFit — token-ceiling semantics
// ---------------------------------------------------------------------------

test("windowFit: ceiling evicts the minimum number of oldest turns", () => {
  // 10 turns, each turn ~costly; budget sized to fit pinned head + ~4 tail turns.
  const messages = conversation(10, { padding: "x".repeat(400) })
  const perTurn =
    estimateTokens(messages[0]) + estimateTokens(messages[1])
  const budget = perTurn * 5 + 50 // head (1 turn) + ~4 tail turns
  const fitted = windowFit(messages, { keepTurns: 15, budget })
  assert.ok(fitted.dropped >= 1, "must evict under the ceiling")
  const kept = userTexts(fitted.messages)
  // Pins hold.
  assert.equal(kept[0], "turn-0")
  assert.ok(kept.includes("turn-8"))
  assert.ok(kept.includes("turn-9"))
  // Evicted turns are the OLDEST evictable block: kept tail is contiguous to the end.
  const tail = kept.slice(1)
  const firstTailIdx = Number(tail[0].split("-")[1])
  assert.deepEqual(
    tail,
    Array.from({ length: 10 - firstTailIdx }, (_, i) => `turn-${firstTailIdx + i}`),
  )
  // Minimality: keeping one more oldest turn would blow the budget.
  const oneMore = windowFit(messages, { keepTurns: 15, budget: budget + perTurn })
  assert.ok(oneMore.dropped < fitted.dropped, "a bigger budget must evict fewer turns")
  assert.ok(fitted.estimatedTokens <= budget)
})

test("windowFit: evictionBatch rounds eviction up but never into the pinned floor", () => {
  const messages = conversation(17) // minimum eviction would be 1
  const fitted = windowFit(messages, { keepTurns: 15, budget: 10_000_000, evictionBatch: 5 })
  assert.equal(fitted.dropped, 5)
  const kept = userTexts(fitted.messages)
  assert.equal(kept[0], "turn-0")
  assert.equal(kept[1], "turn-6")
  // Floor: batch can never evict previous/current even if rounding wants to.
  const tiny = conversation(5)
  const floored = windowFit(tiny, { keepTurns: 2, budget: 10_000_000, evictionBatch: 50 })
  const flooredKept = userTexts(floored.messages)
  assert.ok(flooredKept.includes("turn-3"))
  assert.ok(flooredKept.includes("turn-4"))
})

test("windowFit: prefix before the first user message is pinned with the first turn", () => {
  const messages = [assistant("bootstrap note"), ...conversation(20)]
  const fitted = windowFit(messages, { keepTurns: 5, budget: 10_000_000 })
  assert.equal(fitted.messages[0].content[0].text, "bootstrap note")
  assert.equal(userTexts(fitted.messages)[0], "turn-0")
})

// ---------------------------------------------------------------------------
// engine — assemble
// ---------------------------------------------------------------------------

test("engine.assemble: windows messages, reports estimate, carries the constant primer", async () => {
  const engine = createEngine({ keepTurns: 3, tokenCeiling: 1_000_000 })
  assert.equal(engine.info.id, ENGINE_ID)
  assert.equal(engine.info.ownsCompaction, true)

  const messages = conversation(10)
  const first = await engine.assemble({ sessionId: "s1", messages })
  const kept = userTexts(first.messages)
  assert.equal(kept.length, 4) // pinned first + 3 tail
  assert.equal(kept[0], "turn-0")
  assert.ok(first.estimatedTokens > 0)
  assert.ok(first.systemPromptAddition.includes("Cypher Tempre"))

  // Constant across runs (cache-stable prefix).
  const second = await engine.assemble({ sessionId: "s1", messages })
  assert.equal(first.systemPromptAddition, second.systemPromptAddition)
})

test("engine.assemble: clamps to the runtime tokenBudget when smaller than the ceiling", async () => {
  const engine = createEngine({ keepTurns: 15, tokenCeiling: 10_000_000 })
  const messages = conversation(10, { padding: "x".repeat(400) })
  const perTurn = estimateTokens(messages[0]) + estimateTokens(messages[1])
  const result = await engine.assemble({ sessionId: "s1", messages, tokenBudget: perTurn * 5 })
  assert.ok(result.estimatedTokens <= perTurn * 5)
  assert.ok(userTexts(result.messages).length < 10)
})

test("engine.assemble: primer:false omits systemPromptAddition", async () => {
  const engine = createEngine({ primer: false })
  const result = await engine.assemble({ sessionId: "s1", messages: conversation(2) })
  assert.equal("systemPromptAddition" in result, false)
})

// ---------------------------------------------------------------------------
// engine — compact
// ---------------------------------------------------------------------------

test("engine.compact: no-op with a recognized skip reason while assembly fits", async () => {
  const engine = createEngine({ keepTurns: 3, tokenCeiling: 1_000_000 })
  await engine.assemble({ sessionId: "s1", messages: conversation(10) })
  const result = await engine.compact({ sessionId: "s1", tokenBudget: 1_000_000 })
  assert.equal(result.ok, true)
  assert.equal(result.compacted, false)
  assert.equal(result.reason, "below threshold")

  const forced = await engine.compact({ sessionId: "s1", tokenBudget: 1_000_000, force: true })
  assert.equal(forced.ok, true)
  assert.equal(forced.compacted, false)
  assert.match(forced.reason, /nothing to compact/)
})

test("engine.compact: a smaller revealed budget tightens the window; next assemble evicts more", async () => {
  const engine = createEngine({ keepTurns: 15, tokenCeiling: 10_000_000 })
  const messages = conversation(12, { padding: "x".repeat(400) })
  const before = await engine.assemble({ sessionId: "s1", messages })
  const beforeTurns = userTexts(before.messages).length

  const revealed = Math.floor(before.estimatedTokens * 0.6)
  const result = await engine.compact({
    sessionId: "s1",
    tokenBudget: revealed,
    currentTokenCount: before.estimatedTokens,
  })
  assert.equal(result.ok, true)
  assert.equal(result.compacted, true)
  assert.equal(result.result.tokensBefore, before.estimatedTokens)
  assert.ok(result.result.tokensAfter < revealed)

  const after = await engine.assemble({ sessionId: "s1", messages })
  assert.ok(after.estimatedTokens <= result.result.tokensAfter)
  const kept = userTexts(after.messages)
  assert.ok(kept.length < beforeTurns, "tightened budget must evict more oldest turns")
  // Pins hold through overflow tightening.
  assert.equal(kept[0], "turn-0")
  assert.ok(kept.includes("turn-10"))
  assert.ok(kept.includes("turn-11"))
})

test("engine.compact: unknown session is a harmless no-op", async () => {
  const engine = createEngine({})
  const result = await engine.compact({ sessionId: "never-assembled", tokenBudget: 100 })
  assert.equal(result.ok, true)
  assert.equal(result.compacted, false)
})

// ---------------------------------------------------------------------------
// plugin entry — registration wiring
// ---------------------------------------------------------------------------

function stubApi() {
  const calls = { engines: new Map(), hooks: new Map() }
  return {
    calls,
    registerContextEngine(id, factory) {
      calls.engines.set(id, factory)
    },
    on(name, handler) {
      calls.hooks.set(name, handler)
    },
  }
}

test("entry: registers the context engine and the reminder hook", async () => {
  const api = stubApi()
  entry.register(api)
  assert.ok(api.calls.engines.has(ENGINE_ID))
  assert.ok(api.calls.hooks.has("agent_turn_prepare"))

  const engine = await api.calls.engines.get(ENGINE_ID)({
    config: { plugins: { entries: { "cypher-tempre": { config: { keepTurns: 4 } } } } },
  })
  assert.equal(engine.info.id, ENGINE_ID)

  const reminder = api.calls.hooks.get("agent_turn_prepare")(
    { prompt: "hi", messages: [], queuedInjections: [] },
    { pluginConfig: {} },
  )
  assert.ok(reminder.appendContext.includes("[Cypher Tempre] ACTIVE"))
})

test("entry: reminder respects config and CT_OCLAW_DISABLE", async () => {
  const api = stubApi()
  entry.register(api)
  const handler = api.calls.hooks.get("agent_turn_prepare")

  const off = handler({ prompt: "", messages: [], queuedInjections: [] }, { pluginConfig: { reminder: false } })
  assert.equal(off, undefined)

  process.env["CT_OCLAW_DISABLE"] = "1"
  try {
    const disabled = handler({ prompt: "", messages: [], queuedInjections: [] }, { pluginConfig: {} })
    assert.equal(disabled, undefined)
  } finally {
    delete process.env["CT_OCLAW_DISABLE"]
  }
})

// ---------------------------------------------------------------------------
// priming/config
// ---------------------------------------------------------------------------

test("resolveConfig: config beats env beats defaults", () => {
  process.env["CT_OCLAW_KEEP_TURNS"] = "7"
  try {
    assert.equal(resolveConfig({}).keepTurns, 7)
    assert.equal(resolveConfig({ keepTurns: 3 }).keepTurns, 3)
    assert.equal(resolveConfig({ keepTurns: "bogus" }).keepTurns, 7)
  } finally {
    delete process.env["CT_OCLAW_KEEP_TURNS"]
  }
  assert.equal(resolveConfig({}).keepTurns, 15)
  assert.equal(resolveConfig({}).tokenCeiling, 256_000)
  assert.equal(resolveConfig({}).evictionBatch, 1)
})

test("primer and reminder embed the configured skill dir", () => {
  assert.ok(buildPrimer("/opt/skill").includes("/opt/skill/recall.py"))
  assert.ok(buildReminder("/opt/skill").includes("/opt/skill/recall.py"))
})
