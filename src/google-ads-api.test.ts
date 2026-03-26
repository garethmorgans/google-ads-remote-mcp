import { afterEach, describe, expect, it, vi } from "vitest";
import {
	escapeGaqlString,
	GOOGLE_ADS_API_VERSION,
	listAccessibleCustomers,
	normalizeCustomerId,
	resolveAdsLoginCustomerId,
	searchStreamCollect,
} from "./google-ads-api";
import { fetchCustomerClients } from "./google-ads-resolve";

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

describe("resolveAdsLoginCustomerId", () => {
	const env = { GOOGLE_ADS_LOGIN_CUSTOMER_ID: "999-888" } as Env;

	it("uses env when override is absent", () => {
		expect(resolveAdsLoginCustomerId(env)).toBe("999888");
	});

	it("uses override when it contains digits", () => {
		expect(resolveAdsLoginCustomerId(env, "111-222")).toBe("111222");
	});

	it("treats empty override as absent so env is used", () => {
		expect(resolveAdsLoginCustomerId(env, "")).toBe("999888");
	});

	it("throws when env has no digits", () => {
		expect(() => resolveAdsLoginCustomerId({ GOOGLE_ADS_LOGIN_CUSTOMER_ID: "" } as Env)).toThrow(
			/GOOGLE_ADS_LOGIN_CUSTOMER_ID/,
		);
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

	it("parses documented searchStream JSON array envelope", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(
				'[{"results":[{"campaign":{"id":"1"}}]},{"results":[{"campaign":{"id":"2"}}]}]',
				{ status: 200 },
			),
		);
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

	it("uses options.loginCustomerId for login-customer-id when set", async () => {
		const fetchMock = vi.fn(async (_input: RequestInfo, init?: RequestInit) => {
			const headers = init?.headers as Record<string, string>;
			expect(headers["login-customer-id"]).toBe("8881112222");
			return new Response('{"results":[]}\n', { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		await searchStreamCollect(env, "tok", "123", "SELECT 1", {
			maxRows: 5,
			loginCustomerId: "888-111-2222",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("fetchCustomerClients", () => {
	const env = {
		GOOGLE_ADS_DEVELOPER_TOKEN: "dev",
		GOOGLE_ADS_LOGIN_CUSTOMER_ID: "9990000000",
	} as Env;

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("defaults login-customer-id to managerCustomerId when loginCustomerId is absent", async () => {
		const fetchMock = vi.fn(async (_input: RequestInfo, init?: RequestInit) => {
			const headers = init?.headers as Record<string, string>;
			expect(headers["login-customer-id"]).toBe("1234567890");
			return new Response("{}", { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);

		await fetchCustomerClients(env, "tok", "123-456-7890", { maxRows: 1 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("uses explicit loginCustomerId when provided", async () => {
		const fetchMock = vi.fn(async (_input: RequestInfo, init?: RequestInit) => {
			const headers = init?.headers as Record<string, string>;
			expect(headers["login-customer-id"]).toBe("7778889999");
			return new Response("{}", { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);

		await fetchCustomerClients(env, "tok", "1234567890", {
			maxRows: 1,
			loginCustomerId: "777-888-9999",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("listAccessibleCustomers", () => {
	const env = {
		GOOGLE_ADS_DEVELOPER_TOKEN: "dev",
		GOOGLE_ADS_LOGIN_CUSTOMER_ID: "999",
	} as Env;

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("sends login-customer-id from env by default", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.url;
			expect(url).toContain(":listAccessibleCustomers");
			const headers = init?.headers as Record<string, string>;
			expect(headers["login-customer-id"]).toBe("999");
			return new Response(JSON.stringify({ resourceNames: ["customers/1"] }), { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const r = await listAccessibleCustomers(env, "tok");
		expect(r).toEqual(["customers/1"]);
	});

	it("overrides login-customer-id when options.loginCustomerId is set", async () => {
		const fetchMock = vi.fn(async (_input: RequestInfo, init?: RequestInit) => {
			const headers = init?.headers as Record<string, string>;
			expect(headers["login-customer-id"]).toBe("777");
			return new Response(JSON.stringify({ resourceNames: [] }), { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		await listAccessibleCustomers(env, "tok", { loginCustomerId: "777" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
