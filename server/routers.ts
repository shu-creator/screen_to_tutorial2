import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { z } from "zod";
import * as db from "./db";
import { processVideo } from "./videoProcessor";
import { generateStepsForProject, regenerateStep } from "./stepGenerator";
import { generateSlides } from "./slideGenerator";
import { generateAudioForProject, generateVideo } from "./videoGenerator";
import { storagePut } from "./storage";

// セキュリティ: エラーメッセージからセンシティブ情報を除去
function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    // スタックトレースやファイルパスを含まないメッセージのみを返す
    const message = error.message;
    // ファイルパスを除去
    const sanitized = message.replace(/\/[\w\/.-]+/g, "[path]");
    return sanitized.substring(0, 200); // 長すぎるメッセージを切り詰め
  }
  return "Unknown error";
}

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  project: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      return db.getProjectsByUserId(ctx.user.id);
    }),
    
    getById: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ ctx, input }) => {
        // セキュリティ: ユーザーIDによる所有者チェック
        return db.getProjectById(input.id, ctx.user.id);
      }),
    
    create: protectedProcedure
      .input(z.object({
        title: z.string(),
        description: z.string().optional(),
        videoBase64: z.string(),
        fileName: z.string(),
        contentType: z.string(),
      }))
      .mutation(async ({ ctx, input }) => {
        // Base64からバッファに変換
        const videoBuffer = Buffer.from(input.videoBase64, "base64");
        const videoKey = `projects/${ctx.user.id}/videos/${Date.now()}_${input.fileName}`;

        // ストレージにアップロード
        const { url: videoUrl } = await storagePut(videoKey, videoBuffer, input.contentType);

        const projectId = await db.createProject({
          userId: ctx.user.id,
          title: input.title,
          description: input.description,
          videoUrl,
          videoKey,
          status: "uploading",
        });
        return { projectId, videoUrl, videoKey };
      }),
    
    updateStatus: protectedProcedure
      .input(z.object({
        id: z.number(),
        status: z.enum(["uploading", "processing", "completed", "failed"]),
      }))
      .mutation(async ({ input }) => {
        await db.updateProjectStatus(input.id, input.status);
        return { success: true };
      }),
    
    processVideo: protectedProcedure
      .input(z.object({
        projectId: z.number(),
        videoUrl: z.string(),
        threshold: z.number().optional(),
        minInterval: z.number().optional(),
        maxFrames: z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        const { projectId, videoUrl, threshold, minInterval, maxFrames } = input;
        
        // ステータスを処理中に更新
        await db.updateProjectStatus(projectId, "processing");
        
        try {
          // 動画を処理（バックグラウンドで実行）
          processVideo(projectId, videoUrl, { threshold, minInterval, maxFrames })
            .then(async () => {
              await db.updateProjectStatus(projectId, "completed");
            })
            .catch(async (error) => {
              // セキュリティ: エラーメッセージをサニタイズ
              const safeErrorMsg = sanitizeError(error);
              console.error(`[VideoProcessor] Error processing project ${projectId}: ${safeErrorMsg}`);
              await db.updateProjectStatus(projectId, "failed");
            });

          return { success: true, message: "Processing started" };
        } catch (error) {
          await db.updateProjectStatus(projectId, "failed");
          throw error;
        }
      }),
  }),
  
  frame: router({
    listByProject: protectedProcedure
      .input(z.object({ projectId: z.number() }))
      .query(async ({ ctx, input }) => {
        // セキュリティ: ユーザーIDによる所有者チェック
        return db.getFramesByProjectId(input.projectId, ctx.user.id);
      }),
  }),

  step: router({
    listByProject: protectedProcedure
      .input(z.object({ projectId: z.number() }))
      .query(async ({ ctx, input }) => {
        // セキュリティ: ユーザーIDによる所有者チェック
        return db.getStepsByProjectId(input.projectId, ctx.user.id);
      }),

    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        title: z.string().optional(),
        operation: z.string().optional(),
        description: z.string().optional(),
        narration: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { id, ...data } = input;
        // セキュリティ: ユーザーIDによる所有者チェック
        await db.updateStep(id, data, ctx.user.id);
        return { success: true };
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        // セキュリティ: ユーザーIDによる所有者チェック
        await db.deleteStep(input.id, ctx.user.id);
        return { success: true };
      }),
    
    generate: protectedProcedure
      .input(z.object({ projectId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        // セキュリティ: プロジェクトの所有者チェック
        const project = await db.getProjectById(input.projectId, ctx.user.id);
        if (!project) {
          throw new Error("プロジェクトが見つかりません");
        }

        // バックグラウンドでステップ生成を実行
        generateStepsForProject(input.projectId)
          .then(() => {
            console.log(`[StepGenerator] Steps generated for project ${input.projectId}`);
          })
          .catch((error) => {
            // セキュリティ: エラーメッセージをサニタイズ
            const safeErrorMsg = sanitizeError(error);
            console.error(`[StepGenerator] Error generating steps for project ${input.projectId}: ${safeErrorMsg}`);
          });

        return { success: true, message: "Step generation started" };
      }),
    
    regenerate: protectedProcedure
      .input(z.object({ stepId: z.number(), frameId: z.number() }))
      .mutation(async ({ input }) => {
        await regenerateStep(input.stepId, input.frameId);
        return { success: true };
      }),
  }),
  
  slide: router({
    generate: protectedProcedure
      .input(z.object({ projectId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        // セキュリティ: プロジェクトの所有者チェック
        const project = await db.getProjectById(input.projectId, ctx.user.id);
        if (!project) {
          throw new Error("プロジェクトが見つかりません");
        }
        const slideUrl = await generateSlides(input.projectId);
        return { success: true, slideUrl };
      }),
  }),

  video: router({
    generateAudio: protectedProcedure
      .input(z.object({ projectId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        // セキュリティ: プロジェクトの所有者チェック
        const project = await db.getProjectById(input.projectId, ctx.user.id);
        if (!project) {
          throw new Error("プロジェクトが見つかりません");
        }
        await generateAudioForProject(input.projectId);
        return { success: true };
      }),

    generate: protectedProcedure
      .input(z.object({ projectId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        // セキュリティ: プロジェクトの所有者チェック
        const project = await db.getProjectById(input.projectId, ctx.user.id);
        if (!project) {
          throw new Error("プロジェクトが見つかりません");
        }
        const videoUrl = await generateVideo(input.projectId);
        return { success: true, videoUrl };
      }),
  }),
});

export type AppRouter = typeof appRouter;
