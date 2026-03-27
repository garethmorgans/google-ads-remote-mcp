import { describe, expect, it } from "vitest";
import { buildOfficialSearchGaql } from "./google-ads-official-search";
import {
	dateBetweenClause,
	duringOrBetween,
	queryCampaignPerformanceById,
	queryLowQualityKeywords,
} from "./google-ads-agency-queries";
import { dateRangeDuringClause } from "./google-ads-resolve";

describe("duringOrBetween", () => {
	it("uses BETWEEN when both dates set", () => {
		expect(duringOrBetween(undefined, "2025-01-01", "2025-01-31")).toBe(
			"segments.date BETWEEN '2025-01-01' AND '2025-01-31'",
		);
	});

	it("uses date_range preset", () => {
		expect(duringOrBetween("LAST_7_DAYS", undefined, undefined)).toBe(
			"segments.date DURING LAST_7_DAYS",
		);
	});

	it("rejects invalid date format", () => {
		expect(() => dateBetweenClause("01-01-2025", "2025-01-31")).toThrow();
	});
});

describe("queryCampaignPerformanceById", () => {
	it("includes impression share fields when requested", () => {
		const q = queryCampaignPerformanceById("42", "segments.date DURING LAST_7_DAYS", true);
		expect(q).toContain("metrics.search_impression_share");
		expect(q).toContain("metrics.search_budget_lost_impression_share");
		expect(q).toContain("campaign.id = 42");
	});
});

describe("queryLowQualityKeywords", () => {
	it("builds threshold filter", () => {
		const q = queryLowQualityKeywords(5, "segments.date DURING LAST_30_DAYS");
		expect(q).toContain("metrics.quality_score < 5");
	});
});

describe("parity with official PARAMETERS", () => {
	it("official search builder still appends omit_unselected", () => {
		const q = buildOfficialSearchGaql({
			fields: ["campaign.id"],
			resource: "campaign",
			conditions: null,
			orderings: null,
			limit: null,
		});
		expect(q.endsWith("PARAMETERS omit_unselected_resource_names=true")).toBe(true);
	});
});

describe("dateRangeDuringClause PREVIOUS", () => {
	it("allows PREVIOUS_7_DAYS", () => {
		expect(dateRangeDuringClause("PREVIOUS_7_DAYS")).toBe(
			"segments.date DURING PREVIOUS_7_DAYS",
		);
	});
});
