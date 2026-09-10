import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolvePublicAsset, servePublicAsset } from "../src/core/static.js";

test("public asset paths stay inside the public directory", () => {
  const root = join("/", "opt", "aether", "public");
  assert.equal(resolvePublicAsset("/", root), join(root, "index.html"));
  assert.equal(resolvePublicAsset("/app.js", root), join(root, "app.js"));
  assert.equal(resolvePublicAsset("/../package.json", root), null);
  assert.equal(resolvePublicAsset("/%2e%2e/package.json", root), null);
});

test("static files receive their expected content type", async () => {
  const root = await mkdtemp(join(tmpdir(), "aether-public-"));
  await writeFile(join(root, "app.js"), "export {};\n");
  let status;
  let headers;
  let body;
  const response = {
    writeHead(nextStatus, nextHeaders) { status = nextStatus; headers = nextHeaders; },
    end(nextBody) { body = nextBody; }
  };
  assert.equal(await servePublicAsset(response, "/app.js", root), true);
  assert.equal(status, 200);
  assert.equal(headers["Content-Type"], "text/javascript; charset=utf-8");
  assert.equal(body.toString(), "export {};\n");
});
