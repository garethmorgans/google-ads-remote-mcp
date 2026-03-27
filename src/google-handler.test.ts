import { describe, expect, it, vi } from "vitest";
import { GOOGLE_TOKEN_PREFIX } from "./auth";
import { GOOGLE_MCP_UPSTREAM_SCOPES } from "./oauth-utils";
import { GoogleHandler } from "./google-handler";

type StoredState = {
	clientId: string;
	scope: string;
};

class InMemoryKv {
	private store = new Map<string, string>();

	async put(key: string, value: string): Promise<void> {
		this.store.set(key, value);
	}

	async get(key: string): Promise<string | null> {
		return this.store.get(key) ?? null;
	}

	async delete(key: string): Promise<void> {
		this.store.delete(key);
	}

	getStored(key: string): string | undefined {
		return this.store.get(key);
	}
}

async function sha256Hex(value: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function seedState(kv: InMemoryKv, state: string, oauthReq: StoredState): Promise<string> {
	await kv.put(`oauth:state:${state}`, JSON.stringify(oauthReq));
	const hash = await sha256Hex(state);
	return `__Host-CONSENTED_STATE=${hash}`;
}

function buildEnv(
	oauthKv: InMemoryKv,
	googleAuthKv: InMemoryKv,
	completeAuthorization?: () => Promise<{ redirectTo: string }>,
): Env & { OAUTH_PROVIDER: { completeAuthorization: NonNullable<unknown> } } {
	return {
		OAUTH_KV: oauthKv as unknown as KVNamespace,
		GOOGLE_AUTH_KV: googleAuthKv as unknown as KVNamespace,
		MCP_OBJECT: {} as DurableObjectNamespace<import("./index").MyMCP>,
		GOOGLE_CLIENT_ID: "google-client-id",
		GOOGLE_CLIENT_SECRET: "google-client-secret",
		GOOGLE_ADS_DEVELOPER_TOKEN: "dev-token",
		OAUTH_PROVIDER: {
			completeAuthorization:
				completeAuthorization ??
				(async () => ({
					redirectTo: "https://client.example/callback?code=ok",
				})),
		},
	} as Env & { OAUTH_PROVIDER: { completeAuthorization: NonNullable<unknown> } };
}

describe("GoogleHandler /authorize", () => {
	it("redirects to Google with adwords scope and offline access", async () => {
		const oauthKv = new InMemoryKv();
		const googleAuthKv = new InMemoryKv();
		const env = buildEnv(oauthKv, googleAuthKv);

		const parseAuthRequest = vi.fn(async () => ({ clientId: "abc", scope: "mcp" }));
		const envWithParse = {
			...env,
			OAUTH_PROVIDER: {
				...env.OAUTH_PROVIDER,
				parseAuthRequest,
			},
		};

		const request = new Request("https://mcp.example/authorize");
		const response = await GoogleHandler.fetch(request, envWithParse as typeof env);

		expect(response.status).toBe(302);
		const location = response.headers.get("Location");
		expect(location).toBeTruthy();
		const url = new URL(location!);
		expect(url.searchParams.get("scope")).toBe(GOOGLE_MCP_UPSTREAM_SCOPES);
		expect(url.searchParams.get("access_type")).toBe("offline");
		expect(url.searchParams.get("prompt")).toBe("consent");
		expect(url.searchParams.get("client_id")).toBe("google-client-id");
	});
});

describe("GoogleHandler /callback OAuth flow", () => {
	it("allows authorized domain, stores tokens in GOOGLE_AUTH_KV, and redirects", async () => {
		const oauthKv = new InMemoryKv();
		const googleAuthKv = new InMemoryKv();
		const state = "good-state";
		const cookie = await seedState(oauthKv, state, { clientId: "abc", scope: "read" });
		const env = buildEnv(oauthKv, googleAuthKv);

		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.toString()
						: input.url;
			if (url.includes("oauth2.googleapis.com/token")) {
				return new Response(
					JSON.stringify({
						access_token: "google-access",
						refresh_token: "google-refresh",
						expires_in: 3600,
					}),
					{ status: 200 },
				);
			}
			if (url.includes("openidconnect.googleapis.com/v1/userinfo")) {
				return new Response(
					JSON.stringify({
						sub: "oidc-sub-1",
						email: "allowed@herdl.com",
						name: "Allowed User",
					}),
					{ status: 200 },
				);
			}
			throw new Error(`unexpected fetch url: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const request = new Request(
			`https://mcp.example/callback?state=${encodeURIComponent(state)}&code=auth-code`,
			{
				headers: { Cookie: cookie },
			},
		);

		const response = await GoogleHandler.fetch(request, env);
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("https://client.example/callback?code=ok");
		expect(fetchMock).toHaveBeenCalled();

		const stored = googleAuthKv.getStored(`${GOOGLE_TOKEN_PREFIX}oidc-sub-1`);
		expect(stored).toBeTruthy();
		const parsed = JSON.parse(stored!) as { accessToken: string; refreshToken: string };
		expect(parsed.accessToken).toBe("google-access");
		expect(parsed.refreshToken).toBe("google-refresh");
		vi.unstubAllGlobals();
	});

	it("rejects when Google omits refresh_token", async () => {
		const oauthKv = new InMemoryKv();
		const googleAuthKv = new InMemoryKv();
		const state = "state-no-refresh";
		const cookie = await seedState(oauthKv, state, { clientId: "abc", scope: "read" });
		const env = buildEnv(oauthKv, googleAuthKv);

		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.toString()
						: input.url;
			if (url.includes("oauth2.googleapis.com/token")) {
				return new Response(
					JSON.stringify({
						access_token: "google-access",
						expires_in: 3600,
					}),
					{ status: 200 },
				);
			}
			throw new Error(`unexpected fetch url: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const request = new Request(
			`https://mcp.example/callback?state=${encodeURIComponent(state)}&code=auth-code`,
			{ headers: { Cookie: cookie } },
		);

		const response = await GoogleHandler.fetch(request, env);
		expect(response.status).toBe(400);
		const text = await response.text();
		expect(text).toContain("refresh token");
		vi.unstubAllGlobals();
	});

	it("rejects unauthorized domain", async () => {
		const oauthKv = new InMemoryKv();
		const googleAuthKv = new InMemoryKv();
		const state = "blocked-state";
		const cookie = await seedState(oauthKv, state, { clientId: "abc", scope: "read" });
		const env = buildEnv(oauthKv, googleAuthKv);

		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.toString()
						: input.url;
			if (url.includes("oauth2.googleapis.com/token")) {
				return new Response(
					JSON.stringify({
						access_token: "google-access",
						refresh_token: "r",
						expires_in: 3600,
					}),
					{ status: 200 },
				);
			}
			if (url.includes("openidconnect.googleapis.com/v1/userinfo")) {
				return new Response(
					JSON.stringify({
						sub: "u2",
						email: "blocked@gmail.com",
						name: "Blocked User",
					}),
					{ status: 200 },
				);
			}
			throw new Error(`unexpected fetch url: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const request = new Request(
			`https://mcp.example/callback?state=${encodeURIComponent(state)}&code=auth-code`,
			{
				headers: { Cookie: cookie },
			},
		);

		const response = await GoogleHandler.fetch(request, env);
		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toMatchObject({
			error: "access_denied",
		});
		vi.unstubAllGlobals();
	});

	it("rejects missing OAuth state", async () => {
		const oauthKv = new InMemoryKv();
		const googleAuthKv = new InMemoryKv();
		const env = buildEnv(oauthKv, googleAuthKv);

		const response = await GoogleHandler.fetch(
			new Request("https://mcp.example/callback?code=auth-code"),
			env,
		);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: "invalid_request",
		});
	});

	it("rejects invalid OAuth state", async () => {
		const oauthKv = new InMemoryKv();
		const googleAuthKv = new InMemoryKv();
		const invalidState = "unknown-state";
		const cookieHash = await sha256Hex(invalidState);
		const env = buildEnv(oauthKv, googleAuthKv);

		const response = await GoogleHandler.fetch(
			new Request(`https://mcp.example/callback?state=${invalidState}&code=auth-code`, {
				headers: { Cookie: `__Host-CONSENTED_STATE=${cookieHash}` },
			}),
			env,
		);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: "invalid_request",
		});
	});
});
