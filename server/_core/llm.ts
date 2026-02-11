import fs from "fs/promises";
import path from "path";
import { ENV, type LLMProvider } from "./env";
import {
  isLocalStorageUrl,
  resolveLocalStoragePathFromUrl,
} from "../storage";

export type Role = "system" | "user" | "assistant" | "tool" | "function";

export type TextContent = {
  type: "text";
  text: string;
};

export type ImageContent = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
};

export type FileContent = {
  type: "file_url";
  file_url: {
    url: string;
    mime_type?:
      | "audio/mpeg"
      | "audio/wav"
      | "application/pdf"
      | "audio/mp4"
      | "video/mp4";
  };
};

export type MessageContent = string | TextContent | ImageContent | FileContent;

export type Message = {
  role: Role;
  content: MessageContent | MessageContent[];
  name?: string;
  tool_call_id?: string;
};

export type Tool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type ToolChoicePrimitive = "none" | "auto" | "required";
export type ToolChoiceByName = { name: string };
export type ToolChoiceExplicit = {
  type: "function";
  function: {
    name: string;
  };
};

export type ToolChoice =
  | ToolChoicePrimitive
  | ToolChoiceByName
  | ToolChoiceExplicit;

export type InvokeParams = {
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  tool_choice?: ToolChoice;
  maxTokens?: number;
  max_tokens?: number;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type InvokeResult = {
  id: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: Role;
      content: string | Array<TextContent | ImageContent | FileContent>;
      tool_calls?: ToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type JsonSchema = {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
};

export type OutputSchema = JsonSchema;

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: JsonSchema };

type NormalizedResponseFormat =
  | { type: "json_schema"; json_schema: JsonSchema }
  | { type: "text" }
  | { type: "json_object" }
  | undefined;

type BinaryPayload = {
  base64: string;
  mimeType: string;
  dataUrl: string;
};

interface LLMAdapter {
  invoke(params: InvokeParams): Promise<InvokeResult>;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

const ensureArray = (
  value: MessageContent | MessageContent[]
): MessageContent[] => (Array.isArray(value) ? value : [value]);

function getMaxTokens(params: InvokeParams): number {
  return params.maxTokens ?? params.max_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
}

const normalizeToolChoice = (
  toolChoice: ToolChoice | undefined,
  tools: Tool[] | undefined
): "none" | "auto" | ToolChoiceExplicit | undefined => {
  if (!toolChoice) return undefined;

  if (toolChoice === "none" || toolChoice === "auto") {
    return toolChoice;
  }

  if (toolChoice === "required") {
    if (!tools || tools.length === 0) {
      throw new Error(
        "tool_choice 'required' was provided but no tools were configured"
      );
    }

    if (tools.length > 1) {
      throw new Error(
        "tool_choice 'required' needs a single tool or specify the tool name explicitly"
      );
    }

    return {
      type: "function",
      function: { name: tools[0].function.name },
    };
  }

  if ("name" in toolChoice) {
    return {
      type: "function",
      function: { name: toolChoice.name },
    };
  }

  return toolChoice;
};

const normalizeResponseFormat = ({
  responseFormat,
  response_format,
  outputSchema,
  output_schema,
}: {
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
}): NormalizedResponseFormat => {
  const explicitFormat = responseFormat || response_format;
  if (explicitFormat) {
    if (
      explicitFormat.type === "json_schema" &&
      !explicitFormat.json_schema?.schema
    ) {
      throw new Error(
        "responseFormat json_schema requires a defined schema object"
      );
    }
    return explicitFormat;
  }

  const schema = outputSchema || output_schema;
  if (!schema) return undefined;

  if (!schema.name || !schema.schema) {
    throw new Error("outputSchema requires both name and schema");
  }

  return {
    type: "json_schema",
    json_schema: {
      name: schema.name,
      schema: schema.schema,
      ...(typeof schema.strict === "boolean" ? { strict: schema.strict } : {}),
    },
  };
};

function parseDataUrl(dataUrl: string): BinaryPayload {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error("Invalid data URL for image input");
  }
  return {
    mimeType: match[1],
    base64: match[2],
    dataUrl,
  };
}

function inferMimeType(url: string, contentType?: string): string {
  if (contentType && contentType.length > 0) {
    return contentType.split(";")[0].trim();
  }

  const ext = path.extname(url.toLowerCase());
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

async function loadBinaryPayload(url: string): Promise<BinaryPayload> {
  if (url.startsWith("data:")) {
    return parseDataUrl(url);
  }

  if (isLocalStorageUrl(url)) {
    const filePath = resolveLocalStoragePathFromUrl(url);
    const buffer = await fs.readFile(filePath);
    const mimeType = inferMimeType(filePath);
    const base64 = buffer.toString("base64");
    return {
      base64,
      mimeType,
      dataUrl: `data:${mimeType};base64,${base64}`,
    };
  }

  if (url.startsWith("http://") || url.startsWith("https://")) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch image: ${response.status} ${response.statusText}`
      );
    }
    const mimeType = inferMimeType(url, response.headers.get("content-type") ?? undefined);
    const base64 = Buffer.from(await response.arrayBuffer()).toString("base64");
    return {
      base64,
      mimeType,
      dataUrl: `data:${mimeType};base64,${base64}`,
    };
  }

  const filePath = path.resolve(url);
  const buffer = await fs.readFile(filePath);
  const mimeType = inferMimeType(filePath);
  const base64 = buffer.toString("base64");
  return {
    base64,
    mimeType,
    dataUrl: `data:${mimeType};base64,${base64}`,
  };
}

function flattenTextContent(parts: MessageContent[]): string {
  return parts
    .map((part) => {
      if (typeof part === "string") return part;
      if (part.type === "text") return part.text;
      if (part.type === "image_url") return `[image:${part.image_url.url}]`;
      return `[file:${part.file_url.url}]`;
    })
    .join("\n");
}

class OpenAIAdapter implements LLMAdapter {
  async invoke(params: InvokeParams): Promise<InvokeResult> {
    if (!ENV.llmApiKey) {
      throw new Error("LLM API key is not configured");
    }

    const responseFormat = normalizeResponseFormat(params);

    const input = await Promise.all(
      params.messages.map(async (message) => {
        const parts = ensureArray(message.content);
        const content = await Promise.all(
          parts.map(async (part) => {
            if (typeof part === "string") {
              return { type: "input_text", text: part };
            }
            if (part.type === "text") {
              return { type: "input_text", text: part.text };
            }
            if (part.type === "image_url") {
              const payload = await loadBinaryPayload(part.image_url.url);
              return { type: "input_image", image_url: payload.dataUrl };
            }
            return {
              type: "input_text",
              text: `[file:${part.file_url.mime_type ?? "unknown"}] ${part.file_url.url}`,
            };
          })
        );

        const role =
          message.role === "assistant"
            ? "assistant"
            : message.role === "system"
              ? "system"
              : "user";

        return { role, content };
      })
    );

    const body: Record<string, unknown> = {
      model: ENV.llmModel,
      input,
      max_output_tokens: getMaxTokens(params),
    };

    if (responseFormat) {
      if (responseFormat.type === "json_schema") {
        body.text = {
          format: {
            type: "json_schema",
            name: responseFormat.json_schema.name,
            schema: responseFormat.json_schema.schema,
            strict: responseFormat.json_schema.strict ?? true,
          },
        };
      } else if (responseFormat.type === "json_object") {
        body.text = {
          format: {
            type: "json_schema",
            name: "json_object",
            schema: {
              type: "object",
              additionalProperties: true,
            },
            strict: false,
          },
        };
      }
    }

    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools.map((tool) => ({
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      }));
    }

    const normalizedToolChoice = normalizeToolChoice(
      params.toolChoice || params.tool_choice,
      params.tools
    );
    if (normalizedToolChoice) {
      body.tool_choice = normalizedToolChoice;
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ENV.llmApiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `LLM invoke failed: ${response.status} ${response.statusText} – ${errorText}`
      );
    }

    const json = (await response.json()) as {
      id: string;
      created_at?: number;
      model: string;
      output?: Array<{
        type?: string;
        content?: Array<{ type?: string; text?: string }>;
      }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    let content = "";
    for (const outputItem of json.output ?? []) {
      for (const c of outputItem.content ?? []) {
        if ((c.type === "output_text" || c.type === "text") && c.text) {
          content += c.text;
        }
      }
    }

    return {
      id: json.id,
      created: json.created_at ?? Date.now(),
      model: json.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
          },
          finish_reason: "stop",
        },
      ],
      usage: json.usage
        ? {
            prompt_tokens: json.usage.input_tokens ?? 0,
            completion_tokens: json.usage.output_tokens ?? 0,
            total_tokens:
              (json.usage.input_tokens ?? 0) + (json.usage.output_tokens ?? 0),
          }
        : undefined,
    };
  }
}

class GeminiAdapter implements LLMAdapter {
  async invoke(params: InvokeParams): Promise<InvokeResult> {
    if (!ENV.llmApiKey) {
      throw new Error("LLM API key is not configured");
    }

    const responseFormat = normalizeResponseFormat(params);
    const systemTexts: string[] = [];

    const contents = await Promise.all(
      params.messages
        .filter((message) => {
          if (message.role === "system") {
            systemTexts.push(flattenTextContent(ensureArray(message.content)));
            return false;
          }
          return true;
        })
        .map(async (message) => {
          const role = message.role === "assistant" ? "model" : "user";
          const parts = await Promise.all(
            ensureArray(message.content).map(async (part) => {
              if (typeof part === "string") {
                return { text: part };
              }
              if (part.type === "text") {
                return { text: part.text };
              }
              if (part.type === "image_url") {
                const payload = await loadBinaryPayload(part.image_url.url);
                return {
                  inlineData: {
                    mimeType: payload.mimeType,
                    data: payload.base64,
                  },
                };
              }
              return { text: `[file:${part.file_url.mime_type ?? "unknown"}] ${part.file_url.url}` };
            })
          );

          return { role, parts };
        })
    );

    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: getMaxTokens(params),
    };

    if (responseFormat) {
      if (responseFormat.type === "json_schema") {
        generationConfig.responseMimeType = "application/json";
        generationConfig.responseSchema = responseFormat.json_schema.schema;
      } else if (responseFormat.type === "json_object") {
        generationConfig.responseMimeType = "application/json";
      }
    }

    const body: Record<string, unknown> = {
      contents,
      generationConfig,
    };

    if (systemTexts.length > 0) {
      body.systemInstruction = {
        parts: [{ text: systemTexts.join("\n\n") }],
      };
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ENV.llmModel)}:generateContent?key=${encodeURIComponent(ENV.llmApiKey)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `LLM invoke failed: ${response.status} ${response.statusText} – ${errorText}`
      );
    }

    const json = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
        finishReason?: string;
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
      modelVersion?: string;
    };

    const candidate = json.candidates?.[0];
    const content = (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("");

    const promptTokens = json.usageMetadata?.promptTokenCount ?? 0;
    const completionTokens = json.usageMetadata?.candidatesTokenCount ?? 0;

    return {
      id: `gemini-${Date.now()}`,
      created: Date.now(),
      model: json.modelVersion ?? ENV.llmModel,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
          },
          finish_reason: candidate?.finishReason ?? "stop",
        },
      ],
      usage: json.usageMetadata
        ? {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens:
              json.usageMetadata.totalTokenCount ??
              promptTokens + completionTokens,
          }
        : undefined,
    };
  }
}

class ClaudeAdapter implements LLMAdapter {
  async invoke(params: InvokeParams): Promise<InvokeResult> {
    if (!ENV.llmApiKey) {
      throw new Error("LLM API key is not configured");
    }

    const responseFormat = normalizeResponseFormat(params);
    const system: string[] = [];

    const messages = await Promise.all(
      params.messages
        .filter((message) => {
          if (message.role === "system") {
            system.push(flattenTextContent(ensureArray(message.content)));
            return false;
          }
          return true;
        })
        .map(async (message) => {
          const role = message.role === "assistant" ? "assistant" : "user";

          const content = await Promise.all(
            ensureArray(message.content).map(async (part) => {
              if (typeof part === "string") {
                return { type: "text", text: part };
              }
              if (part.type === "text") {
                return { type: "text", text: part.text };
              }
              if (part.type === "image_url") {
                const payload = await loadBinaryPayload(part.image_url.url);
                return {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: payload.mimeType,
                    data: payload.base64,
                  },
                };
              }
              return {
                type: "text",
                text: `[file:${part.file_url.mime_type ?? "unknown"}] ${part.file_url.url}`,
              };
            })
          );

          return { role, content };
        })
    );

    const body: Record<string, unknown> = {
      model: ENV.llmModel,
      max_tokens: Math.min(getMaxTokens(params), 8192),
      messages,
    };

    if (system.length > 0) {
      body.system = system.join("\n\n");
    }

    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters ?? {},
      }));
    }

    const normalizedToolChoice = normalizeToolChoice(
      params.toolChoice || params.tool_choice,
      params.tools
    );
    if (normalizedToolChoice === "auto" || normalizedToolChoice === "none") {
      body.tool_choice = { type: normalizedToolChoice };
    } else if (normalizedToolChoice?.type === "function") {
      body.tool_choice = {
        type: "tool",
        name: normalizedToolChoice.function.name,
      };
    }

    if (responseFormat?.type === "json_schema") {
      body.output_config = {
        format: {
          type: "json_schema",
          json_schema: {
            name: responseFormat.json_schema.name,
            schema: responseFormat.json_schema.schema,
          },
        },
      };
    } else if (responseFormat?.type === "json_object") {
      body.output_config = {
        format: {
          type: "json_schema",
          json_schema: {
            name: "json_object",
            schema: { type: "object", additionalProperties: true },
          },
        },
      };
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ENV.llmApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `LLM invoke failed: ${response.status} ${response.statusText} – ${errorText}`
      );
    }

    const json = (await response.json()) as {
      id: string;
      model: string;
      content?: Array<{ type?: string; text?: string }>;
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const content = (json.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");

    const promptTokens = json.usage?.input_tokens ?? 0;
    const completionTokens = json.usage?.output_tokens ?? 0;

    return {
      id: json.id,
      created: Date.now(),
      model: json.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
          },
          finish_reason: json.stop_reason ?? "stop",
        },
      ],
      usage: json.usage
        ? {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          }
        : undefined,
    };
  }
}

function createLLMAdapter(provider: LLMProvider): LLMAdapter {
  if (provider === "openai") {
    return new OpenAIAdapter();
  }
  if (provider === "gemini") {
    return new GeminiAdapter();
  }
  return new ClaudeAdapter();
}

export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  const adapter = createLLMAdapter(ENV.llmProvider);
  return adapter.invoke(params);
}
