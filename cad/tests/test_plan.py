"""
The subscription a job runs on (worker.claude_tokens): the plan picked on the dashboard (job.json "plan", a KeyVault
key's id), else every plan in turn, from the plans fetched from the KeyVault. In the cad image:

    cd /opt/cad && python -m unittest tests.test_plan
"""

import json
import os
import tempfile
import time
import unittest
from pathlib import Path

os.environ["JOBS_DIR"] = tempfile.mkdtemp(prefix="cad-plan-test-")

import worker  # noqa: E402 - reads JOBS_DIR when imported


class ClaudeTokensTest(unittest.TestCase):
    def setUp(self):
        worker.limited_at.clear()
        self.dir = Path(tempfile.mkdtemp(dir=os.environ["JOBS_DIR"]))
        self.saved, worker.TOKENS_FILE = worker.TOKENS_FILE, self.dir / "tokens.json"
        self.plans([("k1", "one"), ("k2", "two"), ("k3", "three")])

    def tearDown(self):
        worker.TOKENS_FILE = self.saved

    def plans(self, plans):
        worker.TOKENS_FILE.write_text(json.dumps({"plans": [{"id": i, "name": i, "token": t} for i, t in plans]}),
                                      encoding="utf-8")

    def plan(self, plan):
        (self.dir / "job.json").write_text(json.dumps({"plan": plan}), encoding="utf-8")

    def test_only_the_picked_plan(self):
        self.plan("k2")
        self.assertEqual(worker.claude_tokens(self.dir), ["two"])
        self.plan("k3")
        self.assertEqual(worker.claude_tokens(self.dir), ["three"])

    def test_every_plan_in_turn_without_a_plan_or_once_it_is_gone(self):
        self.assertEqual(worker.claude_tokens(self.dir), ["one", "two", "three"])
        self.plan("auto")
        self.assertEqual(worker.claude_tokens(self.dir), ["one", "two", "three"])
        self.plan("k9")
        self.assertEqual(worker.claude_tokens(self.dir), ["one", "two", "three"])
        worker.limited_at["one"] = time.monotonic()
        self.assertEqual(worker.claude_tokens(self.dir), ["two", "three", "one"])

    def test_a_new_plan_is_used_at_once_and_none_means_no_claude(self):
        self.plans([("k4", "four")])
        self.assertEqual(worker.claude_tokens(self.dir), ["four"])
        worker.TOKENS_FILE.unlink()
        self.assertEqual(worker.claude_tokens(self.dir), [])
        self.assertEqual(worker.claude_plans(), [])


if __name__ == "__main__":
    unittest.main()
