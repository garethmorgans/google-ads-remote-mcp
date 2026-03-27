export interface OAuthTokenRecord {
	accessToken: string;
	refreshToken?: string;
	expiryDate: number;
	scope?: string;
	tokenType?: string;
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export type GoogleOAuthClientEnv = Pick<Env, "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET">;

/** True if Google’s token `scope` string includes Google Ads API (`adwords`). */
export function tokenResponseHasGoogleAdsScope(scope: string | undefined): boolean {
	if (!scope?.trim()) return false;
	return scope.includes("adwords");
}

export async function exchangeAuthCodeForTokens(
	env: GoogleOAuthClientEnv,
	code: string,
	redirectUri: string,
): Promise<OAuthTokenRecord> {
	const body = new URLSearchParams({
		code,
		client_id: env.GOOGLE_CLIENT_ID,
		client_secret: env.GOOGLE_CLIENT_SECRET,
		redirect_uri: redirectUri,
		grant_type: "authorization_code",
	});
	const response = await fetch(GOOGLE_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});
	if (!response.ok) {
		throw new Error(`Google token exchange failed: ${await response.text()}`);
	}

	const json = (await response.json()) as {
		access_token: string;
		refresh_token?: string;
		expires_in: number;
		scope?: string;
		token_type?: string;
	};
	return {
		accessToken: json.access_token,
		refreshToken: json.refresh_token,
		expiryDate: Date.now() + json.expires_in * 1000 - 60_000,
		scope: json.scope,
		tokenType: json.token_type,
	};
}

export async function refreshAccessToken(
	env: GoogleOAuthClientEnv,
	refreshToken: string,
	previousScope?: string,
): Promise<OAuthTokenRecord> {
	const body = new URLSearchParams({
		client_id: env.GOOGLE_CLIENT_ID,
		client_secret: env.GOOGLE_CLIENT_SECRET,
		refresh_token: refreshToken,
		grant_type: "refresh_token",
	});
	const response = await fetch(GOOGLE_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});
	if (!response.ok) {
		throw new Error(`Google token refresh failed: ${await response.text()}`);
	}

	const json = (await response.json()) as {
		access_token: string;
		expires_in: number;
		scope?: string;
		token_type?: string;
	};
	return {
		accessToken: json.access_token,
		refreshToken,
		expiryDate: Date.now() + json.expires_in * 1000 - 60_000,
		scope: json.scope ?? previousScope,
		tokenType: json.token_type,
	};
}

export async function googleApiRequest<T>(
	accessToken: string,
	url: string,
	init?: RequestInit,
): Promise<T> {
	const response = await fetch(url, {
		...init,
		headers: {
			Authorization: `Bearer ${accessToken}`,
			...(init?.headers || {}),
		},
	});
	if (!response.ok) {
		throw new Error(`Google API request failed (${response.status}): ${await response.text()}`);
	}
	return (await response.json()) as T;
}
