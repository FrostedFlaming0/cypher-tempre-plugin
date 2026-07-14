import importlib.util
import json
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

    def test_missing_skill_is_fail_open(self):
        with tempfile.TemporaryDirectory() as td, patch.dict("os.environ", {"CT_HERMES_SKILL_DIR": td}, clear=False):
            self.assertIsNone(MODULE._pre_llm_call(session_id="s", user_message="hello"))


if __name__ == "__main__":
    unittest.main()
