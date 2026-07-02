import { parseRawAuthoringResponse } from "../schema";
import type { RawAuthoringResponse } from "../schema";

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractFirstBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = start; index < text.length; index++) {
    const char = text[index];

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth++;
      continue;
    }
    if (char === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

export function extractJsonObjectText(rawText: string): string {
  const text = rawText.trim();
  if (text.length === 0) {
    throw new Error("Authoring response is empty");
  }

  if (tryParseJson(text) !== null) {
    return text;
  }

  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  let block = fencePattern.exec(text);
  while (block) {
    const candidate = block[1]?.trim() ?? "";
    if (candidate && tryParseJson(candidate) !== null) {
      return candidate;
    }
    block = fencePattern.exec(text);
  }

  const balanced = extractFirstBalancedObject(text);
  if (balanced && tryParseJson(balanced) !== null) {
    return balanced;
  }

  throw new Error("Authoring response did not contain a valid JSON object");
}

export function parseAuthoringResponseText(
  rawText: string
): RawAuthoringResponse {
  const jsonText = extractJsonObjectText(rawText);
  return parseRawAuthoringResponse(JSON.parse(jsonText));
}
