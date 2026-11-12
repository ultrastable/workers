# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas
"""docs/cutover/shims.json is data consumed by this check: every shim and open item has an exit or workaround and a closing probe."""
import json, pathlib, unittest

DATA = pathlib.Path(__file__).resolve().parents[1] / "docs/cutover/shims.json"


class Shims(unittest.TestCase):
    def test_every_shim_has_an_exit_and_a_probe(self):
        d = json.loads(DATA.read_text(encoding="utf-8"))
        ids = [s["id"] for s in d["shims"]] + [i["id"] for i in d["open_items"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertGreaterEqual(len(d["shims"]), 7)
        for s in d["shims"]:
            self.assertTrue(s["shim"] and s["exit"] and s["closing_probe"], s["id"])
        for i in d["open_items"]:
            self.assertTrue(i["workaround"] and i["closing_probe"], i["id"])


if __name__ == "__main__":
    unittest.main()
