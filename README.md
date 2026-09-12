# GhostOS Core

Agentic operations backend for Ghost Tech Solutions.

## Current architecture

- **ATLAS** — general manager/orchestrator
- **RELAY** — customer support and sales
- **SUPPLY** — live repair-parts research with web search
- **LEDGER** — repair economics and margin analysis
- **DISPATCH** — scheduling/mobile-service planning
- **Airtable** — operating database (`Leads & Jobs`)
- **Netlify Functions** — webhook/API runtime

Purchases and consequential external actions remain owner-approval gated.

## API

### Health

`GET /api/ghostos`

Returns a small JSON health response.

### Process a lead

`POST /api/ghostos`

Required header:

`x-ghostos-secret: <GHOSTOS_WEBHOOK_SECRET>`

Example body:

```json
{
  "recordId": "recXXXXXXXXXXXXXX",
  "lead": {
    "name": "Customer",
    "device": "iPhone",
    "issue": "Broken screen"
  }
}
```

GhostOS returns the ATLAS manager decision and, when `recordId` is supplied, writes it to Airtable field `RELAY Next Action`.

## Environment variables

Copy `.env.example` and configure these values in Netlify:

- `OPENAI_API_KEY`
- `AIRTABLE_PAT`
- `AIRTABLE_BASE_ID`
- `GHOSTOS_WEBHOOK_SECRET`

Never commit real secrets.

## Local development

```bash
npm install
npm run dev
```

Netlify Dev exposes the redirect at `/api/ghostos`.

## Safety / operating rules

GhostOS may research, analyze, draft, and recommend autonomously. It must not purchase parts, issue refunds, enter contracts, materially change ad spend, promise unconfirmed appointments, or claim an external action happened without proof.
