import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };
const tinyPngDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6s8QAAAABJRU5ErkJggg==";

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

describe("invokeLLM provider adapters", () => {
  it("uses OpenAI Responses API with image + json schema", async () => {
    setEnv({
      LLM_PROVIDER: "openai",
      OPENAI_API_KEY: "test-openai-key",
      LLM_MODEL: "gpt-5.2",
    });
    vi.resetModules();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "resp_1",
        created_at: 123,
        model: "gpt-5.2",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "{\"title\":\"ok\"}" }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { invokeLLM } = await import("./llm");

    const result = await invokeLLM({
      messages: [
        { role: "system", content: "analyze screenshot" },
        {
          role: "user",
          content: [
            { type: "text", text: "please analyze" },
            { type: "image_url", image_url: { url: tinyPngDataUrl } },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "step_analysis",
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
            additionalProperties: false,
          },
          strict: true,
        },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("gpt-5.2");
    expect(body.text.format.type).toBe("json_schema");
    expect(body.input[1].content.some((c: { type: string }) => c.type === "input_image")).toBe(true);
    expect(result.choices[0]?.message.content).toBe("{\"title\":\"ok\"}");
  });

  it("uses Gemini generateContent with responseSchema", async () => {
    setEnv({
      LLM_PROVIDER: "gemini",
      GEMINI_API_KEY: "test-gemini-key",
      LLM_MODEL: "gemini-3-flash-preview",
    });
    vi.resetModules();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [{ text: "{\"title\":\"gemini\"}" }],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 12,
          candidatesTokenCount: 6,
          totalTokenCount: 18,
        },
        modelVersion: "gemini-3-flash-preview",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { invokeLLM } = await import("./llm");

    await invokeLLM({
      messages: [{ role: "user", content: "analyze this frame" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "step_analysis",
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
          },
        },
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(url).toContain("key=test-gemini-key");
    const body = JSON.parse(String(init.body));
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema.type).toBe("object");
  });

  it("uses Claude messages API with base64 image conversion", async () => {
    setEnv({
      LLM_PROVIDER: "claude",
      ANTHROPIC_API_KEY: "test-anthropic-key",
      LLM_MODEL: "claude-sonnet-4-5",
    });
    vi.resetModules();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "msg_1",
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "{\"title\":\"claude\"}" }],
        usage: { input_tokens: 9, output_tokens: 4 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { invokeLLM } = await import("./llm");

    await invokeLLM({
      messages: [
        { role: "system", content: "return json" },
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image_url", image_url: { url: tinyPngDataUrl } },
          ],
        },
      ],
      response_format: {
        type: "json_object",
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const body = JSON.parse(String(init.body));
    const imagePart = body.messages[0].content.find(
      (part: { type: string }) => part.type === "image"
    );
    expect(imagePart).toBeDefined();
    expect(imagePart.source.type).toBe("base64");
    expect(imagePart.source.media_type).toBe("image/png");
    expect(body.output_config.format.type).toBe("json_schema");
  });
});
