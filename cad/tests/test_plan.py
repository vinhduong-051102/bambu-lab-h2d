"""
The subscription a job runs on (worker.claude_tokens): the one picked on the dashboard (job.json "plan"), else both
in turn. In the cad image:

    cd /opt/cad && python -m unittest tests.test_plan
"""

import json
import os
import tempfile
import unittest
from pathlib import Path

os.environ["JOBS_DIR"] = tempfile.mkdtemp(prefix="cad-plan-test-")

import worker  # noqa: E402 - reads JOBS_DIR when imported


class ClaudeTokensTest(unittest.TestCase):
    def setUp(self):
        self.env = {k: os.environ.get(k) for k in worker.PLAN_TOKENS.values()}
        os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = "one"
        os.environ["CLAUDE_CODE_OAUTH_TOKEN_FALLBACK"] = "two"
        worker.limited_at.clear()
        self.dir = Path(tempfile.mkdtemp(dir=os.environ["JOBS_DIR"]))

    def tearDown(self):
        for k, v in self.env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def plan(self, plan):
        (self.dir / "job.json").write_text(json.dumps({"plan": plan}), encoding="utf-8")

    def test_only_the_picked_subscription(self):
        self.plan("fallback")
        self.assertEqual(worker.claude_tokens(self.dir), ["two"])
        self.plan("primary")
        self.assertEqual(worker.claude_tokens(self.dir), ["one"])

    def test_both_in_turn_without_a_plan_or_its_token(self):
        self.assertEqual(worker.claude_tokens(self.dir), ["one", "two"])
        self.plan("auto")
        self.assertEqual(worker.claude_tokens(self.dir), ["one", "two"])
        os.environ["CLAUDE_CODE_OAUTH_TOKEN_FALLBACK"] = ""
        self.plan("fallback")
        self.assertEqual(worker.claude_tokens(self.dir), ["one"])

    def test_tokens_fetched_from_the_keyvault_win(self):
        tokens = self.dir / "tokens.json"
        tokens.write_text(json.dumps({"CLAUDE_CODE_OAUTH_TOKEN_FALLBACK": "vault-two", "OTHER": "x"}), encoding="utf-8")
        saved, worker.TOKENS_FILE = worker.TOKENS_FILE, tokens
        try:
            self.assertEqual(worker.claude_tokens(self.dir), ["one", "vault-two"])
            self.assertNotIn("OTHER", os.environ)
        finally:
            worker.TOKENS_FILE = saved


if __name__ == "__main__":
    unittest.main()
