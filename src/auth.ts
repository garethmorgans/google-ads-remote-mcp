import { getMcpAuthContext } from "agents/mcp";
import {
	googleApiRequest,
	type OAuthTokenRecord,
	refreshAccessToken,
	type GoogleOAuthClientEnv,
} from "./google-token";

export const GOOGLE_TOKEN_PREFIX = "google-token:";

export type AuthEnv = Pick<Env, "GOOGLE_AUTH_KV" | "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET">;

/** Stable Google user id for KV keys (OIDC `sub`, or tokeninfo fallback). */
export async function resolveGoogleUserId(accessToken: string): Promise<string> {
	try {
		const profile = await googleApiRequest<{ sub: string }>(
			accessToken,
			"https://openidconnect.googleapis.com/v1/userinfo",
		);
		if (profile.sub) return profile.sub;
	} catch {
		// Fall through to token introspection for non-openid responses.
	}

	const response = await fetch(
		`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
	);
	if (!response.ok) {
		throw new Error(
			`Unable to resolve Google user identity from tokeninfo: ${await response.text()}`,
		);
	}
	const payload = (await response.json()) as { sub?: string; user_id?: string };
	if (payload.sub) return payload.sub;
	if (payload.user_id) return payload.user_id;

	throw new Error("Unable to resolve Google user identity: missing sub/user_id.");
}

export function getAuthenticatedUserId(fallbackResolver?: () => string | undefined): string {
	const ctx = getMcpAuthContext();
	const userId =
		(ctx as { props?: { userId?: string }; userId?: string } | undefined)?.props?.userId ??
		(ctx as { userId?: string } | undefined)?.userId ??
		fallbackResolver?.();
	if (!userId) {
		throw new Error("Missing authenticated user context.");
	}
	return userId;
}

export async function getValidAccessToken(env: AuthEnv, userId: string): Promise<string> {
	const raw = await env.GOOGLE_AUTH_KV.get(`${GOOGLE_TOKEN_PREFIX}${userId}`);
	if (!raw) {
		throw new Error("No Google token found for authenticated user. Use Claude Connect first.");
	}

	let token = JSON.parse(raw) as OAuthTokenRecord;
	if (Date.now() >= token.expiryDate) {
		if (!token.refreshToken) {
			throw new Error("Access token expired and no refresh token available.");
		}
		token = await refreshAccessToken(env as GoogleOAuthClientEnv, token.refreshToken);
		await env.GOOGLE_AUTH_KV.put(`${GOOGLE_TOKEN_PREFIX}${userId}`, JSON.stringify(token));
	}

	return token.accessToken;
}
