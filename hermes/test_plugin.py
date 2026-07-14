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

    @unittest.skipUnless(GENESIS_COPY.is_file(), "genesis checkout not present")
    def test_byte_identical_with_genesis_bundle(self):
        ours = (HERE / "__init__.py").read_bytes()
        self.assertEqual(ours, GENESIS_COPY.read_bytes(),
                         "hermes/__init__.py diverged from the genesis bundle copy — sync them")


if __name__ == "__main__":
    unittest.main()
