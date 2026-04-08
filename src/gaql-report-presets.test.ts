import { describe, expect, it } from "vitest";
import {
	buildAccountMetricsQuery,
	buildCampaignMetricsQuery,
	buildChangeEventsQuery,
	changeEventDateBoundsUtc,
} from "./gaql-report-presets";

describe("gaql-report-presets", () => {
	it("buildAccountMetricsQuery uses segments.date DURING", () => {
		const q = buildAccountMetricsQuery("LAST_7_DAYS");
		expect(q).toContain("FROM customer");
		expect(q).toContain("segments.date DURING LAST_7_DAYS");
	});

	it("buildCampaignMetricsQuery excludes removed campaigns by default", () => {
		const q = buildCampaignMetricsQuery({ dateRange: "LAST_30_DAYS" });
		expect(q).toContain("campaign.status != 'REMOVED'");
		expect(q).toContain("FROM campaign");
	});

	it("buildCampaignMetricsQuery filters by campaign id when provided", () => {
		const q = buildCampaignMetricsQuery({
			dateRange: "LAST_30_DAYS",
			campaignId: "12345",
		});
		expect(q).toContain("campaign.id = 12345");
	});

	it("buildChangeEventsQuery uses explicit change_date_time bounds and LIMIT", () => {
		const q = buildChangeEventsQuery({ dateRange: "LAST_7_DAYS", limit: 100 });
		expect(q).toContain("FROM change_event");
		expect(q).toContain("change_event.change_date_time >=");
		expect(q).toContain("change_event.change_date_time <=");
		expect(q).toContain("LIMIT 100");
	});

	it("changeEventDateBoundsUtc returns start <= end for LAST_7_DAYS", () => {
		const { start, end } = changeEventDateBoundsUtc("LAST_7_DAYS");
		expect(start.length).toBe(10);
		expect(end.length).toBe(10);
		expect(start <= end).toBe(true);
	});
});
