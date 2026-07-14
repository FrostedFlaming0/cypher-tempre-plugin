import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


HERE = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("ct_hermes", HERE / "__init__.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

GENESIS_COPY = Path(
    os.environ.get(
        "CT_GENESIS_CHECKOUT",
        Path.home() / "projects" / "cypher-tempre-genesis",
    )
) / "skills" / "hermes" / "cypher-tempre-self-model" / "hermes-plugin" / "__init__.py"


class Context:
    def __init__(self):
        self.hooks = {}

    def register_hook(self, name, callback):
        self.hooks[name] = callback


class Result:
    returncode = 0

    def __init__(self, event, context):
        self.stdout = json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": context}})


class HermesPluginTests(unittest.TestCase):
    def setUp(self):
        MODULE._session_context.clear()
        MODULE._primed_sessions.clear()
        # Hermetic: never read the developer's real ~/.hermes/config.yaml,
        # where the pinned-window engine may genuinely be selected.
        patcher = patch.object(MODULE, "_window_engine_selected", return_value=False)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_registers_runtime_hooks(self):
        ctx = Context()
        MODULE.register(ctx)
        self.assertEqual(set(ctx.hooks), {"on_session_start", "pre_llm_call", "post_llm_call", "subagent_stop"})

    def test_startup_and_turn_context_are_combined_once(self):
        calls = iter([Result("SessionStart", "startup"), Result("UserPromptSubmit", "turn")])
        with patch.object(MODULE, "_run", side_effect=lambda *a, **k: next(calls)):
            MODULE._session_start(session_id="s1")
            value = MODULE._pre_llm_call(session_id="s1", user_message="hello")
        self.assertEqual(value, {"context": "startup\n\nturn"})
        self.assertNotIn("s1", MODULE._session_context)

    def test_resumed_session_rehydrates_on_first_turn(self):
        # Hermes fires on_session_start only for brand-new sessions; a resumed
        # session must be rehydrated from pre_llm_call.
        seen = []

        def fake_run(script, *args, payload=None):
            seen.append(args[0])
            return Result("SessionStart", "rehydrated") if args[0] == "session-start" else Result("UserPromptSubmit", "turn")

        with patch.object(MODULE, "_run", side_effect=fake_run):
            value = MODULE._pre_llm_call(session_id="resumed", user_message="hello")
        self.assertEqual(seen, ["session-start", "user-prompt"])
        self.assertEqual(value, {"context": "rehydrated\n\nturn"})

    def test_failed_prime_is_retried_next_turn(self):
        # A transient session-start failure must not mark the session primed;
        # the next turn retries and the rehydration context still arrives.
        seen = []
        healthy = False

        def fake_run(script, *args, payload=None):
            seen.append(args[0])
            if args[0] == "session-start":
                return Result("SessionStart", "rehydrated") if healthy else None
            return Result("UserPromptSubmit", "turn")

        with patch.object(MODULE, "_run", side_effect=fake_run):
            first = MODULE._pre_llm_call(session_id="flaky", user_message="one")
            healthy = True
            second = MODULE._pre_llm_call(session_id="flaky", user_message="two")
        self.assertEqual(first, {"context": "turn"})
        self.assertEqual(second, {"context": "rehydrated\n\nturn"})
        self.assertEqual(seen.count("session-start"), 2)

    def test_clean_empty_prime_counts_as_primed(self):
        # Exit 0 with no context (e.g. a dormant chain) is a completed prime;
        # session-start must not re-run every turn.
        seen = []

        def fake_run(script, *args, payload=None):
            seen.append(args[0])
            return Result("SessionStart", "") if args[0] == "session-start" else Result("UserPromptSubmit", "turn")

        with patch.object(MODULE, "_run", side_effect=fake_run):
            MODULE._pre_llm_call(session_id="dormant", user_message="one")
            MODULE._pre_llm_call(session_id="dormant", user_message="two")
        self.assertEqual(seen.count("session-start"), 1)
        self.assertIn("dormant", MODULE._primed_sessions)

    def test_session_is_primed_once_per_process(self):
        seen = []

        def fake_run(script, *args, payload=None):
            seen.append(args[0])
            return Result("UserPromptSubmit", "turn")

        with patch.object(MODULE, "_run", side_effect=fake_run):
            MODULE._pre_llm_call(session_id="s2", user_message="first")
            MODULE._pre_llm_call(session_id="s2", user_message="second")
        self.assertEqual(seen.count("session-start"), 1)

    def test_payload_excludes_conversation_history(self):
        captured = []

        def fake_run(script, *args, payload=None):
            captured.append(payload)
            json.dumps(payload)  # every forwarded payload must serialize
            return None

        history = [{"role": "user", "content": object()}]  # not JSON-serializable
        with patch.object(MODULE, "_run", side_effect=fake_run):
            MODULE._pre_llm_call(session_id="s3", user_message="hello", conversation_history=history)
            MODULE._post_llm_call(session_id="s3", user_message="hello", assistant_response="done",
                                  conversation_history=history)
            MODULE._subagent_stop(session_id="s3", conversation_history=history)
        self.assertTrue(captured)
        for payload in captured:
            self.assertNotIn("conversation_history", payload)
        self.assertEqual(captured[1]["prompt"], "hello")

    def test_timeout_is_clamped_and_survives_bad_values(self):
        cases = {"bogus": 8.0, "999": 30.0, "0.01": 0.25, "5": 5.0}
        for raw, expected in cases.items():
            with patch.dict(os.environ, {"CT_HERMES_TIMEOUT": raw}, clear=False):
                self.assertEqual(MODULE._timeout(), expected)

    def test_pending_context_is_bounded(self):
        for i in range(MODULE._MAX_PENDING_CONTEXT + 8):
            MODULE._remember_context(f"s{i}", "ctx")
        self.assertLessEqual(len(MODULE._session_context), MODULE._MAX_PENDING_CONTEXT)

    def test_post_llm_call_drops_unridden_startup_context(self):
        MODULE._session_context["s4"] = "stale"
        with patch.object(MODULE, "_run", return_value=None):
            MODULE._post_llm_call(session_id="s4")
        self.assertNotIn("s4", MODULE._session_context)

    def test_missing_skill_is_fail_open(self):
        with tempfile.TemporaryDirectory() as td, patch.dict("os.environ", {"CT_HERMES_SKILL_DIR": td}, clear=False):
            self.assertIsNone(MODULE._pre_llm_call(session_id="s", user_message="hello"))

    def test_context_discipline_rides_priming_when_engine_selected(self):
        with patch.object(MODULE, "_window_engine_selected", return_value=True), \
             patch.object(MODULE, "_run", return_value=Result("SessionStart", "startup")):
            MODULE._session_start(session_id="w1")
        self.assertIn("Context discipline", MODULE._session_context["w1"])
        self.assertIn("startup", MODULE._session_context["w1"])


def turn(i, extra_msgs=0, size=1):
    msgs = [{"role": "user", "content": f"u{i} " + "x" * size}]
    msgs.append({"role": "assistant", "content": f"a{i}", "tool_calls": [{"id": f"t{i}"}]})
    msgs.append({"role": "tool", "tool_call_id": f"t{i}", "content": f"r{i}"})
    for j in range(extra_msgs):
        msgs.append({"role": "assistant", "content": f"a{i}.{j}"})
    return msgs


class PinnedWindowEngineTests(unittest.TestCase):
    def make(self, keep=3, ceiling=256000):
        with patch.dict(os.environ, {"CT_HERMES_KEEP_TURNS": str(keep),
                                     "CT_HERMES_TOKEN_CEILING": str(ceiling)}, clear=False):
            return MODULE.PinnedWindowEngine()

    def convo(self, n_turns):
        msgs = [{"role": "system", "content": "sys"}]
        for i in range(1, n_turns + 1):
            msgs.extend(turn(i))
        return msgs

    def test_few_turns_unchanged(self):
        engine = self.make(keep=5)
        msgs = self.convo(3)
        self.assertIs(engine.compress(msgs), msgs)
        self.assertEqual(engine.compression_count, 0)

    def test_trims_to_window_pinning_head_and_never_splitting_tool_pairs(self):
        engine = self.make(keep=2)
        msgs = self.convo(6)
        out = engine.compress(msgs)
        self.assertEqual(out[0]["role"], "system")
        self.assertEqual(out[1]["content"].split()[0], "u1")  # pinned first user msg
        kept_users = [m["content"].split()[0] for m in out if m["role"] == "user"]
        self.assertEqual(kept_users, ["u1", "u5", "u6"])
        for m in out:  # every tool result's call is present in the kept window
            if m.get("role") == "tool":
                calls = [c["id"] for km in out if km.get("tool_calls") for c in km["tool_calls"]]
                self.assertIn(m["tool_call_id"], calls)
        self.assertEqual(engine.compression_count, 1)

    def test_newest_turn_always_kept_over_ceiling(self):
        engine = self.make(keep=5, ceiling=1000)
        msgs = [{"role": "system", "content": "sys"}]
        for i in range(1, 4):
            msgs.extend(turn(i, size=200000))  # each turn far over the ceiling
        out = engine.compress(msgs)
        kept_users = [m["content"].split()[0] for m in out if m["role"] == "user"]
        self.assertEqual(kept_users, ["u1", "u3"])

    def test_ceiling_evicts_below_keep_turns(self):
        engine = self.make(keep=10, ceiling=1000)
        msgs = [{"role": "system", "content": "sys"}]
        for i in range(1, 7):
            msgs.extend(turn(i, size=1200))  # ~2 turns fit under 1000 tokens
        out = engine.compress(msgs)
        kept_users = [m["content"].split()[0] for m in out if m["role"] == "user"]
        self.assertLess(len(kept_users), 7)
        self.assertEqual(kept_users[0], "u1")
        self.assertEqual(kept_users[-1], "u6")

    def test_reducible_transcript_lands_below_trigger(self):
        # Codex review finding: the tail budget must account for the pinned
        # prefix, including a large first user message — a reducible
        # transcript must land below the trigger threshold after one trim.
        engine = self.make(keep=10, ceiling=1000)
        msgs = [{"role": "system", "content": "s" * 400},
                {"role": "user", "content": "u1 " + "x" * 800}]
        msgs.append({"role": "assistant", "content": "a1 " + "y" * 800})
        for i in range(2, 6):
            msgs += [{"role": "user", "content": f"u{i} " + "x" * 800},
                     {"role": "assistant", "content": f"a{i} " + "y" * 800}]
        out = engine.compress(msgs)
        estimate = sum(engine._estimate(m) for m in out)
        self.assertLessEqual(estimate, engine.threshold_tokens)
        self.assertEqual(engine.compress(out), out)  # idempotent, not a churn loop
        kept_users = [m["content"].split()[0] for m in out if m["role"] == "user"]
        self.assertEqual(kept_users[0], "u1")
        self.assertEqual(kept_users[-1], "u5")

    def test_irreducible_pinned_prefix_still_keeps_newest_turn(self):
        engine = self.make(keep=10, ceiling=1000)
        msgs = [{"role": "system", "content": "s" * 4000},
                {"role": "user", "content": "u1 " + "x" * 4000}]
        for i in range(2, 5):
            msgs += [{"role": "user", "content": f"u{i} " + "x" * 800},
                     {"role": "assistant", "content": f"a{i}"}]
        out = engine.compress(msgs)
        kept_users = [m["content"].split()[0] for m in out if m["role"] == "user"]
        self.assertEqual(kept_users, ["u1", "u4"])

    def test_should_compress_threshold(self):
        engine = self.make(ceiling=50000)
        self.assertFalse(engine.should_compress(None))
        self.assertFalse(engine.should_compress(49999))
        self.assertTrue(engine.should_compress(50000))

    def test_update_model_caps_threshold_at_ceiling(self):
        engine = self.make(ceiling=256000)
        engine.update_model("m", 128000)
        self.assertEqual(engine.threshold_tokens, 96000)
        engine.update_model("m", 1000000)
        self.assertEqual(engine.threshold_tokens, 256000)

    def test_engine_is_deepcopy_safe(self):
        import copy

        engine = self.make()
        clone = copy.deepcopy(engine)
        clone.compression_count += 1
        self.assertEqual(engine.compression_count, 0)

    def test_register_offers_engine_when_supported(self):
        class EngineContext(Context):
            engine = None
            def register_context_engine(self, engine):
                self.engine = engine

        ctx = EngineContext()
        fake_engine = object()
        with patch.object(MODULE, "create_context_engine", return_value=fake_engine):
            MODULE.register(ctx)
        self.assertIs(ctx.engine, fake_engine)

    @unittest.skipUnless(GENESIS_COPY.is_file(), "genesis checkout not present")
    def test_byte_identical_with_genesis_bundle(self):
        ours = (HERE / "__init__.py").read_bytes()
        self.assertEqual(ours, GENESIS_COPY.read_bytes(),
                         "hermes/__init__.py diverged from the genesis bundle copy — sync them")


if __name__ == "__main__":
    unittest.main()
