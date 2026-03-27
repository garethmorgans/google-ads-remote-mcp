import { getAuthenticatedUserId, getValidAccessToken, type AuthEnv } from "./auth";

/** Central API version for Google Ads REST. */
export const GOOGLE_ADS_API_VERSION = "v21";

/** Default MCC / manager `login-customer-id` when `GOOGLE_ADS_LOGIN_CUSTOMER_ID` is unset. */
export const DEFAULT_ADS_LOGIN_CUSTOMER_ID = "6792590365";

const DEFAULT_SEARCH_MAX_ROWS = 10_000;
const RESOLVER_MAX_ROWS = 50;
/** Cap for customer_client / MCC expansion queries (searchStream). */
export const CUSTOMER_CLIENT_MAX_ROWS = 25_000;

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
	return payload.resourceNames ?? [];
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
	const url = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${normalizeCustomerId(customerId)}/googleAds:searchStream`;

	const response = await fetch(url, {
		method: "POST",
		headers: googleAdsRequestHeaders(env, accessToken, {
			loginCustomerId: options.loginCustomerId,
			contentType: "application/json",
		}),
		body: JSON.stringify({ query }),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Google Ads searchStream failed (${response.status}): ${text}`);
	}

	const rows: unknown[] = [];
	const body = response.body;
	if (!body) {
		const text = await response.text();
		return parseSearchStreamText(text, rows, maxRows);
	}

	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					if (appendSearchStreamRows(JSON.parse(trimmed), rows, maxRows)) return rows;
				} catch {
					// ignore partial line
				}
			}
		}
		if (buffer.trim()) {
			try {
				if (appendSearchStreamRows(JSON.parse(buffer.trim()), rows, maxRows)) return rows;
			} catch {
				// ignore
			}
		}
	} finally {
		reader.releaseLock();
	}

	return rows;
}

function parseSearchStreamText(text: string, rows: unknown[], maxRows: number): unknown[] {
	const trimmed = text.trim();
	if (!trimmed) return rows;
	try {
		appendSearchStreamRows(JSON.parse(trimmed), rows, maxRows);
	} catch {
		for (const line of trimmed.split("\n")) {
			const t = line.trim();
			if (!t) continue;
			try {
				if (appendSearchStreamRows(JSON.parse(t), rows, maxRows)) return rows;
			} catch {
				// skip
			}
		}
	}
	return rows;
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
	if (!Array.isArray(envelope.results)) return rows.length >= maxRows;
	for (const r of envelope.results) {
		rows.push(r);
		if (rows.length >= maxRows) return true;
	}
	return false;
}

export { DEFAULT_SEARCH_MAX_ROWS, RESOLVER_MAX_ROWS };
