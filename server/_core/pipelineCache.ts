import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { ENV } from "./env";

type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike };

function normalizeForHash(value: unknown): JsonLike {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeForHash(item));
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, normalizeForHash(item)] as const);
    return Object.fromEntries(entries);
  }

  return String(value);
}

function computeDigest(payload: unknown): string {
  const normalized = normalizeForHash(payload);
  const serialized = JSON.stringify(normalized);
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

function getNamespaceDir(namespace: string): string {
  return path.join(ENV.pipelineCacheDir, namespace);
}

export function hashBinary(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export async function ensurePipelineCacheDir(): Promise<void> {
  await fs.mkdir(ENV.pipelineCacheDir, { recursive: true });
}

export async function getCachedJson<T>(
  namespace: string,
  keyInput: unknown,
): Promise<T | null> {
  const digest = computeDigest(keyInput);
  const filePath = path.join(getNamespaceDir(namespace), `${digest}.json`);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function setCachedJson(
  namespace: string,
  keyInput: unknown,
  value: unknown,
): Promise<void> {
  const digest = computeDigest(keyInput);
  const namespaceDir = getNamespaceDir(namespace);
  const filePath = path.join(namespaceDir, `${digest}.json`);
  await fs.mkdir(namespaceDir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value), "utf8");
}
