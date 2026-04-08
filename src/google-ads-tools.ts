import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	buildAccountMetricsQuery,
	buildAdGroupMetricsQuery,
	buildCampaignMetricsQuery,
	buildChangeEventsQuery,
	buildDeviceSegmentMetricsQuery,
	buildGeoMetricsQuery,
	buildGetCustomerQuery,
	buildKeywordMetricsQuery,
	buildListAdsQuery,
	buildListCampaignBudgetsQuery,
	buildListConversionActionsQuery,
	buildSearchTermsQuery,
	DATE_RANGE_DURING,
	SEARCH_TERM_DEFAULT_MAX_ROWS,
} from "./gaql-report-presets";
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

const customerIdSchema = z
	.string()
	.describe(
		"Numeric Google Ads customer ID for the report (URL path customers/{id}). Use a leaf account id; set login_customer_id to the manager when querying clients under an MCC.",
	);

const dateRangeDuringSchema = z
	.enum(DATE_RANGE_DURING)
	.describe("Date range preset for segments.date DURING (or matching window for change events).");

export function registerGoogleAdsTools(
	server: McpServer,
	env: Env,
	resolveUserId?: () => string | undefined,
) {
	const runReadonlyGaql = async (
		customer_id: string,
		login_customer_id: string | undefined,
		query: string,
		maxRows: number,
	) => {
		const token = await getGoogleAdsAccessTokenFromContext(env, resolveUserId);
		const cid = normalizeCustomerId(customer_id);
		const streamOpts = mergeSearchStreamOptions({ maxRows }, login_customer_id);
		const rows = await searchStreamCollect(env, token, cid, query, streamOpts);
		return {
			customer_id: cid,
			row_count: rows.length,
			login_customer_id_used: resolveAdsLoginCustomerId(env, login_customer_id),
			rows,
		};
	};

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

	server.tool(
		"get_customer",
		{
			customer_id: customerIdSchema,
			login_customer_id: loginCustomerIdSchema,
		},
		async ({ customer_id, login_customer_id }) => {
			try {
				const out = await runReadonlyGaql(
					customer_id,
					login_customer_id,
					buildGetCustomerQuery(),
					DEFAULT_SEARCH_MAX_ROWS,
				);
				return textJson(out);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textJson({ error: message });
			}
		},
	);

	server.tool(
		"get_account_metrics",
		{
			customer_id: customerIdSchema,
			date_range: dateRangeDuringSchema,
			max_rows: z
				.number()
				.int()
				.positive()
				.max(DEFAULT_SEARCH_MAX_ROWS)
				.optional()
				.describe(`Max rows (default ${DEFAULT_SEARCH_MAX_ROWS}).`),
			login_customer_id: loginCustomerIdSchema,
		},
		async ({ customer_id, date_range, max_rows, login_customer_id }) => {
			try {
				const out = await runReadonlyGaql(
					customer_id,
					login_customer_id,
					buildAccountMetricsQuery(date_range),
					max_rows ?? DEFAULT_SEARCH_MAX_ROWS,
				);
				return textJson({ ...out, date_range });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textJson({ error: message });
			}
		},
	);

	server.tool(
		"get_campaign_metrics",
		{
			customer_id: customerIdSchema,
			date_range: dateRangeDuringSchema,
			campaign_id: z
				.string()
				.optional()
				.describe("Optional numeric campaign id to filter."),
			campaign_status: z
				.enum(["ENABLED", "PAUSED", "REMOVED"])
				.optional()
				.describe("Optional campaign status filter (default: exclude REMOVED)."),
			max_rows: z
				.number()
				.int()
				.positive()
				.max(DEFAULT_SEARCH_MAX_ROWS)
				.optional()
				.describe(`Max rows (default ${DEFAULT_SEARCH_MAX_ROWS}).`),
			login_customer_id: loginCustomerIdSchema,
		},
		async ({
			customer_id,
			date_range,
			campaign_id,
			campaign_status,
			max_rows,
			login_customer_id,
		}) => {
			try {
				const out = await runReadonlyGaql(
					customer_id,
					login_customer_id,
					buildCampaignMetricsQuery({
						dateRange: date_range,
						campaignId: campaign_id,
						campaignStatus: campaign_status,
					}),
					max_rows ?? DEFAULT_SEARCH_MAX_ROWS,
				);
				return textJson({ ...out, date_range });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textJson({ error: message });
			}
		},
	);

	server.tool(
		"get_ad_group_metrics",
		{
			customer_id: customerIdSchema,
			date_range: dateRangeDuringSchema,
			campaign_id: z.string().optional().describe("Optional campaign id filter."),
			ad_group_id: z.string().optional().describe("Optional ad group id filter."),
			max_rows: z
				.number()
				.int()
				.positive()
				.max(DEFAULT_SEARCH_MAX_ROWS)
				.optional()
				.describe(`Max rows (default ${DEFAULT_SEARCH_MAX_ROWS}).`),
			login_customer_id: loginCustomerIdSchema,
		},
		async ({ customer_id, date_range, campaign_id, ad_group_id, max_rows, login_customer_id }) => {
			try {
				const out = await runReadonlyGaql(
					customer_id,
					login_customer_id,
					buildAdGroupMetricsQuery({
						dateRange: date_range,
						campaignId: campaign_id,
						adGroupId: ad_group_id,
					}),
					max_rows ?? DEFAULT_SEARCH_MAX_ROWS,
				);
				return textJson({ ...out, date_range });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textJson({ error: message });
			}
		},
	);

	server.tool(
		"get_keyword_metrics",
		{
			customer_id: customerIdSchema,
			date_range: dateRangeDuringSchema,
			campaign_id: z.string().optional().describe("Optional campaign id filter."),
			ad_group_id: z.string().optional().describe("Optional ad group id filter."),
			max_rows: z
				.number()
				.int()
				.positive()
				.max(DEFAULT_SEARCH_MAX_ROWS)
				.optional()
				.describe(`Max rows (default ${DEFAULT_SEARCH_MAX_ROWS}).`),
			login_customer_id: loginCustomerIdSchema,
		},
		async ({ customer_id, date_range, campaign_id, ad_group_id, max_rows, login_customer_id }) => {
			try {
				const out = await runReadonlyGaql(
					customer_id,
					login_customer_id,
					buildKeywordMetricsQuery({
						dateRange: date_range,
						campaignId: campaign_id,
						adGroupId: ad_group_id,
					}),
					max_rows ?? DEFAULT_SEARCH_MAX_ROWS,
				);
				return textJson({ ...out, date_range });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textJson({ error: message });
			}
		},
	);

	server.tool(
		"get_search_terms",
		{
			customer_id: customerIdSchema,
			date_range: dateRangeDuringSchema,
			campaign_id: z.string().optional().describe("Optional campaign id filter."),
			max_rows: z
				.number()
				.int()
				.positive()
				.max(DEFAULT_SEARCH_MAX_ROWS)
				.optional()
				.describe(
					`Max rows (default ${SEARCH_TERM_DEFAULT_MAX_ROWS}; cap ${DEFAULT_SEARCH_MAX_ROWS}).`,
				),
			login_customer_id: loginCustomerIdSchema,
		},
		async ({ customer_id, date_range, campaign_id, max_rows, login_customer_id }) => {
			try {
				const cap = max_rows ?? SEARCH_TERM_DEFAULT_MAX_ROWS;
				const out = await runReadonlyGaql(
					customer_id,
					login_customer_id,
					buildSearchTermsQuery({ dateRange: date_range, campaignId: campaign_id }),
					cap,
				);
				return textJson({ ...out, date_range });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textJson({ error: message });
			}
		},
	);

	server.tool(
		"list_ads",
		{
			customer_id: customerIdSchema,
			only_responsive_search_ads: z
				.boolean()
				.default(false)
				.describe("When true, only RESPONSIVE_SEARCH_AD creatives."),
			max_rows: z
				.number()
				.int()
				.positive()
				.max(DEFAULT_SEARCH_MAX_ROWS)
				.optional()
				.describe(`Max rows (default ${DEFAULT_SEARCH_MAX_ROWS}).`),
			login_customer_id: loginCustomerIdSchema,
		},
		async ({ customer_id, only_responsive_search_ads, max_rows, login_customer_id }) => {
			try {
				const out = await runReadonlyGaql(
					customer_id,
					login_customer_id,
					buildListAdsQuery({ onlyResponsiveSearchAds: only_responsive_search_ads }),
					max_rows ?? DEFAULT_SEARCH_MAX_ROWS,
				);
				return textJson(out);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textJson({ error: message });
			}
		},
	);

	server.tool(
		"list_conversion_actions",
		{
			customer_id: customerIdSchema,
			max_rows: z
				.number()
				.int()
				.positive()
				.max(DEFAULT_SEARCH_MAX_ROWS)
				.optional()
				.describe(`Max rows (default ${DEFAULT_SEARCH_MAX_ROWS}).`),
			login_customer_id: loginCustomerIdSchema,
		},
		async ({ customer_id, max_rows, login_customer_id }) => {
			try {
				const out = await runReadonlyGaql(
					customer_id,
					login_customer_id,
					buildListConversionActionsQuery(),
					max_rows ?? DEFAULT_SEARCH_MAX_ROWS,
				);
				return textJson(out);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textJson({ error: message });
			}
		},
	);

	server.tool(
		"get_device_segment_metrics",
		{
			customer_id: customerIdSchema,
			date_range: dateRangeDuringSchema,
			max_rows: z
				.number()
				.int()
				.positive()
				.max(DEFAULT_SEARCH_MAX_ROWS)
				.optional()
				.describe(`Max rows (default ${DEFAULT_SEARCH_MAX_ROWS}).`),
			login_customer_id: loginCustomerIdSchema,
		},
		async ({ customer_id, date_range, max_rows, login_customer_id }) => {
			try {
				const out = await runReadonlyGaql(
					customer_id,
					login_customer_id,
					buildDeviceSegmentMetricsQuery(date_range),
					max_rows ?? DEFAULT_SEARCH_MAX_ROWS,
				);
				return textJson({ ...out, date_range });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textJson({ error: message });
			}
		},
	);

	server.tool(
		"get_geo_metrics",
		{
			customer_id: customerIdSchema,
			date_range: dateRangeDuringSchema,
			max_rows: z
				.number()
				.int()
				.positive()
				.max(DEFAULT_SEARCH_MAX_ROWS)
				.optional()
				.describe(`Max rows (default ${DEFAULT_SEARCH_MAX_ROWS}).`),
			login_customer_id: loginCustomerIdSchema,
		},
		async ({ customer_id, date_range, max_rows, login_customer_id }) => {
			try {
				const out = await runReadonlyGaql(
					customer_id,
					login_customer_id,
					buildGeoMetricsQuery(date_range),
					max_rows ?? DEFAULT_SEARCH_MAX_ROWS,
				);
				return textJson({ ...out, date_range });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textJson({ error: message });
			}
		},
	);

	server.tool(
		"get_change_events",
		{
			customer_id: customerIdSchema,
			date_range: dateRangeDuringSchema.describe(
				"Window for change_event.change_date_time (UTC calendar bounds derived from this preset).",
			),
			limit: z
				.number()
				.int()
				.positive()
				.max(10_000)
				.optional()
				.default(500)
				.describe("Max change events (GAQL LIMIT, cap 10000)."),
			login_customer_id: loginCustomerIdSchema,
		},
		async ({ customer_id, date_range, limit, login_customer_id }) => {
			try {
				const out = await runReadonlyGaql(
					customer_id,
					login_customer_id,
					buildChangeEventsQuery({ dateRange: date_range, limit: limit ?? 500 }),
					limit ?? 500,
				);
				return textJson({ ...out, date_range });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textJson({ error: message });
			}
		},
	);

	server.tool(
		"list_campaign_budgets",
		{
			customer_id: customerIdSchema,
			max_rows: z
				.number()
				.int()
				.positive()
				.max(DEFAULT_SEARCH_MAX_ROWS)
				.optional()
				.describe(`Max rows (default ${DEFAULT_SEARCH_MAX_ROWS}).`),
			login_customer_id: loginCustomerIdSchema,
		},
		async ({ customer_id, max_rows, login_customer_id }) => {
			try {
				const out = await runReadonlyGaql(
					customer_id,
					login_customer_id,
					buildListCampaignBudgetsQuery(),
					max_rows ?? DEFAULT_SEARCH_MAX_ROWS,
				);
				return textJson(out);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textJson({ error: message });
			}
		},
	);
}
