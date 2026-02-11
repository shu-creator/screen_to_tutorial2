import fs from "fs/promises";
import path from "path";
import { ENV } from "./_core/env";

const STORAGE_ROUTE_PREFIX = "/api/storage/";

function normalizeKey(relKey: string): string {
  const normalized = path.posix.normalize(relKey.replace(/^\/+/, ""));
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`Invalid storage key: ${relKey}`);
  }
  return normalized;
}

function getStorageRoot(): string {
  return ENV.storageDir;
}

function keyToFsPath(key: string): string {
  const root = getStorageRoot();
  const filePath = path.resolve(root, key);
  const normalizedRoot = path.resolve(root) + path.sep;
  if (!filePath.startsWith(normalizedRoot)) {
    throw new Error(`Path traversal detected for key: ${key}`);
  }
  return filePath;
}

function keyToPublicUrl(key: string): string {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${STORAGE_ROUTE_PREFIX}${encodedKey}`;
}

function storageUrlToKey(url: string): string {
  if (!url.startsWith(STORAGE_ROUTE_PREFIX)) {
    throw new Error(`Unsupported storage URL: ${url}`);
  }

  const keyPart = url
    .slice(STORAGE_ROUTE_PREFIX.length)
    .split("?")[0]
    .split("#")[0]
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .join("/");

  return normalizeKey(keyPart);
}

function toBuffer(data: Buffer | Uint8Array | string): Buffer {
  if (typeof data === "string") {
    return Buffer.from(data);
  }
  return Buffer.from(data);
}

export function isLocalStorageUrl(url: string): boolean {
  return url.startsWith(STORAGE_ROUTE_PREFIX);
}

export function resolveLocalStoragePathFromUrl(url: string): string {
  const key = storageUrlToKey(url);
  return keyToFsPath(key);
}

export async function readBinaryFromSource(source: string): Promise<Buffer> {
  if (isLocalStorageUrl(source)) {
    return fs.readFile(resolveLocalStoragePathFromUrl(source));
  }

  if (source.startsWith("http://") || source.startsWith("https://")) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(
        `Failed to download file: ${response.status} ${response.statusText}`
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }

  return fs.readFile(source);
}

export async function ensureStorageDir(): Promise<void> {
  await fs.mkdir(getStorageRoot(), { recursive: true });
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  _contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  const filePath = keyToFsPath(key);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, toBuffer(data));
  return { key, url: keyToPublicUrl(key) };
}

export async function storageGet(
  relKey: string
): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  const filePath = keyToFsPath(key);
  await fs.access(filePath);
  return { key, url: keyToPublicUrl(key) };
}
