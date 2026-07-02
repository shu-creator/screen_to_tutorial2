import { invokeLLM } from "./llm";
import { ENV } from "./env";
import { getCachedJson, hashBinary, setCachedJson } from "./pipelineCache";
import { readBinaryFromSource, resolveToLocalFile } from "../storage";
import { getSharedOcrEngine } from "./ocrEngine";

export type OCRProvider = "none" | "llm" | "engine";

export interface OcrRegion {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrResult {
  provider: OCRProvider;
  lines: string[];
  regions: OcrRegion[];
  warnings: string[];
  confidence: number;
}

const OCR_SCHEMA = {
  name: "ocr_extraction",
  strict: true,
  schema: {
    type: "object",
    properties: {
      lines: {
        type: "array",
        items: { type: "string" },
      },
      regions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            x: { type: "number" },
            y: { type: "number" },
            w: { type: "number" },
            h: { type: "number" },
          },
          required: ["text", "x", "y", "w", "h"],
          additionalProperties: false,
        },
      },
      warnings: {
        type: "array",
        items: { type: "string" },
      },
      confidence: { type: "number" },
    },
    required: ["lines", "regions", "warnings", "confidence"],
    additionalProperties: false,
  },
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * OCRの統一エントリポイント。
 * provider=engine はローカルOCRエンジン（PaddleOCR/Tesseract）を使用し、
 * エンジンが利用できない環境では既定でLLM-OCRへフォールバックする。
 * OCR_ENGINE_FALLBACK=none の場合はAPI呼び出しを避け、空OCRと警告を返す。
 */
export async function extractFrameOcrUnified(
  source: string,
  frameNumber: number,
  provider: OCRProvider = ENV.ocrProvider,
): Promise<OcrResult> {
  if (provider !== "engine") {
    return extractFrameOcr(source, frameNumber, provider);
  }

  const engine = getSharedOcrEngine();
  if (await engine.isAvailable()) {
    try {
      return await extractFrameOcrWithEngine(source, frameNumber);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (ENV.ocrEngineFallback === "none") {
        return emptyEngineOcrResult(
          `engine OCR failed; LLM fallback disabled by OCR_ENGINE_FALLBACK=none: ${message.substring(0, 120)}`,
        );
      }
      const fallback = await extractFrameOcr(source, frameNumber, "llm");
      fallback.warnings.push(`engine OCR failed, fell back to llm: ${message.substring(0, 120)}`);
      return fallback;
    }
  }

  if (ENV.ocrEngineFallback === "none") {
    return emptyEngineOcrResult(
      "engine OCR unavailable; LLM fallback disabled by OCR_ENGINE_FALLBACK=none",
    );
  }

  const fallback = await extractFrameOcr(source, frameNumber, "llm");
  fallback.warnings.push("engine OCR unavailable, fell back to llm");
  return fallback;
}

function emptyEngineOcrResult(warning: string): OcrResult {
  return {
    provider: "engine",
    lines: [],
    regions: [],
    warnings: [warning],
    confidence: 0,
  };
}

async function extractFrameOcrWithEngine(
  source: string,
  _frameNumber: number,
): Promise<OcrResult> {
  const engine = getSharedOcrEngine();
  const imageBuffer = await readBinaryFromSource(source);
  const cacheKey = {
    provider: "engine",
    engine: engine.engine ?? "unknown",
    promptVersion: "ocr-engine-v2",
    imageHash: hashBinary(imageBuffer),
  };
  const cached = await getCachedJson<OcrResult>("ocr", cacheKey);
  if (cached) {
    return cached;
  }

  const { path: localPath, cleanup } = await resolveToLocalFile(source, ".jpg");
  try {
    const lines = await engine.recognize(localPath);
    const regions: OcrRegion[] = lines.map((line) => ({
      text: line.text,
      x: clamp(line.x, 0, 1),
      y: clamp(line.y, 0, 1),
      w: clamp(line.w, 0, 1),
      h: clamp(line.h, 0, 1),
    }));
    const meanScore =
      lines.length > 0
        ? lines.reduce((sum, line) => sum + line.score, 0) / lines.length
        : 0;
    const result: OcrResult = {
      provider: "engine",
      lines: lines.map((line) => line.text),
      regions,
      warnings: [],
      confidence: clamp(meanScore, 0, 1),
    };
    await setCachedJson("ocr", cacheKey, result);
    return result;
  } finally {
    await cleanup();
  }
}

export async function extractFrameOcr(
  imageUrl: string,
  frameNumber: number,
  provider: OCRProvider = ENV.ocrProvider,
): Promise<OcrResult> {
  if (provider === "none") {
    return {
      provider,
      lines: [],
      regions: [],
      warnings: ["OCR disabled"],
      confidence: 0,
    };
  }
  if (provider === "engine") {
    return extractFrameOcrUnified(imageUrl, frameNumber, provider);
  }

  const imageBuffer = await readBinaryFromSource(imageUrl);
  const cacheKey = {
    provider,
    model: ENV.llmModel,
    promptVersion: "ocr-llm-v1",
    imageHash: hashBinary(imageBuffer),
  };
  const cached = await getCachedJson<OcrResult>("ocr", cacheKey);
  if (cached) {
    return cached;
  }

  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content:
          "あなたはOCR抽出器です。画面内テキストを見たまま抽出してください。推測は禁止。読めない場合は warnings に記載してください。",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `frame_number=${frameNumber}\n画面内のUIテキストを抽出してください。座標は 0〜1 の正規化座標で返してください。`,
          },
          {
            type: "image_url",
            image_url: { url: imageUrl, detail: "high" },
          },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: OCR_SCHEMA,
    },
  });

  const content = response.choices[0]?.message?.content;
  const raw = typeof content === "string" ? content : JSON.stringify(content);
  const parsed = JSON.parse(raw) as {
    lines?: string[];
    regions?: OcrRegion[];
    warnings?: string[];
    confidence?: number;
  };

  const result: OcrResult = {
    provider: "llm",
    lines: (parsed.lines ?? [])
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    regions: (parsed.regions ?? [])
      .map((region) => ({
        text: (region.text ?? "").trim(),
        x: clamp(region.x, 0, 1),
        y: clamp(region.y, 0, 1),
        w: clamp(region.w, 0, 1),
        h: clamp(region.h, 0, 1),
      }))
      .filter((region) => region.text.length > 0),
    warnings: (parsed.warnings ?? []).map((warning) => warning.trim()).filter(Boolean),
    confidence: clamp(parsed.confidence ?? 0.6, 0, 1),
  };

  await setCachedJson("ocr", cacheKey, result);
  return result;
}
