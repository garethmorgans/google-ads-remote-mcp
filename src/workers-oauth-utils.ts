import type { AuthRequest } from "@cloudflare/workers-oauth-provider";

export class OAuthError extends Error {
	constructor(
		public code: string,
		public description: string,
		public statusCode = 400,
	) {
		super(description);
	}

	toResponse(): Response {
		return new Response(
			JSON.stringify({ error: this.code, error_description: this.description }),
			{
				status: this.statusCode,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
}

export async function createOAuthState(oauthReqInfo: AuthRequest, kv: KVNamespace) {
	const stateToken = crypto.randomUUID();
	await kv.put(`oauth:state:${stateToken}`, JSON.stringify(oauthReqInfo), { expirationTtl: 600 });
	return { stateToken };
}

export async function bindStateToSession(stateToken: string) {
	const hashHex = await sha256Hex(stateToken);
	const setCookie = `__Host-CONSENTED_STATE=${hashHex}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`;
	return { setCookie };
}

export async function validateOAuthState(request: Request, kv: KVNamespace) {
	const url = new URL(request.url);
	const stateFromQuery = url.searchParams.get("state");
	if (!stateFromQuery) {
		throw new OAuthError("invalid_request", "Missing state parameter", 400);
	}
	const storedData = await kv.get(`oauth:state:${stateFromQuery}`);
	if (!storedData) {
		throw new OAuthError("invalid_request", "Invalid or expired state", 400);
	}
	const consentedStateHash = (request.headers.get("Cookie") || "")
		.split(";")
		.map((c) => c.trim())
		.find((c) => c.startsWith("__Host-CONSENTED_STATE="))
		?.split("=")[1];
	if (!consentedStateHash) {
		throw new OAuthError(
			"invalid_request",
			"Missing session binding cookie - restart authorization flow",
			400,
		);
	}
	const expectedHash = await sha256Hex(stateFromQuery);
	if (expectedHash !== consentedStateHash) {
		throw new OAuthError("invalid_request", "State token does not match session", 400);
	}
	await kv.delete(`oauth:state:${stateFromQuery}`);
	return {
		oauthReqInfo: JSON.parse(storedData) as AuthRequest,
		clearCookie:
			"__Host-CONSENTED_STATE=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0",
	};
}

async function sha256Hex(value: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
