import { execFile } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import { createLogger } from "./logger";
import { ENV } from "./env";
import { getCachedJson, hashBinary, setCachedJson } from "./pipelineCache";
import { readBinaryFromSource } from "../storage";

const logger = createLogger("ASR");
const execFileAsync = promisify(execFile);

export type ASRProvider = "none" | "openai" | "local_whisper";

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
}

export interface TranscriptionResult {
  provider: ASRProvider;
  model: string;
  segments: TranscriptSegment[];
  fullText: string;
  warnings: string[];
}

function createTempPath(prefix: string, ext: string): string {
  return path.join(
    os.tmpdir(),
    `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`,
  );
}

async function extractAudio(videoPath: string): Promise<string | null> {
  const audioPath = createTempPath("tutorial_audio", ".mp3");

  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-i",
        videoPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        "64k",
        audioPath,
      ],
      { timeout: 120_000 },
    );
    const stat = await fs.stat(audioPath);
    if (stat.size <= 0) {
      await fs.unlink(audioPath).catch(() => {});
      return null;
    }
    return audioPath;
  } catch (error) {
    await fs.unlink(audioPath).catch(() => {});
    logger.warn("No audio stream or extraction failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function transcribeWithOpenAI(audioPath: string): Promise<TranscriptionResult> {
  if (!ENV.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required for ASR_PROVIDER=openai");
  }

  const audioBuffer = await fs.readFile(audioPath);
  const audioHash = hashBinary(audioBuffer);
  const cacheKey = {
    provider: "openai",
    model: ENV.asrModel,
    promptVersion: "asr-openai-v1",
    inputHash: audioHash,
  };

  const cached = await getCachedJson<TranscriptionResult>("asr", cacheKey);
  if (cached) {
    return cached;
  }

  const formData = new FormData();
  formData.append("model", ENV.asrModel);
  formData.append("response_format", "verbose_json");
  formData.append("timestamp_granularities[]", "segment");
  const bytes = new Uint8Array(audioBuffer);
  formData.append("file", new Blob([bytes], { type: "audio/mpeg" }), "audio.mp3");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ENV.openaiApiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI ASR failed: ${response.status} ${response.statusText} - ${body}`);
  }

  const json = (await response.json()) as {
    text?: string;
    segments?: Array<{
      start?: number;
      end?: number;
      text?: string;
      avg_logprob?: number;
    }>;
  };

  const segments: TranscriptSegment[] = (json.segments ?? [])
    .map((segment) => {
      const start = Math.max(0, Math.round((segment.start ?? 0) * 1000));
      const end = Math.max(start + 1, Math.round((segment.end ?? segment.start ?? 0) * 1000));
      const text = (segment.text ?? "").trim();
      return {
        startMs: start,
        endMs: end,
        text,
        confidence:
          typeof segment.avg_logprob === "number"
            ? Math.max(0, Math.min(1, 1 + segment.avg_logprob / 5))
            : 0.7,
      };
    })
    .filter((segment) => segment.text.length > 0);

  const fullText = (json.text ?? segments.map((segment) => segment.text).join(" ")).trim();
  const result: TranscriptionResult = {
    provider: "openai",
    model: ENV.asrModel,
    segments,
    fullText,
    warnings: [],
  };

  await setCachedJson("asr", cacheKey, result);
  return result;
}

async function transcribeWithLocalWhisper(audioPath: string): Promise<TranscriptionResult> {
  const outDir = createTempPath("whisper_out", "");
  const basename = path.basename(audioPath, path.extname(audioPath));
  await fs.mkdir(outDir, { recursive: true });

  try {
    await execFileAsync(
      "whisper",
      [
        audioPath,
        "--task",
        "transcribe",
        "--output_format",
        "json",
        "--output_dir",
        outDir,
        "--language",
        "ja",
      ],
      { timeout: 10 * 60_000 },
    );

    const resultPath = path.join(outDir, `${basename}.json`);
    const raw = await fs.readFile(resultPath, "utf8");
    const json = JSON.parse(raw) as {
      text?: string;
      segments?: Array<{ start?: number; end?: number; text?: string }>;
    };

    const segments: TranscriptSegment[] = (json.segments ?? [])
      .map((segment) => {
        const start = Math.max(0, Math.round((segment.start ?? 0) * 1000));
        const end = Math.max(start + 1, Math.round((segment.end ?? segment.start ?? 0) * 1000));
        const text = (segment.text ?? "").trim();
        return {
          startMs: start,
          endMs: end,
          text,
          confidence: 0.6,
        };
      })
      .filter((segment) => segment.text.length > 0);

    return {
      provider: "local_whisper",
      model: "whisper-cli",
      segments,
      fullText: (json.text ?? segments.map((segment) => segment.text).join(" ")).trim(),
      warnings: [],
    };
  } finally {
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function pickTranscriptSnippet(
  segments: TranscriptSegment[],
  tStartMs: number,
  tEndMs: number,
): string {
  const snippet = segments
    .filter((segment) => segment.endMs >= tStartMs && segment.startMs <= tEndMs)
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(" ");

  return snippet.trim();
}

export async function transcribeVideoSource(
  videoSource: string,
  provider: ASRProvider = ENV.asrProvider,
): Promise<TranscriptionResult> {
  if (provider === "none") {
    return {
      provider,
      model: "none",
      segments: [],
      fullText: "",
      warnings: ["ASR disabled"],
    };
  }

  const tempVideoPath = createTempPath("asr_video", ".mp4");
  let audioPath: string | null = null;

  try {
    const videoBuffer = await readBinaryFromSource(videoSource);
    await fs.writeFile(tempVideoPath, videoBuffer);

    audioPath = await extractAudio(tempVideoPath);
    if (!audioPath) {
      return {
        provider,
        model: "none",
        segments: [],
        fullText: "",
        warnings: ["Audio stream was not found"],
      };
    }

    if (provider === "openai") {
      return transcribeWithOpenAI(audioPath);
    }

    if (provider === "local_whisper") {
      return transcribeWithLocalWhisper(audioPath);
    }

    return {
      provider,
      model: "none",
      segments: [],
      fullText: "",
      warnings: [`Unsupported ASR provider: ${provider}`],
    };
  } finally {
    await fs.unlink(tempVideoPath).catch(() => {});
    if (audioPath) {
      await fs.unlink(audioPath).catch(() => {});
    }
  }
}
