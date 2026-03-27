import { describe, expect, it } from "vitest";
import { nameWhereClause, wrapResolve } from "./google-ads-resolve";

describe("nameWhereClause", () => {
	it("builds exact match", () => {
		expect(nameWhereClause("campaign.name", "Summer", "exact")).toBe(
			"campaign.name = 'Summer'",
		);
	});

	it("builds contains with escaped quotes", () => {
		expect(nameWhereClause("campaign.name", "Joe's", "contains")).toBe(
			"campaign.name LIKE '%Joe\\'s%'",
		);
	});
});

describe("wrapResolve", () => {
	it("marks multiple matches", () => {
		const p = wrapResolve("campaign", [{ campaignId: "1" }, { campaignId: "2" }]);
		expect(p.match_count).toBe(2);
		expect(p.message).toContain("Multiple matches");
	});

	it("marks zero matches", () => {
		const p = wrapResolve("customer", []);
		expect(p.match_count).toBe(0);
		expect(p.message).toContain("No match");
	});
});
