/** Public deployment origin only. Never a credential or user-controlled input. */
const configured = process.env.SUNDARK_SITE_URL || "https://example.invalid";
const parsed = new URL(configured);
if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
  throw new Error("SUNDARK_SITE_URL must be an HTTPS origin without credentials, path, query, or fragment.");
}
export const siteUrl = parsed.origin;
