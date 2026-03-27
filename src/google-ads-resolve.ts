import {
	type MergeAccountMap,
	accessibleRowToAccountEntry,
	mergeClientRowsIntoMap,
} from "./google-ads-account-merge";
import {
	CUSTOMER_CLIENT_MAX_ROWS,
	customerIdFromResourceName,
	escapeGaqlString,
	normalizeCustomerId,
	resolveAdsLoginCustomerId,
	RESOLVER_MAX_ROWS,
	searchStreamCollect,
} from "./google-ads-api";

export type MatchMode = "exact" | "contains";

export type ResolvePayload = {
	match_count: number;
	match_level: "customer" | "campaign" | "ad_group";
	candidates: Array<Record<string, unknown>>;
	message?: string;
	/** When exactly one customer resolved in an upstream step (for campaign/ad_group tools). */
	resolved_customer_id?: string;
};

export function nameWhereClause(field: string, raw: string, mode: MatchMode): string {
	const e = escapeGaqlString(raw);
	if (mode === "exact") return `${field} = '${e}'`;
	return `${field} LIKE '%${e}%'`;
}

export function wrapResolve(
	level: ResolvePayload["match_level"],
	candidates: Array<Record<string, unknown>>,
): ResolvePayload {
	const match_count = candidates.length;
	let message: string | undefined;
	if (match_count === 0) {
		message =
			"No match. Try match_mode 'contains', check spelling, or list_accounts_with_names for valid account names.";
	} else if (match_count > 1) {
		message =
			"Multiple matches — do not guess. Pass a more specific name or use optional customer_id / campaign_id override after user confirms.";
	}
	return { match_count, match_level: level, candidates, message };
}

function rowCustomer(row: unknown): Record<string, unknown> | null {
	const r = row as { customer?: Record<string, unknown> };
	return r.customer ?? null;
}

function rowCampaign(row: unknown): Record<string, unknown> | null {
	const r = row as { campaign?: Record<string, unknown> };
	return r.campaign ?? null;
}

function rowAdGroup(row: unknown): Record<string, unknown> | null {
	const r = row as { adGroup?: Record<string, unknown>; ad_group?: Record<string, unknown> };
	return r.adGroup ?? r.ad_group ?? null;
}

function getStr(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const k of keys) {
		const v = obj[k];
		if (v !== undefined && v !== null) return String(v);
	}
	return undefined;
}

export type ResolveStreamOptions = {
	/** MCC login-customer-id override for searchStream (defaults to env). */
	loginCustomerId?: string;
};

export async function resolveCustomerByName(
	env: Env,
	accessToken: string,
	accountName: string,
	matchMode: MatchMode,
	accessibleResourceNames: string[],
	streamOpts?: ResolveStreamOptions,
): Promise<ResolvePayload> {
	const candidates: Array<Record<string, unknown>> = [];
	const seen = new Set<string>();

	for (const rn of accessibleResourceNames) {
		const cid = customerIdFromResourceName(rn);
		const where = nameWhereClause("customer.descriptive_name", accountName, matchMode);
		const query = `SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager, customer.resource_name FROM customer WHERE ${where}`;
		const rows = await searchStreamCollect(env, accessToken, cid, query, {
			maxRows: RESOLVER_MAX_ROWS,
			...(streamOpts?.loginCustomerId
				? { loginCustomerId: normalizeCustomerId(streamOpts.loginCustomerId) }
				: {}),
		});
		for (const row of rows) {
			const c = rowCustomer(row);
			if (!c) continue;
			const id = getStr(c, "id");
			if (!id || seen.has(id)) continue;
			seen.add(id);
			candidates.push({
				customerId: id,
				descriptiveName: getStr(c, "descriptiveName", "descriptive_name"),
				currencyCode: getStr(c, "currencyCode", "currency_code"),
				manager: c.manager ?? c["manager"],
				resourceName: getStr(c, "resourceName", "resource_name"),
			});
			if (candidates.length >= RESOLVER_MAX_ROWS) break;
		}
		if (candidates.length >= RESOLVER_MAX_ROWS) break;
	}

	const base = wrapResolve("customer", candidates);
	return base;
}

export async function resolveCampaignByName(
	env: Env,
	accessToken: string,
	params: {
		customerId?: string;
		accountName?: string;
		campaignName: string;
		matchMode: MatchMode;
		accessibleResourceNames: string[];
		loginCustomerId?: string;
	},
): Promise<ResolvePayload> {
	let customerId = params.customerId ? params.customerId.replace(/\D/g, "") : undefined;

	const loginStream =
		params.loginCustomerId != null && params.loginCustomerId !== ""
			? { loginCustomerId: normalizeCustomerId(params.loginCustomerId) }
			: undefined;

	if (!customerId && params.accountName) {
		const cust = await resolveCustomerByName(
			env,
			accessToken,
			params.accountName,
			params.matchMode,
			params.accessibleResourceNames,
			loginStream,
		);
		if (cust.match_count !== 1) {
			return {
				...cust,
				match_level: cust.match_count === 0 ? "customer" : "customer",
				resolved_customer_id: undefined,
			};
		}
		customerId = String(cust.candidates[0].customerId ?? "");
	}
	if (!customerId) {
		return {
			match_count: 0,
			match_level: "customer",
			candidates: [],
			message: "Provide account_name (or customer_id) together with campaign_name.",
		};
	}

	const where = nameWhereClause("campaign.name", params.campaignName, params.matchMode);
	const query = `SELECT campaign.id, campaign.name, campaign.status, campaign.resource_name FROM campaign WHERE ${where}`;
	const rows = await searchStreamCollect(env, accessToken, customerId, query, {
		maxRows: RESOLVER_MAX_ROWS,
		...(loginStream ?? {}),
	});
	const candidates: Array<Record<string, unknown>> = [];
	const seen = new Set<string>();
	for (const row of rows) {
		const c = rowCampaign(row);
		if (!c) continue;
		const id = getStr(c, "id");
		if (!id || seen.has(id)) continue;
		seen.add(id);
		candidates.push({
			customerId,
			campaignId: id,
			campaignName: getStr(c, "name"),
			status: getStr(c, "status"),
			resourceName: getStr(c, "resourceName", "resource_name"),
		});
	}

	const base = wrapResolve("campaign", candidates);
	return { ...base, resolved_customer_id: customerId };
}

export async function resolveAdGroupByName(
	env: Env,
	accessToken: string,
	params: {
		customerId?: string;
		accountName?: string;
		campaignName: string;
		adGroupName: string;
		matchMode: MatchMode;
		accessibleResourceNames: string[];
		loginCustomerId?: string;
	},
): Promise<ResolvePayload> {
	const camp = await resolveCampaignByName(env, accessToken, {
		customerId: params.customerId,
		accountName: params.accountName,
		campaignName: params.campaignName,
		matchMode: params.matchMode,
		accessibleResourceNames: params.accessibleResourceNames,
		loginCustomerId: params.loginCustomerId,
	});
	if (camp.match_count !== 1) {
		return {
			...camp,
			match_level: camp.match_level === "campaign" ? "campaign" : "customer",
		};
	}
	const customerId = String(camp.resolved_customer_id ?? camp.candidates[0].customerId ?? "");
	const campaignId = String(camp.candidates[0].campaignId ?? "");

	const whereName = nameWhereClause("ad_group.name", params.adGroupName, params.matchMode);
	const query = `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.resource_name, campaign.id FROM ad_group WHERE campaign.id = ${campaignId} AND ${whereName}`;
	const agLogin =
		params.loginCustomerId != null && params.loginCustomerId !== ""
			? { loginCustomerId: normalizeCustomerId(params.loginCustomerId) }
			: {};
	const rows = await searchStreamCollect(env, accessToken, customerId, query, {
		maxRows: RESOLVER_MAX_ROWS,
		...agLogin,
	});
	const candidates: Array<Record<string, unknown>> = [];
	const seen = new Set<string>();
	for (const row of rows) {
		const ag = rowAdGroup(row);
		if (!ag) continue;
		const id = getStr(ag, "id");
		if (!id || seen.has(id)) continue;
		seen.add(id);
		candidates.push({
			customerId,
			campaignId,
			campaignName: camp.candidates[0].campaignName,
			adGroupId: id,
			adGroupName: getStr(ag, "name"),
			status: getStr(ag, "status"),
			resourceName: getStr(ag, "resourceName", "resource_name"),
		});
	}

	const base = wrapResolve("ad_group", candidates);
	return { ...base, resolved_customer_id: customerId };
}

export async function listAccountsWithNames(
	env: Env,
	accessToken: string,
	accessibleResourceNames: string[],
): Promise<Array<Record<string, unknown>>> {
	const accounts: Array<Record<string, unknown>> = [];
	for (const rn of accessibleResourceNames) {
		const cid = customerIdFromResourceName(rn);
		const query =
			"SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager, customer.resource_name FROM customer";
		const rows = await searchStreamCollect(env, accessToken, cid, query, { maxRows: 1 });
		const row = rows[0];
		const c = rowCustomer(row);
		if (c) {
			const id = getStr(c, "id") ?? cid;
			accounts.push({
				customerId: id,
				descriptiveName: getStr(c, "descriptiveName", "descriptive_name"),
				currencyCode: getStr(c, "currencyCode", "currency_code"),
				manager: c.manager ?? c["manager"],
				resourceName: getStr(c, "resourceName", "resource_name"),
			});
		} else {
			accounts.push({
				customerId: cid,
				descriptiveName: null,
				note: "Could not load customer row",
			});
		}
	}
	return accounts;
}

export function dateRangeDuringClause(range: string): string {
	const allowed = new Set([
		"LAST_7_DAYS",
		"LAST_14_DAYS",
		"LAST_30_DAYS",
		"LAST_90_DAYS",
		"THIS_MONTH",
		"LAST_MONTH",
		"THIS_QUARTER",
		"LAST_QUARTER",
		"PREVIOUS_7_DAYS",
		"PREVIOUS_14_DAYS",
		"PREVIOUS_30_DAYS",
	]);
	if (!allowed.has(range)) {
		throw new Error(`Invalid date_range: ${range}. Use a preset like LAST_30_DAYS.`);
	}
	return `segments.date DURING ${range}`;
}

export type ListCustomerClientsOptions = {
	onlyLeafAccounts?: boolean;
	maxRows?: number;
	loginCustomerId?: string;
};

/**
 * Lists accounts linked under an MCC (manager customer_id in URL).
 * Complements listAccessibleCustomers, which often returns fewer "direct" roots.
 */
export async function fetchCustomerClients(
	env: Env,
	accessToken: string,
	managerCustomerId: string,
	options: ListCustomerClientsOptions = {},
): Promise<unknown[]> {
	const cap = Math.min(options.maxRows ?? CUSTOMER_CLIENT_MAX_ROWS, CUSTOMER_CLIENT_MAX_ROWS);
	const fields =
		"customer_client.client_customer, customer_client.level, customer_client.manager, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.id, customer_client.status, customer_client.resource_name";
	let query = `SELECT ${fields} FROM customer_client`;
	if (options.onlyLeafAccounts) {
		query += " WHERE customer_client.manager = FALSE";
	}
	// For `customer_client` we want the authorized context to match the operating manager
	// (the `customers/{managerCustomerId}` URL customer). If the caller doesn't override,
	// default to `managerCustomerId` so `login-customer-id` always stays consistent.
	const streamLogin = options.loginCustomerId?.replace(/\D/g, "")
		? { loginCustomerId: normalizeCustomerId(options.loginCustomerId) }
		: { loginCustomerId: normalizeCustomerId(managerCustomerId) };
	return searchStreamCollect(env, accessToken, normalizeCustomerId(managerCustomerId), query, {
		maxRows: cap,
		...streamLogin,
	});
}

export type ListAccountsMergedOptions = {
	includeCustomerClients: boolean;
	onlyLeafAccounts: boolean;
	managerCustomerId?: string;
	maxClientRows?: number;
	/** login-customer-id for all searchStream calls in this merge (leaf + customer_client). */
	loginCustomerId?: string;
};

export async function listAccountsWithNamesMerged(
	env: Env,
	accessToken: string,
	accessibleResourceNames: string[],
	options: ListAccountsMergedOptions,
): Promise<{
	accounts: Array<Record<string, unknown>>;
	errors: Array<{ customerId?: string; phase: string; message: string }>;
	sources: { accessible_roots: number; customer_client_rows: number; merged_total: number };
}> {
	const errors: Array<{ customerId?: string; phase: string; message: string }> = [];
	const map: MergeAccountMap = new Map();
	const streamLogin =
		options.loginCustomerId != null && options.loginCustomerId !== ""
			? { loginCustomerId: normalizeCustomerId(options.loginCustomerId) }
			: {};

	for (const rn of accessibleResourceNames) {
		let cid: string;
		try {
			cid = customerIdFromResourceName(rn);
		} catch (e) {
			errors.push({
				phase: "parse_resource_name",
				message: e instanceof Error ? e.message : String(e),
			});
			continue;
		}
		try {
			const query =
				"SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager, customer.resource_name FROM customer";
			const rows = await searchStreamCollect(env, accessToken, cid, query, {
				maxRows: 1,
				...streamLogin,
			});
			const parsed = accessibleRowToAccountEntry(cid, rows[0] ?? null);
			if (parsed) map.set(parsed.customerId, parsed.entry);
		} catch (e) {
			errors.push({
				customerId: cid,
				phase: "accessible_customer_row",
				message: e instanceof Error ? e.message : String(e),
			});
			map.set(cid, {
				customerId: cid,
				descriptiveName: null,
				source: "accessible",
				note: "query_failed_see_errors",
			});
		}
	}

	let customer_client_rows = 0;
	if (options.includeCustomerClients) {
		const managerId = options.managerCustomerId
			? normalizeCustomerId(options.managerCustomerId)
			: resolveAdsLoginCustomerId(env);
		try {
			const clientRows = await fetchCustomerClients(env, accessToken, managerId, {
				onlyLeafAccounts: options.onlyLeafAccounts,
				maxRows: options.maxClientRows,
				loginCustomerId: options.loginCustomerId,
			});
			customer_client_rows = clientRows.length;
			mergeClientRowsIntoMap(map, clientRows);
		} catch (e) {
			errors.push({
				customerId: managerId,
				phase: "customer_client",
				message: e instanceof Error ? e.message : String(e),
			});
		}
	}

	const accounts = [...map.values()].sort((a, b) =>
		String(a.customerId ?? "").localeCompare(String(b.customerId ?? "")),
	);
	return {
		accounts,
		errors,
		sources: {
			accessible_roots: accessibleResourceNames.length,
			customer_client_rows,
			merged_total: accounts.length,
		},
	};
}
