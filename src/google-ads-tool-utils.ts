import { z } from "zod";

export function textJson(payload: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

export const matchModeSchema = z
	.enum(["exact", "contains"])
	.default("contains")
	.describe(
		"How to match names: 'contains' is best for conversational / fuzzy user input; 'exact' for precise names.",
	);

/** Optional MCC for Google Ads `login-customer-id` (required context when querying leaf accounts under a manager). */
export const loginCustomerIdSchema = z
	.string()
	.optional()
	.describe(
		"Manager/MCC customer ID for the login-customer-id header (digits or dashed). Defaults to GOOGLE_ADS_LOGIN_CUSTOMER_ID secret.",
	);

const dateRangeEnum = z.enum([
	"LAST_7_DAYS",
	"LAST_14_DAYS",
	"LAST_30_DAYS",
	"LAST_90_DAYS",
	"THIS_MONTH",
	"LAST_MONTH",
	"THIS_QUARTER",
	"LAST_QUARTER",
	"PREVIOUS_7_DAYS",
	"PREVIOUS_14_DAYS",
	"PREVIOUS_30_DAYS",
]);

export const dateRangeSchema = dateRangeEnum
	.default("LAST_30_DAYS")
	.describe("Preset date range for metrics (segments.date DURING …).");

/** Optional second range for period-over-period comparisons. */
export const compareDateRangeSchema = dateRangeEnum.optional();

export const maxRowsSchema = (cap: number, defaultVal: number) =>
	z
		.number()
		.int()
		.positive()
		.max(cap)
		.optional()
		.describe(`Max rows (default ${defaultVal}, cap ${cap}).`);
