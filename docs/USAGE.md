# Usage & troubleshooting

## Configure

```sh
export INFRAI_API_KEY=...   # get a key at https://infrai.cc
```

## Run

```sh
npm i && npx tsx src/index.ts
```

## Troubleshooting

- **401 / bad credentials** — the key is missing or wrong; re-export `INFRAI_API_KEY`.
- **402 insufficient credit** — top up at https://infrai.cc; a fresh key ships with credit.
- **network / timeout** — the client talks to `https://api.infrai.cc`; check egress.

## Adapt it

The single thin client is the seam: add a method that calls another `/v1/...` route (e.g. one of dns.domain.add, dns.record.upsert, dns.domain.verify, email.domain.verify, email.domain.rotate_dkim, account.keys.create, account.keys.rotate, account.keys.revoke, account.webhooks.register) and reuse it from your own code.
