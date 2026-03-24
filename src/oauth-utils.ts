export function getUpstreamAuthorizeUrl({
	upstreamUrl,
	clientId,
	scope,
	redirectUri,
	state,
	hostedDomain,
}: {
	upstreamUrl: string;
	clientId: string;
	scope: string;
	redirectUri: string;
	state?: string;
	hostedDomain?: string;
}): string {
	const upstream = new URL(upstreamUrl);
	upstream.searchParams.set("client_id", clientId);
	upstream.searchParams.set("redirect_uri", redirectUri);
	upstream.searchParams.set("scope", scope);
	upstream.searchParams.set("response_type", "code");
	if (state) upstream.searchParams.set("state", state);
	if (hostedDomain) upstream.searchParams.set("hd", hostedDomain);
	return upstream.href;
}

export async function fetchUpstreamAuthToken({
	code,
	upstreamUrl,
	clientSecret,
	redirectUri,
	clientId,
	grantType,
}: {
	code: string;
	upstreamUrl: string;
	clientSecret: string;
	redirectUri: string;
	clientId: string;
	grantType: string;
}): Promise<[string, null] | [null, Response]> {
	const response = await fetch(upstreamUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			code,
			grant_type: grantType,
			redirect_uri: redirectUri,
		}).toString(),
	});
	if (!response.ok) {
		return [null, new Response(await response.text(), { status: 500 })];
	}
	const payload = (await response.json()) as { access_token?: string };
	if (!payload.access_token) {
		return [null, new Response("Missing access token", { status: 400 })];
	}
	return [payload.access_token, null];
}

export type AuthProps = {
	name: string;
	email: string;
	accessToken: string;
};
