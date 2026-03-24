import { describe, expect, it } from "vitest";
import { buildOfficialSearchGaql } from "./google-ads-official-search";

describe("buildOfficialSearchGaql", () => {
	it("matches google-ads-mcp minimal query", () => {
		const q = buildOfficialSearchGaql({
			fields: ["campaign.id", "campaign.name"],
			resource: "campaign",
		});
		expect(q).toBe(
			"SELECT campaign.id,campaign.name FROM campaign PARAMETERS omit_unselected_resource_names=true",
		);
	});

	it("adds WHERE, ORDER BY, LIMIT", () => {
		const q = buildOfficialSearchGaql({
			fields: ["metrics.impressions"],
			resource: "campaign",
			conditions: ["campaign.status = 'ENABLED'", "metrics.impressions > 0"],
			orderings: ["campaign.id"],
			limit: 100,
		});
		expect(q).toContain(" WHERE campaign.status = 'ENABLED' AND metrics.impressions > 0");
		expect(q).toContain(" ORDER BY campaign.id");
		expect(q).toContain(" LIMIT 100");
		expect(q.endsWith("PARAMETERS omit_unselected_resource_names=true")).toBe(true);
	});

	it("string limit", () => {
		const q = buildOfficialSearchGaql({
			fields: ["customer.id"],
			resource: "customer",
			limit: "500",
		});
		expect(q).toContain("LIMIT 500");
	});

	it("throws on empty fields", () => {
		expect(() => buildOfficialSearchGaql({ fields: [], resource: "campaign" })).toThrow();
	});
});
