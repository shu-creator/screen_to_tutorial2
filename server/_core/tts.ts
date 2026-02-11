import fs from "fs/promises";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { nanoid } from "nanoid";
import { ENV, type TTSProvider } from "./env";

const execFileAsync = promisify(execFile);

export type TTSVoice = string;
export type TTSModel = string;
export type TTSFormat = "mp3" | "opus" | "aac" | "flac";

export type TTSOptions = {
  text: string;
  voice?: TTSVoice;
  model?: TTSModel;
  speed?: number;
  format?: TTSFormat;
};

export type TTSResponse = {
  audioBuffer: Buffer;
  contentType: string;
};

export type TTSError = {
  error: string;
  code: "TEXT_TOO_LONG" | "INVALID_VOICE" | "GENERATION_FAILED" | "SERVICE_ERROR";
  details?: string;
};

interface TTSAdapter {
  generateSpeech(options: TTSOptions): Promise<TTSResponse | TTSError>;
  getVoices(): Array<{ id: string; name: string; description: string }>;
}

const MAX_TEXT_LENGTH = 4096;

const OPENAI_VOICES: Array<{ id: string; name: string; description: string }> = [
  { id: "alloy", name: "Alloy", description: "Neutral and calm" },
  { id: "echo", name: "Echo", description: "Deep male voice" },
  { id: "fable", name: "Fable", description: "British accented voice" },
  { id: "onyx", name: "Onyx", description: "Strong male voice" },
  { id: "nova", name: "Nova", description: "Bright female voice" },
  { id: "shimmer", name: "Shimmer", description: "Soft female voice" },
];

const GEMINI_VOICES: Array<{ id: string; name: string; description: string }> = [
  { id: "Kore", name: "Kore", description: "Gemini default voice" },
];

function validateOptions(options: TTSOptions): TTSError | null {
  const { text, speed = 1.0 } = options;

  if (!text || text.trim().length === 0) {
    return {
      error: "Text is required",
      code: "GENERATION_FAILED",
      details: "Empty text provided",
    };
  }

  if (text.length > MAX_TEXT_LENGTH) {
    return {
      error: `Text exceeds maximum length of ${MAX_TEXT_LENGTH} characters`,
      code: "TEXT_TOO_LONG",
      details: `Text length: ${text.length} characters`,
    };
  }

  if (speed < 0.25 || speed > 4.0) {
    return {
      error: "Speed must be between 0.25 and 4.0",
      code: "GENERATION_FAILED",
      details: `Invalid speed: ${speed}`,
    };
  }

  return null;
}

function createServiceError(error: string, details?: string): TTSError {
  return {
    error,
    code: "SERVICE_ERROR",
    details,
  };
}

function createGenerationError(error: string, details?: string): TTSError {
  return {
    error,
    code: "GENERATION_FAILED",
    details,
  };
}

function getContentType(format: TTSFormat): string {
  const formatToContentType: Record<TTSFormat, string> = {
    mp3: "audio/mpeg",
    opus: "audio/opus",
    aac: "audio/aac",
    flac: "audio/flac",
  };

  return formatToContentType[format] || "audio/mpeg";
}

function extensionForMimeType(contentType: string): string {
  if (contentType.includes("wav")) return ".wav";
  if (contentType.includes("mpeg") || contentType.includes("mp3")) return ".mp3";
  if (contentType.includes("flac")) return ".flac";
  if (contentType.includes("aac")) return ".aac";
  return ".bin";
}

async function transcodeToMp3(
  inputBuffer: Buffer,
  inputContentType: string
): Promise<Buffer> {
  if (inputContentType.includes("audio/mpeg") || inputContentType.includes("audio/mp3")) {
    return inputBuffer;
  }

  const tempDir = path.join(os.tmpdir(), `tts-transcode-${nanoid()}`);
  await fs.mkdir(tempDir, { recursive: true });

  const inputPath = path.join(tempDir, `input${extensionForMimeType(inputContentType)}`);
  const outputPath = path.join(tempDir, "output.mp3");

  try {
    await fs.writeFile(inputPath, inputBuffer);
    await execFileAsync("ffmpeg", ["-y", "-i", inputPath, "-acodec", "libmp3lame", outputPath], {
      timeout: 60000,
    });
    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

class OpenAITTSAdapter implements TTSAdapter {
  async generateSpeech(options: TTSOptions): Promise<TTSResponse | TTSError> {
    if (!ENV.ttsApiKey) {
      return createServiceError("TTS API key is not configured");
    }

    const validation = validateOptions(options);
    if (validation) return validation;

    try {
      const {
        text,
        voice = "nova",
        model = ENV.ttsModel,
        speed = 1.0,
        format = "mp3",
      } = options;

      const response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ENV.ttsApiKey}`,
        },
        body: JSON.stringify({
          model,
          input: text,
          voice,
          speed,
          response_format: format,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        return createGenerationError(
          "OpenAI TTS generation failed",
          `${response.status} ${response.statusText}${errorText ? `: ${errorText}` : ""}`
        );
      }

      return {
        audioBuffer: Buffer.from(await response.arrayBuffer()),
        contentType: getContentType(format),
      };
    } catch (error) {
      return createServiceError(
        "OpenAI TTS generation failed",
        error instanceof Error ? error.message : "Unexpected error"
      );
    }
  }

  getVoices() {
    return OPENAI_VOICES;
  }
}

class GeminiTTSAdapter implements TTSAdapter {
  async generateSpeech(options: TTSOptions): Promise<TTSResponse | TTSError> {
    if (!ENV.ttsApiKey) {
      return createServiceError("TTS API key is not configured");
    }

    const validation = validateOptions(options);
    if (validation) return validation;

    try {
      const {
        text,
        voice = "Kore",
        model = ENV.ttsModel,
      } = options;

      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(ENV.ttsApiKey)}`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text }],
            },
          ],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: voice,
                },
              },
            },
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        return createGenerationError(
          "Gemini TTS generation failed",
          `${response.status} ${response.statusText}${errorText ? `: ${errorText}` : ""}`
        );
      }

      const json = (await response.json()) as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              inlineData?: {
                mimeType?: string;
                data?: string;
              };
            }>;
          };
        }>;
      };

      const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      const inlineData = part?.inlineData;
      if (!inlineData?.data) {
        return createGenerationError("Gemini TTS response missing audio payload");
      }

      const mimeType = inlineData.mimeType ?? "audio/wav";
      const rawAudio = Buffer.from(inlineData.data, "base64");
      const mp3Audio = await transcodeToMp3(rawAudio, mimeType);

      return {
        audioBuffer: mp3Audio,
        contentType: "audio/mpeg",
      };
    } catch (error) {
      return createServiceError(
        "Gemini TTS generation failed",
        error instanceof Error ? error.message : "Unexpected error"
      );
    }
  }

  getVoices() {
    return GEMINI_VOICES;
  }
}

function createTTSAdapter(provider: TTSProvider): TTSAdapter {
  if (provider === "gemini") {
    return new GeminiTTSAdapter();
  }
  return new OpenAITTSAdapter();
}

export async function generateSpeech(
  options: TTSOptions
): Promise<TTSResponse | TTSError> {
  const adapter = createTTSAdapter(ENV.ttsProvider);
  return adapter.generateSpeech(options);
}

export async function generateSpeechForLongText(
  options: TTSOptions
): Promise<TTSResponse | TTSError> {
  const { text, ...restOptions } = options;

  if (text.length <= MAX_TEXT_LENGTH) {
    return generateSpeech(options);
  }

  const chunks = splitTextIntoChunks(text, MAX_TEXT_LENGTH);
  const audioBuffers: Buffer[] = [];
  let contentType = "audio/mpeg";

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`[TTS] Generating chunk ${i + 1}/${chunks.length} (${chunk.length} chars)`);

    const result = await generateSpeech({
      ...restOptions,
      text: chunk,
    });

    if ("error" in result) {
      return result;
    }

    audioBuffers.push(result.audioBuffer);
    contentType = result.contentType;
  }

  return {
    audioBuffer: Buffer.concat(audioBuffers),
    contentType,
  };
}

function splitTextIntoChunks(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = findSentenceBoundary(remaining, maxLength);
    if (splitIndex === -1) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.substring(0, splitIndex).trim());
    remaining = remaining.substring(splitIndex).trim();
  }

  return chunks;
}

function findSentenceBoundary(text: string, maxLength: number): number {
  const searchText = text.substring(0, maxLength);
  const sentenceEndings = ["。", "！", "？", ".", "!", "?", "\n\n", "\n"];

  let bestIndex = -1;

  for (const ending of sentenceEndings) {
    const lastIndex = searchText.lastIndexOf(ending);
    if (lastIndex > bestIndex) {
      bestIndex = lastIndex + ending.length;
    }
  }

  return bestIndex;
}

export function getAvailableVoices(): Array<{ id: string; name: string; description: string }> {
  const adapter = createTTSAdapter(ENV.ttsProvider);
  return adapter.getVoices();
}
