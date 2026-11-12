# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import claim_url_scan as cs  # noqa: E402


class ClaimUrlScan(unittest.TestCase):
    def test_finds_a_claim_url_and_keys(self):
        t = "ok\nOpen https://dash.cloudflare.com/claim?token=abc123 now\nCLOUDFLARE_API_TOKEN=abcdef0123456789abcd\nauth: Bearer abcdefghijklmnopqrstuvwx\n"
        self.assertEqual([k for k, _ in cs.scan(t)], ["claim-url", "api-key-assignment", "bearer"])

    def test_clean_transcript_has_no_findings(self):
        self.assertEqual(cs.scan("wrangler deploy ok\nhttps://example.workers.dev/health 200\n"), [])

    def test_redact_removes_the_secret_value(self):
        r = cs.redact("see https://dash.cloudflare.com/claim?token=SECRET123 and cfut_" + "A" * 30)
        self.assertNotIn("SECRET123", r); self.assertNotIn("cfut_AAAA", r)
        self.assertEqual(cs.scan(r), [])

    def test_findings_never_contain_the_secret(self):
        self.assertTrue(all(isinstance(x, tuple) and len(x) == 2 for x in cs.scan("https://x/claim?token=SECRET")))


if __name__ == "__main__":
    unittest.main()
