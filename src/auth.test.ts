import { describe, expect, it, vi } from "vitest";
import { GOOGLE_TOKEN_PREFIX, getValidAccessToken } from "./auth";

class InMemoryKv {
	private store = new Map<string, string>();

	async put(key: string, value: string): Promise<void> {
		this.store.set(key, value);
	}

	async get(key: string): Promise<string | null> {
		return this.store.get(key) ?? null;
	}
}

describe("getValidAccessToken", () => {
	it("returns cached access token when not expired", async () => {
		const kv = new InMemoryKv();
		const future = Date.now() + 3600_000;
		await kv.put(
			`${GOOGLE_TOKEN_PREFIX}u1`,
			JSON.stringify({
				accessToken: "fresh",
				refreshToken: "r",
				expiryDate: future,
			}),
		);
		const env = {
			GOOGLE_AUTH_KV: kv as unknown as KVNamespace,
			GOOGLE_CLIENT_ID: "id",
			GOOGLE_CLIENT_SECRET: "secret",
		} as Env;

		const token = await getValidAccessToken(env, "u1");
		expect(token).toBe("fresh");
	});

	it("refreshes when expired and persists new record", async () => {
		const kv = new InMemoryKv();
		const past = Date.now() - 1000;
		await kv.put(
			`${GOOGLE_TOKEN_PREFIX}u1`,
			JSON.stringify({
				accessToken: "stale",
				refreshToken: "refresh-1",
				expiryDate: past,
			}),
		);
		const env = {
			GOOGLE_AUTH_KV: kv as unknown as KVNamespace,
			GOOGLE_CLIENT_ID: "id",
			GOOGLE_CLIENT_SECRET: "secret",
		} as Env;

		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.toString()
						: input.url;
			expect(url).toContain("oauth2.googleapis.com/token");
			return new Response(
				JSON.stringify({
					access_token: "new-access",
					expires_in: 3600,
				}),
				{ status: 200 },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const token = await getValidAccessToken(env, "u1");
		expect(token).toBe("new-access");
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const raw = await kv.get(`${GOOGLE_TOKEN_PREFIX}u1`);
		expect(raw).toBeTruthy();
		const parsed = JSON.parse(raw!) as { accessToken: string; refreshToken: string };
		expect(parsed.accessToken).toBe("new-access");
		expect(parsed.refreshToken).toBe("refresh-1");
		vi.unstubAllGlobals();
	});
});
