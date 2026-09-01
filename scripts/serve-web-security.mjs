#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import process from "node:process";

import { SECURITY_HEADERS } from "../apps/server/dist/security-headers.js";

const host = process.env.SECURITY_TEST_HOST ?? "127.0.0.1";
const port = Number(process.env.SECURITY_TEST_PORT ?? "4174");
const distributionRoot = resolve("apps/web/dist");
const indexPath = resolve(distributionRoot, "index.html");
const contentTypes = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
});

const server = createServer(async (request, response) => {
  setSecurityHeaders(response);
  response.setHeader("cache-control", "no-store");

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return;
  }

  const pathname = new URL(request.url ?? "/", `http://${host}:${port}`).pathname;
  const requestedPath = safeAssetPath(pathname);
  const filePath = requestedPath && (await isFile(requestedPath)) ? requestedPath : indexPath;
  if (!(await isFile(filePath))) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Production Web build was not found.");
    return;
  }

  response.writeHead(200, {
    "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
});

server.listen(port, host, () => {
  process.stdout.write(`M4 security static harness listening on http://${host}:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

function safeAssetPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const candidate = resolve(distributionRoot, `.${decoded}`);
  return candidate === distributionRoot || candidate.startsWith(`${distributionRoot}${sep}`)
    ? candidate
    : null;
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function setSecurityHeaders(response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
}
