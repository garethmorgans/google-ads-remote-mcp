import { describe, expect, it, vi } from "vitest";
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
	kv: InMemoryKv,
	completeAuthorization?: () => Promise<{ redirectTo: string }>,
): Env & { OAUTH_PROVIDER: { completeAuthorization: NonNullable<unknown> } } {
	return {
		OAUTH_KV: kv as unknown as KVNamespace,
		MCP_OBJECT: {} as DurableObjectNamespace<import("./index").MyMCP>,
		GOOGLE_CLIENT_ID: "google-client-id",
		GOOGLE_CLIENT_SECRET: "google-client-secret",
		GOOGLE_ADS_DEVELOPER_TOKEN: "dev-token",
		GOOGLE_ADS_LOGIN_CUSTOMER_ID: "123",
		GOOGLE_ADS_OAUTH_CLIENT_ID: "ads-client",
		GOOGLE_ADS_OAUTH_CLIENT_SECRET: "ads-secret",
		GOOGLE_ADS_OAUTH_REFRESH_TOKEN: "refresh",
		OAUTH_PROVIDER: {
			completeAuthorization:
				completeAuthorization ??
				(async () => ({
					redirectTo: "https://client.example/callback?code=ok",
				})),
		},
	} as Env & { OAUTH_PROVIDER: { completeAuthorization: NonNullable<unknown> } };
}

describe("GoogleHandler /callback OAuth flow", () => {
	it("allows authorized domain and redirects", async () => {
		const kv = new InMemoryKv();
		const state = "good-state";
		const cookie = await seedState(kv, state, { clientId: "abc", scope: "read" });
		const env = buildEnv(kv);

		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.includes("/o/oauth2/token")) {
				return new Response(JSON.stringify({ access_token: "google-token" }), { status: 200 });
			}
			if (url.includes("/oauth2/v2/userinfo")) {
				return new Response(
					JSON.stringify({ id: "u1", name: "Allowed User", email: "allowed@herdl.com" }),
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
		expect(fetchMock).toHaveBeenCalledTimes(2);
		vi.unstubAllGlobals();
	});

	it("rejects unauthorized domain", async () => {
		const kv = new InMemoryKv();
		const state = "blocked-state";
		const cookie = await seedState(kv, state, { clientId: "abc", scope: "read" });
		const env = buildEnv(kv);

		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.includes("/o/oauth2/token")) {
				return new Response(JSON.stringify({ access_token: "google-token" }), { status: 200 });
			}
			if (url.includes("/oauth2/v2/userinfo")) {
				return new Response(
					JSON.stringify({ id: "u2", name: "Blocked User", email: "blocked@gmail.com" }),
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
		const kv = new InMemoryKv();
		const env = buildEnv(kv);

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
		const kv = new InMemoryKv();
		const invalidState = "unknown-state";
		const cookieHash = await sha256Hex(invalidState);
		const env = buildEnv(kv);

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
