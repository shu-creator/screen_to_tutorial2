import { invokeLLM } from "../../_core/llm";
import { buildChunkUserContent, SYSTEM_PROMPT } from "../prompt";
import { AUTHORING_JSON_SCHEMA } from "../schema";
import { parseAuthoringResponseText } from "./json";
import type { AuthoringProvider, AuthoringProviderInput } from "./types";

export function createLLMAuthoringProvider(): AuthoringProvider {
  return {
    async invokeChunk({
      globalContext,
      chunk,
      interimOverview,
    }: AuthoringProviderInput) {
      const response = await invokeLLM({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: buildChunkUserContent(
              globalContext,
              chunk,
              interimOverview
            ),
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: AUTHORING_JSON_SCHEMA,
        },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error("LLM応答が空です");
      }
      const raw =
        typeof content === "string" ? content : JSON.stringify(content);
      return parseAuthoringResponseText(raw);
    },
  };
}
