import { defineConfig } from "drizzle-kit";

const connectionString = process.env.DATABASE_URL ?? "mysql://root:password@localhost:3306/tutorialgen";

export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle",
  dialect: "mysql",
  dbCredentials: {
    url: connectionString,
  },
});
