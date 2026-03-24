/** Extract numeric metrics from searchStream row (REST uses camelCase). */
export function rowMetrics(row: unknown): Record<string, number> {
	const m = (row as Record<string, unknown>)?.metrics as Record<string, unknown> | undefined;
	if (!m) return {};
	const out: Record<string, number> = {};
	for (const [k, v] of Object.entries(m)) {
		const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
		if (!Number.isNaN(n)) out[k] = n;
	}
	return out;
}

export function num(v: unknown): number {
	if (typeof v === "number") return v;
	if (typeof v === "string") return Number(v) || 0;
	return 0;
}

export function aggregateCustomerDaily(rows: unknown[]): {
	impressions: number;
	clicks: number;
	cost_micros: number;
	conversions: number;
	conversions_value: number;
	ctr: number;
	average_cpc_micros: number;
	cost_per_conversion_micros: number;
	roas: number;
} {
	let impressions = 0;
	let clicks = 0;
	let cost_micros = 0;
	let conversions = 0;
	let conversions_value = 0;
	for (const row of rows) {
		const m = rowMetrics(row);
		impressions += m.impressions ?? 0;
		clicks += m.clicks ?? 0;
		cost_micros += m.costMicros ?? m.cost_micros ?? 0;
		conversions += m.conversions ?? 0;
		conversions_value += m.conversionsValue ?? m.conversions_value ?? 0;
	}
	const ctr = impressions > 0 ? clicks / impressions : 0;
	const average_cpc_micros = clicks > 0 ? cost_micros / clicks : 0;
	const cost_per_conversion_micros = conversions > 0 ? cost_micros / conversions : 0;
	const spend = cost_micros / 1_000_000;
	const roas = spend > 0 ? conversions_value / spend : 0;
	return {
		impressions,
		clicks,
		cost_micros,
		conversions,
		conversions_value,
		ctr,
		average_cpc_micros,
		cost_per_conversion_micros,
		roas,
	};
}

/** Weighted average quality score from keyword_view rows. */
export function weightedAvgQualityScore(rows: unknown[]): number | null {
	let w = 0;
	let sum = 0;
	for (const row of rows) {
		const m = rowMetrics(row);
		const qs = m.qualityScore ?? m.quality_score;
		const imp = m.impressions ?? 0;
		if (qs && imp > 0) {
			sum += qs * imp;
			w += imp;
		}
	}
	if (w === 0) return null;
	return sum / w;
}
