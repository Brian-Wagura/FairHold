# FairHold web

A Next.js 16 client-only app (hash routes, static build) that talks to the chain through viem and an injected wallet, and to the mediator service for private evidence.

```bash
cp .env.example .env.local
```

```bash
npm run dev
```

Routes: `#/` my escrows · `#/new` create · `#/escrow/:id` detail and actions · `#/mediator` mediator console.

Every write is simulated first, so contract errors appear in plain language before the wallet opens. Transactions use the legacy type (Aevum has no EIP-1559) and are tracked until the receipt confirms.
