# Contributing

Thank you. Contributions are welcome under these terms.

1. **License.** By submitting a contribution you agree to Section 11 of the Ultrastable License (LICENSE): you license it to everyone under the License, you grant the Licensor a perpetual, irrevocable right to relicense it (including commercially), and you keep your copyright.
2. **Sign-off.** Every commit needs a `Signed-off-by:` line (`git commit -s`), certifying the Developer Certificate of Origin 1.1 (https://developercertificate.org/).
3. **Tests.** `cd core && npm test`, `python -m unittest discover tests`, `node --test adapters/gcp/test/*.js` must pass. New behavior needs a test.
4. **No secrets, no QNFO constants.** Nothing in `core/` or `adapters/` may name an account, host or repository. Read them from configuration.
5. **Headers.** New source files carry the SPDX header used in the existing files.
6. **Scope.** Changes to autonomy policy (`autonomy/policy.json`) widen what agents may do; they need an explanation of the evidence that justifies it.

Commercial users do not need to contribute, but share-alike (LICENSE Section 6) applies to what you distribute.
