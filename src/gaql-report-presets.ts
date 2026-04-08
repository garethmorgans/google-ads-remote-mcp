/**
 * Typed GAQL builders for read-only reporting presets (Google Ads API v21).
 * All user-controlled strings are kept to enums; use {@link escapeGaqlString} if adding literals later.
 */

import { escapeGaqlString } from "./google-ads-api";

/** Preset ranges for `segments.date DURING ...` */
export const DATE_RANGE_DURING = [
	"LAST_7_DAYS",
	"LAST_14_DAYS",
	"LAST_30_DAYS",
	"THIS_MONTH",
	"LAST_MONTH",
	"LAST_BUSINESS_WEEK",
] as const;
export type DateRangeDuring = (typeof DATE_RANGE_DURING)[number];

export const SEARCH_TERM_DEFAULT_MAX_ROWS = 5_000;

function segmentsDuring(range: DateRangeDuring): string {
	return `segments.date DURING ${range}`;
}

/** Core performance metrics + date segment (time series). */
const METRICS_CORE = [
	"metrics.impressions",
	"metrics.clicks",
	"metrics.ctr",
	"metrics.cost_micros",
	"metrics.average_cpc",
	"metrics.conversions",
	"metrics.conversions_value",
	"metrics.all_conversions",
].join(",\n  ");

export function buildGetCustomerQuery(): string {
	return `SELECT
  customer.id,
  customer.resource_name,
  customer.descriptive_name,
  customer.currency_code,
  customer.time_zone,
  customer.test_account,
  customer.auto_tagging_enabled,
  customer.manager,
  customer.optimization_score,
  customer.optimization_score_weight
FROM customer
LIMIT 1`;
}

export function buildAccountMetricsQuery(dateRange: DateRangeDuring): string {
	return `SELECT
  customer.id,
  ${METRICS_CORE},
  segments.date
FROM customer
WHERE ${segmentsDuring(dateRange)}
ORDER BY segments.date DESC`;
}

export type CampaignMetricsOptions = {
	dateRange: DateRangeDuring;
	/** When set, restrict to this campaign id */
	campaignId?: string;
	/** When set, filter campaign.status */
	campaignStatus?: "ENABLED" | "PAUSED" | "REMOVED";
};

export function buildCampaignMetricsQuery(opts: CampaignMetricsOptions): string {
	const where: string[] = [segmentsDuring(opts.dateRange)];
	if (opts.campaignId?.replace(/\D/g, "")) {
		where.push(`campaign.id = ${opts.campaignId.replace(/\D/g, "")}`);
	}
	if (opts.campaignStatus) {
		where.push(`campaign.status = '${opts.campaignStatus}'`);
	} else {
		where.push(`campaign.status != 'REMOVED'`);
	}
	return `SELECT
  campaign.id,
  campaign.name,
  campaign.status,
  campaign.advertising_channel_type,
  ${METRICS_CORE},
  segments.date
FROM campaign
WHERE ${where.join(" AND ")}
ORDER BY metrics.cost_micros DESC, campaign.id, segments.date DESC`;
}

export type AdGroupMetricsOptions = {
	dateRange: DateRangeDuring;
	campaignId?: string;
	adGroupId?: string;
};

export function buildAdGroupMetricsQuery(opts: AdGroupMetricsOptions): string {
	const where: string[] = [segmentsDuring(opts.dateRange), `campaign.status != 'REMOVED'`, `ad_group.status != 'REMOVED'`];
	if (opts.campaignId?.replace(/\D/g, "")) {
		where.push(`campaign.id = ${opts.campaignId.replace(/\D/g, "")}`);
	}
	if (opts.adGroupId?.replace(/\D/g, "")) {
		where.push(`ad_group.id = ${opts.adGroupId.replace(/\D/g, "")}`);
	}
	return `SELECT
  campaign.id,
  campaign.name,
  ad_group.id,
  ad_group.name,
  ad_group.status,
  ${METRICS_CORE},
  segments.date
FROM ad_group
WHERE ${where.join(" AND ")}
ORDER BY metrics.cost_micros DESC, ad_group.id, segments.date DESC`;
}

export type KeywordMetricsOptions = {
	dateRange: DateRangeDuring;
	campaignId?: string;
	adGroupId?: string;
};

export function buildKeywordMetricsQuery(opts: KeywordMetricsOptions): string {
	const where: string[] = [
		segmentsDuring(opts.dateRange),
		`campaign.status != 'REMOVED'`,
		`ad_group.status != 'REMOVED'`,
		`ad_group_criterion.status != 'REMOVED'`,
	];
	if (opts.campaignId?.replace(/\D/g, "")) {
		where.push(`campaign.id = ${opts.campaignId.replace(/\D/g, "")}`);
	}
	if (opts.adGroupId?.replace(/\D/g, "")) {
		where.push(`ad_group.id = ${opts.adGroupId.replace(/\D/g, "")}`);
	}
	return `SELECT
  campaign.id,
  campaign.name,
  ad_group.id,
  ad_group.name,
  ad_group_criterion.resource_name,
  ad_group_criterion.keyword.text,
  ad_group_criterion.keyword.match_type,
  ad_group_criterion.status,
  ${METRICS_CORE},
  segments.date
FROM keyword_view
WHERE ${where.join(" AND ")}
ORDER BY metrics.impressions DESC, campaign.id, ad_group.id, segments.date DESC`;
}

export type SearchTermsOptions = {
	dateRange: DateRangeDuring;
	campaignId?: string;
};

export function buildSearchTermsQuery(opts: SearchTermsOptions): string {
	const where: string[] = [segmentsDuring(opts.dateRange), `campaign.status != 'REMOVED'`];
	if (opts.campaignId?.replace(/\D/g, "")) {
		where.push(`campaign.id = ${opts.campaignId.replace(/\D/g, "")}`);
	}
	return `SELECT
  campaign.id,
  campaign.name,
  ad_group.id,
  ad_group.name,
  search_term_view.search_term,
  search_term_view.status,
  ${METRICS_CORE},
  segments.date
FROM search_term_view
WHERE ${where.join(" AND ")}
ORDER BY metrics.impressions DESC, segments.date DESC`;
}

export type ListAdsOptions = {
	onlyResponsiveSearchAds?: boolean;
};

export function buildListAdsQuery(opts: ListAdsOptions): string {
	const where = [`ad_group_ad.status != 'REMOVED'`, `campaign.status != 'REMOVED'`, `ad_group.status != 'REMOVED'`];
	if (opts.onlyResponsiveSearchAds) {
		where.push(`ad_group_ad.ad.type = RESPONSIVE_SEARCH_AD`);
	}
	return `SELECT
  campaign.id,
  campaign.name,
  ad_group.id,
  ad_group.name,
  ad_group_ad.resource_name,
  ad_group_ad.status,
  ad_group_ad.ad.id,
  ad_group_ad.ad.name,
  ad_group_ad.ad.type,
  ad_group_ad.ad.final_urls
FROM ad_group_ad
WHERE ${where.join(" AND ")}
ORDER BY campaign.name, ad_group.name, ad_group_ad.ad.id`;
}

export function buildListConversionActionsQuery(): string {
	return `SELECT
  conversion_action.id,
  conversion_action.name,
  conversion_action.status,
  conversion_action.type,
  conversion_action.category,
  conversion_action.origin,
  conversion_action.counting_type,
  conversion_action.primary_for_goal,
  conversion_action.click_through_lookback_window_days,
  conversion_action.view_through_lookback_window_days
FROM conversion_action
WHERE conversion_action.status != 'REMOVED'
ORDER BY conversion_action.name`;
}

export function buildDeviceSegmentMetricsQuery(dateRange: DateRangeDuring): string {
	return `SELECT
  campaign.id,
  campaign.name,
  segments.device,
  metrics.impressions,
  metrics.clicks,
  metrics.ctr,
  metrics.cost_micros,
  metrics.conversions,
  metrics.conversions_value,
  segments.date
FROM campaign
WHERE ${segmentsDuring(dateRange)} AND campaign.status != 'REMOVED'
ORDER BY campaign.id, segments.date, segments.device`;
}

export function buildGeoMetricsQuery(dateRange: DateRangeDuring): string {
	return `SELECT
  campaign.id,
  campaign.name,
  geographic_view.country_criterion_id,
  geographic_view.location_type,
  metrics.impressions,
  metrics.clicks,
  metrics.cost_micros,
  metrics.conversions,
  segments.date
FROM geographic_view
WHERE ${segmentsDuring(dateRange)} AND campaign.status != 'REMOVED'
ORDER BY metrics.cost_micros DESC, campaign.id, segments.date DESC`;
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

function formatYmdUtc(d: Date): string {
	return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * `change_event.change_date_time` does not use `segments.date DURING`;
 * use an explicit inclusive date window (UTC calendar dates).
 */
export function changeEventDateBoundsUtc(during: DateRangeDuring): { start: string; end: string } {
	const end = new Date();
	const endDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
	let startDay: Date;

	switch (during) {
		case "LAST_7_DAYS":
			startDay = new Date(endDay);
			startDay.setUTCDate(startDay.getUTCDate() - 6);
			break;
		case "LAST_14_DAYS":
			startDay = new Date(endDay);
			startDay.setUTCDate(startDay.getUTCDate() - 13);
			break;
		case "LAST_30_DAYS":
			startDay = new Date(endDay);
			startDay.setUTCDate(startDay.getUTCDate() - 29);
			break;
		case "LAST_BUSINESS_WEEK":
			startDay = new Date(endDay);
			startDay.setUTCDate(startDay.getUTCDate() - 6);
			break;
		case "THIS_MONTH": {
			startDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
			break;
		}
		case "LAST_MONTH": {
			const firstThis = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
			const lastPrev = new Date(firstThis);
			lastPrev.setUTCDate(0);
			startDay = new Date(Date.UTC(lastPrev.getUTCFullYear(), lastPrev.getUTCMonth(), 1));
			const endLastMonth = lastPrev;
			return { start: formatYmdUtc(startDay), end: formatYmdUtc(endLastMonth) };
		}
		default:
			startDay = new Date(endDay);
			startDay.setUTCDate(startDay.getUTCDate() - 29);
	}
	return { start: formatYmdUtc(startDay), end: formatYmdUtc(endDay) };
}

export function buildChangeEventsQuery(params: {
	dateRange: DateRangeDuring;
	limit: number;
}): string {
	const { start, end } = changeEventDateBoundsUtc(params.dateRange);
	const lim = Math.min(Math.max(1, params.limit), 10_000);
	// change_event requires explicit change_date_time window (not segments.date).
	return `SELECT
  change_event.resource_name,
  change_event.change_date_time,
  change_event.change_resource_name,
  change_event.user_email,
  change_event.client_type,
  change_event.change_resource_type,
  change_event.resource_change_operation,
  change_event.changed_fields
FROM change_event
WHERE change_event.change_date_time >= '${escapeGaqlString(start)}' AND change_event.change_date_time <= '${escapeGaqlString(end)}'
ORDER BY change_event.change_date_time DESC
LIMIT ${lim}`;
}

export function buildListCampaignBudgetsQuery(): string {
	return `SELECT
  campaign.id,
  campaign.name,
  campaign.status,
  campaign_budget.resource_name,
  campaign_budget.name,
  campaign_budget.amount_micros,
  campaign_budget.delivery_method,
  campaign_budget.period,
  campaign_budget.type,
  campaign_budget.status
FROM campaign_budget
WHERE campaign_budget.status != 'REMOVED'
ORDER BY campaign.name`;
}
