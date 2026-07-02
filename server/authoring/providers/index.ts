import {
  ENV,
  type AuthoringProvider as AuthoringProviderName,
} from "../../_core/env";
import { createCodexAppServerAuthoringProvider } from "./codexAppServer";
import { createLLMAuthoringProvider } from "./llm";
import type { AuthoringProvider } from "./types";

export function createAuthoringProvider(
  provider: AuthoringProviderName = ENV.authoringProvider
): AuthoringProvider {
  if (provider === "codex_app_server") {
    return createCodexAppServerAuthoringProvider();
  }
  return createLLMAuthoringProvider();
}

export type { AuthoringProvider, AuthoringProviderInput } from "./types";
