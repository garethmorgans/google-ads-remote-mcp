import { describe, expect, it } from "vitest";
import { isEmailAllowedForMcp } from "./oauth-domain";

describe("isEmailAllowedForMcp", () => {
	it("allows herdl.com by default", () => {
		expect(isEmailAllowedForMcp("user@herdl.com")).toBe(true);
	});

	it("rejects other domains with default", () => {
		expect(isEmailAllowedForMcp("user@gmail.com")).toBe(false);
	});

	it("respects custom domain", () => {
		expect(isEmailAllowedForMcp("a@example.com", "example.com")).toBe(true);
		expect(isEmailAllowedForMcp("a@other.com", "example.com")).toBe(false);
	});

	it("handles @ prefix in allowed domain", () => {
		expect(isEmailAllowedForMcp("user@herdl.com", "@herdl.com")).toBe(true);
	});
});
