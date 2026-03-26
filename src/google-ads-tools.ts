import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as Q from "./google-ads-agency-queries";
import { registerAgencyTools } from "./google-ads-agency-tools";
import {
	CUSTOMER_CLIENT_MAX_ROWS,
	DEFAULT_SEARCH_MAX_ROWS,
	getGoogleAdsAccessToken,
	listAccessibleCustomers,
	listAccessibleLoginOptions,
	mergeSearchStreamOptions,
	normalizeCustomerId,
	resolveAdsLoginCustomerId,
	searchStreamCollect,
} from "./google-ads-api";
import { buildOfficialSearchGaql } from "./google-ads-official-search";
import {
	dateRangeDuringClause,
	fetchCustomerClients,
	listAccountsWithNamesMerged,
	resolveAdGroupByName,
	resolveCampaignByName,
	resolveCustomerByName,
	type ResolvePayload,
} from "./google-ads-resolve";
import { dateRangeSchema, loginCustomerIdSchema, matchModeSchema, textJson } from "./google-ads-tool-utils";

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
			ids_only: z
				.boolean()
				.default(false)
				.describe(
					"When true, return only numeric customer IDs like the official google-ads-mcp (no resource name prefixes).",
				),
			include_manager_context: z
				.boolean()
				.default(true)
				.describe(
					"When true, include the configured manager login-customer-id in the response (ignored if ids_only).",
				),
			login_customer_id: loginCustomerIdSchema,
		},
		async ({ ids_only, include_manager_context, login_customer_id }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const customers = await listAccessibleCustomers(env, token, listAccessibleLoginOptions(login_customer_id));
				if (ids_only) {
					const ids = customers.map((rn) => rn.replace(/^customers\//, ""));
					return textJson(ids);
				}
				const managerCustomerId = normalizeCustomerId(
					login_customer_id ?? env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
				);
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
		{
			include_customer_clients: z
				.boolean()
				.default(true)
				.describe("When true (default), merge MCC customer_client links with listAccessibleCustomers (deduped)."),
			only_leaf_accounts: z
				.boolean()
				.default(false)
				.describe("When true, only non-manager clients when merging customer_client."),
			manager_customer_id: z
				.string()
				.optional()
				.describe("Manager ID for customer_client query; defaults to GOOGLE_ADS_LOGIN_CUSTOMER_ID."),
			max_client_rows: z
				.number()
				.int()
				.positive()
				.max(CUSTOMER_CLIENT_MAX_ROWS)
				.optional()
				.describe(`Max customer_client rows (${CUSTOMER_CLIENT_MAX_ROWS} cap).`),
			login_customer_id: loginCustomerIdSchema,
		},
		async ({
			include_customer_clients,
			only_leaf_accounts,
			manager_customer_id,
			max_client_rows,
			login_customer_id,
		}) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token, listAccessibleLoginOptions(login_customer_id));
				const { accounts, errors, sources } = await listAccountsWithNamesMerged(env, token, rns, {
					includeCustomerClients: include_customer_clients,
					onlyLeafAccounts: only_leaf_accounts,
					managerCustomerId: manager_customer_id,
					maxClientRows: max_client_rows,
					loginCustomerId: login_customer_id,
				});
				return textJson({
					accounts,
					count: accounts.length,
					errors,
					sources,
					login_customer_id_used: resolveAdsLoginCustomerId(env, login_customer_id),
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textJson({ error: message });
			}
		},
	);

	server.tool(
		"list_customer_clients",
		{
			account_name: z
				.string()
				.optional()
				.describe(
					"Optional manager account descriptive name. If omitted with customer_id, uses GOOGLE_ADS_LOGIN_CUSTOMER_ID.",
				),
			customer_id: z
				.string()
				.optional()
				.describe("Manager customer ID (digits). Use for MCC root when listing linked client accounts."),
			match_mode: matchModeSchema,
			only_leaf_accounts: z
				.boolean()
				.default(false)
				.describe("When true, add customer_client.manager = FALSE (non-manager / leaf links)."),
			max_rows: z
				.number()
				.int()
				.positive()
				.max(CUSTOMER_CLIENT_MAX_ROWS)
				.optional()
				.describe(`Max rows (cap ${CUSTOMER_CLIENT_MAX_ROWS}).`),
			login_customer_id: loginCustomerIdSchema,
		},
		async ({ account_name, customer_id, match_mode, only_leaf_accounts, max_rows, login_customer_id }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token, listAccessibleLoginOptions(login_customer_id));
				let managerId = customer_id ? normalizeCustomerId(customer_id) : undefined;
				if (!managerId && account_name?.trim()) {
					const resolved = await resolveCustomerByName(
						env,
						token,
						account_name.trim(),
						match_mode,
						rns,
						login_customer_id ? { loginCustomerId: login_customer_id } : undefined,
					);
					if (resolved.match_count !== 1) {
						return textJson({
							...resolved,
							report: "not_run_needs_resolution",
							hint: "Provide a single manager match, or pass customer_id, or omit both to use login MCC.",
						});
					}
					managerId = String(resolved.candidates[0].customerId ?? "");
				}
				if (!managerId) {
					managerId = normalizeCustomerId(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
				}
				const loginCustomerIdUsed = login_customer_id?.replace(/\D/g, "")
					? normalizeCustomerId(login_customer_id)
					: managerId;
				const rows = await fetchCustomerClients(env, token, managerId, {
					onlyLeafAccounts: only_leaf_accounts,
					maxRows: max_rows,
					loginCustomerId: login_customer_id,
				});
				return textJson({
					operating_customer_id: managerId,
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
		"resolve_customer",
		{
			account_name: z
				.string()
				.min(1)
				.describe("Customer descriptive name as the user said it (not the numeric customer ID)."),
			match_mode: matchModeSchema,
			login_customer_id: loginCustomerIdSchema,
		},
		async ({ account_name, match_mode, login_customer_id }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token, listAccessibleLoginOptions(login_customer_id));
				const payload = await resolveCustomerByName(
					env,
					token,
					account_name,
					match_mode,
					rns,
					login_customer_id ? { loginCustomerId: login_customer_id } : undefined,
				);
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
			login_customer_id: loginCustomerIdSchema,
		},
		async ({ account_name, customer_id, campaign_name, match_mode, login_customer_id }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token, listAccessibleLoginOptions(login_customer_id));
				const cid = customer_id ? normalizeCustomerId(customer_id) : undefined;
				const payload = await resolveCampaignByName(env, token, {
					customerId: cid,
					accountName: account_name,
					campaignName: campaign_name,
					matchMode: match_mode,
					accessibleResourceNames: rns,
					loginCustomerId: login_customer_id,
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
			login_customer_id: loginCustomerIdSchema,
		},
		async ({ account_name, customer_id, campaign_name, ad_group_name, match_mode, login_customer_id }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token, listAccessibleLoginOptions(login_customer_id));
				const payload = await resolveAdGroupByName(env, token, {
					customerId: customer_id ? normalizeCustomerId(customer_id) : undefined,
					accountName: account_name,
					campaignName: campaign_name,
					adGroupName: ad_group_name,
					matchMode: match_mode,
					accessibleResourceNames: rns,
					loginCustomerId: login_customer_id,
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
			login_customer_id: loginCustomerIdSchema,
		},
		async ({ account_name, match_mode, date_range, login_customer_id }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token, listAccessibleLoginOptions(login_customer_id));
				const resolved = await resolveCustomerByName(
					env,
					token,
					account_name,
					match_mode,
					rns,
					login_customer_id ? { loginCustomerId: login_customer_id } : undefined,
				);
				const block = blockUnlessResolved(resolved, "customer");
				if (block) return textJson({ ...block, report: "not_run_needs_resolution" });
				const customerId = String(resolved.candidates[0].customerId);
				const during = dateRangeDuringClause(date_range);
				const query = `SELECT segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM customer WHERE ${during}`;
				const rows = await searchStreamCollect(
					env,
					token,
					customerId,
					query,
					mergeSearchStreamOptions({}, login_customer_id),
				);
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
			login_customer_id: loginCustomerIdSchema,
		},
		async ({ account_name, customer_id, campaign_name, match_mode, date_range, login_customer_id }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token, listAccessibleLoginOptions(login_customer_id));
				const resolved = await resolveCampaignByName(env, token, {
					customerId: customer_id ? normalizeCustomerId(customer_id) : undefined,
					accountName: account_name,
					campaignName: campaign_name,
					matchMode: match_mode,
					accessibleResourceNames: rns,
					loginCustomerId: login_customer_id,
				});
				const block = blockUnlessResolved(resolved, "campaign");
				if (block) return textJson({ ...block, report: "not_run_needs_resolution" });
				const customerId = String(resolved.resolved_customer_id ?? resolved.candidates[0].customerId);
				const campaignId = String(resolved.candidates[0].campaignId);
				const during = dateRangeDuringClause(date_range);
				const query = Q.queryCampaignPerformanceById(campaignId, during, true);
				const rows = await searchStreamCollect(
					env,
					token,
					customerId,
					query,
					mergeSearchStreamOptions({}, login_customer_id),
				);
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

	const listAdGroupsHandler = async (args: {
		account_name?: string;
		customer_id?: string;
		campaign_name: string;
		match_mode: "exact" | "contains";
		date_range?: z.infer<typeof dateRangeSchema>;
		include_metrics?: boolean;
		max_rows?: number;
		login_customer_id?: string;
	}) => {
		const {
			account_name,
			customer_id,
			campaign_name,
			match_mode,
			date_range,
			include_metrics,
			max_rows,
			login_customer_id,
		} = args;
		const token = await getGoogleAdsAccessToken(env);
		const rns = await listAccessibleCustomers(env, token, listAccessibleLoginOptions(login_customer_id));
		const resolved = await resolveCampaignByName(env, token, {
			customerId: customer_id ? normalizeCustomerId(customer_id) : undefined,
			accountName: account_name,
			campaignName: campaign_name,
			matchMode: match_mode,
			accessibleResourceNames: rns,
			loginCustomerId: login_customer_id,
		});
		const block = blockUnlessResolved(resolved, "campaign");
		if (block) return textJson({ ...block, report: "not_run_needs_resolution" });
		const customerId = String(resolved.resolved_customer_id ?? resolved.candidates[0].customerId);
		const campaignId = String(resolved.candidates[0].campaignId);
		const withMetrics = include_metrics ?? false;
		const during = withMetrics ? dateRangeDuringClause(date_range ?? "LAST_30_DAYS") : "";
		const query = Q.queryAdGroupsByCampaign(campaignId, during, withMetrics);
		const cap = max_rows ?? 500;
		const rows = await searchStreamCollect(
			env,
			token,
			customerId,
			query,
			mergeSearchStreamOptions({ maxRows: cap }, login_customer_id),
		);
		return textJson({
			resolved_campaign: resolved.candidates[0],
			row_count: rows.length,
			rows,
		});
	};

	server.tool(
		"list_ad_groups_by_campaign_name",
		{
			account_name: z.string().optional(),
			customer_id: z.string().optional(),
			campaign_name: z.string().min(1),
			match_mode: matchModeSchema,
			date_range: dateRangeSchema.optional().describe("Required when include_metrics is true."),
			include_metrics: z
				.boolean()
				.default(false)
				.describe("When true, includes impressions, CTR, CPA for the date_range (default LAST_30_DAYS)."),
			max_rows: z.number().int().positive().max(DEFAULT_SEARCH_MAX_ROWS).optional(),
			login_customer_id: loginCustomerIdSchema,
		},
		async (args) => {
			try {
				return await listAdGroupsHandler(args);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textJson({ error: message });
			}
		},
	);

	server.tool(
		"list_ad_groups_by_campaign",
		{
			account_name: z.string().optional(),
			customer_id: z.string().optional(),
			campaign_name: z.string().min(1),
			match_mode: matchModeSchema,
			date_range: dateRangeSchema.optional(),
			include_metrics: z.boolean().default(false),
			max_rows: z.number().int().positive().max(DEFAULT_SEARCH_MAX_ROWS).optional(),
			login_customer_id: loginCustomerIdSchema,
		},
		async (args) => {
			try {
				return await listAdGroupsHandler(args);
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
			login_customer_id: loginCustomerIdSchema,
		},
		async ({ account_name, customer_id, campaign_name, ad_group_name, match_mode, date_range, login_customer_id }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token, listAccessibleLoginOptions(login_customer_id));
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
						loginCustomerId: login_customer_id,
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
						loginCustomerId: login_customer_id,
					});
					const block = blockUnlessResolved(resolved, "campaign");
					if (block) return textJson({ ...block, report: "not_run_needs_resolution" });
					customerId = String(resolved.resolved_customer_id ?? resolved.candidates[0].customerId);
					campaignId = String(resolved.candidates[0].campaignId);
				}
				const during = dateRangeDuringClause(date_range);
				const agFilter = adGroupId ? ` AND ad_group.id = ${adGroupId}` : "";
				const query = Q.queryKeywordPerformance(campaignId, agFilter, during);
				const rows = await searchStreamCollect(
					env,
					token,
					customerId,
					query,
					mergeSearchStreamOptions({}, login_customer_id),
				);
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
			login_customer_id: loginCustomerIdSchema,
		},
		async ({ account_name, customer_id, campaign_name, match_mode, date_range, login_customer_id }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token, listAccessibleLoginOptions(login_customer_id));
				const resolved = await resolveCampaignByName(env, token, {
					customerId: customer_id ? normalizeCustomerId(customer_id) : undefined,
					accountName: account_name,
					campaignName: campaign_name,
					matchMode: match_mode,
					accessibleResourceNames: rns,
					loginCustomerId: login_customer_id,
				});
				const block = blockUnlessResolved(resolved, "campaign");
				if (block) return textJson({ ...block, report: "not_run_needs_resolution" });
				const customerId = String(resolved.resolved_customer_id ?? resolved.candidates[0].customerId);
				const campaignId = String(resolved.candidates[0].campaignId);
				const during = dateRangeDuringClause(date_range);
				const query = Q.querySearchTermsReport(campaignId, during);
				const rows = await searchStreamCollect(
					env,
					token,
					customerId,
					query,
					mergeSearchStreamOptions({}, login_customer_id),
				);
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
		"search",
		{
			customer_id: z
				.string()
				.min(1)
				.describe("Customer ID only digits (no hyphens). Same contract as google-ads-mcp search."),
			fields: z
				.array(z.string())
				.min(1)
				.describe("GAQL field names, e.g. campaign.id, metrics.clicks. Must match API field reference."),
			resource: z.string().min(1).describe("GAQL resource, e.g. campaign, ad_group."),
			conditions: z
				.array(z.string())
				.optional()
				.describe("WHERE fragments combined with AND (omit WHERE keyword)."),
			orderings: z.array(z.string()).optional().describe("ORDER BY fragments (omit ORDER BY keyword)."),
			limit: z
				.union([z.number().int().positive(), z.string()])
				.optional()
				.describe("LIMIT value. change_event queries: use LIMIT <= 10000 per Google Ads guidance."),
			login_customer_id: loginCustomerIdSchema,
		},
		async ({ customer_id, fields, resource, conditions, orderings, limit, login_customer_id }) => {
			try {
				const token = await getGoogleAdsAccessToken(env);
				const query = buildOfficialSearchGaql({
					fields,
					resource,
					conditions: conditions ?? null,
					orderings: orderings ?? null,
					limit: limit ?? null,
				});
				const rows = await searchStreamCollect(
					env,
					token,
					normalizeCustomerId(customer_id),
					query,
					mergeSearchStreamOptions({ maxRows: DEFAULT_SEARCH_MAX_ROWS }, login_customer_id),
				);
				return textJson({ customer_id: normalizeCustomerId(customer_id), query, row_count: rows.length, rows });
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
				.describe(
					"Full GAQL string (read-only). For google-ads-mcp-style building use the `search` tool (fields + resource + conditions). Prefer name-based tools for chat.",
				),
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
			login_customer_id: loginCustomerIdSchema,
		},
		async ({ query, account_name, customer_id, max_rows, login_customer_id }) => {
			try {
				const hasCid = Boolean(customer_id?.replace(/\D/g, ""));
				const hasName = Boolean(account_name?.trim());
				if ((hasCid && hasName) || (!hasCid && !hasName)) {
					return textJson({
						error: "Provide exactly one of customer_id or account_name (for conversational flow use account_name).",
					});
				}
				const token = await getGoogleAdsAccessToken(env);
				const rns = await listAccessibleCustomers(env, token, listAccessibleLoginOptions(login_customer_id));
				let customerIdStr: string;
				if (hasCid) {
					customerIdStr = normalizeCustomerId(customer_id!);
				} else {
					const resolved = await resolveCustomerByName(
						env,
						token,
						account_name!.trim(),
						"contains",
						rns,
						login_customer_id ? { loginCustomerId: login_customer_id } : undefined,
					);
					if (resolved.match_count !== 1) {
						return textJson({
							...resolved,
							query: "not_run_needs_account_resolution",
						});
					}
					customerIdStr = String(resolved.candidates[0].customerId);
				}
				const cap = max_rows ?? DEFAULT_SEARCH_MAX_ROWS;
				const rows = await searchStreamCollect(
					env,
					token,
					customerIdStr,
					query,
					mergeSearchStreamOptions({ maxRows: cap }, login_customer_id),
				);
				return textJson({ customer_id: customerIdStr, row_count: rows.length, rows });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textJson({ error: message });
			}
		},
	);

	registerAgencyTools(server, env);
}
