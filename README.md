# GhostOS

Agentic operating system for Ghost Tech Solutions.

## Operating core

- **ATLAS** — general manager/orchestrator with real Airtable read/write tools
- **RELAY** — customer support/sales; persists drafts and can deliver routine messages through a configured outbound webhook
- **SUPPLY** — live repair-parts research with web search; stores Budget / Standard / Premium research back into Airtable
- **LEDGER** — deterministic quote economics and margin analysis
- **DISPATCH** — scheduling/mobile-service planning within owner rules
- **Airtable** — source of truth for jobs, parts, quotes, approvals, activity, cash and controls
- **Netlify Functions** — secured webhook/API runtime
- **GhostOS Dashboard** — protected view of agents, jobs, money, activity and Owner Inbox

BUILDER is intentionally not part of this stage. The operating core should stabilize first.

## Airtable data model

GhostOS uses the existing `GhostOS — Ghost Tech Solutions` base and these operational tables:

- `Leads & Jobs`
- `Parts & Inventory`
- `Quotes`
- `Owner Inbox`
- `Agent Activity`
- `Cash & Storefront`
- `Marketing Channels`
- `Growth Opportunities`
- `GhostOS Control`

### Job state machine

`New Lead -> Need Quote -> Quoted -> Awaiting Customer / Part Approval -> Part Ordered -> Scheduled -> In Progress -> Completed`

Jobs may move to `Lost / Declined` from appropriate active states. Invalid state jumps are rejected by code.

## Owner approval boundary

Owner Inbox is reserved for consequential actions only:

- purchases
- refunds
- contracts
- unusual pricing or weak-margin exceptions
- material advertising-spend changes
- unusual scheduling/external commitments

Routine research, analysis, internal recordkeeping, normal state changes, clarification questions, standard quote drafting and routine customer follow-up should not interrupt the owner.

An approval grants permission; it does **not** prove that a purchase/refund/other external action occurred. GhostOS only advances external-action state when a configured integration provides confirmation.

## API

### Health / process a job

`GET /api/ghostos`

`POST /api/ghostos`

Required POST header:

`x-ghostos-secret: <GHOSTOS_WEBHOOK_SECRET>`

Recommended body:

```json
{
  "recordId": "recXXXXXXXXXXXXXX"
}
```

When `recordId` is present, ATLAS reads the real Airtable job and active business controls first, then uses tools/specialists to make concrete progress.

### Dashboard data

`GET /api/dashboard`

Required header:

`x-ghostos-secret: <GHOSTOS_WEBHOOK_SECRET>`

Dashboard UI: `/dashboard`

The browser asks for the key and stores it only in `sessionStorage`; no Airtable or API credential is embedded in the static page.

### Resolve an owner approval

`POST /api/approval`

Required header:

`x-ghostos-secret: <GHOSTOS_WEBHOOK_SECRET>`

Body:

```json
{
  "approvalId": "recXXXXXXXXXXXXXX",
  "decision": "Approved",
  "notes": "Optional owner note"
}
```

`decision` must be `Approved` or `Rejected`.

## RELAY outbound delivery

RELAY always stores the intended message in Airtable first. Routine messages can be delivered automatically only when `RELAY_OUTBOUND_WEBHOOK_URL` is configured.

Eligible automatic message types:

- clarification
- approved quote
- follow-up
- verified status update
- scheduling question

RELAY refuses automatic delivery while the job is `Awaiting Owner`. The outbound provider must return HTTP 2xx before GhostOS records the message as delivered and updates `Last Contacted`.

## Environment variables

Configure in Netlify:

- `OPENAI_API_KEY` — required
- `AIRTABLE_PAT` — required
- `AIRTABLE_BASE_ID` — required
- `GHOSTOS_WEBHOOK_SECRET` — required for webhook/dashboard/approval API authentication
- `GHOSTOS_MODEL` — optional; defaults to `gpt-5.6-sol`
- `RELAY_OUTBOUND_WEBHOOK_URL` — optional; required for actual routine customer delivery
- `RELAY_OUTBOUND_WEBHOOK_SECRET` — optional shared secret sent to the outbound provider

Never commit real secrets.

## Development and verification

```bash
npm install
npm run check
npm test
npm run dev
```

GitHub Actions runs syntax checks and unit tests on pull requests and pushes to `main`.

## Safety rules

GhostOS may research, analyze, calculate, draft, update internal records and handle routine communication within configured rules. It must not purchase parts, issue refunds, enter contracts, materially change ad spend, make unusual pricing commitments, promise unconfirmed appointments, or claim an external action happened without proof.
