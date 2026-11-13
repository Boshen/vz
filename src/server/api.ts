import { Hono } from "hono";
import type { DashboardInitial, History, Session, Project } from "../dashboard";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { errors as joseErrors } from "jose";
import { z } from "zod";
import { db, and, desc, eq, lt, sql, count } from "void/db";
import { storage } from "void/storage";
import { getUser } from "void/auth";
import { env } from "void/env";
import type { CloudContext } from "void";
import {
  buildManifestSchema,
  compareSummaries,
  datasetSchema,
  PART_BYTES,
  BATCH_FILES,
  SMALL_ARTIFACT_BYTES,
  type BuildRecord,
  type DiagnosticRow,
} from "@vz/protocol";
import { artifacts, builds, projects, repositories } from "../../db/schema";
import { readArtifactJson } from "./artifact-json";
import { buildRegressions } from "./regressions";
import { projectTrends } from "./trends";
import { authorizeRepository } from "./github";
import { bearer } from "./security";
import {
  beginUpload,
  completeArtifact,
  completeBuild,
  deleteBuild,
  objectKey,
  putPart,
  putArtifactBatch,
  uploadBuild,
} from "./uploads";

export const api = new Hono<{ Bindings: { context: CloudContext } }>().basePath("/api/v1");
api.use("*", bodyLimit({ maxSize: 10 * 1024 ** 2 }));
api.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  const start = performance.now();
  await next();
  c.header("Server-Timing", `app;dur=${(performance.now() - start).toFixed(1)}`, { append: true });
});
api.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return c.json(
      { error: "Invalid request", issues: error instanceof z.ZodError ? error.issues : undefined },
      400,
    );
  if (error instanceof joseErrors.JOSEError)
    return c.json({ error: "Invalid or expired identity token" }, 401);
  console.error(
    "VZ request failed",
    error.name,
    error.message,
    error.cause instanceof Error ? error.cause.message : "",
  );
  return c.json({ error: "Request failed. Please retry." }, 500);
});
api.get("/session", (c) =>
  c.json({
    user: getUser(),
    appSlug: env.GITHUB_APP_SLUG ?? null,
    authConfigured: Boolean(env.AUTH_GITHUB_CLIENT_ID && env.AUTH_GITHUB_CLIENT_SECRET),
  }),
);
api.post("/uploads", async (c) =>
  c.json(
    await beginUpload(
      buildManifestSchema.parse(await c.req.json()),
      bearer(c.req.header("Authorization")),
    ),
  ),
);
api.post("/uploads/:id/artifacts/batch", bodyLimit({ maxSize: 6 * 1024 ** 2 }), async (c) => {
  const build = await uploadBuild(c.req.param("id"), bearer(c.req.header("Authorization")));
  const files = z
    .array(
      z.object({
        id: z.string().min(1).max(160),
        content: z.string().max(Math.ceil(SMALL_ARTIFACT_BYTES / 3) * 4),
      }),
    )
    .min(1)
    .max(BATCH_FILES)
    .parse(await c.req.json());
  await putArtifactBatch(build.id, files);
  return c.json({ ok: true });
});
api.put(
  "/uploads/:id/artifacts/:artifact/parts/:part",
  bodyLimit({ maxSize: PART_BYTES }),
  async (c) => {
    const build = await uploadBuild(c.req.param("id"), bearer(c.req.header("Authorization")));
    if (build.state !== "ready")
      await putPart(
        build.id,
        c.req.param("artifact"),
        Number(c.req.param("part")),
        await c.req.arrayBuffer(),
      );
    return c.json({ ok: true });
  },
);
api.post("/uploads/:id/artifacts/:artifact/complete", async (c) => {
  const build = await uploadBuild(c.req.param("id"), bearer(c.req.header("Authorization")));
  await completeArtifact(build.id, c.req.param("artifact"));
  return c.json({ ok: true });
});
api.post("/uploads/:id/complete", async (c) => {
  const ready = await completeBuild(
    await uploadBuild(c.req.param("id"), bearer(c.req.header("Authorization"))),
  );
  return c.json({ ok: ready }, ready ? 200 : 202);
});
async function report(
  c: CloudContext,
  id: string,
  write = false,
  includeArtifacts = true,
  rawOnly = false,
): Promise<BuildRecord> {
  const [row] = await db
    .select({ build: builds, project: projects, repository: repositories })
    .from(builds)
    .innerJoin(projects, eq(projects.id, builds.projectId))
    .innerJoin(repositories, eq(repositories.id, projects.repositoryId))
    .where(and(eq(builds.id, id), eq(builds.state, "ready")));
  if (!row) throw new HTTPException(404);
  const [repo, descriptors] = await Promise.all([
    authorizeRepository(c, row.repository.id, write, row.repository),
    includeArtifacts || rawOnly
      ? db
          .select({ description: artifacts.description })
          .from(artifacts)
          .where(
            and(
              eq(artifacts.buildId, id),
              rawOnly ? sql`json_extract(${artifacts.description}, '$.kind') = 'raw'` : undefined,
            ),
          )
      : Promise.resolve([]),
  ]);
  return {
    id: row.build.id,
    projectId: row.project.id,
    project: row.project.key,
    repository: repo.full_name,
    environment: row.build.manifest.environment,
    createdAt: row.build.createdAt,
    manifest: {
      ...row.build.manifest,
      artifacts: descriptors.map((artifact) => artifact.description),
    },
    provenance: row.build.provenance,
  };
}
const pageNumber = (value: string | undefined) =>
  z.coerce
    .number()
    .int()
    .min(0)
    .max(100000)
    .parse(value ?? 0);
api.get("/projects", async (c) => {
  const page = pageNumber(c.req.query("page"));
  const rows = await db
    .select({ project: projects, repository: repositories })
    .from(projects)
    .innerJoin(repositories, eq(repositories.id, projects.repositoryId))
    .orderBy(desc(projects.id))
    .limit(20)
    .offset(page * 20);
  const access = new Map<string, Promise<Awaited<ReturnType<typeof authorizeRepository>> | null>>();
  const result = await Promise.all(
    rows.map(async (row) => {
      if (!access.has(row.repository.id))
        access.set(
          row.repository.id,
          authorizeRepository(c.env.context, row.repository.id, false, row.repository).catch(
            () => null,
          ),
        );
      const repo = await access.get(row.repository.id);
      if (!repo) return null;
      return {
        id: row.project.id,
        key: row.project.key,
        repository: repo.full_name,
        private: repo.private,
      };
    }),
  );
  return c.json({
    projects: result.filter((row) => row !== null),
    nextPage: rows.length === 20 ? page + 1 : null,
  });
});
api.get("/projects/:id/trends", async (c) =>
  c.json(await projectTrends(c.env.context, c.req.param("id"), c.req.query())),
);
api.get("/projects/:id/builds", async (c) => {
  const [row] = await db
    .select({ project: projects, repository: repositories })
    .from(projects)
    .innerJoin(repositories, eq(repositories.id, projects.repositoryId))
    .where(eq(projects.id, c.req.param("id")));
  if (!row) throw new HTTPException(404);
  const { project } = row;
  const page = pageNumber(c.req.query("page"));
  const [repo, rows] = await Promise.all([
    authorizeRepository(c.env.context, project.repositoryId, false, row.repository),
    db
      .select()
      .from(builds)
      .where(and(eq(builds.projectId, project.id), eq(builds.state, "ready")))
      .orderBy(desc(builds.createdAt))
      .limit(20)
      .offset(page * 20),
  ]);
  return c.json({
    project: { ...project, repository: repo.full_name, private: repo.private },
    builds: rows.map((build) => ({
      id: build.id,
      createdAt: build.createdAt,
      environment: build.manifest.environment,
      summary: build.manifest.summary,
      provenance: build.provenance,
    })),
    nextPage: rows.length === 20 ? page + 1 : null,
  });
});
api.get("/builds/:id", async (c) =>
  c.json(
    await report(
      c.env.context,
      c.req.param("id"),
      false,
      c.req.query("metadata") !== "1",
      c.req.query("metadata") === "1",
    ),
  ),
);
api.get("/builds/:id/inventory", async (c) => {
  const id = c.req.param("id"),
    page = pageNumber(c.req.query("page"));
  const [, rows] = await Promise.all([
    report(c.env.context, id, false, false),
    db
      .select({ description: artifacts.description })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.buildId, id),
          sql`json_extract(${artifacts.description}, '$.kind') NOT IN ('source', 'dataset')`,
        ),
      )
      .orderBy(artifacts.id)
      .limit(51)
      .offset(page * 50),
  ]);
  return c.json({
    artifacts: rows.slice(0, 50).map((row) => row.description),
    nextPage: rows.length > 50 ? page + 1 : null,
  });
});
api.get("/builds/:id/regressions", async (c) =>
  c.json(await buildRegressions(await report(c.env.context, c.req.param("id"), false, false))),
);
api.get("/builds/:id/datasets/:dataset", async (c) => {
  const id = c.req.param("id");
  const dataset = datasetSchema.parse(c.req.param("dataset")),
    page = pageNumber(c.req.query("page"));
  const condition = and(
    eq(artifacts.buildId, id),
    sql`json_extract(${artifacts.description}, '$.kind') = 'dataset'`,
    sql`json_extract(${artifacts.description}, '$.dataset') = ${dataset}`,
  );
  const [build, [total], [record]] = await Promise.all([
    report(c.env.context, id, false, false),
    db.select({ value: count() }).from(artifacts).where(condition),
    db
      .select()
      .from(artifacts)
      .where(and(condition, sql`json_extract(${artifacts.description}, '$.page') = ${page}`))
      .limit(1),
  ]);
  const artifact = record?.description;
  if (!artifact) return c.json({ rows: [], pages: total.value });
  const object = await storage.get(objectKey(build.id, artifact.id));
  if (!object) throw new HTTPException(404);
  return c.json({
    rows: (await readArtifactJson(object, artifact)) as DiagnosticRow[],
    pages: total.value,
  });
});
api.get("/builds/:id/artifacts/:artifact", async (c) => {
  const build = await report(c.env.context, c.req.param("id"), false, false);
  const [record] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.buildId, build.id), eq(artifacts.id, c.req.param("artifact"))));
  const artifact = record?.description;
  if (!artifact) throw new HTTPException(404);
  const range = c.req.header("Range");
  let offset = 0,
    length = artifact.bytes;
  if (range) {
    const match = range.match(/^bytes=(\d+)-(\d+)$/);
    if (!match) return c.body(null, 416);
    offset = Number(match[1]);
    const end = Math.min(Number(match[2]), artifact.bytes - 1);
    if (!Number.isSafeInteger(offset) || offset > end || offset < 0) return c.body(null, 416);
    length = end - offset + 1;
  }
  const object = await storage.get(
    objectKey(build.id, artifact.id),
    range ? { range: { offset, length } } : undefined,
  );
  if (!object) throw new HTTPException(404);
  let filename = artifact.name?.replaceAll("\\", "/").split("/").at(-1) || artifact.id;
  if (artifact.contentType === "application/gzip" && !filename.endsWith(".gz")) filename += ".gz";
  const encodedFilename = encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const headers = new Headers({
    "Content-Type": artifact.kind === "source" ? "text/plain; charset=utf-8" : artifact.contentType,
    "Content-Disposition": `attachment; filename="${artifact.id}${artifact.contentType === "application/gzip" ? ".gz" : ""}"; filename*=UTF-8''${encodedFilename}`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", String(length));
  if (range)
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${artifact.bytes}`);
  return new Response(object.body, { headers, status: range ? 206 : 200 });
});
api.get("/builds/:id/compare", async (c) => {
  const after = await report(c.env.context, c.req.param("id"), false, false);
  let beforeId = c.req.query("before");
  if (!beforeId) {
    const candidates = await db
      .select()
      .from(builds)
      .where(
        and(
          eq(builds.projectId, after.projectId),
          eq(builds.state, "ready"),
          lt(builds.createdAt, after.createdAt),
          sql`json_extract(${builds.manifest}, '$.environment') = ${after.environment}`,
          sql`json_extract(${builds.provenance}, '$.ref') = ${after.provenance.ref}`,
        ),
      )
      .orderBy(desc(builds.createdAt))
      .limit(1);
    beforeId = candidates[0]?.id;
  }
  if (!beforeId) return c.json({ before: null, after: after.id, metrics: null });
  const before = await report(c.env.context, beforeId, false, false);
  if (before.projectId !== after.projectId || before.environment !== after.environment)
    throw new HTTPException(400, {
      message: "Compare builds from the same project and environment",
    });
  return c.json({
    before: before.id,
    after: after.id,
    metrics: compareSummaries(before.manifest.summary, after.manifest.summary),
  });
});
api.delete("/builds/:id", async (c) => {
  if (c.req.header("Origin") !== new URL(c.req.raw.url).origin)
    throw new HTTPException(403, { message: "Same-origin request required" });
  await report(c.env.context, c.req.param("id"), true, false);
  await deleteBuild(c.req.param("id"));
  return c.json({ ok: true });
});

/** Internal API calls share the original request's authorization scope, never HTTP. */
export async function dashboardData(
  c: CloudContext,
  selection: { projectId?: string; reportId?: string } = {},
): Promise<DashboardInitial> {
  c.header("Cache-Control", "no-store");
  const started = performance.now();
  async function read<T>(path: string): Promise<T> {
    const response = await api.fetch(
      new Request(new URL(`/api/v1${path}`, c.req.raw.url), { headers: c.req.raw.headers }),
      { context: c },
      c.executionCtx,
    );
    const value = (await response.json()) as T & { error?: string };
    if (!response.ok)
      throw new HTTPException(response.status as 400, {
        message: value.error ?? "Unable to load page data",
      });
    return value;
  }
  let error = "";
  const optional = <T>(work: Promise<T>): Promise<T | null> =>
    work.catch((failure) => {
      error ||=
        failure instanceof HTTPException
          ? failure.message
          : "Some page data could not be loaded. Please refresh.";
      if (!(failure instanceof HTTPException))
        console.error(
          "Optional dashboard data unavailable",
          failure instanceof Error ? failure.message : String(failure),
        );
      return null;
    });
  const listing = read<{ projects: Project[]; nextPage: number | null }>("/projects").catch(
    (failure) => {
      error ||= failure.message;
      return { projects: [], nextPage: null };
    },
  );
  const session = read<Session>("/session");
  const selected = (async () => {
    let history: History | null = null,
      build: BuildRecord | null = null;
    let trends: DashboardInitial["trends"] = null,
      regression: DashboardInitial["regression"] = null,
      overview: DashboardInitial["overview"] = null;
    if (selection.reportId) {
      build = await read<BuildRecord>(
        `/builds/${encodeURIComponent(selection.reportId)}?metadata=1`,
      );
      [history, regression, overview] = await Promise.all([
        optional(read<History>(`/projects/${build.projectId}/builds`)),
        optional(buildRegressions(build)),
        optional(
          read<NonNullable<DashboardInitial["overview"]>>(`/builds/${build.id}/datasets/assets`),
        ),
      ]);
    } else if (selection.projectId) {
      history = await read<History>(`/projects/${encodeURIComponent(selection.projectId)}/builds`);
      const environment =
        history.builds.find((build) => build.environment === "client")?.environment ??
        history.builds[0]?.environment ??
        "client";
      trends = await optional(projectTrends(c, history.project.id, { environment }));
    }
    return { history, report: build, trends, regression, overview };
  })().catch((failure) => {
    error ||= failure.message;
    return { history: null, report: null, trends: null, regression: null, overview: null };
  });
  const [identity, projects, data] = await Promise.all([session, listing, selected]);
  c.header("Server-Timing", `page-data;dur=${(performance.now() - started).toFixed(1)}`, {
    append: true,
  });
  return {
    ...data,
    session: identity,
    projects: projects.projects,
    nextProjectPage: projects.nextPage,
    error,
  };
}
api.get("/dashboard", async (c) =>
  c.json(
    await dashboardData(c.env.context, {
      projectId: c.req.query("projectId"),
      reportId: c.req.query("reportId"),
    }),
  ),
);
