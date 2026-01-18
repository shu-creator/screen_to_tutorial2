import { describe, it, expect } from "vitest";
import { generateSpeech } from "./server/_core/tts";

describe("TTS API", () => {
  it("should generate speech using OpenAI API", async () => {
    const result = await generateSpeech({
      text: "これはテストです。",
      voice: "nova",
      model: "tts-1",
      speed: 1.0,
      format: "mp3",
    });

    if ("error" in result) {
      console.error("TTS Error:", result);
      throw new Error(`TTS generation failed: ${result.error} - ${result.details}`);
    }

    expect(result.audioBuffer).toBeInstanceOf(Buffer);
    expect(result.audioBuffer.length).toBeGreaterThan(0);
    expect(result.contentType).toBe("audio/mpeg");
  }, 30000); // 30 second timeout for API call
});
