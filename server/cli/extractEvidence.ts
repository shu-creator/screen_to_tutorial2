/**
 * 証拠抽出CLI（Phase 1）— DB・LLM不要のローカル動作確認用
 *
 * 使用方法:
 *   pnpm evidence:extract -- --video ./sample.mp4 --outdir ./outputs/evidence
 *   オプション: --fps 4 --ocr-provider engine|llm|none --asr-provider none|openai|local_whisper
 *
 * 出力:
 *   <outdir>/evidence.json
 *   <outdir>/frames/seg-N_{before,after}.jpg
 */

import fs from "fs/promises";
import path from "path";
import { extractEvidence } from "../evidence/extract";
import { getSharedOcrEngine } from "../_core/ocrEngine";
import type { ENV } from "../_core/env";

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const videoPath = args.video;
  const outdir = args.outdir ?? "./outputs/evidence";

  if (!videoPath) {
    console.error("--video <path> を指定してください");
    process.exit(1);
  }

  const framesDir = path.join(outdir, "frames");
  const started = Date.now();

  const { artifact } = await extractEvidence(path.resolve(videoPath), {
    framesDir: path.resolve(framesDir),
    sampleFps: args.fps ? Number(args.fps) : undefined,
    ocrProvider: (args["ocr-provider"] as typeof ENV.ocrProvider) ?? undefined,
    asrProvider: (args["asr-provider"] as typeof ENV.asrProvider) ?? undefined,
    onProgress: (ratio, message) => {
      process.stdout.write(`\r[${Math.round(ratio * 100).toString().padStart(3)}%] ${message}        `);
    },
  });
  process.stdout.write("\n");

  const outPath = path.join(outdir, "evidence.json");
  await fs.mkdir(outdir, { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`);

  console.log(`セグメント数: ${artifact.segments.length}`);
  console.log(`OCRプロバイダー: ${artifact.config.ocr_provider}（engine: ${artifact.config.ocr_engine ?? "-"}）`);
  console.log(`ASRプロバイダー: ${artifact.config.asr_provider}`);
  console.log(`処理時間: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`出力: ${outPath}`);

  await getSharedOcrEngine().shutdown();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
