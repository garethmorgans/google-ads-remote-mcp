import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "Google Ads Read-Only MCP",
		version: "1.0.0",
	});

	async init() {
		this.server.tool(
			"list_accessible_customers",
			{
				include_manager_context: z
					.boolean()
					.default(true)
					.describe(
						"When true, include the configured manager login-customer-id in the response.",
					),
			},
			async ({ include_manager_context }) => {
				try {
					const oauthToken = await getAccessToken(this.env);
					const customers = await listAccessibleCustomers(this.env, oauthToken);
					const managerCustomerId = normalizeCustomerId(this.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);

					const payload = {
						customers,
						...(include_manager_context
							? { manager_login_customer_id: managerCustomerId }
							: {}),
					};

					return {
						content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
					};
				} catch (error) {
					const message =
						error instanceof Error ? error.message : "Unknown error calling Google Ads";
					return {
						content: [{ type: "text", text: `Google Ads request failed: ${message}` }],
					};
				}
			},
		);
	}
}

type OAuthTokenResponse = {
	access_token: string;
};

type ListAccessibleCustomersResponse = {
	resourceNames: string[];
};

function normalizeCustomerId(customerId: string): string {
	return customerId.replaceAll("-", "").trim();
}

function assertRequiredEnv(env: Env): void {
	const required = [
		"GOOGLE_ADS_DEVELOPER_TOKEN",
		"GOOGLE_ADS_LOGIN_CUSTOMER_ID",
		"GOOGLE_ADS_OAUTH_CLIENT_ID",
		"GOOGLE_ADS_OAUTH_CLIENT_SECRET",
		"GOOGLE_ADS_OAUTH_REFRESH_TOKEN",
	] as const;

	for (const key of required) {
		if (!env[key]) {
			throw new Error(`Missing required environment variable: ${key}`);
		}
	}
}

async function getAccessToken(env: Env): Promise<string> {
	assertRequiredEnv(env);

	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			client_id: env.GOOGLE_ADS_OAUTH_CLIENT_ID,
			client_secret: env.GOOGLE_ADS_OAUTH_CLIENT_SECRET,
			refresh_token: env.GOOGLE_ADS_OAUTH_REFRESH_TOKEN,
			grant_type: "refresh_token",
		}),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`OAuth token exchange failed (${response.status}): ${text}`);
	}

	const token = (await response.json()) as OAuthTokenResponse;
	if (!token.access_token) {
		throw new Error("OAuth token response did not include access_token");
	}
	return token.access_token;
}

async function listAccessibleCustomers(
	env: Env,
	accessToken: string,
): Promise<string[]> {
	const response = await fetch(
		"https://googleads.googleapis.com/v21/customers:listAccessibleCustomers",
		{
			method: "GET",
			headers: {
				authorization: `Bearer ${accessToken}`,
				"developer-token": env.GOOGLE_ADS_DEVELOPER_TOKEN,
				"login-customer-id": normalizeCustomerId(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
			},
		},
	);

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Google Ads API request failed (${response.status}): ${text}`);
	}

	const payload = (await response.json()) as ListAccessibleCustomersResponse;
	return payload.resourceNames ?? [];
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/mcp") {
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
};
