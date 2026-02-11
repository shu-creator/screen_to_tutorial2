import { z } from "zod";
import { ENV } from "./env";
import { protectedProcedure, publicProcedure, router } from "./trpc";

export const systemRouter = router({
  health: publicProcedure
    .input(
      z.object({
        timestamp: z.number().min(0, "timestamp cannot be negative"),
      })
    )
    .query(() => ({
      ok: true,
    })),
  info: protectedProcedure.query(() => ({
    authMode: ENV.authMode,
    isProduction: ENV.isProduction,
    llmProvider: ENV.llmProvider,
    llmModel: ENV.llmModel,
    llmApiKeyConfigured: Boolean(ENV.llmApiKey),
    ttsProvider: ENV.ttsProvider,
    ttsModel: ENV.ttsModel,
    ttsApiKeyConfigured: Boolean(ENV.ttsApiKey),
  })),
});
