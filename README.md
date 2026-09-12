# GhostOS Core
Agentic backend for Ghost Tech Solutions.

## What is live in this starter
ATLAS manages RELAY, SUPPLY, LEDGER and DISPATCH. SUPPLY has live web search. Airtable remains the operating database. Purchases and consequential actions remain approval-gated.

## Layout
```
public/index.html            static status page served at /
netlify/functions/ghostos.js webhook + health endpoint
src/ghostos.js               ATLAS agent graph
netlify.toml                 publish dir, functions dir, redirects
```

## Endpoints
| Path | Method | Purpose |
| --- | --- | --- |
| `/` | GET | Status page, reports "GhostOS Online" |
| `/.netlify/functions/ghostos` | GET | Health probe, no auth required |
| `/api/ghostos` | POST | Lead webhook, requires `x-ghostos-secret` |

`/api/ghostos` is a rewrite of `/.netlify/functions/ghostos`; both accept webhook posts.

## Owner setup
1. Deploy this repo to Netlify. No build command is needed — Netlify installs dependencies, bundles the function and publishes `public/`.
2. In Netlify Environment Variables add OPENAI_API_KEY, AIRTABLE_PAT, AIRTABLE_BASE_ID, GHOSTOS_WEBHOOK_SECRET.
3. Point the lead webhook to `/api/ghostos` and send `x-ghostos-secret`.

Do not put API keys in source code or chat.

## Local development
```
npm install
npm run dev
```
