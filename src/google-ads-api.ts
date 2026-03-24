/** Central API version for Google Ads REST. */
export const GOOGLE_ADS_API_VERSION = "v21";

const DEFAULT_SEARCH_MAX_ROWS = 10_000;
const RESOLVER_MAX_ROWS = 50;

export type OAuthTokenResponse = {
	access_token: string;
};

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
		"GOOGLE_ADS_LOGIN_CUSTOMER_ID",
		"GOOGLE_ADS_OAUTH_CLIENT_ID",
		"GOOGLE_ADS_OAUTH_CLIENT_SECRET",
		"GOOGLE_ADS_OAUTH_REFRESH_TOKEN",
	] as const;

	for (const key of required) {
		if (!env[key]) {
			throw new Error(`Missing required environment variable: ${key}`);
		}
	}
}

export async function getGoogleAdsAccessToken(env: Env): Promise<string> {
	assertGoogleAdsEnv(env);

	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			client_id: env.GOOGLE_ADS_OAUTH_CLIENT_ID,
			client_secret: env.GOOGLE_ADS_OAUTH_CLIENT_SECRET,
			refresh_token: env.GOOGLE_ADS_OAUTH_REFRESH_TOKEN,
			grant_type: "refresh_token",
		}),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`OAuth token exchange failed (${response.status}): ${text}`);
	}

	const token = (await response.json()) as OAuthTokenResponse;
	if (!token.access_token) {
		throw new Error("OAuth token response did not include access_token");
	}
	return token.access_token;
}

export async function listAccessibleCustomers(
	env: Env,
	accessToken: string,
): Promise<string[]> {
	const url = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers:listAccessibleCustomers`;
	const response = await fetch(url, {
		method: "GET",
		headers: {
			authorization: `Bearer ${accessToken}`,
			"developer-token": env.GOOGLE_ADS_DEVELOPER_TOKEN,
			"login-customer-id": normalizeCustomerId(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
		},
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
};

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
		headers: {
			authorization: `Bearer ${accessToken}`,
			"content-type": "application/json",
			"developer-token": env.GOOGLE_ADS_DEVELOPER_TOKEN,
			"login-customer-id": normalizeCustomerId(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
		},
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
					const msg = JSON.parse(trimmed) as { results?: unknown[] };
					if (Array.isArray(msg.results)) {
						for (const r of msg.results) {
							rows.push(r);
							if (rows.length >= maxRows) return rows;
						}
					}
				} catch {
					// ignore partial line
				}
			}
		}
		if (buffer.trim()) {
			try {
				const msg = JSON.parse(buffer.trim()) as { results?: unknown[] };
				if (Array.isArray(msg.results)) {
					for (const r of msg.results) {
						rows.push(r);
						if (rows.length >= maxRows) return rows;
					}
				}
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
		const msg = JSON.parse(trimmed) as { results?: unknown[] };
		if (Array.isArray(msg.results)) {
			for (const r of msg.results) {
				rows.push(r);
				if (rows.length >= maxRows) break;
			}
		}
	} catch {
		for (const line of trimmed.split("\n")) {
			const t = line.trim();
			if (!t) continue;
			try {
				const msg = JSON.parse(t) as { results?: unknown[] };
				if (Array.isArray(msg.results)) {
					for (const r of msg.results) {
						rows.push(r);
						if (rows.length >= maxRows) return rows;
					}
				}
			} catch {
				// skip
			}
		}
	}
	return rows;
}

export { DEFAULT_SEARCH_MAX_ROWS, RESOLVER_MAX_ROWS };
