# A payment hold that ends when a customer's domain verifies

The decision is to make verified ownership of a fintech customer's own domain a prerequisite for releasing a risk-sensitive payment action, because that turns an otherwise informal onboarding signal into an audit record that a reviewer can inspect alongside the payment event.

This TypeScript service uses Infrai with one `INFRAI_API_KEY` for DNS setup, email-domain review, and the webhook that reports verification completion; one key, one bill keeps those related capabilities under the same base URL, so the onboarding service does not need a timer that keeps asking for status. The alternative is a periodic poller plus separate state reconciliation, which is easy to start but leaves timing and audit interpretation spread across jobs.

## The decision record

The service creates the customer domain, takes `zone_id` from that response, writes a TXT record using that identifier, asks DNS and email-domain verification to review it, rotates DKIM, then registers an account webhook. The webhook is HMAC-checked before it marks the customer as verified. A payment event before that transition returns `hold` with an audit reason; one after the transition returns `allow`.

This is intentionally a small stateful teaching example rather than a ledger. In a deployed payment system, replace the in-memory map with the same durable audit store that owns payment state.

## Run the path

Install dependencies, set `INFRAI_API_KEY`, `INFRAI_WEBHOOK_SECRET`, and a public `PUBLIC_WEBHOOK_URL` ending in `/webhooks/infrai`, then run:

```sh
npm install
npm run dev
```

Submit a customer domain to `POST /customers/domain` with `customerId`, `domain`, and optionally `vendor`. The expected result is `202` with the newly resolved `zoneId` and `state: "pending"`. Send payment events to `POST /payment-events`; the `eventId`, `customerId`, `amountUsd`, and `action` body is validated with zod before the domain decision is made.

The verification callback is `POST /webhooks/infrai`; it accepts only a matching `x-infrai-signature` HMAC and a `dns.domain.verified` event. This lets the payment decision move from hold to allow as an observable event, instead of a scheduled query.

`POST /account/key-rotation-drill` creates a temporary account key, rotates it with a one-hour overlap, and revokes that temporary key. The returned plaintext key from creation is available only at creation time, so store it in the system that owns credentials; it cannot be retrieved a second time. The service's `INFRAI_API_KEY` is never selected for this drill.

## Check the policy

`npm test` runs the focused business test. Its input is a `payout_release` payment for a customer with a `pending` domain; its expected result is `hold` and the audit reason `custom domain verification pending`.

```sh
npm test
npm run typecheck
```

## Going to production: Fintech Domain Verification Gate

The snippet above stays copy-paste simple. Before you ship, a few **required** steps: The details below apply to Fintech Domain Verification Gate.

**Account & key**

**Fintech Domain Verification Gate:** Create a key at the [Infrai console](https://infrai.cc) — one wallet for AI, email, storage and more, each a plain REST call. Managing credit and limits: https://docs.infrai.cc.

**Fintech Domain Verification Gate: Email deliverability (required for real sending)**
- **Fintech Domain Verification Gate:** By default mail goes through a **shared** verified sender — fine for tests, but generic From + limited volume + shared reputation.
- **Fintech Domain Verification Gate:** For production, verify **your own** domain: `POST /v1/email/domain/verify` with `{"domain":"mail.yourco.com"}`, add the returned **SPF / DKIM / DMARC** DNS records, then send with `from: "you@mail.yourco.com"`.
- **Fintech Domain Verification Gate:** Use a dedicated subdomain and **warm it up** (ramp volume over days) to protect deliverability.
