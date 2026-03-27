import { customerIdFromResourceName } from "./google-ads-api";

export type AccountRow = Record<string, unknown>;

function getNested(obj: unknown, ...path: string[]): unknown {
	let cur: unknown = obj;
	for (const p of path) {
		if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[p];
	}
	return cur;
}

function str(v: unknown): string | undefined {
	if (v === undefined || v === null) return undefined;
	return String(v);
}

/**
 * Parse numeric customer id from customer_client stream row (REST camelCase).
 */
export function clientRowToAccountEntry(
	row: unknown,
): { customerId: string; entry: AccountRow } | null {
	const cc =
		getNested(row, "customerClient") ??
		getNested(row, "customer_client") ??
		(row as Record<string, unknown>)?.customerClient;
	if (!cc || typeof cc !== "object") return null;
	const o = cc as Record<string, unknown>;
	let id = str(o.id)?.replace(/\D/g, "") ?? "";
	const clientCustomer = str(o.clientCustomer ?? o.client_customer);
	if (!id && clientCustomer) {
		const m = clientCustomer.match(/customers\/(\d+)/);
		if (m) id = m[1];
	}
	if (!id) return null;
	const entry: AccountRow = {
		customerId: id,
		descriptiveName: str(o.descriptiveName ?? o.descriptive_name) ?? null,
		currencyCode: str(o.currencyCode ?? o.currency_code) ?? null,
		manager: o.manager ?? o["manager"],
		resourceName: str(o.resourceName ?? o.resource_name),
		clientCustomer,
		status: str(o.status ?? o["status"]),
		level: o.level ?? o["level"],
		source: "customer_client",
	};
	return { customerId: id, entry };
}

export function accessibleRowToAccountEntry(
	customerId: string,
	row: unknown,
): { customerId: string; entry: AccountRow } | null {
	if (row == null) {
		return {
			customerId,
			entry: {
				customerId,
				descriptiveName: null,
				source: "accessible",
				note: "empty row",
			},
		};
	}
	const c =
		getNested(row, "customer") ??
		(row as Record<string, unknown>)?.customer ??
		getNested(row, "customer_client");
	if (!c || typeof c !== "object") {
		return {
			customerId,
			entry: {
				customerId,
				descriptiveName: null,
				source: "accessible",
				note: "Could not load customer row",
			},
		};
	}
	const o = c as Record<string, unknown>;
	return {
		customerId,
		entry: {
			customerId: str(o.id)?.replace(/\D/g, "") || customerId,
			descriptiveName: str(o.descriptiveName ?? o.descriptive_name) ?? null,
			currencyCode: str(o.currencyCode ?? o.currency_code) ?? null,
			manager: o.manager ?? o["manager"],
			resourceName: str(o.resourceName ?? o.resource_name),
			source: "accessible",
		},
	};
}

export type MergeAccountMap = Map<string, AccountRow>;

/**
 * Merge customer_client entries into map, preserving richer accessible data when same id exists.
 */
export function mergeClientRowsIntoMap(map: MergeAccountMap, clientRows: unknown[]): void {
	for (const row of clientRows) {
		const parsed = clientRowToAccountEntry(row);
		if (!parsed) continue;
		const { customerId, entry: clientEntry } = parsed;
		const existing = map.get(customerId);
		if (!existing) {
			map.set(customerId, clientEntry);
			continue;
		}
		const merged: AccountRow = { ...clientEntry, ...existing };
		const prev = existing.source;
		if (prev === "accessible" || prev === "both") merged.source = "both";
		else merged.source = "customer_client";
		if (merged.descriptiveName == null)
			merged.descriptiveName = (existing.descriptiveName ?? clientEntry.descriptiveName) as
				| string
				| null;
		map.set(customerId, merged);
	}
}

export function resourceNameToId(rn: string): string {
	try {
		return customerIdFromResourceName(rn);
	} catch {
		return rn.replace(/\D/g, "");
	}
}
