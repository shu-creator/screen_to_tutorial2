/**
 * evidence.json のプロジェクト単位の保存/読み込み（Phase 1）
 *
 * steps.json と同じく projects/<id>/artifacts/ 配下に置く。
 * 読み込み失敗をサイレントに握りつぶさない（警告ログを必ず残す）。
 */

import { createLogger } from "../_core/logger";
import { readBinaryFromSource, storageGet, storagePut } from "../storage";
import { parseEvidenceArtifact, type EvidenceArtifact } from "./types";

const logger = createLogger("EvidenceStore");

export function getEvidenceStorageKey(projectId: number): string {
  return `projects/${projectId}/artifacts/evidence.json`;
}

export async function saveEvidenceArtifact(
  projectId: number,
  artifact: EvidenceArtifact,
): Promise<{ key: string; url: string }> {
  const normalized: EvidenceArtifact = { ...artifact, project_id: projectId };
  const key = getEvidenceStorageKey(projectId);
  return storagePut(key, JSON.stringify(normalized, null, 2), "application/json");
}

export async function loadEvidenceArtifact(
  projectId: number,
): Promise<EvidenceArtifact | null> {
  const key = getEvidenceStorageKey(projectId);

  let raw: string;
  try {
    const file = await storageGet(key);
    raw = (await readBinaryFromSource(file.url)).toString("utf8");
  } catch {
    // 未生成（ファイルなし）は正常系
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version === "invalidated") {
      // retry等による意図的な無効化は正常系（再生成までartifactなし扱い）
      return null;
    }
    return parseEvidenceArtifact(parsed);
  } catch (error) {
    // パース失敗・未知バージョンはデータ問題なので必ず警告を残す
    logger.warn("evidence.json の読み込みに失敗しました", {
      projectId,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** retry等でフレームが再生成される際に古い証拠を無効化する */
export async function invalidateEvidenceArtifact(projectId: number): Promise<void> {
  const key = getEvidenceStorageKey(projectId);
  try {
    const file = await storageGet(key);
    const raw = (await readBinaryFromSource(file.url)).toString("utf8");
    const invalidated = {
      ...(JSON.parse(raw) as Record<string, unknown>),
      version: "invalidated",
      invalidated_at: new Date().toISOString(),
    };
    await storagePut(key, JSON.stringify(invalidated, null, 2), "application/json");
  } catch {
    // 存在しなければ何もしない
  }
}
