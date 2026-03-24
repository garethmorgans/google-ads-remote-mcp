import { dateRangeDuringClause } from "./google-ads-resolve";

/** Custom calendar range for segments.date */
export function dateBetweenClause(isoStart: string, isoEnd: string): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(isoStart) || !/^\d{4}-\d{2}-\d{2}$/.test(isoEnd)) {
		throw new Error("date_start and date_end must be YYYY-MM-DD");
	}
	return `segments.date BETWEEN '${isoStart}' AND '${isoEnd}'`;
}

export function duringOrBetween(
	dateRange: string | undefined,
	dateStart: string | undefined,
	dateEnd: string | undefined,
): string {
	if (dateStart && dateEnd) return dateBetweenClause(dateStart, dateEnd);
	if (dateRange) return dateRangeDuringClause(dateRange);
	return dateRangeDuringClause("LAST_30_DAYS");
}

export const LIST_CAMPAIGNS_FIELDS = `campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.campaign_budget, campaign.start_date, campaign.end_date, campaign_budget.resource_name, campaign_budget.name, campaign_budget.amount_micros, campaign_budget.status, campaign_budget.period, campaign_budget.delivery_method, campaign_budget.type`;

export function queryListCampaigns(whereChannel?: string): string {
	let q = `SELECT ${LIST_CAMPAIGNS_FIELDS} FROM campaign`;
	const cond: string[] = ["campaign.status != REMOVED"];
	if (whereChannel) cond.push(whereChannel);
	if (cond.length) q += ` WHERE ${cond.join(" AND ")}`;
	return q;
}

export function queryAccountSummary(during: string): string {
	return `SELECT segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.ctr, metrics.average_cpc, metrics.cost_per_conversion, metrics.value_per_conversion FROM customer WHERE ${during}`;
}

export function queryAccountBudgetPacing(during: string): string {
	return `SELECT account_budget.id, account_budget.name, account_budget.status, account_budget.amount_micros, account_budget.adjusted_spending_limit_micros, account_budget.total_adjustments_micros, segments.date, metrics.cost_micros FROM account_budget WHERE ${during}`;
}

export function queryCampaignPerformanceById(campaignId: string, during: string, withIs: boolean): string {
	const base =
		"campaign.id, campaign.name, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.ctr, metrics.conversions, metrics.conversions_value, metrics.average_cpc, metrics.cost_per_conversion";
	const isFields = withIs
		? ", metrics.search_impression_share, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share, metrics.top_impression_percentage, metrics.absolute_top_impression_percentage"
		: "";
	return `SELECT ${base}${isFields} FROM campaign WHERE campaign.id = ${campaignId} AND ${during}`;
}

export function queryCampaignOverview(during: string, orderMetric: "cost_micros" | "conversions"): string {
	const order =
		orderMetric === "conversions" ? "metrics.conversions DESC" : "metrics.cost_micros DESC";
	return `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.ctr, metrics.cost_per_conversion FROM campaign WHERE campaign.status != REMOVED AND ${during} ORDER BY ${order}`;
}

export function queryCampaignBiddingBudget(during: string): string {
	return `SELECT campaign.id, campaign.name, campaign.bidding_strategy_type, campaign.target_cpa_micros, campaign.target_roas, campaign.campaign_budget, campaign_budget.amount_micros, campaign_budget.status, campaign_budget.total_amount_micros, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign WHERE campaign.status != REMOVED AND ${during}`;
}

export function queryCampaignQualityAggregates(during: string): string {
	return `SELECT campaign.id, campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.search_impression_share, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share FROM campaign WHERE campaign.status != REMOVED AND campaign.advertising_channel_type = SEARCH AND ${during}`;
}

/** Keyword-level quality score (for QS averages). */
export function queryKeywordQualityScores(during: string): string {
	return `SELECT campaign.id, campaign.name, metrics.quality_score, metrics.impressions, metrics.clicks FROM keyword_view WHERE metrics.impressions > 0 AND metrics.quality_score > 0 AND ${during}`;
}

export function queryAdGroupsByCampaign(campaignId: string, during: string, withMetrics: boolean): string {
	const base = `ad_group.id, ad_group.name, ad_group.status, ad_group.cpc_bid_micros, campaign.id`;
	const metrics = withMetrics
		? ", metrics.impressions, metrics.clicks, metrics.ctr, metrics.cost_micros, metrics.conversions, metrics.cost_per_conversion"
		: "";
	return `SELECT ${base}${metrics} FROM ad_group WHERE campaign.id = ${campaignId}${withMetrics ? ` AND ${during}` : ""}`;
}

export function queryAdGroupPerformance(adGroupId: string, during: string): string {
	return `SELECT ad_group.id, ad_group.name, campaign.name, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.ctr, metrics.conversions, metrics.conversions_value, metrics.cost_per_conversion FROM ad_group WHERE ad_group.id = ${adGroupId} AND ${during}`;
}

/** Full keyword report with QS and bids */
export function queryKeywordPerformance(campaignId: string, adGroupFilter: string, during: string): string {
	return `SELECT campaign.name, ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.cpc_bid_micros, ad_group_criterion.effective_cpc_bid_micros, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.ctr, metrics.conversions, metrics.quality_score, metrics.historical_quality_score, metrics.search_impression_share, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share FROM keyword_view WHERE campaign.id = ${campaignId}${adGroupFilter} AND ${during}`;
}

export function queryKeywordsByAccount(
	during: string,
	matchTypes: string[] | undefined,
	statusFilter: string | undefined,
	qsMin: number | undefined,
	qsMax: number | undefined,
): string {
	const cond: string[] = [`${during}`];
	if (matchTypes?.length) {
		cond.push(
			`ad_group_criterion.keyword.match_type IN (${matchTypes.join(", ")})`,
		);
	}
	if (statusFilter) {
		cond.push(`ad_group_criterion.status = ${statusFilter}`);
	}
	if (qsMin !== undefined) cond.push(`metrics.quality_score >= ${qsMin}`);
	if (qsMax !== undefined) cond.push(`metrics.quality_score <= ${qsMax}`);
	return `SELECT campaign.name, ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.cpc_bid_micros, metrics.quality_score, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM keyword_view WHERE ${cond.join(" AND ")}`;
}

export function queryLowQualityKeywords(threshold: number, during: string): string {
	return `SELECT campaign.name, ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, metrics.quality_score, metrics.impressions, metrics.clicks, metrics.cost_micros FROM keyword_view WHERE metrics.quality_score < ${threshold} AND metrics.impressions > 0 AND ${during}`;
}

export function querySearchTermsReport(campaignId: string, during: string): string {
	return `SELECT search_term_view.search_term, search_term_view.status, campaign.name, ad_group.name, segments.keyword.info.text, segments.search_term_match_type, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.ctr, metrics.conversions, metrics.conversions_value FROM search_term_view WHERE campaign.id = ${campaignId} AND ${during}`;
}

export function queryAdPerformanceByCampaign(campaignId: string, during: string): string {
	return `SELECT campaign.name, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.policy_summary.approval_status, ad_group_ad.primary_status, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.ctr, metrics.conversions FROM ad_group_ad WHERE campaign.id = ${campaignId} AND ad_group_ad.ad.type = RESPONSIVE_SEARCH_AD AND ${during}`;
}

export function queryAssetPerformance(campaignId: string, during: string): string {
	return `SELECT campaign.name, ad_group.name, asset.id, asset.name, asset.type, ad_group_ad_asset_view.field_type, ad_group_ad_asset_view.performance_label, metrics.impressions, metrics.clicks, metrics.conversions FROM ad_group_ad_asset_view WHERE campaign.id = ${campaignId} AND ${during}`;
}

export function queryResponsiveSearchAdDetails(campaignId: string, adGroupId?: string): string {
	let w = `campaign.id = ${campaignId} AND ad_group_ad.ad.type = RESPONSIVE_SEARCH_AD AND ad_group_ad.status != REMOVED`;
	if (adGroupId) w += ` AND ad_group.id = ${adGroupId}`;
	return `SELECT ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2, ad_group_ad.ad_strength FROM ad_group_ad WHERE ${w}`;
}

export function queryAdStrengthReport(during: string): string {
	return `SELECT campaign.name, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad_strength, metrics.impressions, metrics.clicks FROM ad_group_ad WHERE ad_group_ad.ad.type = RESPONSIVE_SEARCH_AD AND ad_group_ad.status != REMOVED AND ${during}`;
}

export function queryAudiencePerformance(during: string): string {
	return `SELECT campaign.name, campaign_audience_view.bid_modifier, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign_audience_view WHERE ${during}`;
}

export function queryDemographicAge(during: string): string {
	return `SELECT campaign.name, ad_group.name, segments.age_range, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM age_range_view WHERE ${during}`;
}

export function queryDemographicGender(during: string): string {
	return `SELECT campaign.name, ad_group.name, segments.gender, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM gender_view WHERE ${during}`;
}

export function queryDemographicIncome(during: string): string {
	return `SELECT campaign.name, ad_group.name, segments.income_range, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM income_range_view WHERE ${during}`;
}

export function queryDevicePerformance(during: string): string {
	return `SELECT campaign.name, segments.device, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign WHERE ${during}`;
}

export function queryGeographicUserLocation(during: string): string {
	return `SELECT campaign.name, geographic_view.country_criterion_id, geographic_view.location_type, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM geographic_view WHERE ${during}`;
}

export function queryShoppingProductPerformance(during: string): string {
	return `SELECT campaign.name, segments.product_item_id, segments.product_title, segments.product_brand, segments.product_type_l1, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM shopping_performance_view WHERE ${during}`;
}

export function queryPmaxAssetGroupPerformance(during: string): string {
	return `SELECT campaign.name, asset_group.id, asset_group.name, asset_group.status, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM asset_group WHERE campaign.advertising_channel_type = PERFORMANCE_MAX AND asset_group.status != REMOVED AND ${during}`;
}

export function queryPmaxSearchTerms(during: string): string {
	return `SELECT campaign.name, campaign_search_term_view.search_term, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign_search_term_view WHERE campaign.advertising_channel_type = PERFORMANCE_MAX AND ${during}`;
}

export function queryListConversionActions(): string {
	return `SELECT conversion_action.id, conversion_action.name, conversion_action.type, conversion_action.category, conversion_action.status, conversion_action.primary_for_goal, conversion_action.counting_type, conversion_action.value_settings.default_value, conversion_action.click_through_lookback_window_days FROM conversion_action WHERE conversion_action.status != REMOVED`;
}

export function queryConversionPerformanceByCampaign(during: string): string {
	return `SELECT campaign.id, campaign.name, segments.conversion_action_name, segments.conversion_action_category, metrics.conversions, metrics.conversions_value, metrics.cost_micros, metrics.cost_per_conversion, metrics.value_per_conversion FROM campaign WHERE ${during}`;
}

/** Simplified path / attribution proxy (full path reports are limited in GAQL). */
export function queryAttributionSummary(during: string): string {
	return `SELECT segments.date, metrics.conversions, metrics.all_conversions, metrics.view_through_conversions, metrics.cost_micros FROM customer WHERE ${during}`;
}

export function queryAuctionInsights(campaignId: string, during: string): string {
	return `SELECT campaign.name, auction_insight.domain, metrics.impression_share, metrics.overlap_rate, metrics.position_above_rate, metrics.top_impression_percentage, metrics.outranking_share, metrics.search_impression_share FROM auction_insight WHERE campaign.id = ${campaignId} AND ${during}`;
}

export function queryChangeHistoryDuring(dateRange: string, limit: number): string {
	const lim = Math.min(Math.max(1, limit), 10_000);
	return `SELECT change_event.resource_name, change_event.change_date_time, change_event.user_email, change_event.client_type, change_event.change_resource_type, change_event.resource_change_operation, change_event.old_resource, change_event.new_resource FROM change_event WHERE change_event.change_date_time DURING ${dateRange} ORDER BY change_event.change_date_time DESC LIMIT ${lim}`;
}

/** Single-account MCC-style KPI rollup */
export function queryMccKpiChild(during: string): string {
	return `SELECT metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM customer WHERE ${during}`;
}
