# Google Ads MCC MCP (read-only) on Cloudflare

Remote MCP server for **read-only Google Ads** access scoped around a **manager (MCC)** workflow. It uses **MCP OAuth** (Inspector / compatible clients) plus **Google sign-in** with an optional **email domain allowlist** (default `@herdl.com`).

**v2** exposes only three discovery/query tools. Earlier versions included many agency-style helpers; those have been removed for a clean rebuild. Clients that depended on removed tools must migrate to **`gaql_search`** with raw GAQL.

## Tools

| Tool                            | Purpose                                                                                                                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`list_accessible_customers`** | Wraps [`customers:listAccessibleCustomers`](https://developers.google.com/google-ads/api/reference/rest/v21/customers/listAccessibleCustomers). Optional `ids_only`, `login_customer_id`, `include_manager_context`.   |
| **`list_customer_clients`**     | `FROM customer_client` via `googleAds:searchStream` on the manager customer (default: resolved MCC). Optional `manager_customer_id`, `only_leaf_accounts`, `max_rows`. Response includes **`login_customer_id_used`**. |
| **`gaql_search`**               | Raw GAQL against `customers/{customer_id}/googleAds:searchStream`. Pass numeric `customer_id`, full `query`, optional `max_rows` and `login_customer_id`.                                                              |

[`listAccessibleCustomers`](https://developers.google.com/google-ads/api/reference/rpc/google.ads.googleads.v21.services#google.ads.googleads.v21.services.CustomerService.ListAccessibleCustomers) returns accounts the user can reach **directly**. Many **linked client accounts** under an MCC appear only via **`list_customer_clients`** or explicit GAQL to the client id with the correct **`login-customer-id`** header.

## Architecture

- Cloudflare Workers + Durable Objects (`MyMCP`) + `OAuthProvider`
- **Routes**: `/mcp` (MCP), `/authorize`, `/callback`, `/token`, `/register`
- **KV**: `OAUTH_KV` (OAuth state), **`GOOGLE_AUTH_KV`** (per-user Google access + refresh tokens)
- **Ads**: `GOOGLE_ADS_DEVELOPER_TOKEN`; users grant **`https://www.googleapis.com/auth/adwords`** with `openid` / `email` / `profile`. Calls use REST **v21** and **`googleAds:searchStream`** (read-only). The **`login-customer-id`** header defaults to **`6792590365`** unless **`GOOGLE_ADS_LOGIN_CUSTOMER_ID`** is set; it must be the **manager** when querying child accounts ([call structure](https://developers.google.com/google-ads/api/docs/concepts/call-structure)).

## OAuth client (single Web client)

| Item     | Notes                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------- |
| Secrets  | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_AUTH_KV`, `OAUTH_KV`                       |
| Redirect | **`/callback`** only (not `/mcp`)                                                              |
| Scopes   | Include **`adwords`**; **`access_type=offline`** so refresh tokens persist in `GOOGLE_AUTH_KV` |

Enable **Google Ads API** on the GCP project and add the Ads scope on the consent screen. After scope changes, users should **reconnect** the MCP.

**Scope in URL**: Google’s `/callback` `scope=` may omit sensitive scopes; this Worker validates the **token** response includes Ads access where required.

**MCC errors**: `PERMISSION_DENIED` on a leaf `customer_id` often means **`login-customer-id`** is wrong (use the parent manager, or set `GOOGLE_ADS_LOGIN_CUSTOMER_ID` / tool `login_customer_id`).

## Prerequisites

- Google Cloud: **Google Ads API** enabled
- OAuth Web client redirect URIs: `http://localhost:8787/callback`, `https://<worker>.workers.dev/callback`
- KV namespaces in [`wrangler.jsonc`](wrangler.jsonc): `OAUTH_KV`, `GOOGLE_AUTH_KV`

Optional env: `ALLOWED_EMAIL_DOMAIN`, `HOSTED_DOMAIN`

## Secrets

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_ADS_DEVELOPER_TOKEN
# Optional: override default MCC for login-customer-id (default 6792590365)
# npx wrangler secret put GOOGLE_ADS_LOGIN_CUSTOMER_ID
npx wrangler secret put COOKIE_ENCRYPTION_KEY
```

## Local development

```bash
npm install
npm run type-check
npm test
npm run dev
```

- MCP endpoint: `http://localhost:8787/mcp` (port from Wrangler output)

### Inspector

1. Connect with the Worker `/mcp` URL.
2. Complete Google OAuth (allowed domain if configured).
3. Use **`list_accessible_customers`** / **`list_customer_clients`** for discovery, then **`gaql_search`** with explicit GAQL. Check **`login_customer_id_used`** in responses when debugging headers.

## Deploy

```bash
npm run deploy
```

## Limits

- **`gaql_search`**: default **10,000** rows max per call (`max_rows` capped the same).
- **`list_customer_clients`**: cap **25,000** rows.
- Read-only: no mutate calls.

## References

- [Google Ads API / GAQL](https://developers.google.com/google-ads/api/docs/query/overview)
- [Remote MCP (Cloudflare)](https://developers.cloudflare.com/agents/guides/remote-mcp-server/#add-authentication)
