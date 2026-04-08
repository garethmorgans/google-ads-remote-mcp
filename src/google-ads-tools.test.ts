import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./google-ads-api";
import { registerGoogleAdsTools } from "./google-ads-tools";

type RegisteredTool = { handler: (args: unknown, extra: unknown) => Promise<unknown> };
type McpWithTools = McpServer & { _registeredTools: Record<string, RegisteredTool> };

function getTool(server: McpServer, name: string): RegisteredTool {
	return (server as McpWithTools)._registeredTools[name];
}

describe("registerGoogleAdsTools", () => {
	const env = {
		GOOGLE_ADS_DEVELOPER_TOKEN: "dev",
		GOOGLE_ADS_LOGIN_CUSTOMER_ID: "9990000000",
		GOOGLE_CLIENT_ID: "c",
		GOOGLE_CLIENT_SECRET: "s",
	} as Env;

	beforeEach(() => {
		vi.spyOn(api, "getGoogleAdsAccessTokenFromContext").mockResolvedValue("tok");
	});

	it("registers exactly three tools", () => {
		const server = new McpServer({ name: "t", version: "1" });
		registerGoogleAdsTools(server, env);
		const names = Object.keys((server as McpWithTools)._registeredTools);
		expect(names.sort()).toEqual([
			"gaql_search",
			"list_accessible_customers",
			"list_customer_clients",
		]);
	});

	it("list_accessible_customers returns ids when ids_only", async () => {
		vi.spyOn(api, "listAccessibleCustomers").mockResolvedValue(["customers/1", "customers/2"]);
		const server = new McpServer({ name: "t", version: "1" });
		registerGoogleAdsTools(server, env);
		const out = await getTool(server, "list_accessible_customers").handler(
			{ ids_only: true, include_manager_context: true },
			{},
		);
		const text = (out as { content: Array<{ text: string }> }).content[0].text;
		expect(JSON.parse(text)).toEqual(["1", "2"]);
	});

	it("list_customer_clients uses manager default and reports login_customer_id_used", async () => {
		vi.spyOn(api, "fetchCustomerClients").mockResolvedValue([{ customerClient: { id: "1" } }]);
		const server = new McpServer({ name: "t", version: "1" });
		registerGoogleAdsTools(server, env);
		const out = await getTool(server, "list_customer_clients").handler(
			{ only_leaf_accounts: false },
			{},
		);
		const text = (out as { content: Array<{ text: string }> }).content[0].text;
		const payload = JSON.parse(text) as {
			login_customer_id_used: string;
			manager_customer_id: string;
			row_count: number;
		};
		expect(payload.row_count).toBe(1);
		expect(payload.manager_customer_id).toBe("9990000000");
		expect(payload.login_customer_id_used).toBe("9990000000");
		expect(api.fetchCustomerClients).toHaveBeenCalledWith(
			env,
			"tok",
			"9990000000",
			expect.objectContaining({ onlyLeafAccounts: false }),
		);
	});

	it("gaql_search passes normalized customer_id to searchStreamCollect", async () => {
		const search = vi.spyOn(api, "searchStreamCollect").mockResolvedValue([]);
		const server = new McpServer({ name: "t", version: "1" });
		registerGoogleAdsTools(server, env);
		await getTool(server, "gaql_search").handler(
			{
				customer_id: "123-456-7890",
				query: "SELECT campaign.id FROM campaign",
			},
			{},
		);
		expect(search).toHaveBeenCalledWith(
			env,
			"tok",
			"1234567890",
			"SELECT campaign.id FROM campaign",
			expect.any(Object),
		);
	});
});
