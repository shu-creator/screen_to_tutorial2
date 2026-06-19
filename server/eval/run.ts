/**
 * 評価ランナー（Phase 0）— `pnpm eval`
 *
 * eval/dataset/<case-id>/ground_truth.json と生成結果（steps.json / evidence.json）を
 * 突き合わせて G1/G2/G3・セグメント境界Recall を計算する。
 *
 * 使用方法:
 *   pnpm eval                                  # 全ケース: eval/results/generated/<case-id>/ 配下の生成物を評価
 *   pnpm eval -- --case synth-login-click-01   # 特定ケースのみ
 *   pnpm eval -- --steps path/to/steps.json --case <case-id>     # 任意のsteps.jsonを単発評価
 *   pnpm eval -- --evidence path/to/evidence.json --case <case-id> # セグメント境界Recallのみ
 *   pnpm eval -- --save-baseline               # 今回の結果を eval/baseline.json として保存
 *
 * 生成物の置き場所（デフォルトモード）:
 *   eval/results/generated/<case-id>/steps.json     … パイプライン出力（artifact v1/v2）
 *   eval/results/generated/<case-id>/evidence.json  … 証拠抽出出力（Phase 1以降）
 *   実パイプラインでの生成には DB と LLM APIキーが必要（CLI: pnpm pipeline:generate）。
 */

import fs from "fs/promises";
import path from "path";
import {
  computeBoundaryRecall,
  computeG1,
  computeG2,
  computeG3,
  type GeneratedStepLike,
  type GroundTruthStep,
} from "./metrics";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const DATASET_DIR = path.join(ROOT, "eval", "dataset");
const RESULTS_DIR = path.join(ROOT, "eval", "results");
const GENERATED_DIR = path.join(RESULTS_DIR, "generated");
const BASELINE_PATH = path.join(ROOT, "eval", "baseline.json");

interface CaseMetrics {
  caseId: string;
  g1?: { precision: number; recall: number; f1: number };
  g2?: { accuracy: number; noCitationRate: number; totalLabels: number };
  g3?: { rate: number };
  boundaryRecall?: { recall: number; matchedBoundaries: number; totalBoundaries: number };
  notes: string[];
}

interface GroundTruthFile {
  version: number;
  case_id: string;
  steps: GroundTruthStep[];
}

interface CaseMetaFile {
  has_narration?: boolean;
  synthetic_narration?: boolean;
}

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

async function listCases(): Promise<string[]> {
  const entries = await fs.readdir(DATASET_DIR, { withFileTypes: true }).catch(() => []);
  const cases: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await fileExists(path.join(DATASET_DIR, entry.name, "ground_truth.json"))) {
      cases.push(entry.name);
    }
  }
  return cases.sort();
}

/** steps.json（artifact v1/v2）から評価対象ステップを取り出す */
function extractSteps(artifact: unknown): GeneratedStepLike[] {
  const obj = artifact as { steps?: unknown[] };
  if (!Array.isArray(obj.steps)) {
    throw new Error("steps.json に steps 配列がありません");
  }
  return obj.steps.map((raw) => {
    const step = raw as Record<string, unknown>;
    return {
      t_start: Number(step.t_start ?? 0),
      t_end: Number(step.t_end ?? 0),
      title: String(step.title ?? ""),
      operation: typeof step.operation === "string" ? step.operation : undefined,
      instruction: typeof step.instruction === "string" ? step.instruction : undefined,
      cited_ui_labels: Array.isArray(step.cited_ui_labels)
        ? step.cited_ui_labels.filter((label): label is string => typeof label === "string")
        : undefined,
    };
  });
}

/** evidence.json からセグメント境界（ms）を取り出す */
function extractSegmentBoundaries(evidence: unknown): number[] {
  const obj = evidence as {
    segments?: Array<{ t_start?: number; t_end?: number; transition_start?: number }>;
  };
  if (!Array.isArray(obj.segments)) {
    throw new Error("evidence.json に segments 配列がありません");
  }
  const boundaries = new Set<number>();
  for (const segment of obj.segments) {
    // GTの境界は「操作開始時刻」「結果安定時刻」で定義されるため transition_start も含める
    if (typeof segment.t_start === "number") boundaries.add(segment.t_start);
    if (typeof segment.transition_start === "number") boundaries.add(segment.transition_start);
    if (typeof segment.t_end === "number") boundaries.add(segment.t_end);
  }
  return Array.from(boundaries).sort((a, b) => a - b);
}

async function evaluateCase(
  caseId: string,
  options: { stepsPath?: string; evidencePath?: string },
): Promise<CaseMetrics> {
  const gt = await readJson<GroundTruthFile>(
    path.join(DATASET_DIR, caseId, "ground_truth.json"),
  );
  const metaPath = path.join(DATASET_DIR, caseId, "meta.json");
  const meta = await fileExists(metaPath)
    ? await readJson<CaseMetaFile>(metaPath)
    : {};
  const metrics: CaseMetrics = { caseId, notes: [] };

  const stepsPath =
    options.stepsPath ?? path.join(GENERATED_DIR, caseId, "steps.json");
  const evidencePath =
    options.evidencePath ?? path.join(GENERATED_DIR, caseId, "evidence.json");

  if (await fileExists(stepsPath)) {
    const artifact = await readJson<{
      config?: { asr_provider?: string };
    }>(stepsPath);
    if (meta.has_narration && artifact.config?.asr_provider === "none") {
      metrics.notes.push("has_narration=true だが steps artifact は ASRなし (asr_provider=none)");
    }
    if (meta.synthetic_narration) {
      metrics.notes.push("synthetic_narration=true: 画面は実録画、音声は合成ナレーション");
    }
    const generated = extractSteps(artifact);
    const g1 = computeG1(generated, gt.steps);
    metrics.g1 = { precision: g1.precision, recall: g1.recall, f1: g1.f1 };

    const allowedLabels = gt.steps.flatMap((step) => step.ui_labels ?? []);
    const g2 = computeG2(generated, allowedLabels);
    metrics.g2 = {
      accuracy: g2.accuracy,
      noCitationRate: g2.noCitationRate,
      totalLabels: g2.totalLabels,
    };

    metrics.g3 = { rate: computeG3(generated, gt.steps).rate };
  } else {
    metrics.notes.push(`steps.json なし (${path.relative(ROOT, stepsPath)}) — G1/G2/G3 スキップ`);
  }

  if (await fileExists(evidencePath)) {
    const boundaries = extractSegmentBoundaries(await readJson(evidencePath));
    metrics.boundaryRecall = computeBoundaryRecall(boundaries, gt.steps);
  } else {
    metrics.notes.push(
      `evidence.json なし (${path.relative(ROOT, evidencePath)}) — 境界Recall スキップ`,
    );
  }

  return metrics;
}

function formatPercent(value: number | undefined): string {
  return value === undefined ? "  -  " : `${(value * 100).toFixed(1)}%`;
}

function printTable(results: CaseMetrics[], baseline: CaseMetrics[] | null) {
  const baselineById = new Map((baseline ?? []).map((m) => [m.caseId, m]));
  console.log("");
  console.log(
    "case".padEnd(28),
    "G1-F1".padEnd(8),
    "G2-acc".padEnd(8),
    "G2-無引用".padEnd(9),
    "G3".padEnd(8),
    "境界Recall",
  );
  console.log("-".repeat(80));
  for (const metric of results) {
    const base = baselineById.get(metric.caseId);
    const delta = (current?: number, prev?: number) =>
      current !== undefined && prev !== undefined
        ? ` (${current >= prev ? "+" : ""}${((current - prev) * 100).toFixed(1)})`
        : "";
    console.log(
      metric.caseId.padEnd(28),
      (formatPercent(metric.g1?.f1) + delta(metric.g1?.f1, base?.g1?.f1)).padEnd(8),
      formatPercent(metric.g2?.accuracy).padEnd(8),
      formatPercent(metric.g2?.noCitationRate).padEnd(9),
      formatPercent(metric.g3?.rate).padEnd(8),
      formatPercent(metric.boundaryRecall?.recall) +
        delta(metric.boundaryRecall?.recall, base?.boundaryRecall?.recall),
    );
    for (const note of metric.notes) {
      console.log(`    note: ${note}`);
    }
  }
  console.log("");
  console.log("G4（人手修正コスト）は自動計測対象外です。出荷判断時に編集箇所数を記録してください。");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const allCases = await listCases();
  if (allCases.length === 0) {
    console.error(
      "評価データセットがありません。`python3 eval/generate_dataset.py` で合成データを生成してください。",
    );
    process.exit(1);
  }

  const targetCases =
    typeof args.case === "string" ? [args.case] : allCases;
  for (const caseId of targetCases) {
    if (!allCases.includes(caseId)) {
      console.error(`未知のケース: ${caseId}（存在: ${allCases.join(", ")}）`);
      process.exit(1);
    }
  }

  if ((args.steps || args.evidence) && typeof args.case !== "string") {
    console.error("--steps / --evidence を使う場合は --case を指定してください");
    process.exit(1);
  }

  const results: CaseMetrics[] = [];
  for (const caseId of targetCases) {
    results.push(
      await evaluateCase(caseId, {
        stepsPath: typeof args.steps === "string" ? path.resolve(args.steps) : undefined,
        evidencePath:
          typeof args.evidence === "string" ? path.resolve(args.evidence) : undefined,
      }),
    );
  }

  let baseline: CaseMetrics[] | null = null;
  if (await fileExists(BASELINE_PATH)) {
    const baselineFile = await readJson<{ results?: CaseMetrics[] }>(BASELINE_PATH);
    baseline = baselineFile.results ?? null;
  }

  printTable(results, baseline);

  await fs.mkdir(RESULTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const payload = {
    generated_at: new Date().toISOString(),
    cases: targetCases,
    results,
  };
  const outPath = path.join(RESULTS_DIR, `${timestamp}.json`);
  await fs.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`結果を保存: ${path.relative(ROOT, outPath)}`);

  if (args["save-baseline"]) {
    await fs.writeFile(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`ベースラインを更新: ${path.relative(ROOT, BASELINE_PATH)}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
