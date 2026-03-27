import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { GOOGLE_TOKEN_PREFIX, resolveGoogleUserId } from "./auth";
import { exchangeAuthCodeForTokens, googleApiRequest } from "./google-token";
import { getUpstreamAuthorizeUrl, GOOGLE_MCP_UPSTREAM_SCOPES } from "./oauth-utils";
import { isEmailAllowedForMcp } from "./oauth-domain";
import {
	OAuthError,
	bindStateToSession,
	createOAuthState,
	validateOAuthState,
} from "./workers-oauth-utils";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

function allowedDomain(env: Env): string {
	return (env.ALLOWED_EMAIL_DOMAIN ?? "herdl.com").replace(/^@/, "");
}

/** Auto-approve: redirect straight to Google after binding OAuth state. */
app.get("/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	if (!oauthReqInfo.clientId) return c.text("Invalid request", 400);

	const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
	const { setCookie: sessionCookie } = await bindStateToSession(stateToken);
	return redirectToGoogle(c.req.raw, c.env, stateToken, { "Set-Cookie": sessionCookie });
});

app.get("/callback", async (c) => {
	try {
		const { oauthReqInfo, clearCookie } = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
		if (!oauthReqInfo.clientId) return c.text("Invalid OAuth request data", 400);

		const code = c.req.query("code");
		if (!code) return c.text("Missing code", 400);

		const redirectUri = new URL("/callback", c.req.url).href;
		let tokens;
		try {
			tokens = await exchangeAuthCodeForTokens(c.env, code, redirectUri);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return c.text(`Token exchange failed: ${msg}`, 500);
		}

		if (!tokens.refreshToken) {
			return c.text(
				"Google did not return a refresh token. Revoke this app at https://myaccount.google.com/permissions and connect again.",
				400,
			);
		}

		let userId: string;
		let email: string;
		let displayName: string;
		try {
			const profile = await googleApiRequest<{ sub?: string; email?: string; name?: string }>(
				tokens.accessToken,
				"https://openidconnect.googleapis.com/v1/userinfo",
			);
			if (profile.sub && profile.email) {
				userId = profile.sub;
				email = profile.email;
				displayName = profile.name ?? profile.email;
			} else {
				userId = await resolveGoogleUserId(tokens.accessToken);
				const userInfoResponse = await fetch(
					"https://www.googleapis.com/oauth2/v2/userinfo",
					{
						headers: { Authorization: `Bearer ${tokens.accessToken}` },
					},
				);
				if (!userInfoResponse.ok) return c.text("Failed to fetch user info", 500);
				const userInfo = (await userInfoResponse.json()) as {
					id: string;
					name: string;
					email: string;
				};
				email = userInfo.email;
				displayName = userInfo.name;
			}
		} catch {
			return c.text("Failed to resolve user profile", 500);
		}

		const domain = allowedDomain(c.env);
		if (!isEmailAllowedForMcp(email, domain)) {
			return new Response(
				JSON.stringify({
					error: "access_denied",
					error_description: `Only @${domain} accounts are allowed.`,
				}),
				{ status: 403, headers: { "Content-Type": "application/json" } },
			);
		}

		await c.env.GOOGLE_AUTH_KV.put(`${GOOGLE_TOKEN_PREFIX}${userId}`, JSON.stringify(tokens));

		const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
			request: oauthReqInfo,
			scope: oauthReqInfo.scope,
			userId,
			metadata: { label: displayName },
			props: {
				userId,
				email,
				name: displayName,
			},
		});

		const headers = new Headers({ Location: redirectTo, "Set-Cookie": clearCookie });
		return new Response(null, { status: 302, headers });
	} catch (error) {
		if (error instanceof OAuthError) return error.toResponse();
		return c.text("Internal server error", 500);
	}
});

function redirectToGoogle(
	request: Request,
	env: Env,
	stateToken: string,
	headers: Record<string, string> = {},
): Response {
	return new Response(null, {
		status: 302,
		headers: {
			...headers,
			location: getUpstreamAuthorizeUrl({
				upstreamUrl: "https://accounts.google.com/o/oauth2/v2/auth",
				clientId: env.GOOGLE_CLIENT_ID,
				redirectUri: new URL("/callback", request.url).href,
				scope: GOOGLE_MCP_UPSTREAM_SCOPES,
				state: stateToken,
				hostedDomain: env.HOSTED_DOMAIN,
				accessType: "offline",
				prompt: "consent",
			}),
		},
	});
}

export { app as GoogleHandler };
