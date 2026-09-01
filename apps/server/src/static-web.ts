import { relative, sep } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

import { recordStaticWebOperation } from "./operational-logging.js";

const IMMUTABLE_ASSET_CACHE = "public, max-age=31536000, immutable";
const NO_STORE_CACHE = "no-store";
const HASHED_ASSET_PATTERN = /-[0-9A-Za-z_-]{8,}\.[0-9A-Za-z]+$/u;

export interface StaticWebOptions {
  readonly rootDirectory: string;
}

export function registerStaticWeb(server: FastifyInstance, options: StaticWebOptions): void {
  server.register(fastifyStatic, {
    root: options.rootDirectory,
    prefix: "/",
    cacheControl: false,
    dotfiles: "deny",
    serveDotFiles: false,
    redirect: false,
    allowedPath: (pathName) => !containsDotfileSegment(pathName),
    setHeaders: (reply, filepath) => {
      recordStaticWebOperation(reply.request);
      reply.header(
        "cache-control",
        isHashedAsset(options.rootDirectory, filepath) ? IMMUTABLE_ASSET_CACHE : NO_STORE_CACHE,
      );
    },
  });
}

export function shouldServeSpaFallback(method: string, url: string, accept: unknown): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (typeof accept !== "string" || !accept.toLowerCase().includes("text/html")) return false;
  const pathname = safeRequestPathname(url);
  return (
    pathname !== null &&
    !isReservedServerPath(pathname) &&
    !containsDotfileSegment(pathname) &&
    !isAssetLikePath(pathname)
  );
}

export function isUnsafeStaticWebRequest(url: string): boolean {
  const pathname = safeRequestPathname(url);
  return pathname === null || containsDotfileSegment(pathname);
}

export function markSpaFallbackRequest(
  request: Parameters<typeof recordStaticWebOperation>[0],
): void {
  recordStaticWebOperation(request);
}

function isHashedAsset(rootDirectory: string, filepath: string): boolean {
  const relativePath = relative(rootDirectory, filepath);
  if (relativePath.length === 0 || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    return false;
  }
  const normalized = relativePath.split(sep).join("/");
  return normalized.startsWith("assets/") && HASHED_ASSET_PATTERN.test(normalized);
}

function containsDotfileSegment(pathName: string): boolean {
  return pathName.split("/").some((segment) => segment.startsWith(".") && segment !== ".");
}

function safeRequestPathname(url: string): string | null {
  try {
    const pathname = decodeURIComponent(url.split("?", 1)[0] ?? "/");
    return pathname.includes("\\") || containsControlCharacter(pathname) ? null : pathname;
  } catch {
    return null;
  }
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function isAssetLikePath(pathname: string): boolean {
  if (pathname === "/assets" || pathname.startsWith("/assets/")) return true;
  const finalSegment = pathname.split("/").at(-1) ?? "";
  return finalSegment.includes(".");
}

function isReservedServerPath(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/health" ||
    pathname.startsWith("/health/")
  );
}
