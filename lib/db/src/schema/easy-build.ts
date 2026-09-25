import { createInsertSchema } from "drizzle-zod";
import {
  bigint,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const easyBuildSessionsTable = pgTable("easy_build_sessions", {
  id: text("id").primaryKey(),
  githubAccessTokenEncrypted: text("github_access_token_encrypted"),
  githubUserId: bigint("github_user_id", { mode: "number" }),
  githubLogin: text("github_login"),
  githubAvatarUrl: text("github_avatar_url"),
  oauthState: text("oauth_state"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const easyBuildBuildsTable = pgTable(
  "easy_build_builds",
  {
    id: uuid("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => easyBuildSessionsTable.id, { onDelete: "cascade" }),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    sourceBranch: text("source_branch").notNull(),
    runBranch: text("run_branch").notNull(),
    repairBranch: text("repair_branch").notNull(),
    status: text("status")
      .$type<"queued" | "in_progress" | "success" | "failure" | "cancelled">()
      .notNull()
      .default("queued"),
    attempt: integer("attempt").notNull().default(0),
    runId: bigint("run_id", { mode: "number" }),
    artifactId: bigint("artifact_id", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("easy_build_builds_session_id_idx").on(table.sessionId),
    index("easy_build_builds_repo_idx").on(table.owner, table.repo),
  ],
);

export const easyBuildEventsTable = pgTable(
  "easy_build_events",
  {
    id: serial("id").primaryKey(),
    buildId: uuid("build_id")
      .notNull()
      .references(() => easyBuildBuildsTable.id, { onDelete: "cascade" }),
    message: text("message").notNull(),
    level: text("level").$type<"info" | "success" | "warning" | "error">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("easy_build_events_build_id_idx").on(table.buildId)],
);

export const insertEasyBuildSessionSchema = createInsertSchema(
  easyBuildSessionsTable,
).omit({ createdAt: true });
export const insertEasyBuildBuildSchema = createInsertSchema(
  easyBuildBuildsTable,
).omit({ createdAt: true, updatedAt: true });
export const insertEasyBuildEventSchema = createInsertSchema(
  easyBuildEventsTable,
).omit({ id: true, createdAt: true });

export type EasyBuildSession = z.infer<typeof insertEasyBuildSessionSchema>;
export type EasyBuildBuild = typeof easyBuildBuildsTable.$inferSelect;
export type EasyBuildEvent = typeof easyBuildEventsTable.$inferSelect;