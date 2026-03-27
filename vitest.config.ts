import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		alias: {
			"agents/mcp": path.resolve(__dirname, "src/test-mocks/agents-mcp.ts"),
		},
	},
});
