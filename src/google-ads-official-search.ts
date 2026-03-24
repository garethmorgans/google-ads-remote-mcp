/**
 * GAQL builder matching google-ads-mcp `search` tool (ads_mcp/tools/search.py).
 * Read-only: caller must run via searchStreamCollect only.
 */

export type OfficialSearchParams = {
	fields: string[];
	resource: string;
	conditions?: string[] | null;
	orderings?: string[] | null;
	limit?: number | string | null;
};

export function buildOfficialSearchGaql(params: OfficialSearchParams): string {
	if (!params.fields.length) {
		throw new Error("search: fields must include at least one GAQL field.");
	}
	const queryParts: string[] = [`SELECT ${params.fields.join(",")} FROM ${params.resource}`];

	if (params.conditions?.length) {
		queryParts.push(` WHERE ${params.conditions.join(" AND ")}`);
	}
	if (params.orderings?.length) {
		queryParts.push(` ORDER BY ${params.orderings.join(",")}`);
	}
	if (params.limit != null && params.limit !== "") {
		queryParts.push(` LIMIT ${params.limit}`);
	}
	queryParts.push(" PARAMETERS omit_unselected_resource_names=true");
	return queryParts.join("");
}
