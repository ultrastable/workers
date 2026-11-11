# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import unittest
from ultrastable.agents import VertexAgent, build_agent, check_pairing, model_family


class Vertex(unittest.TestCase):
    ITEM = {"id": "X-1", "title": "t", "done_check": "d"}

    def test_do_and_verify_with_stub_transport(self):
        seen = []
        a = VertexAgent("rev", transport=lambda p: seen.append(p) or "PASS looks right")
        r = a.do(self.ITEM)
        self.assertTrue(r.ok)
        ok, ev = a.verify(self.ITEM, r)
        self.assertTrue(ok)
        self.assertEqual(len(seen), 2)

    def test_transport_error_is_evidence_not_swallowed(self):
        def boom(_):
            raise RuntimeError("no token")
        a = VertexAgent("rev", transport=boom)
        r = a.do(self.ITEM)
        self.assertFalse(r.ok)
        self.assertIn("no token", r.evidence)
        self.assertFalse(a.verify(self.ITEM, r)[0])

    def test_missing_env_fails_closed(self):
        import os
        for k in ("VERTEX_ACCESS_TOKEN", "VERTEX_PROJECT", "VERTEX_LOCATION"):
            os.environ.pop(k, None)
        self.assertFalse(VertexAgent("v").do(self.ITEM).ok)

    def test_build_agent_vertex(self):
        self.assertEqual(build_agent({"kind": "vertex"}, "r").kind, "vertex")


class Pairing(unittest.TestCase):
    def test_families(self):
        self.assertEqual(model_family({"kind": "anthropic", "model": "x"}), "anthropic")
        self.assertEqual(model_family({"kind": "vertex"}), "google")
        self.assertEqual(model_family({"kind": "workers-ai"}), "meta")
        self.assertIsNone(model_family({"kind": "simulated"}))

    def test_same_family_refused(self):
        with self.assertRaises(ValueError):
            check_pairing({"kind": "anthropic", "model": "a"}, {"kind": "anthropic", "model": "b"})

    def test_different_family_and_simulated_allowed(self):
        check_pairing({"kind": "anthropic", "model": "a"}, {"kind": "vertex"})
        check_pairing({"kind": "simulated"}, {"kind": "simulated"})


if __name__ == "__main__":
    unittest.main()
