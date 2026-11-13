import { defineHandler } from "void";
import { env } from "void/env";
import { db, and, eq, lt } from "void/db";
import { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import { repositories, webhookDeliveries } from "../../../db/schema";
import { required, verifyWebhook } from "../../../src/server/security";

const repositorySchema = z.object({
  id: z.number().int(),
  full_name: z.string(),
  private: z.boolean(),
  owner: z.object({ id: z.number().int() }),
});
const payloadSchema = z.object({
  action: z.string().optional(),
  installation: z.object({ id: z.number().int() }).optional(),
  repository: repositorySchema.optional(),
  repositories_removed: z.array(z.object({ id: z.number().int() })).optional(),
  repositories_added: z.array(repositorySchema).optional(),
  repositories: z.array(repositorySchema).optional(),
});
export const POST = defineHandler(bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
  if (Number(c.req.header("Content-Length") ?? 0) > 1024 * 1024)
    return c.json({ error: "Webhook too large" }, 413);
  const body = await c.req.text();
  if (body.length > 1024 * 1024) return c.json({ error: "Webhook too large" }, 413);
  if (
    !verifyWebhook(
      body,
      c.req.header("X-Hub-Signature-256") ?? "",
      required(env.GITHUB_WEBHOOK_SECRET, "GITHUB_WEBHOOK_SECRET"),
    )
  )
    return c.json({ error: "Invalid signature" }, 401);
  const delivery = c.req.header("X-GitHub-Delivery");
  if (!delivery || delivery.length > 160) return c.json({ error: "Delivery id required" }, 400);
  const payload = payloadSchema.safeParse(JSON.parse(body));
  if (!payload.success) return c.json({ error: "Invalid payload" }, 400);
  const [seen] = await db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, delivery));
  if (seen) return { ok: true };
  const { action, installation, repository, repositories_removed: removed } = payload.data;
  const event = c.req.header("X-GitHub-Event");
  if (event === "installation" && installation && ["deleted", "suspend"].includes(action ?? ""))
    await db
      .update(repositories)
      .set({ active: false })
      .where(eq(repositories.installationId, installation.id));
  if (event === "installation" && installation && action === "unsuspend")
    await db
      .update(repositories)
      .set({ active: true })
      .where(eq(repositories.installationId, installation.id));
  if (installation)
    for (const repo of [
      ...(payload.data.repositories_added ?? []),
      ...(payload.data.repositories ?? []),
    ])
      await db
        .update(repositories)
        .set({
          installationId: installation.id,
          name: repo.full_name,
          ownerId: String(repo.owner.id),
          isPrivate: repo.private,
          active: true,
        })
        .where(eq(repositories.id, String(repo.id)));
  if (event === "installation_repositories" && installation)
    for (const repo of removed ?? [])
      await db
        .update(repositories)
        .set({ active: false })
        .where(
          and(
            eq(repositories.id, String(repo.id)),
            eq(repositories.installationId, installation.id),
          ),
        );
  if (event === "repository" && repository) {
    await db
      .update(repositories)
      .set({
        name: repository.full_name,
        ownerId: String(repository.owner.id),
        isPrivate: repository.private,
        ...(action === "deleted" ? { active: false } : {}),
      })
      .where(eq(repositories.id, String(repository.id)));
  }
  await db
    .insert(webhookDeliveries)
    .values({ id: delivery, createdAt: Date.now() })
    .onConflictDoNothing();
  await db
    .delete(webhookDeliveries)
    .where(lt(webhookDeliveries.createdAt, Date.now() - 7 * 86400000));
  return { ok: true };
});
