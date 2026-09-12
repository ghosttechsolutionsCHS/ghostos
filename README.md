# GhostOS

Agentic operating system for Ghost Tech Solutions.

## Operating core

- **ATLAS** — general manager/orchestrator with real Airtable read/write tools
- **RELAY** — customer support/sales drafting only; the owner personally sends customer messages
- **SUPPLY** — live repair-parts research with web search; stores Budget / Standard / Premium research back into Airtable
- **LEDGER** — deterministic quote economics and margin analysis
- **DISPATCH** — scheduling/mobile-service planning within owner rules
- **Airtable** — source of truth for jobs, parts, quotes, approvals, activity, cash and controls
- **Netlify Functions** — secured webhook/API runtime
- **GhostOS Dashboard** — protected view of agents, jobs, money, RELAY drafts, activity and Owner Inbox

BUILDER is intentionally not part of this stage. The operating core should stabilize first.

## Airtable data model

GhostOS uses the existing `GhostOS — Ghost Tech Solutions` base and these operational tables:

- `Leads & Jobs`
- `Parts & Inventory`
- `Quotes`
- `Owner Inbox`
- `Agent Activity`
- `RELAY Messages`
- `Cash & Storefront`
- `Marketing Channels`
- `Growth Opportunities`
- `GhostOS Control`

`RELAY Messages` records drafts plus manual-send audit fields. A manual send records `Manual Sent At` and `Send Method`. It never records delivery unless an older legacy provider record actually has provider-confirmed delivery data.

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

Routine research, analysis, internal recordkeeping, normal state changes, clarification questions, standard quote drafting and routine customer follow-up drafts should not interrupt the owner.

An approval grants permission; it does **not** prove that a purchase/refund/other external action occurred. GhostOS only advances external-action state when there is an appropriate confirmation or an explicit owner record.

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

### Edit or manually mark a RELAY message sent

`POST /api/relay-message`

Required header:

`x-ghostos-secret: <GHOSTOS_WEBHOOK_SECRET>`

Supported actions:

- `update_draft` — saves an owner-edited draft; sends nothing
- `mark_sent` — records that the owner personally sent the exact text outside GhostOS

`mark_sent` records a manual-send timestamp/method and updates `Last Contacted`. It does **not** mean delivered, and GhostOS never turns a manual send into `Delivered`.

## RELAY customer messaging

The normal workflow is intentionally manual:

1. RELAY creates a draft in Airtable.
2. The dashboard displays the draft in an editable text area.
3. The owner may edit and save it.
4. The owner presses **Copy Message**.
5. The owner pastes/sends it personally from their own phone/account.
6. The owner presses **Mark as Sent** after actually sending it.

GhostOS does not automatically send SMS or email. There are no normal dashboard Send/Retry controls and no outbound provider is required.

A manual `Mark as Sent` means only **owner reported sent manually**. It is never proof of delivery. STOP/opt-out state remains visible in the dashboard for owner reference and blocks the manual-copy/send workflow for opted-out SMS records.

Legacy provider/Twilio code may remain in the repository for historical compatibility, but it is not routed from normal GhostOS operation and is not required configuration.

## Environment variables

Configure in Netlify:

- `OPENAI_API_KEY` — required
- `AIRTABLE_PAT` — required
- `AIRTABLE_BASE_ID` — required
- `GHOSTOS_WEBHOOK_SECRET` — required for webhook/dashboard/approval/manual-message API authentication
- `GHOSTOS_MODEL` — optional; defaults to `gpt-5.6-sol`

No `RELAY_OUTBOUND_WEBHOOK_URL`, Twilio account, SMS provider, or provider credential is required for normal GhostOS operation.

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

GhostOS may research, analyze, calculate, draft and update internal records within configured rules. It must not autonomously send customer messages, purchase parts, issue refunds, enter contracts, materially change ad spend, make unusual pricing commitments, promise unconfirmed appointments, or claim an external action happened without appropriate evidence. Manually reported sends are explicitly tracked as owner-reported and never as verified delivery.
