/** Scopes for MCP gate (email) + Google Ads API (`adwords`). */
export const GOOGLE_MCP_UPSTREAM_SCOPES =
	"email profile openid https://www.googleapis.com/auth/adwords";

export function getUpstreamAuthorizeUrl({
	upstreamUrl,
	clientId,
	scope,
	redirectUri,
	state,
	hostedDomain,
	accessType,
	prompt,
}: {
	upstreamUrl: string;
	clientId: string;
	scope: string;
	redirectUri: string;
	state?: string;
	hostedDomain?: string;
	/** e.g. `offline` for refresh tokens */
	accessType?: string;
	prompt?: string;
}): string {
	const upstream = new URL(upstreamUrl);
	upstream.searchParams.set("client_id", clientId);
	upstream.searchParams.set("redirect_uri", redirectUri);
	upstream.searchParams.set("scope", scope);
	upstream.searchParams.set("response_type", "code");
	if (state) upstream.searchParams.set("state", state);
	if (hostedDomain) upstream.searchParams.set("hd", hostedDomain);
	if (accessType) upstream.searchParams.set("access_type", accessType);
	if (prompt) upstream.searchParams.set("prompt", prompt);
	return upstream.href;
}
