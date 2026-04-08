import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./google-ads-api";
import { registerGoogleAdsTools } from "./google-ads-tools";

type RegisteredTool = { handler: (args: unknown, extra: unknown) => Promise<unknown> };
type ServerWithTools = { _registeredTools: Record<string, RegisteredTool> };

function getTool(server: McpServer, name: string): RegisteredTool {
	return (server as unknown as ServerWithTools)._registeredTools[name];
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

	const EXPECTED_TOOL_NAMES = [
		"gaql_search",
		"get_account_metrics",
		"get_ad_group_metrics",
		"get_campaign_metrics",
		"get_change_events",
		"get_customer",
		"get_device_segment_metrics",
		"get_geo_metrics",
		"get_keyword_metrics",
		"get_search_terms",
		"list_accessible_customers",
		"list_ads",
		"list_campaign_budgets",
		"list_conversion_actions",
		"list_customer_clients",
	];

	it("registers all expected tools", () => {
		const server = new McpServer({ name: "t", version: "1" });
		registerGoogleAdsTools(server, env);
		const names = Object.keys((server as unknown as ServerWithTools)._registeredTools);
		expect(names.sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
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

	it("get_account_metrics runs preset GAQL via searchStreamCollect", async () => {
		const search = vi.spyOn(api, "searchStreamCollect").mockResolvedValue([{ row: 1 }]);
		const server = new McpServer({ name: "t", version: "1" });
		registerGoogleAdsTools(server, env);
		const out = await getTool(server, "get_account_metrics").handler(
			{ customer_id: "111", date_range: "LAST_7_DAYS" },
			{},
		);
		const text = (out as { content: Array<{ text: string }> }).content[0].text;
		const payload = JSON.parse(text) as { customer_id: string; row_count: number; date_range: string };
		expect(payload.customer_id).toBe("111");
		expect(payload.row_count).toBe(1);
		expect(payload.date_range).toBe("LAST_7_DAYS");
		expect(search).toHaveBeenCalledWith(
			env,
			"tok",
			"111",
			expect.stringContaining("FROM customer"),
			expect.objectContaining({ maxRows: 10_000 }),
		);
	});

	it("get_change_events passes LIMIT-derived maxRows to searchStreamCollect", async () => {
		const search = vi.spyOn(api, "searchStreamCollect").mockResolvedValue([]);
		const server = new McpServer({ name: "t", version: "1" });
		registerGoogleAdsTools(server, env);
		await getTool(server, "get_change_events").handler(
			{ customer_id: "222", date_range: "LAST_14_DAYS", limit: 50 },
			{},
		);
		expect(search).toHaveBeenCalledWith(
			env,
			"tok",
			"222",
			expect.stringContaining("FROM change_event"),
			expect.objectContaining({ maxRows: 50 }),
		);
	});
});
