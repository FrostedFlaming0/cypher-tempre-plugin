import assert from "node:assert"
import { CypherTempre } from "./cypher-tempre.js"
const { FULL_PRIMING, REMINDER, appendToUserParts, truncateMessages } = CypherTempre.internals

// loader contract: every export must be a (or wrap a) plugin function
const mod = await import("./cypher-tempre.js")
for (const [name, value] of Object.entries(mod)) {
  assert.equal(typeof value, "function", `export ${name} must be a function for the opencode loader`)
}

// --- helpers ------------------------------------------------------------
const text = (t, extra = {}) => ({ id: "prt_x", sessionID: "ses_x", messageID: "msg_x", type: "text", text: t, ...extra })
const user = (parts) => ({ info: { role: "user" }, parts })
const assistant = (parts = [text("reply")]) => ({ info: { role: "assistant" }, parts })
const turn = (userText, assistantCount = 1) => [user([text(userText)]), ...Array.from({ length: assistantCount }, () => assistant())]

// --- appendToUserParts ---------------------------------------------------
{
  const parts = [text("hello world")]
  assert.equal(appendToUserParts(parts, "BLOCK"), true)
  assert.equal(parts[0].text, "hello world\n\nBLOCK")
}
{
  // appends to LAST non-synthetic text part, skipping synthetic ones
  const parts = [text("first"), text("second"), text("synth", { synthetic: true })]
  appendToUserParts(parts, "B")
  assert.equal(parts[1].text, "second\n\nB")
  assert.equal(parts[0].text, "first")
  assert.equal(parts[2].text, "synth")
}
{
  // no text part -> false, nothing mutated
  const parts = [{ type: "file", mime: "image/png" }]
  assert.equal(appendToUserParts(parts, "B"), false)
}

// --- truncateMessages: turn-count policy ---------------------------------
{
  // 6 turns, keep 3 -> first user msg pinned + last 3 full turns
  const msgs = [...turn("t1"), ...turn("t2"), ...turn("t3"), ...turn("t4"), ...turn("t5"), ...turn("t6")]
  const out = truncateMessages(msgs, { keepTurns: 3, tokenCeiling: 1e9 })
  assert.equal(out[0].parts[0].text, "t1") // pinned first user message
  assert.equal(out[0].info.role, "user")
  assert.equal(out.length, 1 + 3 * 2) // pin + 3 turns of (user+assistant)
  assert.equal(out[1].parts[0].text, "t4") // tail starts at a user message
  assert.equal(out[out.length - 2].parts[0].text, "t6")
}
{
  // under the limit -> untouched (same reference)
  const msgs = [...turn("t1"), ...turn("t2"), ...turn("t3")]
  assert.equal(truncateMessages(msgs, { keepTurns: 5, tokenCeiling: 1e9 }), msgs)
}
{
  // exactly at the limit -> untouched
  const msgs = [...turn("t1"), ...turn("t2"), ...turn("t3")]
  assert.equal(truncateMessages(msgs, { keepTurns: 3, tokenCeiling: 1e9 }), msgs)
}
{
  // single turn -> untouched
  const msgs = [...turn("only")]
  assert.equal(truncateMessages(msgs, { keepTurns: 1, tokenCeiling: 10 }), msgs)
}

// --- truncateMessages: token-ceiling policy -------------------------------
{
  // heavy middle turns get dropped before the turn cap is reached
  const heavy = (t) => [user([text(t)]), assistant([text("x".repeat(40_000))])] // ~10k tokens each
  const msgs = [...turn("t1"), ...heavy("t2"), ...heavy("t3"), ...heavy("t4"), ...heavy("t5")]
  const out = truncateMessages(msgs, { keepTurns: 15, tokenCeiling: 25_000 })
  // ~10k per heavy turn: t5 + t4 fit (~20k), t3 would exceed 25k
  const userTexts = out.filter((m) => m.info.role === "user").map((m) => m.parts[0].text)
  assert.deepEqual(userTexts, ["t1", "t4", "t5"])
}
{
  // a single oversized most-recent turn is ALWAYS kept
  const msgs = [...turn("t1"), ...turn("t2"), [user([text("t3")]), assistant([text("y".repeat(400_000))])].flat()].flat()
  const flat = [...turn("t1"), ...turn("t2"), user([text("t3")]), assistant([text("y".repeat(400_000))])]
  const out = truncateMessages(flat, { keepTurns: 15, tokenCeiling: 1000 })
  const userTexts = out.filter((m) => m.info.role === "user").map((m) => m.parts[0].text)
  assert.deepEqual(userTexts, ["t1", "t3"])
}
{
  // turn boundaries: assistant messages stay with their turn's user message
  const msgs = [...turn("t1", 3), ...turn("t2", 2), ...turn("t3", 4)]
  const out = truncateMessages(msgs, { keepTurns: 1, tokenCeiling: 1e9 })
  // pinned t1 user + full t3 turn (user + 4 assistants)
  assert.equal(out.length, 1 + 5)
  assert.equal(out[1].parts[0].text, "t3")
  for (let i = 2; i < out.length; i++) assert.equal(out[i].info.role, "assistant")
}

// --- truncateMessages: clipping ORDER as the ceiling tightens --------------
{
  // 6 equal-weight turns. Progressively lower ceilings must clip oldest-first:
  // t2 goes first, then t3, ... with t1 (pinned) and t6 (most recent) never clipped.
  const msgs = [...turn("t1"), ...turn("t2"), ...turn("t3"), ...turn("t4"), ...turn("t5"), ...turn("t6")]
  const per = 2 * (Math.ceil(JSON.stringify(turn("tX")[0].parts).length / 4) + 20) // user+assistant cost
  const survivors = (ceiling) =>
    truncateMessages(msgs, { keepTurns: 15, tokenCeiling: ceiling })
      .filter((m) => m.info.role === "user")
      .map((m) => m.parts[0].text)
  assert.deepEqual(survivors(per * 5.5), ["t1", "t2", "t3", "t4", "t5", "t6"]) // all fit
  assert.deepEqual(survivors(per * 4.5), ["t1", "t3", "t4", "t5", "t6"]) // t2 clipped first
  assert.deepEqual(survivors(per * 3.5), ["t1", "t4", "t5", "t6"]) // then t3
  assert.deepEqual(survivors(per * 2.5), ["t1", "t5", "t6"]) // then t4
  assert.deepEqual(survivors(per * 1.5), ["t1", "t6"]) // then t5
  assert.deepEqual(survivors(1), ["t1", "t6"]) // t6 + pinned t1 survive ANY ceiling
}

// --- hooks end-to-end ------------------------------------------------------
{
  process.env.CT_OC_DISABLE = ""
  const hooks = await CypherTempre()
  const sid = `ses_test_${Math.random().toString(36).slice(2)}`

  // first message -> FULL_PRIMING
  const out1 = { message: {}, parts: [text("do the thing")] }
  await hooks["chat.message"]({ sessionID: sid }, out1)
  assert.ok(out1.parts[0].text.includes("standing instruction"), "first message gets full priming")
  assert.ok(out1.parts[0].text.includes("recall.py turn"))

  // second message -> REMINDER
  const out2 = { message: {}, parts: [text("next step")] }
  await hooks["chat.message"]({ sessionID: sid }, out2)
  assert.ok(out2.parts[0].text.includes("[Cypher Tempre] ACTIVE"), "second message gets reminder")
  assert.ok(!out2.parts[0].text.includes("standing instruction"))

  // persistence: a fresh hook instance still sees the session as primed
  const hooks2 = await CypherTempre()
  const out3 = { message: {}, parts: [text("third")] }
  await hooks2["chat.message"]({ sessionID: sid }, out3)
  assert.ok(!out3.parts[0].text.includes("standing instruction"), "primed state survives reload")

  // transform splices in place
  const msgs = [...turn("t1"), ...turn("t2"), ...turn("t3"), ...turn("t4")]
  const output = { messages: msgs }
  process.env.CT_OC_KEEP_TURNS = "" // defaults are baked at import; use big array vs default 15
  const big = []
  for (let i = 1; i <= 20; i++) big.push(...turn(`t${i}`))
  const outBig = { messages: big }
  await hooks["experimental.chat.messages.transform"]({}, outBig)
  assert.equal(outBig.messages.length, 1 + 15 * 2, "default keeps pin + 15 turns")
  assert.equal(outBig.messages[0].parts[0].text.split("\n")[0], "t1")
}

console.log("ALL PLUGIN TESTS PASSED")
console.log("priming length:", FULL_PRIMING.length, "chars; reminder length:", REMINDER.length, "chars")
