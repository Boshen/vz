import { createHash } from "node:crypto";
import { db, and, eq, asc, isNull, or, lt } from "void/db";
import { storage } from "void/storage";
import { env } from "void/env";
import { HTTPException } from "hono/http-exception";
import { artifacts, builds, projects, repositories, uploadParts } from "../../db/schema";
import { PART_BYTES, type ArtifactManifest, type BuildManifest } from "@vz/protocol";
import { indexBuild } from "./trends";
import { installationFor, refreshRepository } from "./github";
import {
  issueUploadToken,
  required,
  sha256,
  verifyActionsToken,
  verifyUploadToken,
} from "./security";

export const objectKey = (buildId: string, artifactId: string) =>
  `reports/${buildId}/${artifactId}`;
export async function beginUpload(manifest: BuildManifest, token: string) {
  const origin = new URL(required(env.PLATFORM_ORIGIN, "PLATFORM_ORIGIN")).origin;
  const provenance = await verifyActionsToken(token, origin);
  const installationId = await installationFor(provenance.repository);
  const repo = await refreshRepository(provenance.repositoryId, installationId);
  if (String(repo.owner.id) !== provenance.ownerId || repo.full_name !== provenance.repository)
    throw new HTTPException(403, { message: "Repository identity changed" });
  await db
    .insert(repositories)
    .values({
      id: provenance.repositoryId,
      ownerId: provenance.ownerId,
      name: repo.full_name,
      isPrivate: repo.private,
      installationId,
      active: true,
    })
    .onConflictDoUpdate({
      target: repositories.id,
      set: {
        name: repo.full_name,
        ownerId: provenance.ownerId,
        installationId,
        isPrivate: repo.private,
        active: true,
      },
    });
  const projectId = sha256(`${provenance.repositoryId}:${manifest.project}`).slice(0, 32);
  await db
    .insert(projects)
    .values({ id: projectId, repositoryId: provenance.repositoryId, key: manifest.project })
    .onConflictDoNothing();
  const id = sha256(`${projectId}:${manifest.captureId}`).slice(0, 32);
  const manifestHash = sha256(JSON.stringify(manifest));
  await db
    .insert(builds)
    .values({
      id,
      projectId,
      captureId: manifest.captureId,
      manifestHash,
      manifest: { ...manifest, artifacts: [] },
      artifactCount: manifest.artifacts.length,
      provenance,
      createdAt: Date.now(),
    })
    .onConflictDoNothing();
  const [build] = await db.select().from(builds).where(eq(builds.id, id));
  if (build.manifestHash !== manifestHash || build.state === "deleting")
    throw new HTTPException(409, { message: "Capture id already used" });
  // Individual inserts avoid D1's bind-parameter limit even for captures with many source objects.
  for (let i = 0; i < manifest.artifacts.length; i += 20) {
    await db
      .insert(artifacts)
      .values(
        manifest.artifacts
          .slice(i, i + 20)
          .map((artifact) => ({ buildId: id, id: artifact.id, description: artifact })),
      )
      .onConflictDoNothing();
  }
  return {
    id,
    token: await issueUploadToken(id, manifestHash, required(env.UPLOAD_SECRET, "UPLOAD_SECRET")),
    reportUrl: `${origin}/reports/${id}`,
  };
}
export async function uploadBuild(id: string, token: string) {
  const [build] = await db.select().from(builds).where(eq(builds.id, id));
  if (!build || build.state === "deleting") throw new HTTPException(404);
  await verifyUploadToken(
    token,
    id,
    build.manifestHash,
    required(env.UPLOAD_SECRET, "UPLOAD_SECRET"),
  );
  const [project] = await db.select().from(projects).where(eq(projects.id, build.projectId));
  const [repo] = await db
    .select()
    .from(repositories)
    .where(eq(repositories.id, project.repositoryId));
  if (!repo.active) throw new HTTPException(403);
  return build;
}
async function artifactFor(buildId: string, id: string) {
  const [record] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.buildId, buildId), eq(artifacts.id, id)));
  if (!record) throw new HTTPException(404);
  return { description: record.description, record };
}
export function expectedPartSize(artifact: Pick<ArtifactManifest, "bytes">, part: number) {
  if (!Number.isSafeInteger(part) || part < 1 || part > Math.ceil(artifact.bytes / PART_BYTES))
    throw new HTTPException(400, { message: "Invalid part number" });
  return Math.min(PART_BYTES, artifact.bytes - (part - 1) * PART_BYTES);
}
export async function putPart(buildId: string, id: string, part: number, body: ArrayBuffer) {
  const { description, record } = await artifactFor(buildId, id);
  if (body.byteLength !== expectedPartSize(description, part))
    throw new HTTPException(400, { message: "Unexpected part size" });
  if (record.state === "ready") return;
  if (record.state !== "uploading") throw new HTTPException(409);
  let multipartId = record.multipartId;
  if (!multipartId) {
    const multipart = await storage.createMultipartUpload(objectKey(buildId, id), {
      httpMetadata: { contentType: description.contentType },
    });
    const changed = await db
      .update(artifacts)
      .set({ multipartId: multipart.uploadId })
      .where(
        and(eq(artifacts.buildId, buildId), eq(artifacts.id, id), isNull(artifacts.multipartId)),
      )
      .returning();
    if (changed.length) multipartId = multipart.uploadId;
    else {
      await multipart.abort();
      multipartId = (await artifactFor(buildId, id)).record.multipartId!;
    }
  }
  const result = await storage
    .resumeMultipartUpload(objectKey(buildId, id), multipartId)
    .uploadPart(part, body);
  await db
    .insert(uploadParts)
    .values({ buildId, artifactId: id, part, etag: result.etag, bytes: body.byteLength })
    .onConflictDoUpdate({
      target: [uploadParts.buildId, uploadParts.artifactId, uploadParts.part],
      set: { etag: result.etag, bytes: body.byteLength },
    });
}
export async function completeArtifact(buildId: string, id: string) {
  const { description, record } = await artifactFor(buildId, id);
  if (record.state === "ready") return;
  if (!record.multipartId) throw new HTTPException(409, { message: "Artifact has no parts" });
  const parts = await db
    .select()
    .from(uploadParts)
    .where(and(eq(uploadParts.buildId, buildId), eq(uploadParts.artifactId, id)))
    .orderBy(asc(uploadParts.part));
  if (
    parts.length !== Math.ceil(description.bytes / PART_BYTES) ||
    parts.some(
      (part, index) =>
        part.part !== index + 1 || part.bytes !== expectedPartSize(description, part.part),
    )
  )
    throw new HTTPException(409, { message: "Artifact is incomplete" });
  await db
    .update(artifacts)
    .set({ state: "verifying" })
    .where(
      and(eq(artifacts.buildId, buildId), eq(artifacts.id, id), eq(artifacts.state, "uploading")),
    )
    .returning();
  const key = objectKey(buildId, id);
  try {
    let object = await storage.get(key);
    if (!object) {
      try {
        await storage
          .resumeMultipartUpload(key, record.multipartId)
          .complete(parts.map(({ part, etag }) => ({ partNumber: part, etag })));
      } catch (error) {
        // Completion may have succeeded before the response was lost, or in a
        // concurrent retry. R2's strongly consistent object read resolves that.
        object = await storage.get(key);
        if (!object) throw error;
      }
      object ??= await storage.get(key);
    }
    if (!object) throw new Error("Completed artifact is not available yet");
    if (object.size !== description.bytes)
      throw new HTTPException(400, { message: "Artifact size mismatch" });
    const digest = createHash("sha256");
    for await (const chunk of object.body) digest.update(chunk);
    if (digest.digest("hex") !== description.sha256)
      throw new HTTPException(400, { message: "Artifact checksum mismatch" });
    await db
      .update(artifacts)
      .set({ state: "ready" })
      .where(and(eq(artifacts.buildId, buildId), eq(artifacts.id, id)));
  } catch (error) {
    // Keep the finalized object and part receipts after transient failures so
    // another completion request can resume verification without re-uploading.
    if (!(error instanceof HTTPException) || error.status !== 400) throw error;
    await storage.delete(key);
    await db
      .update(artifacts)
      .set({ state: "uploading", multipartId: null })
      .where(and(eq(artifacts.buildId, buildId), eq(artifacts.id, id)));
    await db
      .delete(uploadParts)
      .where(and(eq(uploadParts.buildId, buildId), eq(uploadParts.artifactId, id)));
    throw error;
  }
}
export async function completeBuild(build: typeof builds.$inferSelect) {
  if (build.state === "ready") return;
  const records = await db.select().from(artifacts).where(eq(artifacts.buildId, build.id));
  if (
    records.length !== build.artifactCount ||
    records.some((artifact) => artifact.state !== "ready")
  )
    throw new HTTPException(409, { message: "Upload is incomplete" });
  const [project] = await db.select().from(projects).where(eq(projects.id, build.projectId));
  const [repo] = await db
    .select()
    .from(repositories)
    .where(eq(repositories.id, project.repositoryId));
  await refreshRepository(repo.id, repo.installationId);
  await indexBuild(
    build,
    records.map((record) => record.description),
  );
  await db
    .update(builds)
    .set({ state: "ready" })
    .where(and(eq(builds.id, build.id), eq(builds.state, "uploading")));
}
export async function deleteBuild(id: string) {
  await db.update(builds).set({ state: "deleting" }).where(eq(builds.id, id));
  const pending = await db.select().from(artifacts).where(eq(artifacts.buildId, id));
  for (const artifact of pending)
    if (artifact.multipartId && artifact.state !== "ready") {
      try {
        await storage
          .resumeMultipartUpload(objectKey(id, artifact.id), artifact.multipartId)
          .abort();
      } catch {
        /* Already completed or aborted. */
      }
    }
  let cursor: string | undefined;
  do {
    const list = await storage.list({ prefix: `reports/${id}/`, cursor, limit: 500 });
    if (list.objects.length) await storage.delete(list.objects.map((object) => object.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  await db.delete(builds).where(eq(builds.id, id));
}
export async function cleanupAbandoned(now = Date.now()) {
  const abandoned = await db
    .select()
    .from(builds)
    .where(
      or(
        eq(builds.state, "deleting"),
        and(eq(builds.state, "uploading"), lt(builds.createdAt, now - 86400000)),
      ),
    )
    .limit(20);
  for (const build of abandoned) await deleteBuild(build.id);
}
