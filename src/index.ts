import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { GoogleHandler } from "./google-handler";
import { registerGoogleAdsTools } from "./google-ads-tools";

export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "Google Ads Read-Only MCP",
		version: "1.0.0",
	});

	async init() {
		registerGoogleAdsTools(this.server, this.env as Env);
	}
}

export default new OAuthProvider({
	apiRoute: "/mcp",
	apiHandler: MyMCP.serve("/mcp"),
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GoogleHandler as any,
});
