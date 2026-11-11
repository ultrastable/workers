# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""No single point of failure, and no terminal as the first door (D-NO-SINGLE-POINT-OF-FAILURE, D-NON-CODER-START)."""
import json
import unittest
from pathlib import Path

DOORS = json.loads((Path(__file__).resolve().parents[1] / "self" / "doors.json").read_text(encoding="utf-8"))
ORDER = DOORS["effort_levels"]


class Doors(unittest.TestCase):
    def test_every_prerequisite_has_at_least_two_independent_doors(self):
        for p in DOORS["prerequisites"]:
            self.assertGreaterEqual(len(p["doors"]), 2, p["id"])
            self.assertEqual(len({d["id"] for d in p["doors"]}), len(p["doors"]), f"{p['id']}: duplicate door ids")

    def test_doors_are_ordered_from_least_owner_effort_to_most(self):
        for p in DOORS["prerequisites"]:
            ranks = [ORDER.index(d["owner_effort"]) for d in p["doors"]]
            self.assertEqual(ranks, sorted(ranks), f"{p['id']} doors are not ordered by effort")

    def test_the_first_door_never_needs_a_terminal_or_typing_a_secret(self):
        for p in DOORS["prerequisites"]:
            first = p["doors"][0]
            self.assertLessEqual(ORDER.index(first["owner_effort"]), ORDER.index("clicks"), f"{p['id']} first door needs {first['owner_effort']}")

    def test_the_terminal_is_never_the_only_door(self):
        for p in DOORS["prerequisites"]:
            self.assertTrue(any(d["owner_effort"] != "terminal" for d in p["doors"]), p["id"])

    def test_every_door_says_how_and_has_a_known_status(self):
        for p in DOORS["prerequisites"]:
            for d in p["doors"]:
                self.assertTrue(d["how"].strip(), f"{p['id']}/{d['id']}")
                self.assertIn(d["status"], ("built", "planned"))
                self.assertIn(d["owner_effort"], ORDER)

    def test_at_least_one_door_per_prerequisite_is_built_so_the_system_can_start_today(self):
        for p in DOORS["prerequisites"]:
            self.assertTrue(any(d["status"] == "built" for d in p["doors"]), p["id"])


if __name__ == "__main__":
    unittest.main()
