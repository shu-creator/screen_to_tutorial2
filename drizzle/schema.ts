import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, index } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Projects table - stores video processing projects
 */
export const projects = mysqlTable("projects", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  videoUrl: text("videoUrl").notNull(),
  videoKey: varchar("videoKey", { length: 512 }).notNull(),
  status: mysqlEnum("status", ["uploading", "processing", "completed", "failed"]).default("uploading").notNull(),
  processingProgress: int("processingProgress").default(0), // 0-100の進捗率
  processingMessage: text("processingMessage"), // 現在の処理ステップメッセージ
  errorMessage: text("errorMessage"), // エラー発生時の詳細メッセージ
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  userIdIdx: index("projects_userId_idx").on(table.userId),
  statusIdx: index("projects_status_idx").on(table.status),
}));

export type Project = typeof projects.$inferSelect;
export type InsertProject = typeof projects.$inferInsert;

/**
 * Frames table - stores extracted key frames from videos
 */
export const frames = mysqlTable("frames", {
  id: int("id").autoincrement().primaryKey(),
  projectId: int("projectId").notNull().references(() => projects.id, { onDelete: "cascade" }),
  frameNumber: int("frameNumber").notNull(),
  timestamp: int("timestamp").notNull(), // milliseconds
  imageUrl: text("imageUrl").notNull(),
  imageKey: varchar("imageKey", { length: 512 }).notNull(),
  diffScore: int("diffScore"), // difference score from previous frame
  sortOrder: int("sortOrder").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  projectIdIdx: index("frames_projectId_idx").on(table.projectId),
}));

export type Frame = typeof frames.$inferSelect;
export type InsertFrame = typeof frames.$inferInsert;

/**
 * Steps table - stores AI-generated step descriptions for each frame
 */
export const steps = mysqlTable("steps", {
  id: int("id").autoincrement().primaryKey(),
  frameId: int("frameId").notNull().references(() => frames.id, { onDelete: "cascade" }),
  projectId: int("projectId").notNull().references(() => projects.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 255 }).notNull(),
  operation: text("operation").notNull(),
  description: text("description").notNull(),
  narration: text("narration"),
  audioUrl: text("audioUrl"),
  audioKey: varchar("audioKey", { length: 512 }),
  sortOrder: int("sortOrder").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  projectIdIdx: index("steps_projectId_idx").on(table.projectId),
  frameIdIdx: index("steps_frameId_idx").on(table.frameId),
}));

export type Step = typeof steps.$inferSelect;
export type InsertStep = typeof steps.$inferInsert;