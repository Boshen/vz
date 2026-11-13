import { integer, sqliteTable, text, uniqueIndex, index, primaryKey } from "void/schema-d1";
import type { BuildManifest, Provenance, ArtifactManifest } from "@vz/protocol";

export const repositories = sqliteTable("repositories", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  name: text("name").notNull(),
  installationId: integer("installation_id").notNull(),
  isPrivate: integer("is_private", { mode: "boolean" }).notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});
export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
  },
  (table) => [uniqueIndex("project_repository_key").on(table.repositoryId, table.key)],
);
export const builds = sqliteTable(
  "builds",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    captureId: text("capture_id").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    artifactCount: integer("artifact_count").notNull().default(0),
    manifest: text("manifest", { mode: "json" }).$type<BuildManifest>().notNull(),
    provenance: text("provenance", { mode: "json" }).$type<Provenance>().notNull(),
    state: text("state", { enum: ["uploading", "ready", "deleting"] })
      .notNull()
      .default("uploading"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("build_capture").on(table.projectId, table.captureId),
    index("build_project_created").on(table.projectId, table.createdAt),
  ],
);
export const artifacts = sqliteTable(
  "artifacts",
  {
    buildId: text("build_id")
      .notNull()
      .references(() => builds.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    description: text("description", { mode: "json" }).$type<ArtifactManifest>().notNull(),
    multipartId: text("multipart_id"),
    state: text("state", { enum: ["uploading", "verifying", "ready"] })
      .notNull()
      .default("uploading"),
  },
  (table) => [primaryKey({ columns: [table.buildId, table.id] })],
);
export const uploadParts = sqliteTable(
  "upload_parts",
  {
    buildId: text("build_id")
      .notNull()
      .references(() => builds.id, { onDelete: "cascade" }),
    artifactId: text("artifact_id").notNull(),
    part: integer("part").notNull(),
    etag: text("etag").notNull(),
    bytes: integer("bytes").notNull(),
  },
  (table) => [primaryKey({ columns: [table.buildId, table.artifactId, table.part] })],
);
export const webhookDeliveries = sqliteTable("webhook_deliveries", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
});

export const trendIndex = sqliteTable("trend_index", {
  buildId: text("build_id")
    .primaryKey()
    .references(() => builds.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
});
export const trendMeasurements = sqliteTable(
  "trend_measurements",
  {
    buildId: text("build_id")
      .notNull()
      .references(() => builds.id, { onDelete: "cascade" }),
    dataset: text("dataset").notNull(),
    entity: text("entity").notNull(),
    label: text("label").notNull(),
    metrics: text("metrics", { mode: "json" }).$type<Record<string, number>>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.buildId, table.dataset, table.entity] }),
    index("trend_dataset_entity_build").on(table.dataset, table.entity, table.buildId),
    index("trend_build_dataset_label_entity").on(
      table.buildId,
      table.dataset,
      table.label,
      table.entity,
    ),
  ],
);
