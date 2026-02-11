import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

function setEnv(overrides: Record<string, string>) {
  process.env = {
    ...originalEnv,
    NODE_ENV: "test",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
});

describe("TTS adapters", () => {
  it("generates speech with OpenAI provider", async () => {
    setEnv({
      TTS_PROVIDER: "openai",
      OPENAI_API_KEY: "test-openai-key",
      TTS_MODEL: "gpt-4o-mini-tts",
    });
    vi.resetModules();

    const audio = Buffer.from("fake-mp3-audio");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () =>
        audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { generateSpeech } = await import("./_core/tts");
    const result = await generateSpeech({
      text: "test narration",
      voice: "nova",
      format: "mp3",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.contentType).toBe("audio/mpeg");
    expect(result.audioBuffer.length).toBeGreaterThan(0);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
  });

  it("generates speech with Gemini provider", async () => {
    setEnv({
      TTS_PROVIDER: "gemini",
      GEMINI_API_KEY: "test-gemini-key",
      TTS_MODEL: "gemini-2.5-flash-preview-tts",
    });
    vi.resetModules();

    const base64Audio = Buffer.from("gemini-audio").toString("base64");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: "audio/mpeg",
                    data: base64Audio,
                  },
                },
              ],
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { generateSpeech, getAvailableVoices } = await import("./_core/tts");
    const result = await generateSpeech({
      text: "gemini narration",
      voice: "Kore",
      format: "mp3",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.contentType).toBe("audio/mpeg");
    expect(result.audioBuffer.toString()).toBe("gemini-audio");

    const voices = getAvailableVoices();
    expect(voices.length).toBeGreaterThan(0);
    expect(voices[0].id).toBe("Kore");
  });

  it("returns validation error for text over max length", async () => {
    setEnv({
      TTS_PROVIDER: "openai",
      OPENAI_API_KEY: "test-openai-key",
    });
    vi.resetModules();

    const { generateSpeech } = await import("./_core/tts");
    const longText = "a".repeat(4097);
    const result = await generateSpeech({ text: longText });

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.code).toBe("TEXT_TOO_LONG");
    }
  });
});
