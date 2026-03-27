# Google Ads Remote MCP (Read-Only) on Cloudflare

Remote MCP server for **read-only Google Ads** reporting and analysis. It uses **MCP OAuth** (Claude Cowork / Inspector) plus **Google sign-in** with a **domain allowlist** (default `@herdl.com`).

This project **extends** the read-only surface of [googleads/google-ads-mcp](https://github.com/googleads/google-ads-mcp?tab=readme-ov-file) with the same core ideas (`list_accessible_customers`, structured `search`) and adds **agency-style GAQL tools**, **MCC-aware account listing**, and **name-first** helpers for conversational clients.

## `listAccessibleCustomers` vs MCC client accounts

[`listAccessibleCustomers`](https://developers.google.com/google-ads/api/reference/rpc/google.ads.googleads.v21.services#google.ads.googleads.v21.services.CustomerService.ListAccessibleCustomers) returns customers the user can access **directly**. Under a **manager (MCC)** account, many **linked client accounts** do **not** appear there.

- **`list_customer_clients`** — Lists linked accounts via `FROM customer_client` (bounded stream, default cap **25,000** rows).
- **`list_accounts_with_names`** — By default (**`include_customer_clients: true`**), merges `listAccessibleCustomers` with `customer_client` rows from your login MCC (or `manager_customer_id`), **deduped by customer ID**. Per-account enrichment errors are collected in **`errors`** instead of failing the whole call.

## Official-parity vs convenience tools

| Tool                            | Notes                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`search`**                    | Same shape as [google-ads-mcp `search`](https://github.com/googleads/google-ads-mcp/blob/main/ads_mcp/tools/search.py): `customer_id`, `fields[]`, `resource`, optional `conditions`, `orderings`, `limit`; appends `PARAMETERS omit_unselected_resource_names=true`. **ID-based** `customer_id` only. |
| **`gaql_search`**               | Full GAQL string; requires **exactly one** of `account_name` or `customer_id`. Does **not** add the PARAMETERS line unless you include it.                                                                                                                                                             |
| **`list_accessible_customers`** | Set **`ids_only: true`** for a plain ID list like the official server.                                                                                                                                                                                                                                 |

## MCP tools (read-only)

### Core / discovery

| Tool                                                       | Purpose                                                |
| ---------------------------------------------------------- | ------------------------------------------------------ |
| `list_accessible_customers`                                | Direct roots from API; optional `ids_only`.            |
| `list_accounts_with_names`                                 | Accessible + optional MCC merge; `errors` / `sources`. |
| `list_customer_clients`                                    | Raw `customer_client` stream.                          |
| `resolve_customer`, `resolve_campaign`, `resolve_ad_group` | Name disambiguation.                                   |
| **`search`**                                               | Official-style GAQL builder.                           |
| `gaql_search`                                              | Raw GAQL + `account_name` or `customer_id`.            |

### Account / campaigns

| Tool                                    | Purpose                                                   |
| --------------------------------------- | --------------------------------------------------------- |
| `get_account_performance_by_name`       | Daily customer metrics by preset range.                   |
| **`get_account_summary`**               | Rolled-up KPIs (CTR, CPC, CPA, ROAS) for a range.         |
| **`get_account_budget_and_pacing`**     | `account_budget` + spend (calendar range).                |
| **`list_campaigns`**                    | Campaigns with channel, bidding, budget linkage.          |
| `get_campaign_performance_by_name`      | Campaign daily metrics + **Search IS / lost IS / top %**. |
| **`get_campaign_performance_overview`** | All campaigns ranked; optional `compare_date_range`.      |
| **`get_campaign_bidding_and_budget`**   | Strategies, budgets, spend.                               |
| **`get_campaign_quality_metrics`**      | Search IS + impression-weighted QS sample.                |

### Ad groups / keywords / search terms

| Tool                                                                | Purpose                                                   |
| ------------------------------------------------------------------- | --------------------------------------------------------- |
| `list_ad_groups_by_campaign_name`, **`list_ad_groups_by_campaign`** | Ad groups; optional **`include_metrics`** + `date_range`. |
| **`get_ad_group_performance`**                                      | Ad group + date metrics.                                  |
| `get_keyword_performance_by_names`                                  | `keyword_view` with QS + IS fields.                       |
| **`get_keywords_by_account`**                                       | Account-wide keywords + filters.                          |
| **`get_low_quality_score_keywords`**                                | QS below threshold.                                       |
| `get_search_terms_by_campaign_name`, **`get_search_terms_report`**  | Query report + matched keyword / conversions.             |

### Creatives

| Tool                                   | Purpose                                      |
| -------------------------------------- | -------------------------------------------- |
| **`get_ad_performance_by_campaign`**   | RSA-level metrics + policy summary.          |
| **`get_asset_performance`**            | `ad_group_ad_asset_view`.                    |
| **`get_responsive_search_ad_details`** | Headlines, descriptions, paths, ad strength. |
| **`get_ad_strength_report`**           | Ad strength across RSAs.                     |

### Segments

| Tool                              | Purpose                      |
| --------------------------------- | ---------------------------- |
| **`get_audience_performance`**    | `campaign_audience_view`.    |
| **`get_demographic_performance`** | Age / gender / income views. |
| **`get_device_performance`**      | `segments.device`.           |
| **`get_geographic_performance`**  | `geographic_view`.           |

### Shopping / Performance Max

| Tool                                   | Purpose                                           |
| -------------------------------------- | ------------------------------------------------- |
| **`get_shopping_product_performance`** | `shopping_performance_view`.                      |
| **`get_pmax_asset_group_performance`** | Asset groups (PMax campaigns).                    |
| **`get_pmax_search_terms`**            | `campaign_search_term_view` (limited visibility). |

### Conversions / attribution / audit

| Tool                                         | Purpose                                                   |
| -------------------------------------------- | --------------------------------------------------------- |
| **`list_conversion_actions`**                | Conversion action definitions.                            |
| **`get_conversion_performance_by_campaign`** | By campaign + conversion action segment.                  |
| **`get_attribution_path_report`**            | **Simplified**: account metrics proxy (not full path UI). |
| **`get_auction_insights`**                   | Per **campaign** competitive metrics (`auction_insight`). |
| **`get_change_history`**                     | `change_event` (bounded `limit` ≤ 10,000).                |

### MCC (portfolio)

| Tool                               | Purpose                                                              |
| ---------------------------------- | -------------------------------------------------------------------- |
| **`get_mcc_performance_overview`** | KPI per linked client (`max_accounts` cap).                          |
| **`get_mcc_budget_pacing`**        | This-month spend + `account_budget` rows per client.                 |
| **`get_mcc_anomaly_alerts`**       | WoW-style flags (conversions, spend, CTR); `compare_range` optional. |

**`match_mode`**: `contains` (default) or `exact`. **Date presets**: includes `LAST_*`, `THIS_MONTH`, `PREVIOUS_7_DAYS`, `PREVIOUS_30_DAYS`, etc. Optional **`date_start` / `date_end`** (`YYYY-MM-DD`) on many agency tools.

**Disambiguation**: If `match_count` ≠ 1, tools return `report: "not_run_needs_resolution"` and `candidates`.

**Field reference**: [GAQL grammar](https://developers.google.com/google-ads/api/docs/query/grammar), [fields (v21)](https://developers.google.com/google-ads/api/fields/v21/overview). Some views (e.g. auction insights, demographics) depend on campaign type and account features; use raw **`search`** if a tool errors.

## Architecture

- Cloudflare Workers + Durable Objects (`MyMCP`) + `OAuthProvider`
- **HTTP**: `/mcp` (MCP), `/authorize`, `/callback`, `/token`, `/register`
- **MCP gate + Google Ads**: one **OAuth Web client** (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`), KV `OAUTH_KV` (OAuth state) and **`GOOGLE_AUTH_KV`** (per-user Google access + refresh tokens after connect)
- **Ads API**: `GOOGLE_ADS_DEVELOPER_TOKEN` (Worker-level); each MCP user connects with Google and grants **`https://www.googleapis.com/auth/adwords`** alongside `email` / `profile` / `openid`. **`listAccessibleCustomers`** + **`searchStream`** only (no mutates). The **`login-customer-id`** header defaults to MCC **`6792590365`** unless you set optional **`GOOGLE_ADS_LOGIN_CUSTOMER_ID`** (digits or hyphenated). That must be the **manager** when querying child accounts, per [Google’s access model](https://developers.google.com/google-ads/api/concepts/call-structure).

## Single OAuth client (required)

| Purpose                        | Secrets / bindings                                                       | Notes                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MCP + Google sign-in + Ads** | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_AUTH_KV`, `OAUTH_KV` | Redirect URI **`/callback`** only. Scopes include **`adwords`**; **`access_type=offline`** so refresh tokens are stored per user in `GOOGLE_AUTH_KV`. |
| **Google Ads API (non-user)**  | `GOOGLE_ADS_DEVELOPER_TOKEN`                                             | Developer token (same for all users).                                                                                                                 |

**Google Cloud Console**: For the same OAuth client, add **`https://www.googleapis.com/auth/adwords`** to the OAuth consent screen (and enable the **Google Ads API** on the project). After deploying this change, **reconnect** the MCP in Claude so users grant the new scope.

**Troubleshooting (MCC / child queries)**: `PERMISSION_DENIED` or “wrong customer” when using a leaf `customer_id` often means **`login_customer_id`** / env default is wrong (e.g. set to a **client** instead of the **parent manager**). Optional **`GOOGLE_ADS_LOGIN_CUSTOMER_ID`** overrides the default MCC; tool arg **`login_customer_id`** overrides for a single call.

## Prerequisites

- Google Cloud: **Google Ads API** enabled
- **OAuth Web client** redirect URIs: `http://localhost:8787/callback`, `https://<worker>/callback` (**not** `/mcp`)
- KV namespace `OAUTH_KV` and **`GOOGLE_AUTH_KV`** in [wrangler.jsonc](wrangler.jsonc)

Optional: `ALLOWED_EMAIL_DOMAIN`, `HOSTED_DOMAIN`

## Worker secrets

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_ADS_DEVELOPER_TOKEN
# Optional: override default MCC login-customer-id (6792590365)
# npx wrangler secret put GOOGLE_ADS_LOGIN_CUSTOMER_ID
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

1. Use **Direct** transport (not Via Proxy) unless you configure a proxy token.
2. Connect to `/mcp`, complete Google (allowed domain).
3. For **full client lists**: **`list_accounts_with_names`** (default merge) or **`list_customer_clients`**. The response includes **`login_customer_id_used`** (digits only) so you can confirm which manager ID was sent as `login-customer-id` on each Ads request.
4. For **official-style reporting**: **`search`** with numeric `customer_id`.
5. For **chat-first** names: **`resolve_*`** and agency tools with `account_name`.

## Deploy

```bash
npm run deploy
```

## Limits

- **`search`** / **`gaql_search`**: stream cap **10,000** rows (`gaql_search` optional `max_rows`).
- **`list_customer_clients`**: cap **25,000** rows.
- **MCC tools**: default **25–40** accounts per call (`max_accounts`) to reduce Worker timeouts.
- **`get_change_history`**: `limit` ≤ **10,000**.
- **Resolvers**: **50** matches per stage.
- Read-only: no `Mutate` calls.

## References

- [googleads/google-ads-mcp](https://github.com/googleads/google-ads-mcp?tab=readme-ov-file)
- [Google Ads API / GAQL](https://developers.google.com/google-ads/api/docs/query/overview)
- [Remote MCP + auth (Cloudflare)](https://developers.cloudflare.com/agents/guides/remote-mcp-server/#add-authentication)
