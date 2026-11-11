# Security

Report a vulnerability privately by email to rowan.quni@qnfo.org, or through GitHub's "Report a vulnerability" (private security advisory) on this repository. Please do not open a public issue for a vulnerability. Expect an acknowledgement within 7 days.

Design rule worth knowing when you report: the tick must never read, log or write a secret value. It only learns whether a secret binding exists. A path where a value can leak is a vulnerability.
