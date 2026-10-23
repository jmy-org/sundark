const path = require("node:path");
const fs = require("node:fs");
// Use production-pinned assets without relying on CDN availability.
module.exports = async function offlineAssets(page) {
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1")
      throw new Error(`Unexpected external request: ${url.hostname}`);
    return route.continue();
  });
  await page.route("https://cdn.jsdelivr.net/npm/dompurify@3.4.17/dist/purify.min.js", async (route) => {
    await route.fulfill({ path: require.resolve("dompurify/dist/purify.min.js") });
  });
  await page.route("https://cdnjs.cloudflare.com/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    let file;
    if (pathname.includes("/pdf.js/3.11.174/"))
      file = path.join(
        path.dirname(require.resolve("pdfjs-dist/package.json")),
        "build",
        path.basename(pathname),
      );
    if (pathname.includes("/marked/12.0.2/"))
      file = path.join(
        path.dirname(require.resolve("marked/package.json")),
        path.basename(pathname),
      );
    if (pathname.includes("/KaTeX/0.16.11/"))
      file = path.join(
        path.dirname(require.resolve("katex/package.json")),
        "dist",
        pathname.split("/KaTeX/0.16.11/")[1],
      );
    if (!file || !fs.existsSync(file)) throw new Error(`Unmapped CDN asset: ${pathname}`);
    await route.fulfill({ path: file });
  });
};
