<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# Ultrastable Commercial Terms v1.0 (DEFAULT RATE CARD)

Status: **decided 2026-11-11, rationale in the Decisions section below.** The numbers in the tables below are the only part of this file that is a pricing judgment. The licence (`LICENSE`, Section 4) works with any numbers, and Section 4.3 lets the Licensor change them for new licences.

If You use the Materials or an Implementation commercially (`LICENSE` Section 3), You accept these terms by registering (Section 3 below) and paying when due. That is a Commercial License under `LICENSE` Section 4.1.

## 1. Who needs this

You, if any of these is true: You earn money using the Software or an Implementation; You run a for-profit business with it, including a business run autonomously from an idea; You are paid to use it for a client; You embed it in a product; You host it for others. If You only use it for Non-Commercial Use (`LICENSE` Section 2.2), You owe nothing and need not register.

## 2. Price

| Tier | Who | Price |
|---|---|---|
| **Evaluate** | Any organization, up to 60 days, no production use, no revenue | Free (this is Non-Commercial Use, `LICENSE` 2.2(e)) |
| **Founder** | A business with total Covered Revenue under USD 100,000 cumulative | 0% until cumulative Covered Revenue passes USD 100,000, then the Standard rate on revenue above that line. Registration required. |
| **Standard** | Any business with Covered Revenue | **5%** of Covered Revenue up to USD 1,000,000 per calendar year, **2%** of the part above USD 1,000,000, paid quarterly |
| **Internal** | A for-profit organization using the Software only for internal operations with no customer-facing revenue | USD 1,200 per organization per year if it has fewer than 25 people; USD 12,000 per year otherwise. Or the Standard rate on the revenue the internal operations support, whichever the organization elects |
| **Platform / reseller / hosted service** | You offer the Software or an Implementation to third parties as a product or platform | Separate agreement (`LICENSE` Section 4.1(c) and 4.2); default starting point 15% of the platform's revenue from the Software |

"Covered Revenue" means money and the market value of other consideration You and Your Affiliates receive, in the period, from any product, service, deliverable or organization that is operated, managed, produced or run with material use of the Materials or of an Implementation, **less** refunds, chargebacks, sales and value-added taxes, and pass-through third-party costs billed at cost. Revenue is counted when received.

The Standard rate applies to the whole organization or product the Software runs. If the Software runs only a separable product line and You keep separate books for it, Covered Revenue is that line's revenue.

## 3. How to register

1. Open an issue titled `Commercial registration: <organization>` in `github.com/ultrastable/license`, or email `rowan.quni@qnfo.org` (the Licensor's address in `LICENSE` Section 22; the issue route needs no mailbox), stating: legal name, country, intended use, the product or organization the Software will run, and the tier You choose.
2. The Licensor acknowledges in writing. Your Commercial License starts on the date of Your registration notice.
3. Within 30 days after each calendar quarter ends, send a one-page statement of Covered Revenue and pay the amount due. Keep the books that support it for three years.

Registration does not require negotiation. The Licensor may decline only for the reasons in `LICENSE` Section 4.1.

## 4. Audit

The Licensor may, once a year and on 30 days' notice, ask for a statement from Your officer that the revenue reports are complete, and for the records that support it. If an audit shows an under-payment of more than 5%, You pay the audit cost as well as the shortfall and interest at 1% per month.

## 5. What You get

A non-exclusive, non-transferable (except with the business) license for Commercial Use of the Materials and Implementations for the term of Your registration, for the tier You chose, in any country not barred by `LICENSE` Section 4.1(d). The duties in `LICENSE` Sections 6 (share-alike), 8 (prohibited uses), 9 (AI training), 10 (patents) and 12 (marks) continue to apply. A Founder or Standard licensee may keep private any code that is not a Covered File (`LICENSE` Section 6.4).

## 6. Term and ending

The license continues while You pay. Either side may end it on 60 days' written notice. When it ends You stop Commercial Use, and You owe Covered Revenue received up to the end date. A business You operated with the Software keeps its own data and outputs (`LICENSE` Section 2.3).

## 7. Support and liability

No support is included. The liability limit in `LICENSE` Section 15.2 is USD 1 for the non-commercial grant; for a Commercial License it is the fees You paid in the 12 months before the claim, except where the law does not allow a limit.

## 8. Changes

The Licensor may publish a new version of this file at any time. `LICENSE` Section 4.3 protects licences already in force.

## Decisions and rationale (2026-11-11)

Researched against how source-available and dual licenses are written and priced:

- **Business Source License (MariaDB, HashiCorp, CockroachDB and others)** forbids production use by default, lets the owner add an "Additional Use Grant", and converts to a GPL-compatible license after at most four years. Critics (for example the OpenTofu project) call "production use" ambiguous. USL-1.0 avoids that: the test is whether the use makes or saves money, with a closed list of free uses (`LICENSE` 2.2). It deliberately has no change date, because the business model is revenue from commercial use.
- **Functional Source License (Sentry)** bars only a competing commercial offering and lapses to Apache-2.0 after two years. USL-1.0 is stricter, since it licenses all commercial use, which is the owner's stated goal.
- **n8n Sustainable Use License** allows internal business use free, forbids charging for hosted access and embedding without a separate agreement, and sells Enterprise by custom quote. USL-1.0 charges for internal for-profit use too, so the Internal tier is priced low for small teams.
- **Directus** (BSL) lets organizations under USD 5M revenue and 50 employees use it free in production. That is a free-grant approach; ours is a small revenue share with a zero band, because the Software here operates the business, not just a feature of it.
- **PolyForm** licenses are free-for-noncommercial or free-for-small-business with commercial licenses negotiated case by case. A published, acceptable-without-negotiation price list (our `LICENSE` 4.1) is more usable than negotiation for solo founders.
- **Take rates people already pay** to platforms that sit in the money flow: payment processors about 3%; creator and storefront platforms roughly 5% to 10%; app stores 15% to 30% (published rate cards, approximate). A system that runs the whole business earns a rate above a payment rail and below a marketplace.

Resulting choices:
1. **Standard 5%, stepping down to 2% above USD 1M a year.** In the band buyers already accept; the step-down keeps cost predictable for large users so evading the license is not worth it.
2. **Founder zero band of USD 100,000 cumulative** (was 50,000). A first business can prove itself before paying; revenue below that is rarely worth the audit cost.
3. **Internal use: USD 1,200 a year under 25 people, USD 12,000 otherwise**, or the revenue-share route. Matches seat-based business tools at small scale and a modest enterprise floor.
4. **Platform/reseller default 15%** as a starting point only (it is a custom agreement), in line with marketplace rates.
5. **The Founder tier stays.** It lowers the entry barrier and is the main adoption lever; the 5% still applies from the first dollar above the line.
6. **Contact:** `LICENSE` 22 stays as written; registration through an issue in `ultrastable/license` needs no mailbox.
7. **Review cadence:** these numbers are re-read after the first ten registrations or twelve months, whichever is first, using actual registration and drop-off data. Changes apply to new licenses only (`LICENSE` 4.3).
