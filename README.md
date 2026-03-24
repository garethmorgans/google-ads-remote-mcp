# Google Ads Remote MCP (Read-Only) on Cloudflare

Remote MCP server for **read-only Google Ads** reporting and analysis. It uses **MCP OAuth** (Claude Cowork / Inspector) plus **Google sign-in** with a **domain allowlist** (default `@herdl.com`).

Tools are **name-first** for conversational use: account **descriptive names**, **campaign names**, and **ad group names**—not numeric IDs. Optional `customer_id` / overrides exist for power users after disambiguation.

## MCP tools (read-only)

| Tool | Purpose |
|------|---------|
| `list_accessible_customers` | Raw resource names from `customers:listAccessibleCustomers`. |
| `list_accounts_with_names` | Maps each accessible account to `customer.id` + `descriptive_name` (+ currency, manager flag). |
| `resolve_customer` | Match `account_name` → 0/1/N customer candidates (no auto-pick if N > 1). |
| `resolve_campaign` | Match `campaign_name` + `account_name` (or `customer_id`) → campaign candidates. |
| `resolve_ad_group` | Match `ad_group_name` + campaign + account. |
| `get_account_performance_by_name` | Account-level daily metrics (`customer` + `segments.date`). |
| `get_campaign_performance_by_name` | Campaign daily metrics. |
| `list_ad_groups_by_campaign_name` | Ad groups under a resolved campaign. |
| `get_keyword_performance_by_names` | `keyword_view` metrics; optional `ad_group_name`. |
| `get_search_terms_by_campaign_name` | `search_term_view` for a campaign. |
| `gaql_search` | Expert escape hatch: full GAQL; requires **exactly one** of `account_name` or `customer_id`. Max rows capped (default 10,000). |

**`match_mode`**: `contains` (default, chat-friendly) or `exact`. **Date presets**: `LAST_7_DAYS`, `LAST_14_DAYS`, `LAST_30_DAYS`, `LAST_90_DAYS`, `THIS_MONTH`, `LAST_MONTH`, `THIS_QUARTER`, `LAST_QUARTER`.

**Disambiguation**: If a resolver returns `match_count` ≠ 1, curated report tools return JSON with `report: "not_run_needs_resolution"` and a `candidates` list—Claude should ask the user or refine the name; it must not guess.

## Architecture

- Cloudflare Workers + Durable Objects (`MyMCP`) + `OAuthProvider`
- **HTTP**: `/mcp` (MCP), `/authorize`, `/callback`, `/token`, `/register`
- **MCP gate**: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (Google OAuth `email profile`), KV `OAUTH_KV`
- **Ads data plane**: `GOOGLE_ADS_DEVELOPER_TOKEN` + refresh token (`adwords` scope) + `GOOGLE_ADS_LOGIN_CUSTOMER_ID`; calls `listAccessibleCustomers` and `googleAds:searchStream` only (no mutates)

OAuth clients for **MCP sign-in** and **Ads API** may differ; see table below.

## Two OAuth credential pairs (both required)

| Purpose | Secrets | Notes |
|--------|---------|--------|
| **Protect the MCP** | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Web client; redirect **`/callback`** only; scopes `email profile` |
| **Google Ads API** | `GOOGLE_ADS_OAUTH_*`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Refresh token needs `https://www.googleapis.com/auth/adwords` |

## Prerequisites

- Google Cloud: **Google Ads API** enabled  
- **OAuth Web client** redirect URIs: `http://localhost:8787/callback`, `https://<worker>/callback` (**not** `/mcp`)  
- KV namespace `OAUTH_KV` in [wrangler.jsonc](wrangler.jsonc)

Optional secrets: `ALLOWED_EMAIL_DOMAIN`, `HOSTED_DOMAIN`

## Worker secrets

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_ADS_DEVELOPER_TOKEN
npx wrangler secret put GOOGLE_ADS_OAUTH_CLIENT_ID
npx wrangler secret put GOOGLE_ADS_OAUTH_CLIENT_SECRET
npx wrangler secret put GOOGLE_ADS_OAUTH_REFRESH_TOKEN
npx wrangler secret put GOOGLE_ADS_LOGIN_CUSTOMER_ID
```

## Local development

```bash
npm install
npm run type-check
npm test
npm run dev
```

- MCP: `http://localhost:8787/mcp`

### MCP Inspector / Claude Cowork

1. Connect to `/mcp` and complete Google (allowed domain).  
2. Prefer **`list_accounts_with_names`** or **`resolve_*`** before running reports.  
3. Use **`gaql_search`** only for custom GAQL; it still needs `account_name` or `customer_id`.

## Deploy

```bash
npm run deploy
```

## Limits

- **`searchStream` row cap**: default **10,000** rows per tool call (`gaql_search` `max_rows`); resolver queries cap at **50** matches per stage.
- Read-only: no `Mutate` calls.

## References

- [googleads/google-ads-mcp](https://github.com/googleads/google-ads-mcp)  
- [Google Ads API / GAQL](https://developers.google.com/google-ads/api/docs/query/overview)  
- [Remote MCP + auth (Cloudflare)](https://developers.cloudflare.com/agents/guides/remote-mcp-server/#add-authentication)
