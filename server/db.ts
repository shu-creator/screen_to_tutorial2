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

export async function getProjectById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return result[0];
}

export async function updateProjectStatus(id: number, status: "uploading" | "processing" | "completed" | "failed") {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(projects).set({ status }).where(eq(projects.id, id));
}

// Frame queries
export async function createFrame(data: InsertFrame) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(frames).values(data);
  return result[0].insertId;
}

export async function getFramesByProjectId(projectId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(frames).where(eq(frames.projectId, projectId)).orderBy(frames.sortOrder);
}

// Step queries
export async function createStep(data: InsertStep) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(steps).values(data);
  return result[0].insertId;
}

export async function getStepsByProjectId(projectId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(steps).where(eq(steps.projectId, projectId)).orderBy(steps.sortOrder);
}

export async function updateStep(id: number, data: Partial<InsertStep>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(steps).set(data).where(eq(steps.id, id));
}

export async function deleteStep(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(steps).where(eq(steps.id, id));
}
