# GhostOS

Agent-company operating system for Ghost Tech Solutions.

## Agent company

GhostOS operates as six bounded agents over Airtable:

- **ATLAS** — general manager/orchestrator
- **RELAY** — customer communication drafting only; owner copies/sends messages manually
- **SUPPLY** — live parts research and inventory intelligence; never purchases
- **LEDGER** — quote economics, revenue/cost/margin analysis
- **DISPATCH** — scheduling and mobile-service planning
- **BUILDER** — internal software engineering planner

Airtable is the operating source of truth. Netlify Functions provide authenticated APIs and the dashboard runtime.

## Company dashboard

`/dashboard` is the owner command center with dedicated views for:

- Command Center / company health
- Agents
- Jobs & Sales
- RELAY drafts
- Supply / parts research
- Finance / cash
- BUILDER engineering backlog
- Agent activity and active business controls

The browser stores the GhostOS dashboard key only in `sessionStorage`. Airtable, OpenAI and GitHub credentials remain server-side.

## RELAY manual communication boundary

GhostOS does not send customer SMS/email. RELAY prepares drafts. The owner may edit a draft, copy it, send it personally from their phone/account, then manually mark it sent. A manual sent record is never delivery confirmation.

No SMS provider or outbound webhook is required for normal GhostOS operation. STOP/opt-out state remains visible for owner reference and blocks the manual SMS workflow inside the dashboard.

## BUILDER

BUILDER uses the `Builder Requests` Airtable table as its engineering backlog.

BUILDER v1 can:

- accept owner or ATLAS improvement requests
- inspect the current GhostOS `main` branch using server-side GitHub read access
- read relevant source files
- create a grounded ordered implementation plan
- classify risk
- record likely files affected
- record a verification plan
- log its activity to Airtable

BUILDER v1 is intentionally **read-only against GitHub**. It cannot commit, merge, deploy, change secrets, or claim code was changed. Repository execution remains owner-controlled until a later bounded build-execution stage is explicitly approved.

## Owner approval boundary

Owner Inbox is reserved for consequential business actions such as purchases, refunds, contracts, unusual pricing/discounts, material ad-spend changes, scheduling exceptions, or unusual external commitments. Routine RELAY drafts and Builder Requests do not flood Owner Inbox.

## Core environment variables

Required for normal operation:

- `OPENAI_API_KEY`
- `AIRTABLE_PAT`
- `AIRTABLE_BASE_ID`
- `GHOSTOS_WEBHOOK_SECRET`
- `GHOSTOS_MODEL` optional; defaults to `gpt-5.6-sol`

BUILDER analysis additionally uses server-side `GITHUB_TOKEN` read access and optional `GHOSTOS_GITHUB_REPO` (defaults to `ghosttechsolutionsCHS/ghostos`). Never expose secret values in dashboard/browser/log output.

## APIs

- `GET /api/ghostos` — health
- `POST /api/ghostos` — process a job through ATLAS
- `GET /api/dashboard` — company dashboard snapshot
- `POST /api/approval` — resolve consequential Owner Inbox approvals
- `POST /api/relay-message` — edit a RELAY draft or record owner-reported manual send
- `POST /api/builder` — create/analyze Builder Requests

Authenticated endpoints require `x-ghostos-secret`.

## Development and verification

```bash
npm install
npm run check
npm test
npm run dev
```

GitHub Actions runs syntax checks and tests on pull requests and pushes to `main`.
