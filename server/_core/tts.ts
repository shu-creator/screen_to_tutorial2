/**
 * Text-to-Speech service using OpenAI TTS API via Forge
 *
 * Usage:
 * ```ts
 * import { generateSpeech } from "./_core/tts";
 *
 * const result = await generateSpeech({
 *   text: "こんにちは、これはテストです。",
 *   voice: "nova",
 *   speed: 1.0,
 * });
 *
 * if ('error' in result) {
 *   console.error(result.error);
 * } else {
 *   // result.audioBuffer is the MP3 audio data
 *   await fs.writeFile("output.mp3", result.audioBuffer);
 * }
 * ```
 */
import { ENV } from "./env";

export type TTSVoice = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";
export type TTSModel = "tts-1" | "tts-1-hd" | "gpt-4o-mini-tts";
export type TTSFormat = "mp3" | "opus" | "aac" | "flac";

export type TTSOptions = {
  text: string;
  voice?: TTSVoice;
  model?: TTSModel;
  speed?: number; // 0.25 to 4.0
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

// OpenAI TTS API has a 4096 character limit per request
const MAX_TEXT_LENGTH = 4096;

/**
 * Generate speech from text using OpenAI TTS API
 *
 * @param options - TTS options
 * @returns Audio buffer or error
 */
export async function generateSpeech(
  options: TTSOptions
): Promise<TTSResponse | TTSError> {
  try {
    // Step 1: Validate environment configuration
    if (!ENV.forgeApiUrl) {
      return {
        error: "TTS service is not configured",
        code: "SERVICE_ERROR",
        details: "BUILT_IN_FORGE_API_URL is not set",
      };
    }
    if (!ENV.forgeApiKey) {
      return {
        error: "TTS service authentication is missing",
        code: "SERVICE_ERROR",
        details: "BUILT_IN_FORGE_API_KEY is not set",
      };
    }

    // Step 2: Validate input
    const { text, voice = "nova", model = "gpt-4o-mini-tts", speed = 1.0, format = "mp3" } = options;

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

    // Step 3: Build API URL
    const baseUrl = ENV.forgeApiUrl.endsWith("/")
      ? ENV.forgeApiUrl
      : `${ENV.forgeApiUrl}/`;
    const fullUrl = new URL("v1/audio/speech", baseUrl).toString();

    // Step 4: Call TTS API
    const response = await fetch(fullUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ENV.forgeApiKey}`,
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
      return {
        error: "TTS generation failed",
        code: "GENERATION_FAILED",
        details: `${response.status} ${response.statusText}${errorText ? `: ${errorText}` : ""}`,
      };
    }

    // Step 5: Return audio buffer
    const audioBuffer = Buffer.from(await response.arrayBuffer());
    const contentType = getContentType(format);

    return {
      audioBuffer,
      contentType,
    };
  } catch (error) {
    return {
      error: "TTS generation failed",
      code: "SERVICE_ERROR",
      details: error instanceof Error ? error.message : "An unexpected error occurred",
    };
  }
}

/**
 * Generate speech for long text by splitting into chunks
 * Returns concatenated audio buffers
 */
export async function generateSpeechForLongText(
  options: TTSOptions
): Promise<TTSResponse | TTSError> {
  const { text, ...restOptions } = options;

  // If text is short enough, use single request
  if (text.length <= MAX_TEXT_LENGTH) {
    return generateSpeech(options);
  }

  // Split text into chunks at sentence boundaries
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

  // Concatenate all audio buffers
  const combinedBuffer = Buffer.concat(audioBuffers);

  return {
    audioBuffer: combinedBuffer,
    contentType,
  };
}

/**
 * Split text into chunks at sentence boundaries
 */
function splitTextIntoChunks(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find the best split point (sentence boundary)
    let splitIndex = findSentenceBoundary(remaining, maxLength);

    // If no good split point, split at maxLength
    if (splitIndex === -1) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.substring(0, splitIndex).trim());
    remaining = remaining.substring(splitIndex).trim();
  }

  return chunks;
}

/**
 * Find the best sentence boundary within maxLength
 */
function findSentenceBoundary(text: string, maxLength: number): number {
  const searchText = text.substring(0, maxLength);

  // Look for sentence endings (Japanese and English)
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

/**
 * Get content type from format
 */
function getContentType(format: TTSFormat): string {
  const formatToContentType: Record<TTSFormat, string> = {
    mp3: "audio/mpeg",
    opus: "audio/opus",
    aac: "audio/aac",
    flac: "audio/flac",
  };

  return formatToContentType[format] || "audio/mpeg";
}

/**
 * Get available voices with descriptions
 */
export function getAvailableVoices(): Array<{ id: TTSVoice; name: string; description: string }> {
  return [
    { id: "alloy", name: "Alloy", description: "中性的で落ち着いた声" },
    { id: "echo", name: "Echo", description: "男性的で深みのある声" },
    { id: "fable", name: "Fable", description: "イギリス英語風の声" },
    { id: "onyx", name: "Onyx", description: "男性的で力強い声" },
    { id: "nova", name: "Nova", description: "女性的で明るい声（推奨）" },
    { id: "shimmer", name: "Shimmer", description: "女性的で柔らかい声" },
  ];
}
