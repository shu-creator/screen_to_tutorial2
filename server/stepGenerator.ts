import fs from "fs/promises";
import os from "os";
import path from "path";
import { invokeLLM } from "./_core/llm";
import { detectChangedRegion } from "./_core/frameAnalysis";
import { ensurePipelineCacheDir, getCachedJson, hashBinary, setCachedJson } from "./_core/pipelineCache";
import { extractFrameOcr } from "./_core/ocr";
import { pickTranscriptSnippet, transcribeVideoSource } from "./_core/asr";
import { ENV } from "./_core/env";
import { createLogger } from "./_core/logger";
import { readBinaryFromSource, storagePut } from "./storage";
import * as db from "./db";
import type { Frame } from "../drizzle/schema";
import {
  STEPS_ARTIFACT_VERSION,
  type StepArtifact,
  type StepsArtifact,
  saveStepsArtifact,
} from "./stepsArtifact";

const logger = createLogger("StepGenerator");
const STEP_PROMPT_VERSION = "steps-grounded-v1";

interface StepData {
  title: string;
  operation: string;
  description: string;
  narration: string;
  instruction: string;
  expected_result: string;
  warnings: string[];
  confidence: number;
}

interface GroundingInput {
  imageUrl: string;
  frameNumber: number;
  ocrText: string[];
  transcriptSnippet: string;
}

const STEP_SCHEMA = {
  name: "step_grounded",
  strict: true,
  schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      operation: { type: "string" },
      description: { type: "string" },
      narration: { type: "string" },
      instruction: { type: "string" },
      expected_result: { type: "string" },
      warnings: {
        type: "array",
        items: { type: "string" },
      },
      confidence: { type: "number" },
    },
    required: [
      "title",
      "operation",
      "description",
      "narration",
      "instruction",
      "expected_result",
      "warnings",
      "confidence",
    ],
    additionalProperties: false,
  },
} as const;

function createTempFilePath(prefix: string, extension: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return path.join(os.tmpdir(), `${prefix}_${timestamp}_${random}${extension}`);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function analyzeFrame(input: GroundingInput): Promise<StepData> {
  const imageHash = hashBinary(await readBinaryFromSource(input.imageUrl));
  const cacheKey = {
    provider: ENV.llmProvider,
    model: ENV.llmModel,
    promptVersion: STEP_PROMPT_VERSION,
    imageHash,
    ocrText: input.ocrText,
    transcript: input.transcriptSnippet,
  };

  const cached = await getCachedJson<StepData>("step-analysis", cacheKey);
  if (cached) {
    return cached;
  }

  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `あなたは業務画面チュートリアル作成者です。必ず次の制約を守ってJSONを返してください。
- 1ステップは「目的1つ・操作1つ・結果1つ」
- OCRにないUIラベルは推測しない。推測した場合は warnings に明記して confidence を下げる
- instruction は短い命令文（1文）
- expected_result は画面状態の変化を短く書く
- operation は実行内容、description は補足（最大3文）`,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              `frame_number=${input.frameNumber}`,
              `ocr_text=${input.ocrText.join(" | ") || "(none)"}`,
              `transcript_snippet=${input.transcriptSnippet || "(none)"}`,
            ].join("\n"),
          },
          {
            type: "image_url",
            image_url: {
              url: input.imageUrl,
              detail: "high",
            },
          },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: STEP_SCHEMA,
    },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("LLM response is empty");
  }

  const raw = typeof content === "string" ? content : JSON.stringify(content);
  const parsed = JSON.parse(raw) as StepData;
  const normalized: StepData = {
    title: parsed.title?.trim() || "ステップ",
    operation: parsed.operation?.trim() || "操作を確認する",
    description: parsed.description?.trim() || "画面の内容を確認してください。",
    narration: parsed.narration?.trim() || "",
    instruction: parsed.instruction?.trim() || parsed.operation?.trim() || "操作を実行する",
    expected_result:
      parsed.expected_result?.trim() || parsed.description?.trim() || "画面が更新される",
    warnings: (parsed.warnings ?? []).map((warning) => warning.trim()).filter(Boolean),
    confidence: clamp(parsed.confidence ?? 0.6, 0, 1),
  };

  await setCachedJson("step-analysis", cacheKey, normalized);
  return normalized;
}

async function createFrameLocalPathCache(frames: Frame[]): Promise<{
  getLocalPath: (frame: Frame) => Promise<string>;
  cleanup: () => Promise<void>;
}> {
  const cache = new Map<number, string>();
  const tempFiles: string[] = [];

  const getLocalPath = async (frame: Frame): Promise<string> => {
    const cached = cache.get(frame.id);
    if (cached) return cached;

    const filePath = createTempFilePath(`step_frame_${frame.id}`, ".jpg");
    const buffer = await readBinaryFromSource(frame.imageUrl);
    await fs.writeFile(filePath, buffer);
    cache.set(frame.id, filePath);
    tempFiles.push(filePath);
    return filePath;
  };

  const cleanup = async (): Promise<void> => {
    await Promise.all(tempFiles.map((filePath) => fs.unlink(filePath).catch(() => {})));
  };

  return { getLocalPath, cleanup };
}

async function persistStepsToDb(
  projectId: number,
  artifact: StepsArtifact,
): Promise<StepsArtifact> {
  await db.deleteStepsByProjectId(projectId);

  for (const step of artifact.steps.sort((a, b) => a.sort_order - b.sort_order)) {
    const frameId =
      step.frame_id ??
      step.representative_frames[0]?.frame_id;
    if (!frameId) {
      throw new Error(`Missing frame_id for ${step.step_id}`);
    }
    const stepId = await db.createStep({
      projectId,
      frameId,
      title: step.title,
      operation: step.operation,
      description: step.description,
      narration: step.narration,
      sortOrder: step.sort_order,
    });
    step.legacy_step_db_id = stepId;
  }

  return artifact;
}

async function writeRunLog(
  projectId: number,
  runId: string,
  lines: string[],
): Promise<void> {
  const key = `projects/${projectId}/outputs/${runId}/log.jsonl`;
  await storagePut(key, `${lines.join("\n")}\n`, "application/jsonl");
}

export async function generateStepsForProject(projectId: number): Promise<void> {
  logger.info(`Starting step generation for project ${projectId}`);
  await ensurePipelineCacheDir();

  await db.updateProjectProgress(projectId, 70, "steps.json を生成中...");

  const project = await db.getProjectById(projectId);
  if (!project) {
    throw new Error("プロジェクトが見つかりません");
  }

  const frames = await db.getFramesByProjectId(projectId);
  if (frames.length === 0) {
    throw new Error("フレームが見つかりません");
  }

  const sortedFrames = [...frames].sort((a, b) => a.sortOrder - b.sortOrder);
  const runId = `run_${Date.now()}`;
  const runLogLines: string[] = [];
  const addRunLog = (event: string, payload: Record<string, unknown>) => {
    runLogLines.push(
      JSON.stringify({
        ts: new Date().toISOString(),
        event,
        ...payload,
      }),
    );
  };

  addRunLog("pipeline.start", {
    projectId,
    frameCount: sortedFrames.length,
    asrProvider: ENV.asrProvider,
    ocrProvider: ENV.ocrProvider,
    llmProvider: ENV.llmProvider,
    llmModel: ENV.llmModel,
  });

  const transcript = await transcribeVideoSource(project.videoUrl, ENV.asrProvider);
  addRunLog("asr.done", {
    provider: transcript.provider,
    model: transcript.model,
    segmentCount: transcript.segments.length,
    warnings: transcript.warnings,
  });

  const { getLocalPath, cleanup } = await createFrameLocalPathCache(sortedFrames);

  try {
    const artifactSteps: StepArtifact[] = [];

    for (let index = 0; index < sortedFrames.length; index++) {
      const frame = sortedFrames[index];
      const nextFrame = sortedFrames[index + 1];
      const prevFrame = sortedFrames[index - 1];

      const tStart = frame.timestamp;
      const tEnd =
        nextFrame?.timestamp ??
        frame.timestamp + 1_500;

      const transcriptSnippet = pickTranscriptSnippet(
        transcript.segments,
        tStart,
        Math.max(tEnd, tStart + 1),
      );

      let changedRegionBBox: StepArtifact["changed_region_bbox"] = null;
      if (prevFrame) {
        const prevPath = await getLocalPath(prevFrame);
        const currPath = await getLocalPath(frame);
        changedRegionBBox = await detectChangedRegion(prevPath, currPath, {
          minWidthRatio: 0.008,
          minHeightRatio: 0.008,
          cropThreshold: 20,
          skipNearFullFrameRatio: 0.97,
        });
      }

      try {
        const ocrResult = await extractFrameOcr(frame.imageUrl, frame.frameNumber, ENV.ocrProvider);
        const stepData = await analyzeFrame({
          imageUrl: frame.imageUrl,
          frameNumber: frame.frameNumber,
          ocrText: ocrResult.lines,
          transcriptSnippet,
        });

        artifactSteps.push({
          step_id: `step-${index + 1}`,
          sort_order: index,
          frame_id: frame.id,
          t_start: tStart,
          t_end: Math.max(tEnd, tStart + 1),
          representative_frames: [
            {
              frame_id: frame.id,
              frame_number: frame.frameNumber,
              timestamp: frame.timestamp,
              image_url: frame.imageUrl,
            },
          ],
          changed_region_bbox: changedRegionBBox,
          ocr_text: ocrResult.lines,
          transcript_snippet: transcriptSnippet,
          instruction: stepData.instruction,
          expected_result: stepData.expected_result,
          warnings: [...ocrResult.warnings, ...stepData.warnings],
          confidence: clamp((stepData.confidence + ocrResult.confidence) / 2, 0, 1),
          title: stepData.title,
          operation: stepData.operation,
          description: stepData.description,
          narration: stepData.narration,
        });
        addRunLog("step.generated", {
          index,
          frameId: frame.id,
          confidence: stepData.confidence,
          warningCount: stepData.warnings.length + ocrResult.warnings.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("Step analysis failed", {
          projectId,
          frameId: frame.id,
          message,
        });
        artifactSteps.push({
          step_id: `step-${index + 1}`,
          sort_order: index,
          frame_id: frame.id,
          t_start: tStart,
          t_end: Math.max(tEnd, tStart + 1),
          representative_frames: [
            {
              frame_id: frame.id,
              frame_number: frame.frameNumber,
              timestamp: frame.timestamp,
              image_url: frame.imageUrl,
            },
          ],
          changed_region_bbox: changedRegionBBox,
          ocr_text: [],
          transcript_snippet: transcriptSnippet,
          instruction: "画面の操作を確認する",
          expected_result: "画面が意図どおり更新される",
          warnings: [`step generation failed: ${message.substring(0, 120)}`],
          confidence: 0.2,
          title: `ステップ ${index + 1}`,
          operation: "操作を分析できませんでした",
          description: "このステップは手動で編集してください。",
          narration: "",
        });
        addRunLog("step.failed", {
          index,
          frameId: frame.id,
          message: message.substring(0, 160),
        });
      }

      const analysisProgress = 72 + Math.floor(((index + 1) / sortedFrames.length) * 16);
      await db.updateProjectProgress(
        projectId,
        analysisProgress,
        `steps.json を生成中 (${index + 1}/${sortedFrames.length})`,
      );
    }

    const artifact: StepsArtifact = {
      version: STEPS_ARTIFACT_VERSION,
      project_id: projectId,
      generated_at: new Date().toISOString(),
      config: {
        asr_provider: ENV.asrProvider,
        ocr_provider: ENV.ocrProvider,
        llm_provider: ENV.llmProvider,
        llm_model: ENV.llmModel,
        prompt_version: STEP_PROMPT_VERSION,
      },
      steps: artifactSteps,
    };

    const withLegacyIds = await persistStepsToDb(projectId, artifact);
    await saveStepsArtifact(projectId, withLegacyIds);
    await writeRunLog(projectId, runId, runLogLines);

    await db.updateProjectProgress(projectId, 90, "steps.json とステップ保存が完了しました");
    logger.info("Step generation complete", { projectId, stepCount: artifactSteps.length });
  } finally {
    await cleanup();
  }
}

/**
 * エラーメッセージを生成（内部用）
 */
function generateErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "AI解析中に不明なエラーが発生しました";
  }
  
  const msg = error.message.toLowerCase();
  
  if (msg.includes("rate limit") || msg.includes("429")) {
    return "AI APIのレート制限に達しました。しばらく待ってから再度お試しください。";
  } else if (msg.includes("quota") || msg.includes("insufficient")) {
    return "AI APIの利用可能枠を超えました。APIキーの設定を確認してください。";
  } else if (msg.includes("unauthorized") || msg.includes("401") || msg.includes("403")) {
    return "AI APIの認証に失敗しました。APIキーが有効か確認してください。";
  } else if (msg.includes("timeout") || msg.includes("timed out")) {
    return "AI解析がタイムアウトしました。ネットワーク接続を確認してください。";
  } else if (msg.includes("network") || msg.includes("fetch")) {
    return "ネットワークエラーが発生しました。インターネット接続を確認してください。";
  } else if (msg.includes("image") || msg.includes("url")) {
    return "画像の読み込みに失敗しました。フレーム画像が破損している可能性があります。";
  } else if (msg.includes("json") || msg.includes("parse")) {
    return "AIからの応答の解析に失敗しました。再度お試しください。";
  } else {
    return `AI解析中にエラーが発生しました: ${error.message.substring(0, 100)}`;
  }
}

/**
 * 単一のフレームを再分析してステップを更新
 */
export async function regenerateStep(stepId: number, frameId: number): Promise<void> {
  // フレーム情報を取得（所有者チェックはrouters.tsで実施済み）
  const frame = await db.getFrameById(frameId);

  if (!frame) {
    throw new Error("フレームが見つかりません");
  }

  // AIで画像を分析
  const ocrResult = await extractFrameOcr(frame.imageUrl, frame.frameNumber, ENV.ocrProvider);
  const stepData = await analyzeFrame({
    imageUrl: frame.imageUrl,
    frameNumber: frame.frameNumber,
    ocrText: ocrResult.lines,
    transcriptSnippet: "",
  });

  // ステップを更新
  await db.updateStep(stepId, {
    title: stepData.title,
    operation: stepData.operation,
    description: stepData.description,
    narration: stepData.narration,
  });
}
