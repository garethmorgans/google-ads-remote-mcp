import { describe, expect, it } from "vitest";
import { aggregateCustomerDaily, weightedAvgQualityScore } from "./google-ads-agency-metrics";

describe("aggregateCustomerDaily", () => {
	it("sums micros and computes roas", () => {
		const rows = [
			{
				metrics: {
					impressions: 100,
					clicks: 10,
					costMicros: 5_000_000,
					conversions: 2,
					conversionsValue: 80,
				},
			},
			{
				metrics: {
					impressions: 100,
					clicks: 10,
					costMicros: 5_000_000,
					conversions: 1,
					conversionsValue: 40,
				},
			},
		];
		const s = aggregateCustomerDaily(rows);
		expect(s.impressions).toBe(200);
		expect(s.clicks).toBe(20);
		expect(s.cost_micros).toBe(10_000_000);
		expect(s.conversions).toBe(3);
		expect(s.conversions_value).toBe(120);
		expect(s.roas).toBeCloseTo(12, 5);
	});
});

describe("weightedAvgQualityScore", () => {
	it("returns impression-weighted QS", () => {
		const rows = [
			{ metrics: { qualityScore: 8, impressions: 100 } },
			{ metrics: { qualityScore: 4, impressions: 100 } },
		];
		expect(weightedAvgQualityScore(rows)).toBe(6);
	});

	it("returns null when no data", () => {
		expect(weightedAvgQualityScore([])).toBeNull();
	});
});
