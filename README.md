# Google Ads Remote MCP (Read-Only) on Cloudflare

This project hosts a remote MCP server on Cloudflare Workers for **read-only Google Ads** access. It mirrors the **MCP OAuth + Google sign-in** pattern from the Google Analytics MCP: clients must complete OAuth before using `/mcp`, with a **domain allowlist** (default `@herdl.com`).

Current MCP surface:

- `list_accessible_customers`

## Architecture

- Runtime: Cloudflare Workers + Durable Object MCP server
- **MCP OAuth 2.1**: `/authorize`, `/token`, `/register` — `/mcp` is handled by `OAuthProvider`
- **Google OAuth** (email + profile): gates who may connect; KV-backed state + `__Host-CONSENTED_STATE` cookie validation (**fail closed**)
- **Google Ads API**: server uses a **separate** OAuth refresh token + developer token + login-customer-id for `listAccessibleCustomers` (no Analytics-style service account)

## Two OAuth credential pairs (both required)

| Purpose | Secrets | Notes |
|--------|---------|--------|
| **Protect the MCP** (who can connect) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Web app client; redirect URI must be **`/callback`**, not `/mcp`; scopes `email profile` |
| **Call Google Ads API** | `GOOGLE_ADS_OAUTH_*`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Refresh token must include `https://www.googleapis.com/auth/adwords` |

They can be different OAuth clients in the same GCP project, or you can reuse one client **only if** it supports both redirect flows and token grants you need.

## Prerequisites

- Google Cloud: **Google Ads API** enabled
- **OAuth 2.0 Client (Web application)** with authorized redirect URIs:
  - `http://localhost:8787/callback` (local; port from `wrangler dev` if different)
  - `https://<your-worker>.workers.dev/callback` (production)
  - **Must be `/callback` — not `/mcp`**
- **KV namespace** `OAUTH_KV` (see `wrangler.jsonc`)

Optional Worker secrets:

- `ALLOWED_EMAIL_DOMAIN` — default `herdl.com` (no leading `@`)
- `HOSTED_DOMAIN` — Google OAuth `hd` (Workspace hint)

## KV setup

If you need a new namespace:

```bash
npx wrangler kv namespace create OAUTH_KV
```

Put the returned `id` in [wrangler.jsonc](wrangler.jsonc) under `kv_namespaces`.

## Worker secrets

```bash
# MCP gate (Google sign-in)
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET

# Google Ads API (read-only tool)
npx wrangler secret put GOOGLE_ADS_DEVELOPER_TOKEN
npx wrangler secret put GOOGLE_ADS_OAUTH_CLIENT_ID
npx wrangler secret put GOOGLE_ADS_OAUTH_CLIENT_SECRET
npx wrangler secret put GOOGLE_ADS_OAUTH_REFRESH_TOKEN
npx wrangler secret put GOOGLE_ADS_LOGIN_CUSTOMER_ID
```

Optional:

```bash
npx wrangler secret put ALLOWED_EMAIL_DOMAIN
npx wrangler secret put HOSTED_DOMAIN
```

Manager account example: `6792590365` (digits only in env).

## Local development

```bash
npm install
npm run type-check
npm test
npm run dev
```

- MCP URL: `http://localhost:8787/mcp`

## Local MCP Inspector

1. `npm run dev`
2. MCP Inspector → Streamable HTTP → `http://localhost:8787/mcp`
3. Complete OAuth (Google user must be on the allowed domain)
4. List tools → `list_accessible_customers`

## Deploy

```bash
npm run deploy
```

Production MCP URL: `https://<your-worker>.workers.dev/mcp`

## MCP client example (Claude Desktop via mcp-remote)

```json
{
  "mcpServers": {
    "google-ads-remote": {
      "command": "npx",
      "args": ["mcp-remote@latest", "https://<your-worker-subdomain>.workers.dev/mcp"]
    }
  }
}
```

## References

- Google Ads MCP inspiration: https://github.com/googleads/google-ads-mcp
- Google Ads API: https://developers.google.com/google-ads/api
- Cloudflare remote MCP + auth: https://developers.cloudflare.com/agents/guides/remote-mcp-server/#add-authentication
