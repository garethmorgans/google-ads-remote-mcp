import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	DEFAULT_SEARCH_MAX_ROWS,
	getGoogleAdsAccessToken,
	listAccessibleCustomers,
	normalizeCustomerId,
	searchStreamCollect,
} from "./google-ads-api";
import {
	dateRangeDuringClause,
	listAccountsWithNames,
	resolveAdGroupByName,
	resolveCampaignByName,
	resolveCustomerByName,
	type ResolvePayload,
} from "./google-ads-resolve";

function textJson(payload: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

const matchModeSchema = z
	.enum(["exact", "contains"])
	.default("contains")
	.describe(
		"How to match names: 'contains' is best for conversational / fuzzy user input; 'exact' for precise names.",
	);

const dateRangeSchema = z
	.enum([
		"LAST_7_DAYS",
		"LAST_14_DAYS",
		"LAST_30_DAYS",
		"LAST_90_DAYS",
		"THIS_MONTH",
		"LAST_MONTH",
		"THIS_QUARTER",
		"LAST_QUARTER",
	])
	.default("LAST_30_DAYS")
	.describe("Preset date range for metrics (segments.date DURING …).");

function blockUnlessResolved(res: ResolvePayload, need: "customer" | "campaign" | "ad_group"): ResolvePayload | null {
	if (res.match_count !== 1) return res;
	if (need === "customer" && !res.candidates[0].customerId) return res;
	if (need === "campaign" && !res.candidates[0].campaignId) return res;
	if (need === "ad_group" && !res.candidates[0].adGroupId) return res;
	return null;
}

export function registerGoogleAdsTools(server: McpServer, env: Env) {
	server.tool(
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
				const token = await getGoogleAdsAccessToken(env);
				const customers = await listAccessibleCustomers(env, token);
				const managerCustomerId = normalizeCustomerId(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
				return textJson({
					customers,
					...(include_manager_context ? { manager_login_customer_id: managerCustomerId } : {}),
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error calling Google Ads";
				return textJson({ error: `Google Ads request failed: ${message}` });
			}
		},
	);

	server.tool(
		"list_accounts_with_names",
		{},
		async () => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const accounts = await listAccountsWithNames(env, token, rns);
				return textJson({ accounts, count: accounts.length });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textJson({ error: message });
			}
		},
	);

	server.tool(
		"resolve_customer",
		{
			account_name: z
				.string()
				.min(1)
				.describe("Customer descriptive name as the user said it (not the numeric customer ID)."),
			match_mode: matchModeSchema,
		},
		async ({ account_name, match_mode }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const payload = await resolveCustomerByName(env, token, account_name, match_mode, rns);
				return textJson(payload);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textJson({ error: message });
			}
		},
	);

	server.tool(
		"resolve_campaign",
		{
			account_name: z
				.string()
				.optional()
				.describe("Account descriptive name — prefer this over customer_id for conversational use."),
			customer_id: z
				.string()
				.optional()
				.describe("Optional numeric customer ID override if the user already confirmed the account."),
			campaign_name: z.string().min(1).describe("Campaign name as the user said it."),
			match_mode: matchModeSchema,
		},
		async ({ account_name, customer_id, campaign_name, match_mode }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const cid = customer_id ? normalizeCustomerId(customer_id) : undefined;
				const payload = await resolveCampaignByName(env, token, {
					customerId: cid,
					accountName: account_name,
					campaignName: campaign_name,
					matchMode: match_mode,
					accessibleResourceNames: rns,
				});
				return textJson(payload);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textJson({ error: message });
			}
		},
	);

	server.tool(
		"resolve_ad_group",
		{
			account_name: z.string().optional().describe("Account descriptive name."),
			customer_id: z.string().optional().describe("Optional customer ID override."),
			campaign_name: z.string().min(1).describe("Campaign name."),
			ad_group_name: z.string().min(1).describe("Ad group name as the user said it."),
			match_mode: matchModeSchema,
		},
		async ({ account_name, customer_id, campaign_name, ad_group_name, match_mode }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const payload = await resolveAdGroupByName(env, token, {
					customerId: customer_id ? normalizeCustomerId(customer_id) : undefined,
					accountName: account_name,
					campaignName: campaign_name,
					adGroupName: ad_group_name,
					matchMode: match_mode,
					accessibleResourceNames: rns,
				});
				return textJson(payload);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textJson({ error: message });
			}
		},
	);

	server.tool(
		"get_account_performance_by_name",
		{
			account_name: z.string().min(1).describe("Account descriptive name."),
			match_mode: matchModeSchema,
			date_range: dateRangeSchema,
		},
		async ({ account_name, match_mode, date_range }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const resolved = await resolveCustomerByName(env, token, account_name, match_mode, rns);
				const block = blockUnlessResolved(resolved, "customer");
				if (block) return textJson({ ...block, report: "not_run_needs_resolution" });
				const customerId = String(resolved.candidates[0].customerId);
				const during = dateRangeDuringClause(date_range);
				const query = `SELECT segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM customer WHERE ${during}`;
				const rows = await searchStreamCollect(env, token, customerId, query, {});
				return textJson({ resolved_customer: resolved.candidates[0], date_range, row_count: rows.length, rows });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textJson({ error: message });
			}
		},
	);

	server.tool(
		"get_campaign_performance_by_name",
		{
			account_name: z.string().optional(),
			customer_id: z.string().optional(),
			campaign_name: z.string().min(1),
			match_mode: matchModeSchema,
			date_range: dateRangeSchema,
		},
		async ({ account_name, customer_id, campaign_name, match_mode, date_range }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const resolved = await resolveCampaignByName(env, token, {
					customerId: customer_id ? normalizeCustomerId(customer_id) : undefined,
					accountName: account_name,
					campaignName: campaign_name,
					matchMode: match_mode,
					accessibleResourceNames: rns,
				});
				const block = blockUnlessResolved(resolved, "campaign");
				if (block) return textJson({ ...block, report: "not_run_needs_resolution" });
				const customerId = String(resolved.resolved_customer_id ?? resolved.candidates[0].customerId);
				const campaignId = String(resolved.candidates[0].campaignId);
				const during = dateRangeDuringClause(date_range);
				const query = `SELECT campaign.name, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.ctr, metrics.conversions, metrics.conversions_value FROM campaign WHERE campaign.id = ${campaignId} AND ${during}`;
				const rows = await searchStreamCollect(env, token, customerId, query, {});
				return textJson({
					resolved_campaign: resolved.candidates[0],
					date_range,
					row_count: rows.length,
					rows,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textJson({ error: message });
			}
		},
	);

	server.tool(
		"list_ad_groups_by_campaign_name",
		{
			account_name: z.string().optional(),
			customer_id: z.string().optional(),
			campaign_name: z.string().min(1),
			match_mode: matchModeSchema,
		},
		async ({ account_name, customer_id, campaign_name, match_mode }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const resolved = await resolveCampaignByName(env, token, {
					customerId: customer_id ? normalizeCustomerId(customer_id) : undefined,
					accountName: account_name,
					campaignName: campaign_name,
					matchMode: match_mode,
					accessibleResourceNames: rns,
				});
				const block = blockUnlessResolved(resolved, "campaign");
				if (block) return textJson({ ...block, report: "not_run_needs_resolution" });
				const customerId = String(resolved.resolved_customer_id ?? resolved.candidates[0].customerId);
				const campaignId = String(resolved.candidates[0].campaignId);
				const query = `SELECT ad_group.id, ad_group.name, ad_group.status FROM ad_group WHERE campaign.id = ${campaignId}`;
				const rows = await searchStreamCollect(env, token, customerId, query, { maxRows: 500 });
				return textJson({
					resolved_campaign: resolved.candidates[0],
					row_count: rows.length,
					rows,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textJson({ error: message });
			}
		},
	);

	server.tool(
		"get_keyword_performance_by_names",
		{
			account_name: z.string().optional(),
			customer_id: z.string().optional(),
			campaign_name: z.string().min(1),
			ad_group_name: z.string().optional().describe("Optional: narrow to one ad group by name."),
			match_mode: matchModeSchema,
			date_range: dateRangeSchema,
		},
		async ({ account_name, customer_id, campaign_name, ad_group_name, match_mode, date_range }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				let customerId: string;
				let campaignId: string;
				let adGroupId: string | undefined;

				if (ad_group_name) {
					const resolvedAg = await resolveAdGroupByName(env, token, {
						customerId: customer_id ? normalizeCustomerId(customer_id) : undefined,
						accountName: account_name,
						campaignName: campaign_name,
						adGroupName: ad_group_name,
						matchMode: match_mode,
						accessibleResourceNames: rns,
					});
					const blockAg = blockUnlessResolved(resolvedAg, "ad_group");
					if (blockAg) return textJson({ ...blockAg, report: "not_run_needs_resolution" });
					customerId = String(resolvedAg.resolved_customer_id ?? resolvedAg.candidates[0].customerId);
					campaignId = String(resolvedAg.candidates[0].campaignId);
					adGroupId = String(resolvedAg.candidates[0].adGroupId);
				} else {
					const resolved = await resolveCampaignByName(env, token, {
						customerId: customer_id ? normalizeCustomerId(customer_id) : undefined,
						accountName: account_name,
						campaignName: campaign_name,
						matchMode: match_mode,
						accessibleResourceNames: rns,
					});
					const block = blockUnlessResolved(resolved, "campaign");
					if (block) return textJson({ ...block, report: "not_run_needs_resolution" });
					customerId = String(resolved.resolved_customer_id ?? resolved.candidates[0].customerId);
					campaignId = String(resolved.candidates[0].campaignId);
				}
				const during = dateRangeDuringClause(date_range);
				const agFilter = adGroupId ? ` AND ad_group.id = ${adGroupId}` : "";
				const query = `SELECT campaign.name, ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.ctr, metrics.conversions FROM keyword_view WHERE campaign.id = ${campaignId}${agFilter} AND ${during}`;
				const rows = await searchStreamCollect(env, token, customerId, query, {});
				return textJson({ customerId, campaignId, adGroupId: adGroupId ?? null, date_range, row_count: rows.length, rows });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textJson({ error: message });
			}
		},
	);

	server.tool(
		"get_search_terms_by_campaign_name",
		{
			account_name: z.string().optional(),
			customer_id: z.string().optional(),
			campaign_name: z.string().min(1),
			match_mode: matchModeSchema,
			date_range: dateRangeSchema,
		},
		async ({ account_name, customer_id, campaign_name, match_mode, date_range }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const resolved = await resolveCampaignByName(env, token, {
					customerId: customer_id ? normalizeCustomerId(customer_id) : undefined,
					accountName: account_name,
					campaignName: campaign_name,
					matchMode: match_mode,
					accessibleResourceNames: rns,
				});
				const block = blockUnlessResolved(resolved, "campaign");
				if (block) return textJson({ ...block, report: "not_run_needs_resolution" });
				const customerId = String(resolved.resolved_customer_id ?? resolved.candidates[0].customerId);
				const campaignId = String(resolved.candidates[0].campaignId);
				const during = dateRangeDuringClause(date_range);
				const query = `SELECT search_term_view.search_term, campaign.name, ad_group.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.ctr FROM search_term_view WHERE campaign.id = ${campaignId} AND ${during}`;
				const rows = await searchStreamCollect(env, token, customerId, query, {});
				return textJson({
					resolved_campaign: resolved.candidates[0],
					date_range,
					row_count: rows.length,
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
			query: z
				.string()
				.min(1)
				.describe("Full GAQL SELECT … FROM … (read-only). Prefer name-based tools for normal chat."),
			account_name: z
				.string()
				.optional()
				.describe("Exactly one of account_name or customer_id required to choose the Ads customer for this query."),
			customer_id: z.string().optional().describe("Numeric customer ID alternative to account_name."),
			max_rows: z
				.number()
				.int()
				.positive()
				.max(DEFAULT_SEARCH_MAX_ROWS)
				.optional()
				.describe(`Max rows to collect (cap ${DEFAULT_SEARCH_MAX_ROWS}).`),
		},
		async ({ query, account_name, customer_id, max_rows }) => {
			try {
				const hasCid = Boolean(customer_id?.replace(/\D/g, ""));
				const hasName = Boolean(account_name?.trim());
				if ((hasCid && hasName) || (!hasCid && !hasName)) {
					return textJson({
						error: "Provide exactly one of customer_id or account_name (for conversational flow use account_name).",
					});
				}
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				let customerIdStr: string;
				if (hasCid) {
					customerIdStr = normalizeCustomerId(customer_id!);
				} else {
					const resolved = await resolveCustomerByName(env, token, account_name!.trim(), "contains", rns);
					if (resolved.match_count !== 1) {
						return textJson({
							...resolved,
							query: "not_run_needs_account_resolution",
						});
					}
					customerIdStr = String(resolved.candidates[0].customerId);
				}
				const cap = max_rows ?? DEFAULT_SEARCH_MAX_ROWS;
				const rows = await searchStreamCollect(env, token, customerIdStr, query, { maxRows: cap });
				return textJson({ customer_id: customerIdStr, row_count: rows.length, rows });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textJson({ error: message });
			}
		},
	);
}
