# Google Ads Remote MCP (Read-Only) on Cloudflare

This project hosts a remote MCP server on Cloudflare Workers for read-only Google Ads access.

Current MCP surface:
- `list_accessible_customers`

## Architecture

- Runtime: Cloudflare Workers + Durable Object MCP server
- Auth: OAuth 2.0 refresh-token exchange at runtime
- Google Ads manager context: `6792590365` (configure as `GOOGLE_ADS_LOGIN_CUSTOMER_ID`)
- Write operations: intentionally not implemented

## Required Credentials

Set these as Cloudflare Worker secrets:
- `GOOGLE_ADS_DEVELOPER_TOKEN`
- `GOOGLE_ADS_OAUTH_CLIENT_ID`
- `GOOGLE_ADS_OAUTH_CLIENT_SECRET`
- `GOOGLE_ADS_OAUTH_REFRESH_TOKEN`
- `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (for your setup: `6792590365`)

OAuth scope must include:
- `https://www.googleapis.com/auth/adwords`

## Local Development

```bash
npm install
npm run type-check
npm run dev
```

Local MCP endpoint:
- `http://localhost:8787/mcp`

## Configure Secrets

Run once per secret:

```bash
npx wrangler secret put GOOGLE_ADS_DEVELOPER_TOKEN
npx wrangler secret put GOOGLE_ADS_OAUTH_CLIENT_ID
npx wrangler secret put GOOGLE_ADS_OAUTH_CLIENT_SECRET
npx wrangler secret put GOOGLE_ADS_OAUTH_REFRESH_TOKEN
npx wrangler secret put GOOGLE_ADS_LOGIN_CUSTOMER_ID
```

## Deploy

```bash
npm run deploy
```

Production MCP endpoint:
- `https://<your-worker-subdomain>.workers.dev/mcp`

## MCP Client Example (Claude Desktop via mcp-remote)

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
- Google Ads API docs: https://developers.google.com/google-ads/api
- Cloudflare Workers docs: https://developers.cloudflare.com/workers/
