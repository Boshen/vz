import { createHash } from "node:crypto";
import { db, and, eq, desc, lt, or, sql, isNull, inArray } from "void/db";
import { storage } from "void/storage";
import type { CloudContext } from "void";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  diagnosticIdentity,
  diagnosticMetrics,
  datasets,
  type DiagnosticRow,
  type ArtifactManifest,
} from "@vz/protocol";
import {
  artifacts,
  builds,
  projects,
  repositories,
  trendIndex,
  trendMeasurements,
} from "../../db/schema";
import { readArtifactJson } from "./artifact-json";
import { authorizeRepository } from "./github";
import {
  trendDatasets,
  trendMetrics,
  type TrendDataset,
  type TrendResponse,
  type TrendValues,
} from "../trends/model";
const VERSION = 1;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
interface Measurement {
  dataset: TrendDataset;
  entity: string;
  label: string;
  metrics: TrendValues;
}
const empty = (dataset: TrendDataset) =>
  Object.fromEntries(trendMetrics[dataset].map(({ key }) => [key, 0]));
async function objectJson(buildId: string, artifact: ArtifactManifest): Promise<unknown> {
  const object = await storage.get(`reports/${buildId}/${artifact.id}`);
  if (!object) throw new Error(`Missing diagnostic artifact: ${artifact.id}`);
  return readArtifactJson(object, artifact);
}
export async function indexBuild(
  build: typeof builds.$inferSelect,
  descriptions?: ArtifactManifest[],
) {
  const [indexed] = await db.select().from(trendIndex).where(eq(trendIndex.buildId, build.id));
  if (indexed?.version === VERSION) return;
  const files =
    descriptions ??
    (
      await db
        .select({ description: artifacts.description })
        .from(artifacts)
        .where(eq(artifacts.buildId, build.id))
    ).map((row) => row.description);
  const byId = new Map(files.map((file) => [file.id, file]));
  const measurements = new Map<string, Measurement>();
  function add(dataset: TrendDataset, entity: string, label: string, values: TrendValues) {
    const key = `${dataset}:${entity}`;
    const previous = measurements.get(key);
    const hadRecords = (previous?.metrics.records ?? 0) > 0;
    const metrics = previous?.metrics ?? empty(dataset);
    for (const [name, value] of Object.entries(values)) {
      if (!Number.isFinite(value) || !Object.hasOwn(metrics, name)) continue;
      metrics[name] =
        name === "startMs" && hadRecords
          ? Math.min(metrics[name], value)
          : (metrics[name] ?? 0) + value;
    }
    measurements.set(key, { dataset, entity, label: label.slice(0, 1024), metrics });
  }
  for (const dataset of datasets) add(dataset, "", "All records", {});
  for (const file of files) {
    add("artifacts", "", "All files", { records: 1, bytes: file.bytes });
    add("artifacts", hash(file.kind), file.kind, { records: 1, bytes: file.bytes });
  }
  const pages = files.filter((file) => file.kind === "dataset");
  let pageIndex = 0;
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      for (let page = pages[pageIndex++]; page; page = pages[pageIndex++]) {
        const rows = (await objectJson(build.id, page)) as DiagnosticRow[];
        if (!Array.isArray(rows) || !page.dataset) throw new Error("Invalid diagnostic dataset");
        for (let row of rows) {
          if (typeof row.details?.fullRecord === "string" && row.details.trendScalars !== 1) {
            const file = byId.get(row.details.fullRecord);
            if (!file || file.kind !== "metadata")
              throw new Error("Missing full diagnostic record");
            row = (await objectJson(build.id, file)) as DiagnosticRow;
          }
          const dataset = page.dataset;
          const values = diagnosticMetrics(row);
          if (
            row.details?.trendScalars === 1 &&
            row.details.trendValues &&
            typeof row.details.trendValues === "object"
          )
            for (const [key, value] of Object.entries(row.details.trendValues))
              if (typeof value === "number" && Number.isFinite(value)) values[key] = value;
          if (dataset === "events" && row.hook) values.calls = 1;
          for (const [field, source] of [
            ["sourceBytes", row.source],
            ["beforeBytes", row.before],
            ["afterBytes", row.after],
          ] as const)
            if (source) values[field] = byId.get(source)?.bytes ?? 0;
          const entity = diagnosticIdentity(dataset, row);
          add(dataset, "", "All records", values);
          add(
            dataset,
            typeof row.details?.trendEntity === "string" &&
              /^[a-f0-9]{64}$/.test(row.details.trendEntity)
              ? row.details.trendEntity
              : hash(entity.key),
            entity.label,
            values,
          );
        }
      }
    }),
  );
  const contextFile = byId.get("build-context");
  if (contextFile) {
    const context = (await objectJson(build.id, contextFile)) as {
      memory?: Record<string, number>;
      cpu?: { user: number; system: number };
      warnings?: { level: string }[];
    };
    add("runtime", "", "Process snapshot", {
      ...context.memory,
      cpuUserMs: (context.cpu?.user ?? 0) / 1000,
      cpuSystemMs: (context.cpu?.system ?? 0) / 1000,
      warnings: context.warnings?.filter((warning) => warning.level === "warn").length ?? 0,
    });
  }
  add("build", "", "Build summary", build.manifest.summary);
  for (const row of measurements.values())
    if (Object.hasOwn(row.metrics, "averageDurationMs"))
      row.metrics.averageDurationMs = row.metrics.calls
        ? row.metrics.durationMs / row.metrics.calls
        : 0;
  const batches: Measurement[][] = [];
  let batch: Measurement[] = [],
    bytes = 2;
  for (const measurement of measurements.values()) {
    const size = Buffer.byteLength(JSON.stringify(measurement)) + 1;
    if (bytes + size > 64 * 1024 && batch.length) {
      batches.push(batch);
      batch = [];
      bytes = 2;
    }
    batch.push(measurement);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  for (let i = 0; i < batches.length; i += 4)
    await Promise.all(
      batches.slice(i, i + 4).map((rows) =>
        db.run(sql`
    INSERT INTO trend_measurements (build_id, dataset, entity, label, metrics)
    SELECT ${build.id}, json_extract(value, '$.dataset'), json_extract(value, '$.entity'), json_extract(value, '$.label'), json_extract(value, '$.metrics')
    FROM json_each(${JSON.stringify(rows)}) WHERE true
    ON CONFLICT (build_id, dataset, entity) DO UPDATE SET label = excluded.label, metrics = excluded.metrics
  `),
      ),
    );
  await db
    .insert(trendIndex)
    .values({ buildId: build.id, version: VERSION })
    .onConflictDoUpdate({ target: trendIndex.buildId, set: { version: VERSION } });
}
export async function backfillTrends(ids?: string[]) {
  const targets = ids
    ? ids.length
      ? await db
          .select()
          .from(builds)
          .where(and(inArray(builds.id, ids), eq(builds.state, "ready")))
      : []
    : (
        await db
          .select({ build: builds })
          .from(builds)
          .leftJoin(trendIndex, eq(trendIndex.buildId, builds.id))
          .where(and(eq(builds.state, "ready"), isNull(trendIndex.buildId)))
          .orderBy(desc(builds.createdAt))
          .limit(5)
      ).map((row) => row.build);
  let index = 0;
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      for (let build = targets[index++]; build; build = targets[index++]) await indexBuild(build);
    }),
  );
}
const querySchema = z.object({
  branch: z.string().min(1).max(250).default("main"),
  environment: z.string().min(1).max(160).default("client"),
  dataset: z.enum(trendDatasets).default("build"),
  entity: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  search: z.string().max(100).default(""),
  cursor: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export async function projectTrends(
  c: CloudContext,
  projectId: string,
  query: Record<string, string>,
): Promise<TrendResponse> {
  const input = querySchema.parse(query);
  const branch = input.branch.startsWith("refs/heads/")
    ? input.branch
    : `refs/heads/${input.branch}`;
  const [row] = await db
    .select({ project: projects, repository: repositories })
    .from(projects)
    .innerJoin(repositories, eq(repositories.id, projects.repositoryId))
    .where(eq(projects.id, projectId));
  if (!row) throw new HTTPException(404);
  const access = () => authorizeRepository(c, row.repository.id, false, row.repository);
  const condition = and(
    eq(builds.projectId, projectId),
    eq(builds.state, "ready"),
    sql`json_extract(${builds.provenance}, '$.ref') = ${branch}`,
    sql`json_extract(${builds.manifest}, '$.environment') = ${input.environment}`,
  );
  let before;
  if (input.cursor) {
    const [cursor] = await db
      .select()
      .from(builds)
      .where(and(condition, eq(builds.id, input.cursor)));
    if (!cursor) {
      await access();
      throw new HTTPException(400, { message: "Invalid trend cursor" });
    }
    before = or(
      lt(builds.createdAt, cursor.createdAt),
      and(eq(builds.createdAt, cursor.createdAt), lt(builds.id, cursor.id)),
    );
  }
  const [history, environments, catalog] = await Promise.all([
    db
      .select({ build: builds, metrics: trendMeasurements.metrics, indexed: trendIndex.buildId })
      .from(builds)
      .leftJoin(trendIndex, eq(trendIndex.buildId, builds.id))
      .leftJoin(
        trendMeasurements,
        and(
          eq(trendMeasurements.buildId, builds.id),
          eq(trendMeasurements.dataset, input.dataset),
          eq(trendMeasurements.entity, input.entity ?? ""),
        ),
      )
      .where(and(condition, before))
      .orderBy(desc(builds.createdAt), desc(builds.id))
      .limit(input.limit + 1),
    db
      .selectDistinct({
        environment: sql<string>`json_extract(${builds.manifest}, '$.environment')`,
      })
      .from(builds)
      .where(
        and(
          eq(builds.projectId, projectId),
          eq(builds.state, "ready"),
          sql`json_extract(${builds.provenance}, '$.ref') = ${branch}`,
        ),
      ),
    db
      .selectDistinct({ id: trendMeasurements.entity, label: trendMeasurements.label })
      .from(trendMeasurements)
      .innerJoin(builds, eq(builds.id, trendMeasurements.buildId))
      .innerJoin(trendIndex, eq(trendIndex.buildId, builds.id))
      .where(
        and(
          condition,
          eq(trendMeasurements.dataset, input.dataset),
          sql`${builds.id} IN (SELECT id FROM builds WHERE ${and(condition, before)} ORDER BY created_at DESC, id DESC LIMIT ${input.limit})`,
          sql`${trendMeasurements.entity} != ''`,
          input.search
            ? sql`instr(lower(${trendMeasurements.label}), ${input.search.toLowerCase()}) > 0`
            : undefined,
        ),
      )
      .orderBy(trendMeasurements.label, trendMeasurements.entity)
      .limit(51),
    access(),
  ]);
  const selected = history.slice(0, input.limit).reverse();
  const missing = selected.filter((row) => !row.indexed);
  if (missing.length && c.executionCtx)
    c.executionCtx.waitUntil(
      backfillTrends(missing.slice(-3).map((row) => row.build.id)).catch((error: unknown) =>
        console.error(
          "Trend backfill failed",
          error instanceof Error ? error.message : String(error),
        ),
      ),
    );
  return {
    branch,
    environment: input.environment,
    dataset: input.dataset,
    environments: environments.map((row) => row.environment).sort(),
    entities: catalog.slice(0, 50),
    moreEntities: catalog.length > 50,
    points: selected.map(({ build, metrics, indexed }) => ({
      id: build.id,
      createdAt: build.createdAt,
      provenance: build.provenance,
      summary: build.manifest.summary,
      indexed: !!indexed,
      values: !indexed ? null : (metrics ?? (input.entity ? empty(input.dataset) : null)),
    })),
    nextCursor: history.length > input.limit ? selected[0].build.id : null,
    pending: missing.length,
  };
}
