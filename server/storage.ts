// Local filesystem storage
// Replaces Manus Forge storage proxy with direct filesystem operations

import { promises as fs } from "fs";
import path from "path";
import { ENV } from "./_core/env";

const STORAGE_URL_PREFIX = "/storage/";

function getStoragePath(): string {
  return path.resolve(ENV.storagePath);
}

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

/**
 * ファイルをローカルストレージに保存
 */
export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  const filePath = path.join(getStoragePath(), key);

  // 親ディレクトリを作成
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  // ファイルを書き込み
  if (typeof data === "string") {
    await fs.writeFile(filePath, data, "utf-8");
  } else {
    await fs.writeFile(filePath, data);
  }

  return { key, url: STORAGE_URL_PREFIX + key };
}

/**
 * ストレージキーからURLを取得
 */
export async function storageGet(relKey: string): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  return { key, url: STORAGE_URL_PREFIX + key };
}

/**
 * URLがローカルストレージURLの場合、ファイルシステムパスに変換
 * ローカルでない場合は null を返す
 */
export function storageResolveUrl(url: string): string | null {
  if (url.startsWith(STORAGE_URL_PREFIX)) {
    const key = url.substring(STORAGE_URL_PREFIX.length);
    return path.join(getStoragePath(), key);
  }
  return null;
}

/**
 * URLからファイルを読み込み
 * ローカルストレージURLの場合はファイルシステムから直接読み込み、
 * リモートURLの場合はHTTP fetchでダウンロード
 */
export async function fetchStorageFile(url: string): Promise<Buffer> {
  const localPath = storageResolveUrl(url);
  if (localPath) {
    return fs.readFile(localPath);
  }

  // リモートURLの場合はHTTP fetch
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch file: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
