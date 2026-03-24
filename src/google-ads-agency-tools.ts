import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { clientRowToAccountEntry } from "./google-ads-account-merge";
import { aggregateCustomerDaily, weightedAvgQualityScore } from "./google-ads-agency-metrics";
import * as Q from "./google-ads-agency-queries";
import {
	CUSTOMER_CLIENT_MAX_ROWS,
	DEFAULT_SEARCH_MAX_ROWS,
	getGoogleAdsAccessToken,
	listAccessibleCustomers,
	normalizeCustomerId,
	searchStreamCollect,
} from "./google-ads-api";
import {
	compareDateRangeSchema,
	dateRangeSchema,
	matchModeSchema,
	maxRowsSchema,
	textJson,
} from "./google-ads-tool-utils";
import {
	dateRangeDuringClause,
	fetchCustomerClients,
	resolveAdGroupByName,
	resolveCampaignByName,
	resolveCustomerByName,
	type ResolvePayload,
} from "./google-ads-resolve";

const LIST_CAP = 2000;
const KEYWORD_CAP = DEFAULT_SEARCH_MAX_ROWS;
const MCC_MAX_ACCOUNTS_DEFAULT = 40;
const ANOMALY_MIN_IMPRESSIONS = 100;

type CustomerOk = { customerId: string };
type ResolvedErr = { error: unknown };

async function resolveSingleCustomer(
	env: Env,
	token: string,
	rns: string[],
	account_name: string | undefined,
	customer_id: string | undefined,
	match_mode: "exact" | "contains",
): Promise<CustomerOk | ResolvedErr> {
	const hasCid = Boolean(customer_id?.replace(/\D/g, ""));
	const hasName = Boolean(account_name?.trim());
	if (hasCid) return { customerId: normalizeCustomerId(customer_id!) };
	if (!hasName) return { error: { message: "Provide account_name or customer_id." } };
	const resolved = await resolveCustomerByName(env, token, account_name!.trim(), match_mode, rns);
	if (resolved.match_count !== 1)
		return { error: { ...resolved, report: "not_run_needs_resolution" } };
	return { customerId: String(resolved.candidates[0].customerId) };
}

function blockUnlessResolved(
	res: ResolvePayload,
	need: "customer" | "campaign" | "ad_group",
): ResolvePayload | null {
	if (res.match_count !== 1) return res;
	const c0 = res.candidates[0];
	if (need === "customer" && !c0.customerId) return res;
	if (need === "campaign" && !c0.campaignId) return res;
	if (need === "ad_group" && !c0.adGroupId) return res;
	return null;
}

async function mccLeafCustomerIds(
	env: Env,
	token: string,
	managerId: string,
	maxAccounts: number,
	onlyLeaf: boolean,
): Promise<string[]> {
	const rows = await fetchCustomerClients(env, token, managerId, {
		onlyLeafAccounts: onlyLeaf,
		maxRows: CUSTOMER_CLIENT_MAX_ROWS,
	});
	const ids: string[] = [];
	const seenSet = new Set<string>();
	for (const row of rows) {
		const p = clientRowToAccountEntry(row);
		if (!p) continue;
		if (seenSet.has(p.customerId)) continue;
		seenSet.add(p.customerId);
		ids.push(p.customerId);
		if (ids.length >= maxAccounts) break;
	}
	return ids;
}

const accountCustomerArgs = {
	account_name: z.string().optional().describe("Account descriptive name (conversational)."),
	customer_id: z.string().optional().describe("Numeric customer ID."),
	match_mode: matchModeSchema,
	date_range: dateRangeSchema,
	date_start: z.string().optional().describe("YYYY-MM-DD; use with date_end instead of date_range."),
	date_end: z.string().optional(),
	max_rows: maxRowsSchema(DEFAULT_SEARCH_MAX_ROWS, LIST_CAP),
};

export function registerAgencyTools(server: McpServer, env: Env) {
	server.tool(
		"list_campaigns",
		{
			...accountCustomerArgs,
			channel_filter: z
				.string()
				.optional()
				.describe("Optional GAQL fragment, e.g. campaign.advertising_channel_type = SEARCH"),
		},
		async ({ account_name, customer_id, match_mode, max_rows, channel_filter }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const r = await resolveSingleCustomer(env, token, rns, account_name, customer_id, match_mode);
				if ("error" in r) return textJson(r.error);
				const cap = max_rows ?? LIST_CAP;
				const query = Q.queryListCampaigns(channel_filter);
				const rows = await searchStreamCollect(env, token, r.customerId, query, { maxRows: cap });
				return textJson({ customer_id: r.customerId, row_count: rows.length, rows });
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"get_account_summary",
		{
			...accountCustomerArgs,
		},
		async ({ account_name, customer_id, match_mode, date_range, date_start, date_end, max_rows }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const r = await resolveSingleCustomer(env, token, rns, account_name, customer_id, match_mode);
				if ("error" in r) return textJson(r.error);
				const during = Q.duringOrBetween(date_range, date_start, date_end);
				const query = Q.queryAccountSummary(during);
				const rows = await searchStreamCollect(env, token, r.customerId, query, {
					maxRows: max_rows ?? DEFAULT_SEARCH_MAX_ROWS,
				});
				const summary = aggregateCustomerDaily(rows);
				return textJson({ customer_id: r.customerId, date_filter: during, summary, daily_row_count: rows.length });
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"get_account_budget_and_pacing",
		{
			...accountCustomerArgs,
		},
		async ({ account_name, customer_id, match_mode, date_range, date_start, date_end, max_rows }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const r = await resolveSingleCustomer(env, token, rns, account_name, customer_id, match_mode);
				if ("error" in r) return textJson(r.error);
				const during = Q.duringOrBetween(date_range, date_start, date_end);
				const query = Q.queryAccountBudgetPacing(during);
				const rows = await searchStreamCollect(env, token, r.customerId, query, {
					maxRows: max_rows ?? LIST_CAP,
				});
				return textJson({
					customer_id: r.customerId,
					note: "Some accounts have no account_budget rows; use campaign budgets via list_campaigns / get_campaign_bidding_and_budget.",
					row_count: rows.length,
					rows,
				});
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"get_campaign_performance_overview",
		{
			account_name: z.string().optional(),
			customer_id: z.string().optional(),
			match_mode: matchModeSchema,
			date_range: dateRangeSchema,
			date_start: z.string().optional(),
			date_end: z.string().optional(),
			compare_date_range: compareDateRangeSchema.describe(
				"Optional second DURING range for period-over-period (separate query).",
			),
			order_by: z
				.enum(["cost_micros", "conversions"])
				.default("cost_micros")
				.describe("Rank campaigns by cost or conversions."),
			max_rows: maxRowsSchema(LIST_CAP, 500),
		},
		async ({
			account_name,
			customer_id,
			match_mode,
			date_range,
			date_start,
			date_end,
			compare_date_range,
			order_by,
			max_rows,
		}) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const r = await resolveSingleCustomer(env, token, rns, account_name, customer_id, match_mode);
				if ("error" in r) return textJson(r.error);
				const during = Q.duringOrBetween(date_range, date_start, date_end);
				const query = Q.queryCampaignOverview(during, order_by);
				const rows = await searchStreamCollect(env, token, r.customerId, query, {
					maxRows: max_rows ?? 500,
				});
				let compare_rows: unknown[] | undefined;
				if (compare_date_range) {
					const during2 = dateRangeDuringClause(compare_date_range);
					const q2 = Q.queryCampaignOverview(during2, order_by);
					compare_rows = await searchStreamCollect(env, token, r.customerId, q2, {
						maxRows: max_rows ?? 500,
					});
				}
				return textJson({
					customer_id: r.customerId,
					order_by,
					row_count: rows.length,
					rows,
					compare_date_range: compare_date_range ?? null,
					compare_row_count: compare_rows?.length ?? 0,
					compare_rows: compare_rows ?? null,
				});
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"get_campaign_bidding_and_budget",
		{
			...accountCustomerArgs,
		},
		async ({ account_name, customer_id, match_mode, date_range, date_start, date_end, max_rows }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const r = await resolveSingleCustomer(env, token, rns, account_name, customer_id, match_mode);
				if ("error" in r) return textJson(r.error);
				const during = Q.duringOrBetween(date_range, date_start, date_end);
				const query = Q.queryCampaignBiddingBudget(during);
				const rows = await searchStreamCollect(env, token, r.customerId, query, {
					maxRows: max_rows ?? LIST_CAP,
				});
				return textJson({ customer_id: r.customerId, row_count: rows.length, rows });
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"get_campaign_quality_metrics",
		{
			...accountCustomerArgs,
		},
		async ({ account_name, customer_id, match_mode, date_range, date_start, date_end, max_rows }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const r = await resolveSingleCustomer(env, token, rns, account_name, customer_id, match_mode);
				if ("error" in r) return textJson(r.error);
				const during = Q.duringOrBetween(date_range, date_start, date_end);
				const qCamp = Q.queryCampaignQualityAggregates(during);
				const qKw = Q.queryKeywordQualityScores(during);
				const cap = max_rows ?? LIST_CAP;
				const [campRows, kwRows] = await Promise.all([
					searchStreamCollect(env, token, r.customerId, qCamp, { maxRows: cap }),
					searchStreamCollect(env, token, r.customerId, qKw, { maxRows: cap }),
				]);
				const avgQs = weightedAvgQualityScore(kwRows);
				return textJson({
					customer_id: r.customerId,
					weighted_avg_quality_score: avgQs,
					campaign_search_row_count: campRows.length,
					keyword_view_row_count: kwRows.length,
					campaign_rows: campRows,
					keyword_quality_sample: kwRows.slice(0, Math.min(100, kwRows.length)),
				});
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"get_ad_group_performance",
		{
			account_name: z.string().optional(),
			customer_id: z.string().optional(),
			campaign_name: z.string().min(1),
			ad_group_name: z.string().min(1),
			match_mode: matchModeSchema,
			date_range: dateRangeSchema,
			date_start: z.string().optional(),
			date_end: z.string().optional(),
			max_rows: maxRowsSchema(DEFAULT_SEARCH_MAX_ROWS, 5000),
		},
		async ({
			account_name,
			customer_id,
			campaign_name,
			ad_group_name,
			match_mode,
			date_range,
			date_start,
			date_end,
			max_rows,
		}) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const resolved = await resolveAdGroupByName(env, token, {
					customerId: customer_id ? normalizeCustomerId(customer_id) : undefined,
					accountName: account_name,
					campaignName: campaign_name,
					adGroupName: ad_group_name,
					matchMode: match_mode,
					accessibleResourceNames: rns,
				});
				const block = blockUnlessResolved(resolved, "ad_group");
				if (block) return textJson({ ...block, report: "not_run_needs_resolution" });
				const customerId = String(resolved.resolved_customer_id ?? resolved.candidates[0].customerId);
				const adGroupId = String(resolved.candidates[0].adGroupId);
				const during = Q.duringOrBetween(date_range, date_start, date_end);
				const query = Q.queryAdGroupPerformance(adGroupId, during);
				const rows = await searchStreamCollect(env, token, customerId, query, {
					maxRows: max_rows ?? DEFAULT_SEARCH_MAX_ROWS,
				});
				return textJson({
					resolved_ad_group: resolved.candidates[0],
					row_count: rows.length,
					rows,
				});
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"get_keywords_by_account",
		{
			...accountCustomerArgs,
			match_types: z
				.array(z.enum(["EXACT", "PHRASE", "BROAD"]))
				.optional()
				.describe("Filter Google Ads keyword match types."),
			status: z.enum(["ENABLED", "PAUSED", "REMOVED"]).optional(),
			quality_score_min: z.number().int().min(1).max(10).optional(),
			quality_score_max: z.number().int().min(1).max(10).optional(),
		},
		async ({
			account_name,
			customer_id,
			match_mode,
			date_range,
			date_start,
			date_end,
			max_rows,
			match_types,
			status,
			quality_score_min,
			quality_score_max,
		}) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const r = await resolveSingleCustomer(env, token, rns, account_name, customer_id, match_mode);
				if ("error" in r) return textJson(r.error);
				const during = Q.duringOrBetween(date_range, date_start, date_end);
				const query = Q.queryKeywordsByAccount(
					during,
					match_types,
					status,
					quality_score_min,
					quality_score_max,
				);
				const rows = await searchStreamCollect(env, token, r.customerId, query, {
					maxRows: max_rows ?? KEYWORD_CAP,
				});
				return textJson({ customer_id: r.customerId, row_count: rows.length, rows });
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"get_low_quality_score_keywords",
		{
			account_name: z.string().optional(),
			customer_id: z.string().optional(),
			match_mode: matchModeSchema,
			date_range: dateRangeSchema,
			threshold: z.number().int().min(1).max(10).default(5).describe("QS strictly below this (default 5)."),
			max_rows: maxRowsSchema(LIST_CAP, 500),
		},
		async ({ account_name, customer_id, match_mode, date_range, threshold, max_rows }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const r = await resolveSingleCustomer(env, token, rns, account_name, customer_id, match_mode);
				if ("error" in r) return textJson(r.error);
				const during = dateRangeDuringClause(date_range);
				const query = Q.queryLowQualityKeywords(threshold, during);
				const rows = await searchStreamCollect(env, token, r.customerId, query, {
					maxRows: max_rows ?? 500,
				});
				return textJson({ customer_id: r.customerId, threshold, row_count: rows.length, rows });
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"get_search_terms_report",
		{
			account_name: z.string().optional(),
			customer_id: z.string().optional(),
			campaign_name: z.string().min(1),
			match_mode: matchModeSchema,
			date_range: dateRangeSchema,
			date_start: z.string().optional(),
			date_end: z.string().optional(),
			max_rows: maxRowsSchema(DEFAULT_SEARCH_MAX_ROWS, 2000),
		},
		async ({
			account_name,
			customer_id,
			campaign_name,
			match_mode,
			date_range,
			date_start,
			date_end,
			max_rows,
		}) => {
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
				const during = Q.duringOrBetween(date_range, date_start, date_end);
				const query = Q.querySearchTermsReport(campaignId, during);
				const rows = await searchStreamCollect(env, token, customerId, query, { maxRows: max_rows ?? 2000 });
				return textJson({ resolved_campaign: resolved.candidates[0], row_count: rows.length, rows });
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"get_ad_performance_by_campaign",
		{
			account_name: z.string().optional(),
			customer_id: z.string().optional(),
			campaign_name: z.string().min(1),
			match_mode: matchModeSchema,
			date_range: dateRangeSchema,
			date_start: z.string().optional(),
			date_end: z.string().optional(),
			max_rows: maxRowsSchema(LIST_CAP, 500),
		},
		async ({
			account_name,
			customer_id,
			campaign_name,
			match_mode,
			date_range,
			date_start,
			date_end,
			max_rows,
		}) => {
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
				const during = Q.duringOrBetween(date_range, date_start, date_end);
				const query = Q.queryAdPerformanceByCampaign(campaignId, during);
				const rows = await searchStreamCollect(env, token, customerId, query, { maxRows: max_rows ?? 500 });
				return textJson({ resolved_campaign: resolved.candidates[0], row_count: rows.length, rows });
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"get_asset_performance",
		{
			account_name: z.string().optional(),
			customer_id: z.string().optional(),
			campaign_name: z.string().min(1),
			match_mode: matchModeSchema,
			date_range: dateRangeSchema,
			date_start: z.string().optional(),
			date_end: z.string().optional(),
			max_rows: maxRowsSchema(LIST_CAP, 500),
		},
		async ({
			account_name,
			customer_id,
			campaign_name,
			match_mode,
			date_range,
			date_start,
			date_end,
			max_rows,
		}) => {
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
				const during = Q.duringOrBetween(date_range, date_start, date_end);
				const query = Q.queryAssetPerformance(campaignId, during);
				const rows = await searchStreamCollect(env, token, customerId, query, { maxRows: max_rows ?? 500 });
				return textJson({ resolved_campaign: resolved.candidates[0], row_count: rows.length, rows });
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"get_responsive_search_ad_details",
		{
			account_name: z.string().optional(),
			customer_id: z.string().optional(),
			campaign_name: z.string().min(1),
			ad_group_name: z.string().optional(),
			match_mode: matchModeSchema,
			max_rows: maxRowsSchema(LIST_CAP, 200),
		},
		async ({ account_name, customer_id, campaign_name, ad_group_name, match_mode, max_rows }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				let customerId: string;
				let campaignId: string;
				let adGroupId: string | undefined;
				if (ad_group_name?.trim()) {
					const ra = await resolveAdGroupByName(env, token, {
						customerId: customer_id ? normalizeCustomerId(customer_id) : undefined,
						accountName: account_name,
						campaignName: campaign_name,
						adGroupName: ad_group_name.trim(),
						matchMode: match_mode,
						accessibleResourceNames: rns,
					});
					const b = blockUnlessResolved(ra, "ad_group");
					if (b) return textJson({ ...b, report: "not_run_needs_resolution" });
					customerId = String(ra.resolved_customer_id ?? ra.candidates[0].customerId);
					campaignId = String(ra.candidates[0].campaignId);
					adGroupId = String(ra.candidates[0].adGroupId);
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
				const query = Q.queryResponsiveSearchAdDetails(campaignId, adGroupId);
				const rows = await searchStreamCollect(env, token, customerId, query, { maxRows: max_rows ?? 200 });
				return textJson({ customer_id: customerId, row_count: rows.length, rows });
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"get_ad_strength_report",
		{
			...accountCustomerArgs,
		},
		async ({ account_name, customer_id, match_mode, date_range, date_start, date_end, max_rows }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const r = await resolveSingleCustomer(env, token, rns, account_name, customer_id, match_mode);
				if ("error" in r) return textJson(r.error);
				const during = Q.duringOrBetween(date_range, date_start, date_end);
				const query = Q.queryAdStrengthReport(during);
				const rows = await searchStreamCollect(env, token, r.customerId, query, { maxRows: max_rows ?? LIST_CAP });
				return textJson({ customer_id: r.customerId, row_count: rows.length, rows });
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"get_audience_performance",
		{
			...accountCustomerArgs,
		},
		async ({ account_name, customer_id, match_mode, date_range, date_start, date_end, max_rows }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const r = await resolveSingleCustomer(env, token, rns, account_name, customer_id, match_mode);
				if ("error" in r) return textJson(r.error);
				const during = Q.duringOrBetween(date_range, date_start, date_end);
				const query = Q.queryAudiencePerformance(during);
				const rows = await searchStreamCollect(env, token, r.customerId, query, {
					maxRows: max_rows ?? LIST_CAP,
				});
				return textJson({ customer_id: r.customerId, row_count: rows.length, rows });
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"get_demographic_performance",
		{
			...accountCustomerArgs,
			dimension: z.enum(["age", "gender", "income", "all"]).default("all"),
		},
		async ({ account_name, customer_id, match_mode, date_range, date_start, date_end, max_rows, dimension }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const r = await resolveSingleCustomer(env, token, rns, account_name, customer_id, match_mode);
				if ("error" in r) return textJson(r.error);
				const during = Q.duringOrBetween(date_range, date_start, date_end);
				const cap = max_rows ?? LIST_CAP;
				const out: Record<string, unknown> = { customer_id: r.customerId };
				if (dimension === "age" || dimension === "all") {
					out.age_range = await searchStreamCollect(env, token, r.customerId, Q.queryDemographicAge(during), {
						maxRows: cap,
					});
				}
				if (dimension === "gender" || dimension === "all") {
					out.gender = await searchStreamCollect(env, token, r.customerId, Q.queryDemographicGender(during), {
						maxRows: cap,
					});
				}
				if (dimension === "income" || dimension === "all") {
					out.income_range = await searchStreamCollect(env, token, r.customerId, Q.queryDemographicIncome(during), {
						maxRows: cap,
					});
				}
				return textJson(out);
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"get_device_performance",
		{
			...accountCustomerArgs,
		},
		async ({ account_name, customer_id, match_mode, date_range, date_start, date_end, max_rows }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const r = await resolveSingleCustomer(env, token, rns, account_name, customer_id, match_mode);
				if ("error" in r) return textJson(r.error);
				const during = Q.duringOrBetween(date_range, date_start, date_end);
				const query = Q.queryDevicePerformance(during);
				const rows = await searchStreamCollect(env, token, r.customerId, query, { maxRows: max_rows ?? LIST_CAP });
				return textJson({ customer_id: r.customerId, row_count: rows.length, rows });
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"get_geographic_performance",
		{
			...accountCustomerArgs,
		},
		async ({ account_name, customer_id, match_mode, date_range, date_start, date_end, max_rows }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const r = await resolveSingleCustomer(env, token, rns, account_name, customer_id, match_mode);
				if ("error" in r) return textJson(r.error);
				const during = Q.duringOrBetween(date_range, date_start, date_end);
				const query = Q.queryGeographicUserLocation(during);
				const rows = await searchStreamCollect(env, token, r.customerId, query, { maxRows: max_rows ?? LIST_CAP });
				return textJson({ customer_id: r.customerId, row_count: rows.length, rows });
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"get_shopping_product_performance",
		{
			...accountCustomerArgs,
		},
		async ({ account_name, customer_id, match_mode, date_range, date_start, date_end, max_rows }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const r = await resolveSingleCustomer(env, token, rns, account_name, customer_id, match_mode);
				if ("error" in r) return textJson(r.error);
				const during = Q.duringOrBetween(date_range, date_start, date_end);
				const query = Q.queryShoppingProductPerformance(during);
				const rows = await searchStreamCollect(env, token, r.customerId, query, { maxRows: max_rows ?? LIST_CAP });
				return textJson({ customer_id: r.customerId, row_count: rows.length, rows });
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"get_pmax_asset_group_performance",
		{
			...accountCustomerArgs,
		},
		async ({ account_name, customer_id, match_mode, date_range, date_start, date_end, max_rows }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const r = await resolveSingleCustomer(env, token, rns, account_name, customer_id, match_mode);
				if ("error" in r) return textJson(r.error);
				const during = Q.duringOrBetween(date_range, date_start, date_end);
				const query = Q.queryPmaxAssetGroupPerformance(during);
				const rows = await searchStreamCollect(env, token, r.customerId, query, { maxRows: max_rows ?? LIST_CAP });
				return textJson({ customer_id: r.customerId, row_count: rows.length, rows });
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"get_pmax_search_terms",
		{
			...accountCustomerArgs,
		},
		async ({ account_name, customer_id, match_mode, date_range, date_start, date_end, max_rows }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const r = await resolveSingleCustomer(env, token, rns, account_name, customer_id, match_mode);
				if ("error" in r) return textJson(r.error);
				const during = Q.duringOrBetween(date_range, date_start, date_end);
				const query = Q.queryPmaxSearchTerms(during);
				const rows = await searchStreamCollect(env, token, r.customerId, query, { maxRows: max_rows ?? LIST_CAP });
				return textJson({ customer_id: r.customerId, row_count: rows.length, rows });
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"list_conversion_actions",
		{
			account_name: z.string().optional(),
			customer_id: z.string().optional(),
			match_mode: matchModeSchema,
			max_rows: maxRowsSchema(500, 200),
		},
		async ({ account_name, customer_id, match_mode, max_rows }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const r = await resolveSingleCustomer(env, token, rns, account_name, customer_id, match_mode);
				if ("error" in r) return textJson(r.error);
				const query = Q.queryListConversionActions();
				const rows = await searchStreamCollect(env, token, r.customerId, query, { maxRows: max_rows ?? 200 });
				return textJson({ customer_id: r.customerId, row_count: rows.length, rows });
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"get_conversion_performance_by_campaign",
		{
			...accountCustomerArgs,
		},
		async ({ account_name, customer_id, match_mode, date_range, date_start, date_end, max_rows }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const r = await resolveSingleCustomer(env, token, rns, account_name, customer_id, match_mode);
				if ("error" in r) return textJson(r.error);
				const during = Q.duringOrBetween(date_range, date_start, date_end);
				const query = Q.queryConversionPerformanceByCampaign(during);
				const rows = await searchStreamCollect(env, token, r.customerId, query, { maxRows: max_rows ?? LIST_CAP });
				return textJson({ customer_id: r.customerId, row_count: rows.length, rows });
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"get_attribution_path_report",
		{
			...accountCustomerArgs,
		},
		async ({ account_name, customer_id, match_mode, date_range, date_start, date_end, max_rows }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const r = await resolveSingleCustomer(env, token, rns, account_name, customer_id, match_mode);
				if ("error" in r) return textJson(r.error);
				const during = Q.duringOrBetween(date_range, date_start, date_end);
				const query = Q.queryAttributionSummary(during);
				const rows = await searchStreamCollect(env, token, r.customerId, query, {
					maxRows: max_rows ?? DEFAULT_SEARCH_MAX_ROWS,
				});
				return textJson({
					customer_id: r.customerId,
					disclaimer:
						"Simplified proxy (conversions, all_conversions, view_through). Full path reports may need BigQuery / offline exports.",
					row_count: rows.length,
					rows,
				});
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"get_auction_insights",
		{
			account_name: z.string().optional(),
			customer_id: z.string().optional(),
			campaign_name: z.string().min(1),
			match_mode: matchModeSchema,
			date_range: dateRangeSchema,
			date_start: z.string().optional(),
			date_end: z.string().optional(),
			max_rows: maxRowsSchema(500, 100),
		},
		async ({
			account_name,
			customer_id,
			campaign_name,
			match_mode,
			date_range,
			date_start,
			date_end,
			max_rows,
		}) => {
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
				const during = Q.duringOrBetween(date_range, date_start, date_end);
				const query = Q.queryAuctionInsights(campaignId, during);
				const rows = await searchStreamCollect(env, token, customerId, query, { maxRows: max_rows ?? 100 });
				return textJson({ resolved_campaign: resolved.candidates[0], row_count: rows.length, rows });
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"get_change_history",
		{
			account_name: z.string().optional(),
			customer_id: z.string().optional(),
			match_mode: matchModeSchema,
			date_range: dateRangeSchema.default("LAST_7_DAYS"),
			limit: z.number().int().min(1).max(10_000).default(2000),
		},
		async ({ account_name, customer_id, match_mode, date_range, limit }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token);
				const r = await resolveSingleCustomer(env, token, rns, account_name, customer_id, match_mode);
				if ("error" in r) return textJson(r.error);
				const query = Q.queryChangeHistoryDuring(date_range, limit);
				const rows = await searchStreamCollect(env, token, r.customerId, query, { maxRows: limit });
				return textJson({ customer_id: r.customerId, row_count: rows.length, rows });
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"get_mcc_performance_overview",
		{
			manager_customer_id: z.string().optional().describe("Defaults to GOOGLE_ADS_LOGIN_CUSTOMER_ID."),
			date_range: dateRangeSchema,
			only_leaf_accounts: z.boolean().default(true),
			max_accounts: z.number().int().min(1).max(MCC_MAX_ACCOUNTS_DEFAULT).default(25),
		},
		async ({ manager_customer_id, date_range, only_leaf_accounts, max_accounts }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const mid = manager_customer_id
					? normalizeCustomerId(manager_customer_id)
					: normalizeCustomerId(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
				const ids = await mccLeafCustomerIds(env, token, mid, max_accounts, only_leaf_accounts);
				const during = dateRangeDuringClause(date_range);
				const query = Q.queryMccKpiChild(during);
				const results: Array<{
					customer_id: string;
					summary: ReturnType<typeof aggregateCustomerDaily>;
					error?: string;
				}> = [];
				for (const cid of ids) {
					try {
						const rows = await searchStreamCollect(env, token, cid, query, { maxRows: 500 });
						results.push({ customer_id: cid, summary: aggregateCustomerDaily(rows) });
					} catch (err) {
						results.push({
							customer_id: cid,
							summary: aggregateCustomerDaily([]),
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
				return textJson({ manager_customer_id: mid, account_count: results.length, results });
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"get_mcc_budget_pacing",
		{
			manager_customer_id: z.string().optional(),
			only_leaf_accounts: z.boolean().default(true),
			max_accounts: z.number().int().min(1).max(MCC_MAX_ACCOUNTS_DEFAULT).default(25),
		},
		async ({ manager_customer_id, only_leaf_accounts, max_accounts }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const mid = manager_customer_id
					? normalizeCustomerId(manager_customer_id)
					: normalizeCustomerId(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
				const ids = await mccLeafCustomerIds(env, token, mid, max_accounts, only_leaf_accounts);
				const thisMonth = dateRangeDuringClause("THIS_MONTH");
				const qBudget = Q.queryAccountBudgetPacing(thisMonth);
				const qSpend = Q.queryMccKpiChild(thisMonth);
				const results: unknown[] = [];
				for (const cid of ids) {
					try {
						const [budgetRows, spendRows] = await Promise.all([
							searchStreamCollect(env, token, cid, qBudget, { maxRows: 200 }),
							searchStreamCollect(env, token, cid, qSpend, { maxRows: 500 }),
						]);
						results.push({
							customer_id: cid,
							spend_summary: aggregateCustomerDaily(spendRows),
							account_budget_rows: budgetRows,
						});
					} catch (err) {
						results.push({
							customer_id: cid,
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
				return textJson({ manager_customer_id: mid, account_count: results.length, results });
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);

	server.tool(
		"get_mcc_anomaly_alerts",
		{
			manager_customer_id: z.string().optional(),
			only_leaf_accounts: z.boolean().default(true),
			max_accounts: z.number().int().min(1).max(30).default(20),
			current_range: dateRangeSchema.default("LAST_7_DAYS"),
			compare_range: compareDateRangeSchema.describe(
				"Prior window; defaults to PREVIOUS_7_DAYS or PREVIOUS_30_DAYS based on current_range.",
			),
		},
		async ({ manager_customer_id, only_leaf_accounts, max_accounts, current_range, compare_range }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const mid = manager_customer_id
					? normalizeCustomerId(manager_customer_id)
					: normalizeCustomerId(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
				const ids = await mccLeafCustomerIds(env, token, mid, max_accounts, only_leaf_accounts);
				const cur = dateRangeDuringClause(current_range);
				const cmp =
					compare_range != null
						? dateRangeDuringClause(compare_range)
						: current_range === "LAST_7_DAYS"
							? dateRangeDuringClause("PREVIOUS_7_DAYS")
							: dateRangeDuringClause("PREVIOUS_30_DAYS");
				const q = Q.queryMccKpiChild(cur);
				const qPrev = Q.queryMccKpiChild(cmp);
				const alerts: unknown[] = [];
				for (const cid of ids) {
					try {
						const [rowsC, rowsP] = await Promise.all([
							searchStreamCollect(env, token, cid, q, { maxRows: 500 }),
							searchStreamCollect(env, token, cid, qPrev, { maxRows: 500 }),
						]);
						const a = aggregateCustomerDaily(rowsC);
						const b = aggregateCustomerDaily(rowsP);
						const convDrop =
							b.conversions > 5 && a.conversions < b.conversions * 0.5 ? "conversions_down_50pct" : null;
						let spendSpikeFlag: string | null = null;
						if (b.cost_micros > 1_000_000 && a.cost_micros > b.cost_micros * 1.5)
							spendSpikeFlag = "spend_up_50pct";
						const ctrDrop =
							b.clicks > ANOMALY_MIN_IMPRESSIONS &&
							a.impressions > ANOMALY_MIN_IMPRESSIONS &&
							b.impressions > 0 &&
							a.clicks / a.impressions < (b.clicks / b.impressions) * 0.6
								? "ctr_down_40pct_vs_prior"
								: null;
						const flags = [convDrop, spendSpikeFlag, ctrDrop].filter(Boolean);
						if (flags.length > 0) {
							alerts.push({
								customer_id: cid,
								flags,
								current: a,
								prior: b,
							});
						}
					} catch (err) {
						alerts.push({ customer_id: cid, error: err instanceof Error ? err.message : String(err) });
					}
				}
				return textJson({
					manager_customer_id: mid,
					current: current_range,
					compare: compare_range ?? "auto",
					alerts,
				});
			} catch (e) {
				return textJson({ error: e instanceof Error ? e.message : String(e) });
			}
		},
	);
}
