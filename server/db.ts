import { eq, desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users, projects, InsertProject, frames, InsertFrame, steps, InsertStep } from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// Project queries
export async function createProject(data: InsertProject) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(projects).values(data);
  return result[0].insertId;
}

export async function getProjectsByUserId(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(projects).where(eq(projects.userId, userId)).orderBy(desc(projects.createdAt));
}

export async function getProjectById(id: number, userId?: number) {
  const db = await getDb();
  if (!db) return undefined;
  // セキュリティ: userIdが指定された場合、所有者チェックを行う
  if (userId !== undefined) {
    const result = await db.select().from(projects)
      .where(eq(projects.id, id))
      .limit(1);
    const project = result[0];
    if (project && project.userId !== userId) {
      return undefined; // 他のユーザーのプロジェクトにはアクセス不可
    }
    return project;
  }
  const result = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return result[0];
}

export async function updateProjectStatus(id: number, status: "uploading" | "processing" | "completed" | "failed") {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(projects).set({ status }).where(eq(projects.id, id));
}

export async function updateProjectProgress(id: number, progress: number, message: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(projects).set({ 
    processingProgress: progress, 
    processingMessage: message 
  }).where(eq(projects.id, id));
}

export async function updateProjectError(id: number, errorMessage: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(projects).set({ 
    status: "failed",
    errorMessage: errorMessage 
  }).where(eq(projects.id, id));
}

// Frame queries
export async function createFrame(data: InsertFrame) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(frames).values(data);
  return result[0].insertId;
}

export async function getFramesByProjectId(projectId: number, userId?: number) {
  const db = await getDb();
  if (!db) return [];
  // セキュリティ: userIdが指定された場合、プロジェクトの所有者チェックを行う
  if (userId !== undefined) {
    const project = await getProjectById(projectId, userId);
    if (!project) return []; // プロジェクトが見つからないか、所有者が異なる場合は空配列
  }
  return db.select().from(frames).where(eq(frames.projectId, projectId)).orderBy(frames.sortOrder);
}

// Step queries
export async function createStep(data: InsertStep) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(steps).values(data);
  return result[0].insertId;
}

export async function getStepsByProjectId(projectId: number, userId?: number) {
  const db = await getDb();
  if (!db) return [];
  // セキュリティ: userIdが指定された場合、プロジェクトの所有者チェックを行う
  if (userId !== undefined) {
    const project = await getProjectById(projectId, userId);
    if (!project) return []; // プロジェクトが見つからないか、所有者が異なる場合は空配列
  }
  return db.select().from(steps).where(eq(steps.projectId, projectId)).orderBy(steps.sortOrder);
}

export async function updateStep(id: number, data: Partial<InsertStep>, userId?: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // セキュリティ: userIdが指定された場合、ステップの所有者チェックを行う
  if (userId !== undefined) {
    const step = await db.select().from(steps).where(eq(steps.id, id)).limit(1);
    if (step.length === 0) throw new Error("Step not found");
    const project = await getProjectById(step[0].projectId, userId);
    if (!project) throw new Error("Unauthorized");
  }
  await db.update(steps).set(data).where(eq(steps.id, id));
}

export async function deleteStep(id: number, userId?: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // セキュリティ: userIdが指定された場合、ステップの所有者チェックを行う
  if (userId !== undefined) {
    const step = await db.select().from(steps).where(eq(steps.id, id)).limit(1);
    if (step.length === 0) throw new Error("Step not found");
    const project = await getProjectById(step[0].projectId, userId);
    if (!project) throw new Error("Unauthorized");
  }
  await db.delete(steps).where(eq(steps.id, id));
}

// 再試行機能用のヘルパー関数
export async function deleteFramesByProjectId(projectId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(frames).where(eq(frames.projectId, projectId));
}

export async function deleteStepsByProjectId(projectId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(steps).where(eq(steps.projectId, projectId));
}

export async function clearProjectError(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(projects).set({
    errorMessage: null,
    processingProgress: 0,
    processingMessage: null,
  }).where(eq(projects.id, id));
}
