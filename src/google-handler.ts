import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import type { AuthProps } from "./oauth-utils";
import { fetchUpstreamAuthToken, getUpstreamAuthorizeUrl } from "./oauth-utils";
import { isEmailAllowedForMcp } from "./oauth-domain";
import { OAuthError, bindStateToSession, createOAuthState, validateOAuthState } from "./workers-oauth-utils";

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

		const [accessToken, tokenError] = await fetchUpstreamAuthToken({
			clientId: c.env.GOOGLE_CLIENT_ID,
			clientSecret: c.env.GOOGLE_CLIENT_SECRET,
			code,
			grantType: "authorization_code",
			redirectUri: new URL("/callback", c.req.url).href,
			upstreamUrl: "https://accounts.google.com/o/oauth2/token",
		});
		if (tokenError) return tokenError;

		const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		if (!userInfoResponse.ok) return c.text("Failed to fetch user info", 500);

		const userInfo = (await userInfoResponse.json()) as { id: string; name: string; email: string };
		const domain = allowedDomain(c.env);
		if (!isEmailAllowedForMcp(userInfo.email, domain)) {
			return new Response(
				JSON.stringify({
					error: "access_denied",
					error_description: `Only @${domain} accounts are allowed.`,
				}),
				{ status: 403, headers: { "Content-Type": "application/json" } },
			);
		}

		const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
			request: oauthReqInfo,
			scope: oauthReqInfo.scope,
			userId: userInfo.id,
			metadata: { label: userInfo.name },
			props: {
				name: userInfo.name,
				email: userInfo.email,
				accessToken,
			} as AuthProps,
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
				scope: "email profile",
				state: stateToken,
				hostedDomain: env.HOSTED_DOMAIN,
			}),
		},
	});
}

export { app as GoogleHandler };
