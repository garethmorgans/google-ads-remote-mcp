/**
 * Returns true if email is allowed to use this MCP server.
 * Domain is normalized to lowercase; default @herdl.com.
 */
export function isEmailAllowedForMcp(
	email: string,
	allowedDomain: string = "herdl.com",
): boolean {
	const trimmed = email.trim().toLowerCase();
	const domain = allowedDomain.trim().toLowerCase().replace(/^@/, "");
	if (!trimmed.includes("@")) return false;
	const at = trimmed.lastIndexOf("@");
	const userDomain = trimmed.slice(at + 1);
	return userDomain === domain;
}
