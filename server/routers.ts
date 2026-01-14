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
      .query(async ({ input }) => {
        return db.getProjectById(input.id);
      }),
    
    create: protectedProcedure
      .input(z.object({
        title: z.string(),
        description: z.string().optional(),
        videoUrl: z.string(),
        videoKey: z.string(),
      }))
      .mutation(async ({ ctx, input }) => {
        const projectId = await db.createProject({
          userId: ctx.user.id,
          title: input.title,
          description: input.description,
          videoUrl: input.videoUrl,
          videoKey: input.videoKey,
          status: "uploading",
        });
        return { projectId };
      }),

    uploadVideo: protectedProcedure
      .input(
        z.object({
          title: z.string(),
          description: z.string().optional(),
          fileName: z.string(),
          fileData: z.string(),
          mimeType: z.string(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { storagePut } = await import("./storage");
        const { nanoid } = await import("nanoid");

        const fileBuffer = Buffer.from(input.fileData, "base64");
        const fileKey = `projects/${ctx.user.id}/videos/${nanoid()}_${input.fileName}`;
        const { url: videoUrl } = await storagePut(fileKey, fileBuffer, input.mimeType);

        const projectId = await db.createProject({
          userId: ctx.user.id,
          title: input.title,
          description: input.description,
          videoUrl,
          videoKey: fileKey,
          status: "processing",
        });

        processVideo(projectId, videoUrl).catch((error) => {
          console.error(`Failed to process video for project ${projectId}:`, error);
        });

        return { projectId, videoUrl };
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
              console.error(`[VideoProcessor] Error processing project ${projectId}:`, error);
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
      .query(async ({ input }) => {
        return db.getFramesByProjectId(input.projectId);
      }),
  }),
  
  step: router({
    listByProject: protectedProcedure
      .input(z.object({ projectId: z.number() }))
      .query(async ({ input }) => {
        return db.getStepsByProjectId(input.projectId);
      }),
    
    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        title: z.string().optional(),
        operation: z.string().optional(),
        description: z.string().optional(),
        narration: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        await db.updateStep(id, data);
        return { success: true };
      }),
    
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.deleteStep(input.id);
        return { success: true };
      }),
    
    generate: protectedProcedure
      .input(z.object({ projectId: z.number() }))
      .mutation(async ({ input }) => {
        // バックグラウンドでステップ生成を実行
        generateStepsForProject(input.projectId)
          .then(() => {
            console.log(`[StepGenerator] Steps generated for project ${input.projectId}`);
          })
          .catch((error) => {
            console.error(`[StepGenerator] Error generating steps:`, error);
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
      .mutation(async ({ input }) => {
        const slideUrl = await generateSlides(input.projectId);
        return { success: true, slideUrl };
      }),
  }),
  
  video: router({
    generateAudio: protectedProcedure
      .input(z.object({ projectId: z.number() }))
      .mutation(async ({ input }) => {
        await generateAudioForProject(input.projectId);
        return { success: true };
      }),
    
    generate: protectedProcedure
      .input(z.object({ projectId: z.number() }))
      .mutation(async ({ input }) => {
        const videoUrl = await generateVideo(input.projectId);
        return { success: true, videoUrl };
      }),
  }),
});

export type AppRouter = typeof appRouter;
