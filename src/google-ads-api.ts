import { getAuthenticatedUserId, getValidAccessToken, type AuthEnv } from "./auth";

/** Central API version for Google Ads REST. */
export const GOOGLE_ADS_API_VERSION = "v21";

/** Default MCC / manager `login-customer-id` when `GOOGLE_ADS_LOGIN_CUSTOMER_ID` is unset. */
export const DEFAULT_ADS_LOGIN_CUSTOMER_ID = "6792590365";

const DEFAULT_SEARCH_MAX_ROWS = 10_000;
/** Cap for customer_client / MCC expansion queries (searchStream). */
export const CUSTOMER_CLIENT_MAX_ROWS = 25_000;

/** Max characters of raw response body to log when `GOOGLE_ADS_DEBUG` is on and parsing yields 0 rows. */
const SEARCH_STREAM_RAW_PREVIEW_MAX = 12_000;

export function isGoogleAdsDebugEnabled(env: Env): boolean {
	const v = env.GOOGLE_ADS_DEBUG?.toLowerCase().trim();
	return v === "1" || v === "true" || v === "yes";
}

function adsDebug(env: Env, message: string, data?: Record<string, unknown>): void {
	if (!isGoogleAdsDebugEnabled(env)) return;
	// Single string so Cloudflare Workers logs / tail show the full payload (multi-arg often loses objects in the UI).
	if (data !== undefined) {
		console.warn(`[google-ads-api] ${message} ${JSON.stringify(data)}`);
	} else {
		console.warn(`[google-ads-api] ${message}`);
	}
}

/** Google Ads API returns request id in headers (casing varies by layer). */
function responseRequestId(response: Response): string | undefined {
	return (
		response.headers.get("request-id") ??
		response.headers.get("Request-Id") ??
		response.headers.get("x-request-id") ??
		undefined
	);
}

export type ListAccessibleCustomersResponse = {
	resourceNames: string[];
};

export function normalizeCustomerId(customerId: string): string {
	return customerId.replaceAll("-", "").trim();
}

export function customerIdFromResourceName(resourceName: string): string {
	const m = resourceName.match(/customers\/(\d+)/);
	if (!m) throw new Error(`Invalid customer resource name: ${resourceName}`);
	return m[1];
}

export function assertGoogleAdsEnv(env: Env): void {
	const required = [
		"GOOGLE_ADS_DEVELOPER_TOKEN",
		"GOOGLE_CLIENT_ID",
		"GOOGLE_CLIENT_SECRET",
	] as const;

	for (const key of required) {
		if (!env[key]) {
			throw new Error(`Missing required environment variable: ${key}`);
		}
	}
}

/** Access token for Google Ads API using the connected user’s OAuth (KV-backed refresh). */
export async function getGoogleAdsAccessTokenForUser(env: Env, userId: string): Promise<string> {
	assertGoogleAdsEnv(env);
	return getValidAccessToken(env as AuthEnv, userId);
}

/** Resolves MCP user from context (and optional DO props fallback) and returns a fresh Ads access token. */
export async function getGoogleAdsAccessTokenFromContext(
	env: Env,
	resolveUserId?: () => string | undefined,
): Promise<string> {
	const userId = getAuthenticatedUserId(resolveUserId);
	return getGoogleAdsAccessTokenForUser(env, userId);
}

export type ListAccessibleCustomersOptions = {
	/** Manager/MCC ID for login-customer-id when disambiguating access (defaults to GOOGLE_ADS_LOGIN_CUSTOMER_ID). */
	loginCustomerId?: string;
};

/** Optional third argument for listAccessibleCustomers from an MCP override. */
export function listAccessibleLoginOptions(
	loginCustomerIdOverride?: string,
): ListAccessibleCustomersOptions | undefined {
	if (!loginCustomerIdOverride?.replace(/\D/g, "")) return undefined;
	return { loginCustomerId: normalizeCustomerId(loginCustomerIdOverride) };
}

/**
 * Effective `login-customer-id` (digits only). Per [Google’s call-structure docs](https://developers.google.com/google-ads/api/docs/concepts/call-structure#cid),
 * this must be the manager when accessing a client account under MCC.
 *
 * Tool override wins only when it contains at least one digit; empty string does not mask env/default
 * (avoids sending a blank header).
 *
 * When `GOOGLE_ADS_LOGIN_CUSTOMER_ID` is unset, uses {@link DEFAULT_ADS_LOGIN_CUSTOMER_ID}.
 */
export function resolveAdsLoginCustomerId(env: Env, override?: string | null): string {
	if (override != null && /\d/.test(override)) {
		return normalizeCustomerId(override);
	}
	const fromEnv = normalizeCustomerId(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ?? "");
	if (fromEnv) return fromEnv;
	return DEFAULT_ADS_LOGIN_CUSTOMER_ID;
}

/**
 * Headers for Google Ads REST calls. `login-customer-id` must be the manager when accessing client accounts under MCC.
 */
export function googleAdsRequestHeaders(
	env: Env,
	accessToken: string,
	options: { loginCustomerId?: string; contentType?: string } = {},
): Record<string, string> {
	const loginId = resolveAdsLoginCustomerId(env, options.loginCustomerId);
	const headers: Record<string, string> = {
		authorization: `Bearer ${accessToken}`,
		"developer-token": env.GOOGLE_ADS_DEVELOPER_TOKEN,
		"login-customer-id": loginId,
	};
	if (options.contentType) {
		headers["content-type"] = options.contentType;
	}
	return headers;
}

export async function listAccessibleCustomers(
	env: Env,
	accessToken: string,
	options?: ListAccessibleCustomersOptions,
): Promise<string[]> {
	const url = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers:listAccessibleCustomers`;
	adsDebug(env, "listAccessibleCustomers request", {
		url,
		loginCustomerId: resolveAdsLoginCustomerId(env, options?.loginCustomerId),
	});
	const response = await fetch(url, {
		method: "GET",
		headers: googleAdsRequestHeaders(env, accessToken, {
			loginCustomerId: options?.loginCustomerId,
		}),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Google Ads API request failed (${response.status}): ${text}`);
	}

	const payload = (await response.json()) as ListAccessibleCustomersResponse;
	const names = payload.resourceNames ?? [];
	adsDebug(env, "listAccessibleCustomers ok", {
		status: response.status,
		requestId: responseRequestId(response),
		count: names.length,
		sample: names.slice(0, 8),
	});
	return names;
}

/** Escape single quotes for GAQL string literals. */
export function escapeGaqlString(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

export type SearchStreamOptions = {
	maxRows?: number;
	/** Override login-customer-id (MCC) for this request; defaults to GOOGLE_ADS_LOGIN_CUSTOMER_ID. */
	loginCustomerId?: string;
};

/** Merge optional MCC override into searchStream options (digits-only header value). */
export function mergeSearchStreamOptions(
	base: SearchStreamOptions,
	loginCustomerIdOverride?: string,
): SearchStreamOptions {
	const out = { ...base };
	if (loginCustomerIdOverride?.replace(/\D/g, "")) {
		out.loginCustomerId = normalizeCustomerId(loginCustomerIdOverride);
	}
	return out;
}

/**
 * Collect rows from googleAds:searchStream (streaming JSON chunks).
 * Caps at maxRows (default DEFAULT_SEARCH_MAX_ROWS).
 */
export async function searchStreamCollect(
	env: Env,
	accessToken: string,
	customerId: string,
	query: string,
	options: SearchStreamOptions = {},
): Promise<unknown[]> {
	const maxRows = options.maxRows ?? DEFAULT_SEARCH_MAX_ROWS;
	const cid = normalizeCustomerId(customerId);
	const url = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${cid}/googleAds:searchStream`;
	const loginResolved = resolveAdsLoginCustomerId(env, options.loginCustomerId);

	adsDebug(env, "searchStream request", {
		url,
		customerId: cid,
		loginCustomerId: loginResolved,
		maxRows,
		queryLength: query.length,
		queryPreview: query.length > 500 ? `${query.slice(0, 500)}…` : query,
	});

	const response = await fetch(url, {
		method: "POST",
		headers: googleAdsRequestHeaders(env, accessToken, {
			loginCustomerId: options.loginCustomerId,
			contentType: "application/json",
		}),
		body: JSON.stringify({ query }),
	});

	const requestId = responseRequestId(response);
	adsDebug(env, "searchStream response headers", {
		ok: response.ok,
		status: response.status,
		contentType: response.headers.get("content-type") ?? undefined,
		requestId,
	});

	if (!response.ok) {
		const text = await response.text();
		console.warn(
			`[google-ads-api] searchStream HTTP error ${JSON.stringify({
				status: response.status,
				requestId,
				bodyPreview: text.slice(0, 2000),
			})}`,
		);
		throw new Error(`Google Ads searchStream failed (${response.status}): ${text}`);
	}

	const rows: unknown[] = [];
	const body = response.body;
	if (!body) {
		const text = await response.text();
		adsDebug(env, "searchStream body was null; using response.text()", {
			textLength: text.length,
			textPreview: text.slice(0, 800),
		});
		const out = parseSearchStreamText(env, text, rows, maxRows, requestId);
		logSearchStreamOutcome(env, {
			customerId: cid,
			requestId,
			rowCount: out.length,
			parseContext: "noReadableBody",
		});
		return out;
	}

	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let totalBytes = 0;
	let nonemptyLineCount = 0;
	let jsonParseFailures = 0;
	let firstInvalidLine: string | undefined;
	let firstParsedValue: unknown;
	let rawPreview = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				totalBytes += value.byteLength;
				const chunk = decoder.decode(value, { stream: true });
				if (rawPreview.length < SEARCH_STREAM_RAW_PREVIEW_MAX) {
					rawPreview += chunk.slice(0, SEARCH_STREAM_RAW_PREVIEW_MAX - rawPreview.length);
				}
				buffer += chunk;
			}
		}
	} finally {
		reader.releaseLock();
	}

	// Google Ads REST often returns pretty-printed JSON arrays for searchStream.
	// Parse the full buffered payload first; fallback logic inside parseSearchStreamText
	// handles NDJSON/newline variants.
	const trimmed = buffer.trim();
	if (trimmed) {
		nonemptyLineCount = trimmed.split("\n").filter((line) => line.trim().length > 0).length;
		try {
			const parsed = JSON.parse(trimmed);
			firstParsedValue = parsed;
			appendSearchStreamRows(parsed, rows, maxRows);
		} catch {
			jsonParseFailures = 1;
			firstInvalidLine = trimmed.slice(0, 400);
			parseSearchStreamText(env, trimmed, rows, maxRows, requestId);
		}
	}

	logSearchStreamOutcome(env, {
		customerId: cid,
		requestId,
		rowCount: rows.length,
		parseContext: "streamComplete",
		totalBytes,
		nonemptyLineCount,
		jsonParseFailures,
		firstInvalidLine,
		firstParsedTopKeys:
			firstParsedValue !== undefined && typeof firstParsedValue === "object" && firstParsedValue !== null
				? Object.keys(firstParsedValue as object).slice(0, 25)
				: firstParsedValue === undefined
					? undefined
					: typeof firstParsedValue,
		rawPreview: rows.length === 0 ? rawPreview : undefined,
	});

	return rows;
}

function logSearchStreamOutcome(
	env: Env,
	info: {
		customerId: string;
		requestId?: string;
		rowCount: number;
		parseContext: string;
		totalBytes?: number;
		nonemptyLineCount?: number;
		jsonParseFailures?: number;
		firstInvalidLine?: string;
		firstParsedTopKeys?: string[] | string;
		rawPreview?: string;
	},
): void {
	if (!isGoogleAdsDebugEnabled(env)) return;
	const base: Record<string, unknown> = {
		customerId: info.customerId,
		requestId: info.requestId,
		rowCount: info.rowCount,
		parseContext: info.parseContext,
	};
	if (info.totalBytes !== undefined) base.totalBytesDecoded = info.totalBytes;
	if (info.nonemptyLineCount !== undefined) base.nonemptyJsonLines = info.nonemptyLineCount;
	if (info.jsonParseFailures !== undefined) base.jsonParseFailures = info.jsonParseFailures;
	if (info.firstInvalidLine !== undefined) base.firstInvalidLineSample = info.firstInvalidLine;
	if (info.firstParsedTopKeys !== undefined) base.firstParsedValueKeysOrType = info.firstParsedTopKeys;
	console.warn(`[google-ads-api] searchStream parse summary ${JSON.stringify(base)}`);
	if (info.rowCount === 0 && info.rawPreview !== undefined && info.rawPreview.length > 0) {
		console.warn(
			`[google-ads-api] searchStream raw body preview (empty parse) ${JSON.stringify({
				length: info.rawPreview.length,
				preview: info.rawPreview.slice(0, SEARCH_STREAM_RAW_PREVIEW_MAX),
			})}`,
		);
	}
}

function parseSearchStreamText(
	env: Env,
	text: string,
	rows: unknown[],
	maxRows: number,
	requestId?: string,
): unknown[] {
	const trimmed = text.trim();
	if (!trimmed) {
		adsDebug(env, "parseSearchStreamText: empty body text", { requestId });
		return rows;
	}
	try {
		appendSearchStreamRows(JSON.parse(trimmed), rows, maxRows);
	} catch {
		for (const line of trimmed.split("\n")) {
			const t = line.trim();
			if (!t) continue;
			try {
				if (appendSearchStreamRows(JSON.parse(t), rows, maxRows)) break;
			} catch {
				// skip
			}
		}
	}
	return rows;
}

/** Chunks that are not GoogleAdsRow payloads (REST stream metadata). */
const STREAM_METADATA_KEYS = new Set([
	"fieldMask",
	"requestId",
	"queryResourceConsumption",
	"summaryRow",
	"metricAttributes",
]);

function looksLikeGoogleAdsRowChunk(obj: Record<string, unknown>): boolean {
	const keys = Object.keys(obj).filter((k) => !STREAM_METADATA_KEYS.has(k));
	if (keys.length === 0) return false;
	// Bare row: at least one nested message (resource or metrics) from the SELECT.
	for (const k of keys) {
		const v = obj[k];
		if (v !== null && typeof v === "object") return true;
	}
	return false;
}

function appendSearchStreamRows(parsed: unknown, rows: unknown[], maxRows: number): boolean {
	// REST searchStream wraps chunks in a JSON array, e.g. [{ results: [...] }, ...].
	if (Array.isArray(parsed)) {
		for (const item of parsed) {
			if (appendSearchStreamRows(item, rows, maxRows)) return true;
		}
		return rows.length >= maxRows;
	}
	if (!parsed || typeof parsed !== "object") return rows.length >= maxRows;
	const envelope = parsed as { results?: unknown[] };
	if (Array.isArray(envelope.results)) {
		for (const r of envelope.results) {
			rows.push(r);
			if (rows.length >= maxRows) return true;
		}
		return false;
	}
	// Some streams emit a bare GoogleAdsRow per line (not wrapped in `results`).
	if (looksLikeGoogleAdsRowChunk(envelope as Record<string, unknown>)) {
		rows.push(envelope);
		return rows.length >= maxRows;
	}
	return false;
}

export type ListCustomerClientsOptions = {
	onlyLeafAccounts?: boolean;
	maxRows?: number;
	loginCustomerId?: string;
};

/**
 * Lists accounts linked under an MCC (manager customer_id in URL path).
 * Complements listAccessibleCustomers, which often returns fewer direct roots.
 */
export async function fetchCustomerClients(
	env: Env,
	accessToken: string,
	managerCustomerId: string,
	options: ListCustomerClientsOptions = {},
): Promise<unknown[]> {
	const cap = Math.min(options.maxRows ?? CUSTOMER_CLIENT_MAX_ROWS, CUSTOMER_CLIENT_MAX_ROWS);
	const fields =
		"customer_client.client_customer, customer_client.level, customer_client.manager, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.id, customer_client.status, customer_client.resource_name";
	// Match Google’s hierarchy examples: direct links under this manager (level 0 = root, 1 = children).
	let query = `SELECT ${fields} FROM customer_client WHERE customer_client.level <= 1`;
	if (options.onlyLeafAccounts) {
		query += " AND customer_client.manager = FALSE";
	}
	const streamLogin = options.loginCustomerId?.replace(/\D/g, "")
		? { loginCustomerId: normalizeCustomerId(options.loginCustomerId) }
		: { loginCustomerId: normalizeCustomerId(managerCustomerId) };
	adsDebug(env, "fetchCustomerClients GAQL", {
		managerCustomerId: normalizeCustomerId(managerCustomerId),
		query,
		streamLoginCustomerId: streamLogin.loginCustomerId,
	});
	return searchStreamCollect(env, accessToken, normalizeCustomerId(managerCustomerId), query, {
		maxRows: cap,
		...streamLogin,
	});
}

export { DEFAULT_SEARCH_MAX_ROWS };
