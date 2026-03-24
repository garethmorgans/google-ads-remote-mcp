import { afterEach, describe, expect, it, vi } from "vitest";
import {
	escapeGaqlString,
	GOOGLE_ADS_API_VERSION,
	normalizeCustomerId,
	searchStreamCollect,
} from "./google-ads-api";

describe("escapeGaqlString", () => {
	it("escapes single quotes and backslashes", () => {
		expect(escapeGaqlString("a'b")).toBe("a\\'b");
		expect(escapeGaqlString("a\\b")).toBe("a\\\\b");
	});
});

describe("normalizeCustomerId", () => {
	it("strips dashes", () => {
		expect(normalizeCustomerId("123-456-7890")).toBe("1234567890");
	});
});

describe("searchStreamCollect", () => {
	const env = {
		GOOGLE_ADS_DEVELOPER_TOKEN: "dev",
		GOOGLE_ADS_LOGIN_CUSTOMER_ID: "999",
	} as Env;

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("posts searchStream with expected URL, headers, and aggregates NDJSON results", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.url;
			expect(url).toBe(
				`https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/123/googleAds:searchStream`,
			);
			expect(init?.method).toBe("POST");
			const headers = init?.headers as Record<string, string>;
			expect(headers["developer-token"]).toBe("dev");
			expect(headers["login-customer-id"]).toBe("999");
			expect(headers["authorization"]).toBe("Bearer tok");
			expect(JSON.parse(init?.body as string)).toEqual({ query: "SELECT campaign.id FROM campaign" });
			return new Response(
				'{"results":[{"campaign":{"id":"1"}}]}\n{"results":[{"campaign":{"id":"2"}}]}\n',
				{ status: 200 },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const rows = await searchStreamCollect(env, "tok", "123", "SELECT campaign.id FROM campaign", {
			maxRows: 10,
		});
		expect(rows).toHaveLength(2);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("stops at maxRows", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(
				'{"results":[{"campaign":{"id":"1"}},{"campaign":{"id":"2"}},{"campaign":{"id":"3"}}]}\n',
				{ status: 200 },
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const rows = await searchStreamCollect(env, "tok", "123", "SELECT campaign.id FROM campaign", {
			maxRows: 2,
		});
		expect(rows).toHaveLength(2);
	});
});
