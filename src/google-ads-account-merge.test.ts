import { describe, expect, it } from "vitest";
import {
	clientRowToAccountEntry,
	mergeClientRowsIntoMap,
	type MergeAccountMap,
} from "./google-ads-account-merge";

describe("clientRowToAccountEntry", () => {
	it("parses REST-shaped customerClient row", () => {
		const row = {
			customerClient: {
				id: "123",
				descriptiveName: "Acme",
				clientCustomer: "customers/123",
				manager: false,
			},
		};
		const p = clientRowToAccountEntry(row);
		expect(p?.customerId).toBe("123");
		expect(p?.entry.descriptiveName).toBe("Acme");
		expect(p?.entry.source).toBe("customer_client");
	});

	it("derives id from clientCustomer when id missing", () => {
		const row = {
			customerClient: {
				descriptiveName: "Beta",
				clientCustomer: "customers/999",
			},
		};
		const p = clientRowToAccountEntry(row);
		expect(p?.customerId).toBe("999");
	});
});

describe("mergeClientRowsIntoMap", () => {
	it("dedupes and marks both when accessible then client", () => {
		const map: MergeAccountMap = new Map();
		map.set("1", {
			customerId: "1",
			descriptiveName: "From Accessible",
			source: "accessible",
		});
		mergeClientRowsIntoMap(map, [
			{
				customerClient: {
					id: "1",
					descriptiveName: "From Client",
					clientCustomer: "customers/1",
				},
			},
		]);
		const m = map.get("1");
		expect(m?.source).toBe("both");
		expect(m?.descriptiveName).toBe("From Accessible");
	});
});
