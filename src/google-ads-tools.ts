import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	CUSTOMER_CLIENT_MAX_ROWS,
	DEFAULT_SEARCH_MAX_ROWS,
	fetchCustomerClients,
	getGoogleAdsAccessTokenFromContext,
	listAccessibleCustomers,
	listAccessibleLoginOptions,
	mergeSearchStreamOptions,
	normalizeCustomerId,
	resolveAdsLoginCustomerId,
	searchStreamCollect,
} from "./google-ads-api";

function textJson(payload: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

const loginCustomerIdSchema = z
	.string()
	.optional()
	.describe(
		"Manager/MCC customer ID for the login-customer-id header (digits or dashed). Defaults to GOOGLE_ADS_LOGIN_CUSTOMER_ID / default MCC.",
	);

export function registerGoogleAdsTools(
	server: McpServer,
	env: Env,
	resolveUserId?: () => string | undefined,
) {
	server.tool(
		"list_accessible_customers",
		{
			ids_only: z
				.boolean()
				.default(false)
				.describe("When true, return only numeric customer IDs (no customers/ prefix)."),
			include_manager_context: z
				.boolean()
				.default(true)
				.describe(
					"When true, include manager_login_customer_id in the response (ignored if ids_only).",
				),
			login_customer_id: loginCustomerIdSchema,
		},
		async ({ ids_only, include_manager_context, login_customer_id }) => {
			try {
				const token = await getGoogleAdsAccessTokenFromContext(env, resolveUserId);
				const customers = await listAccessibleCustomers(
					env,
					token,
					listAccessibleLoginOptions(login_customer_id),
				);
				if (ids_only) {
					const ids = customers.map((rn) => rn.replace(/^customers\//, ""));
					return textJson(ids);
				}
				const managerCustomerId = resolveAdsLoginCustomerId(env, login_customer_id);
				return textJson({
					customers,
					...(include_manager_context
						? { manager_login_customer_id: managerCustomerId }
						: {}),
				});
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error calling Google Ads";
				return textJson({ error: `Google Ads request failed: ${message}` });
			}
		},
	);

	server.tool(
		"list_customer_clients",
		{
			manager_customer_id: z
				.string()
				.optional()
				.describe(
					"Manager (MCC) customer ID for the customer_client query URL. Defaults to resolved GOOGLE_ADS_LOGIN_CUSTOMER_ID / default MCC.",
				),
			only_leaf_accounts: z
				.boolean()
				.default(false)
				.describe(
					"When true, restrict to customer_client.manager = FALSE (leaf accounts).",
				),
			max_rows: z
				.number()
				.int()
				.positive()
				.max(CUSTOMER_CLIENT_MAX_ROWS)
				.optional()
				.describe(`Max rows (cap ${CUSTOMER_CLIENT_MAX_ROWS}).`),
			login_customer_id: loginCustomerIdSchema,
		},
		async ({ manager_customer_id, only_leaf_accounts, max_rows, login_customer_id }) => {
			try {
				const token = await getGoogleAdsAccessTokenFromContext(env, resolveUserId);
				const managerId = manager_customer_id?.replace(/\D/g, "")
					? normalizeCustomerId(manager_customer_id)
					: resolveAdsLoginCustomerId(env);
				const rows = await fetchCustomerClients(env, token, managerId, {
					onlyLeafAccounts: only_leaf_accounts,
					maxRows: max_rows,
					loginCustomerId: login_customer_id,
				});
				const loginCustomerIdUsed = login_customer_id?.replace(/\D/g, "")
					? normalizeCustomerId(login_customer_id)
					: managerId;
				return textJson({
					manager_customer_id: managerId,
					row_count: rows.length,
					only_leaf_accounts,
					login_customer_id_used: loginCustomerIdUsed,
					rows,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textJson({ error: message });
			}
		},
	);

	server.tool(
		"gaql_search",
		{
			customer_id: z
				.string()
				.describe(
					"Numeric Google Ads customer ID to query (the customers/{id} in the URL path).",
				),
			query: z.string().min(1).describe("Full GAQL query string."),
			max_rows: z
				.number()
				.int()
				.positive()
				.max(DEFAULT_SEARCH_MAX_ROWS)
				.optional()
				.describe(`Max result rows (default ${DEFAULT_SEARCH_MAX_ROWS}).`),
			login_customer_id: loginCustomerIdSchema,
		},
		async ({ customer_id, query, max_rows, login_customer_id }) => {
			try {
				const token = await getGoogleAdsAccessTokenFromContext(env, resolveUserId);
				const cid = normalizeCustomerId(customer_id);
				const streamOpts = mergeSearchStreamOptions(
					{ maxRows: max_rows ?? DEFAULT_SEARCH_MAX_ROWS },
					login_customer_id,
				);
				const rows = await searchStreamCollect(env, token, cid, query, streamOpts);
				return textJson({
					customer_id: cid,
					row_count: rows.length,
					login_customer_id_used: resolveAdsLoginCustomerId(env, login_customer_id),
					rows,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textJson({ error: message });
			}
		},
	);
}
