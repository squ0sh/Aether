import { readFile } from "fs/promises";
import { extname, join, normalize, relative, resolve } from "path";

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function resolvePublicAsset(pathname, publicRoot) {
  const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const normalized = normalize(requested);
  const file = resolve(publicRoot, normalized);
  const withinRoot = relative(resolve(publicRoot), file);
  if (withinRoot.startsWith("..") || withinRoot === "") return pathname === "/" ? file : null;
  return file;
}

async function servePublicAsset(res, pathname, publicRoot) {
  const file = resolvePublicAsset(pathname, publicRoot);
  if (!file) return false;
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": contentTypes[extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": pathname === "/" ? "no-cache" : "public, max-age=300",
      "X-Content-Type-Options": "nosniff"
    });
    res.end(body);
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") return false;
    throw error;
  }
}

export { resolvePublicAsset, servePublicAsset };
