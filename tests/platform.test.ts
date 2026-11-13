import { beforeAll, beforeEach, afterAll, expect, test, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { Hono } from "hono";
import type { CloudEnv, CloudContext } from "void";
import { exportJWK, exportPKCS8, generateKeyPair, SignJWT, createLocalJWKSet } from "jose";
import { buildManifestSchema, PART_BYTES, type BuildManifest } from "@vz/protocol";
import { d1, memoryStorage, state, settings, reset, fakeContext, sqlite } from "./support";

vi.mock("void/db", async (original) => {
  const actual = await original<typeof import("void/db")>();
  return { ...actual, db: actual.createDb(d1) };
});
vi.mock("void/_env", () => ({ requireRuntimeBinding: () => d1 }));
vi.mock("void/storage", () => ({ storage: memoryStorage }));
vi.mock("void/env", () => ({ env: settings }));
vi.mock("void/auth", () => ({
  getUser: () => state.user,
  getAuth: () => ({
    api: {
      listUserAccounts: async () => [{ id: "account", providerId: "github" }],
      getAccessToken: async () => ({ accessToken: "user-token" }),
    },
  }),
}));
import { backfillTrends } from "../src/server/trends";
import type { TrendResponse } from "../src/trends/model";
import { api } from "../src/server/api";
import { expectedPartSize, cleanupAbandoned } from "../src/server/uploads";
import { verifyActionsToken, verifyWebhook } from "../src/server/security";
import { POST as webhook } from "../routes/api/github/webhook";

let key: CryptoKey;
let jwks: { keys: Awaited<ReturnType<typeof exportJWK>>[] };
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  key = pair.privateKey;
  settings.GITHUB_APP_PRIVATE_KEY = await exportPKCS8(key);
  jwks = {
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: "test", alg: "RS256", use: "sig" }],
  };
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    state.requests.push(url);
    if (url === "https://token.actions.githubusercontent.com/.well-known/jwks")
      return Response.json(jwks);
    if (!url.startsWith("https://api.github.com/"))
      throw new Error(`Unexpected network access: ${url}`);
    const path = url.slice("https://api.github.com".length);
    if (path === "/repos/acme/app/installation")
      return Response.json({ id: 123, suspended_at: state.active ? null : "now" });
    if (path === "/app/installations/123")
      return Response.json({ suspended_at: state.active ? null : "now" });
    if (path === "/app/installations/123/access_tokens")
      return Response.json({
        token: "installation-token",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
    if (path === "/repositories/42") {
      const token = new Headers(init?.headers).get("Authorization");
      if (token === "Bearer user-token" && !state.access)
        return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json({
        id: 42,
        full_name: "acme/app",
        private: state.private,
        owner: { id: 7 },
        permissions: { push: state.write },
      });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  });
});
beforeEach(reset);
afterAll(() => vi.unstubAllGlobals());
async function oidc(overrides: Record<string, unknown> = {}, audience = settings.PLATFORM_ORIGIN) {
  return new SignJWT({
    repository_id: "42",
    repository_owner_id: "7",
    repository: "acme/app",
    sha: "a".repeat(40),
    ref: "refs/heads/main",
    run_id: "11",
    run_attempt: "1",
    workflow_ref: "acme/app/.github/workflows/build.yml@refs/heads/main",
    actor: "alice",
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setSubject("repo:acme/app:ref:refs/heads/main")
    .setIssuer("https://token.actions.githubusercontent.com")
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(typeof overrides.exp === "number" ? overrides.exp : "5m")
    .sign(key);
}
const contents = JSON.stringify([{ id: "entry", name: "src/main.ts", bytes: 42, imports: [] }]);
function manifest(): BuildManifest {
  return buildManifestSchema.parse({
    version: 1,
    captureId: crypto.randomUUID(),
    project: "web",
    environment: "client",
    checkoutSha: "a".repeat(40),
    producer: { plugin: "0.1.0", vite: "8.3.7", rolldown: "1.2.18" },
    summary: { durationMs: 42, outputBytes: 42, modules: 1, chunks: 1, assets: 1, packages: 0 },
    artifacts: [
      {
        id: "modules-0",
        kind: "dataset",
        dataset: "modules",
        page: 0,
        contentType: "application/json",
        bytes: Buffer.byteLength(contents),
        sha256: createHash("sha256").update(contents).digest("hex"),
      },
    ],
  });
}
async function call(
  path: string,
  method = "GET",
  token?: string,
  body?: string,
  headers: Record<string, string> = {},
) {
  return api.request(
    `https://vz.example/api/v1${path}`,
    {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body,
    },
    {
      context: {
        ...fakeContext,
        req: { raw: new Request(`https://vz.example/api/v1${path}`) },
      } as CloudContext,
    },
  );
}
async function create(data = manifest(), claims: Record<string, unknown> = {}) {
  const response = await call("/uploads", "POST", await oidc(claims), JSON.stringify(data));
  expect(response.status).toBe(200);
  return { ...((await response.json()) as { id: string; token: string }), manifest: data };
}
async function complete(session: Awaited<ReturnType<typeof create>>, content = contents) {
  expect(
    (
      await call(
        `/uploads/${session.id}/artifacts/modules-0/parts/1`,
        "PUT",
        session.token,
        content,
      )
    ).status,
  ).toBe(200);
  expect(
    (await call(`/uploads/${session.id}/artifacts/modules-0/complete`, "POST", session.token))
      .status,
  ).toBe(200);
  expect((await call(`/uploads/${session.id}/complete`, "POST", session.token)).status).toBe(200);
}
test("OIDC validates audience, expiry, signature, and repository identity", async () => {
  const keys = createLocalJWKSet(jwks);
  expect(
    (await verifyActionsToken(await oidc(), settings.PLATFORM_ORIGIN, keys)).repositoryId,
  ).toBe("42");
  await expect(
    verifyActionsToken(await oidc({}, "https://wrong.example"), settings.PLATFORM_ORIGIN, keys),
  ).rejects.toThrow();
  await expect(
    verifyActionsToken(await oidc({ exp: 1 }), settings.PLATFORM_ORIGIN, keys),
  ).rejects.toThrow();
  const valid = await oidc();
  await expect(
    verifyActionsToken(valid.slice(0, -10) + "0000000000", settings.PLATFORM_ORIGIN, keys),
  ).rejects.toThrow();
  expect(
    (
      await call(
        "/uploads",
        "POST",
        await oidc({ repository_id: "99" }),
        JSON.stringify(manifest()),
      )
    ).status,
  ).toBe(404);
});
test("uploads are hidden until finalized; retrying initialization and completion is safe", async () => {
  const data = manifest(),
    session = await create(data),
    duplicate = await create(data);
  expect(duplicate.id).toBe(session.id);
  expect((await call(`/builds/${session.id}`)).status).toBe(404);
  expect((await call(`/uploads/${session.id}/complete`, "POST", session.token)).status).toBe(409);
  await complete(session);
  expect(
    (await call(`/uploads/${session.id}/artifacts/modules-0/complete`, "POST", session.token))
      .status,
  ).toBe(200);
  expect((await call(`/uploads/${session.id}/complete`, "POST", session.token)).status).toBe(200);
  expect((await call(`/builds/${session.id}`)).status).toBe(200);
  const dataset = (await (await call(`/builds/${session.id}/datasets/modules`)).json()) as {
    rows: unknown[];
  };
  expect(dataset.rows).toHaveLength(1);
});
test("private reports require current user repository access on every route", async () => {
  state.private = true;
  const session = await create();
  await complete(session);
  for (const path of [
    `/builds/${session.id}`,
    `/builds/${session.id}/datasets/modules`,
    `/builds/${session.id}/artifacts/modules-0`,
    `/builds/${session.id}/compare`,
  ])
    expect((await call(path)).status).toBe(401);
  state.user = { id: "user", name: "Alice" };
  expect((await call(`/builds/${session.id}`)).status).toBe(200);
  state.access = false;
  expect((await call(`/builds/${session.id}`)).status).toBe(404);
  expect(((await (await call("/projects")).json()) as { projects: unknown[] }).projects).toEqual(
    [],
  );
});
test("public-to-private transitions and installation suspension immediately block reads", async () => {
  const session = await create();
  await complete(session);
  expect((await call(`/builds/${session.id}`)).status).toBe(200);
  state.private = true;
  expect((await call(`/builds/${session.id}`)).status).toBe(401);
  state.user = { id: "user", name: "Alice" };
  state.active = false;
  expect((await call(`/builds/${session.id}/artifacts/modules-0`)).status).toBe(404);
});
test("upload credentials cannot access other captures; manifest collisions are rejected", async () => {
  const a = await create(),
    b = await create();
  expect((await call(`/uploads/${b.id}/complete`, "POST", a.token)).status).toBe(401);
  const altered = { ...a.manifest, environment: "server" };
  expect((await call("/uploads", "POST", await oidc(), JSON.stringify(altered))).status).toBe(409);
});
test("parts enforce boundaries and artifact hashes before publishing", async () => {
  expect(expectedPartSize({ bytes: PART_BYTES + 2 }, 2)).toBe(2);
  expect(() => expectedPartSize({ bytes: 10 }, 2)).toThrow();
  const session = await create();
  expect(
    (
      await call(
        `/uploads/${session.id}/artifacts/modules-0/parts/1`,
        "PUT",
        session.token,
        "short",
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await call(
        `/uploads/${session.id}/artifacts/modules-0/parts/1`,
        "PUT",
        session.token,
        "x".repeat(Buffer.byteLength(contents)),
      )
    ).status,
  ).toBe(200);
  expect(
    (await call(`/uploads/${session.id}/artifacts/modules-0/complete`, "POST", session.token))
      .status,
  ).toBe(400);
  expect((await call(`/builds/${session.id}`)).status).toBe(404);
  await complete(session);
});
test("downloads are attachments and support bounded source previews", async () => {
  const session = await create();
  await complete(session);
  const response = await call(
    `/builds/${session.id}/artifacts/modules-0`,
    "GET",
    undefined,
    undefined,
    { Range: "bytes=0-7" },
  );
  expect(response.status).toBe(206);
  expect(await response.text()).toBe(contents.slice(0, 8));
  expect(response.headers.get("Content-Disposition")).toContain("attachment");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});
test("monorepo histories stay separate; cross-project comparisons are rejected", async () => {
  const a = await create();
  await complete(a);
  const b = await create({ ...manifest(), project: "api" });
  await complete(b);
  expect((await call(`/builds/${b.id}/compare?before=${a.id}`)).status).toBe(400);
  const c = await create();
  await complete(c);
  const comparison = (await (await call(`/builds/${c.id}/compare?before=${a.id}`)).json()) as {
    before: string;
    metrics: { modules: { delta: number } };
  };
  expect(comparison.before).toBe(a.id);
  expect(comparison.metrics.modules.delta).toBe(0);
});
test("deletion requires same-origin maintainer access and removes artifacts", async () => {
  const session = await create();
  await complete(session);
  expect((await call(`/builds/${session.id}`, "DELETE")).status).toBe(403);
  state.user = { id: "user", name: "Alice" };
  state.write = false;
  expect(
    (
      await call(`/builds/${session.id}`, "DELETE", undefined, undefined, {
        Origin: settings.PLATFORM_ORIGIN,
      })
    ).status,
  ).toBe(403);
  state.write = true;
  expect(
    (
      await call(`/builds/${session.id}`, "DELETE", undefined, undefined, {
        Origin: settings.PLATFORM_ORIGIN,
      })
    ).status,
  ).toBe(200);
  expect((await call(`/builds/${session.id}`)).status).toBe(404);
  expect((await memoryStorage.list({ prefix: `reports/${session.id}/` })).objects).toHaveLength(0);
  expect(sqlite.prepare("SELECT count(*) AS total FROM upload_parts").get()?.total).toBe(0);
});
test("webhook verification rejects tampering", () => {
  const signature = "sha256=" + createHmac("sha256", "secret").update("{}").digest("hex");
  expect(verifyWebhook("{}", signature, "secret")).toBe(true);
  expect(verifyWebhook('{"changed":true}', signature, "secret")).toBe(false);
  expect(verifyWebhook("{}", "sha256=" + "0".repeat(64), "secret")).toBe(false);
  expect(verifyWebhook("{}", "invalid", "secret")).toBe(false);
});
test("signed webhook deliveries suspend installations and deduplicate replay", async () => {
  const session = await create();
  await complete(session);
  const receiver = new Hono<CloudEnv>().post("/", async (c) => {
    const result = await webhook(c as CloudContext);
    return result instanceof Response ? result : c.json(result);
  });
  const body = JSON.stringify({ action: "suspend", installation: { id: 123 } });
  const headers = {
    "Content-Type": "application/json",
    "X-GitHub-Delivery": "delivery-1",
    "X-GitHub-Event": "installation",
    "X-Hub-Signature-256":
      "sha256=" + createHmac("sha256", settings.GITHUB_WEBHOOK_SECRET).update(body).digest("hex"),
  };
  expect((await receiver.request("/", { method: "POST", headers, body })).status).toBe(200);
  expect((await call(`/builds/${session.id}`)).status).toBe(404);
  expect((await receiver.request("/", { method: "POST", headers, body })).status).toBe(200);
  expect(sqlite.prepare("SELECT count(*) AS total FROM webhook_deliveries").get()?.total).toBe(1);
});
test("large multipart artifacts can retry a part without duplicate data", async () => {
  const content = "x".repeat(PART_BYTES + 17),
    data = manifest();
  data.artifacts = [
    {
      id: "raw",
      kind: "raw",
      contentType: "application/gzip",
      bytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
    },
  ];
  const session = await create(data);
  const path = `/uploads/${session.id}/artifacts/raw`;
  for (let repeat = 0; repeat < 2; repeat++)
    expect(
      (await call(`${path}/parts/1`, "PUT", session.token, content.slice(0, PART_BYTES))).status,
    ).toBe(200);
  expect(
    (await call(`${path}/parts/2`, "PUT", session.token, content.slice(PART_BYTES))).status,
  ).toBe(200);
  expect((await call(`${path}/complete`, "POST", session.token)).status).toBe(200);
  expect((await call(`/uploads/${session.id}/complete`, "POST", session.token)).status).toBe(200);
  expect(await (await call(`/builds/${session.id}/artifacts/raw`)).text()).toBe(content);
});
test("concurrent completion retries converge on one verified artifact", async () => {
  const session = await create();
  await call(`/uploads/${session.id}/artifacts/modules-0/parts/1`, "PUT", session.token, contents);
  const results = await Promise.all(
    Array.from({ length: 3 }, () =>
      call(`/uploads/${session.id}/artifacts/modules-0/complete`, "POST", session.token),
    ),
  );
  expect(results.map((result) => result.status)).toEqual([200, 200, 200]);
  expect((await call(`/uploads/${session.id}/complete`, "POST", session.token)).status).toBe(200);
});
test("cleanup expires unfinished uploads but retains completed history until deletion", async () => {
  const ready = await create();
  await complete(ready);
  const pending = await create();
  sqlite.prepare("UPDATE builds SET created_at = ?").run(Date.now() - 2 * 86400000);
  await cleanupAbandoned();
  expect((await call(`/builds/${ready.id}`)).status).toBe(200);
  expect((await call(`/uploads/${pending.id}/complete`, "POST", pending.token)).status).toBe(404);
});
test("large manifests store descriptors separately from the bounded build row", async () => {
  const data = manifest();
  data.artifacts = Array.from({ length: 10000 }, (_, index) => ({
    id: `source-${"x".repeat(120)}-${index}`,
    kind: "source" as const,
    bytes: 1,
    sha256: "a".repeat(64),
    contentType: "text/plain" as const,
  }));
  expect(Buffer.byteLength(JSON.stringify(data))).toBeGreaterThan(2 * 1024 ** 2);
  const session = await create(data);
  const stored = sqlite
    .prepare("SELECT length(manifest) AS bytes, artifact_count AS count FROM builds WHERE id = ?")
    .get(session.id);
  expect(Number(stored?.bytes)).toBeLessThan(4096);
  expect(stored?.count).toBe(10000);
  expect(
    sqlite.prepare("SELECT count(*) AS total FROM artifacts WHERE build_id = ?").get(session.id)
      ?.total,
  ).toBe(10000);
});

test("warm reads reuse credentials, keep fresh checks, and avoid database writes", async () => {
  const session = await create();
  await complete(session);
  state.requests = [];
  const before = sqlite.prepare("SELECT total_changes() AS n").get()!.n;
  expect((await call(`/builds/${session.id}`)).status).toBe(200);
  expect((await call(`/builds/${session.id}/datasets/modules`)).status).toBe(200);
  expect(state.requests.filter((url) => url.endsWith("/access_tokens"))).toHaveLength(0);
  expect(state.requests.filter((url) => url.endsWith("/app/installations/123"))).toHaveLength(2);
  expect(state.requests.filter((url) => url.endsWith("/repositories/42"))).toHaveLength(2);
  expect(sqlite.prepare("SELECT total_changes() AS n").get()!.n).toBe(before);
});

test("comparison authorizes its repository once within the request", async () => {
  const a = await create(),
    b = await create();
  await complete(a);
  await complete(b);
  state.requests = [];
  expect((await call(`/builds/${b.id}/compare?before=${a.id}`)).status).toBe(200);
  expect(state.requests.filter((url) => url.endsWith("/repositories/42"))).toHaveLength(1);
  expect(state.requests.filter((url) => url.endsWith("/app/installations/123"))).toHaveLength(1);
  state.private = true;
  expect((await call(`/builds/${b.id}/compare?before=${a.id}`)).status).toBe(401);
});

test("installation credentials renew before expiration", async () => {
  const session = await create();
  await complete(session);
  state.requests = [];
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 3600_000);
  try {
    expect((await call(`/builds/${session.id}`)).status).toBe(200);
    expect(state.requests.filter((url) => url.endsWith("/access_tokens"))).toHaveLength(1);
    state.requests = [];
    expect((await call(`/builds/${session.id}`)).status).toBe(200);
    expect(state.requests.filter((url) => url.endsWith("/access_tokens"))).toHaveLength(0);
    state.active = false;
    expect((await call(`/builds/${session.id}`)).status).toBe(404);
  } finally {
    clock.mockRestore();
  }
});

async function trendBuild(
  value: number,
  options: {
    ref?: string;
    environment?: string;
    project?: string;
    name?: string;
    dataset?: "modules" | "plugins";
    pluginId?: string;
  } = {},
) {
  const data = manifest();
  data.environment = options.environment ?? "client";
  data.project = options.project ?? "web";
  data.summary.outputBytes = value;
  const content = JSON.stringify([
    {
      id: options.pluginId ?? "entry",
      name: options.name ?? "src/main.ts",
      bytes: value,
      ...(options.dataset === "plugins"
        ? { plugin: "compiler", hook: "Transform", calls: 2, durationMs: value }
        : {}),
    },
  ]);
  data.artifacts[0] = {
    ...data.artifacts[0],
    dataset: options.dataset ?? "modules",
    bytes: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
  const session = await create(data, { ref: options.ref ?? "refs/heads/main" });
  await complete(session, content);
  const projectId = sqlite.prepare("SELECT project_id FROM builds WHERE id = ?").get(session.id)!
    .project_id as string;
  return { ...session, projectId };
}
async function trends(projectId: string, query = "") {
  const response = await call(`/projects/${projectId}/trends${query ? `?${query}` : ""}`);
  expect(response.status).toBe(200);
  return response.json() as Promise<TrendResponse>;
}
test("main timelines isolate branches, projects, environments, and incomplete uploads", async () => {
  const a = await trendBuild(10),
    b = await trendBuild(20);
  await trendBuild(999, { ref: "refs/heads/feature" });
  await trendBuild(888, { environment: "ssr" });
  await trendBuild(777, { project: "other" });
  await create();
  const response = await trends(a.projectId);
  expect(response.points.map((point) => point.id)).toEqual([a.id, b.id]);
  expect(response.points.map((point) => point.values?.outputBytes)).toEqual([10, 20]);
  expect(response.environments).toEqual(["client", "ssr"]);
  expect((await trends(a.projectId, "environment=ssr")).points[0].values?.outputBytes).toBe(888);
  expect((await trends(a.projectId, "branch=feature")).points[0].values?.outputBytes).toBe(999);
});
test("dataset series include historical records, aggregate stable plugin identities, and plot removals as zero", async () => {
  const a = await trendBuild(12),
    b = await trendBuild(25);
  await trendBuild(30, { name: "src/other.ts", pluginId: "other" });
  const catalog = await trends(a.projectId, "dataset=modules&search=main");
  expect(catalog.entities.map((entry) => entry.label)).toEqual(["src/main.ts"]);
  const series = await trends(a.projectId, `dataset=modules&entity=${catalog.entities[0].id}`);
  expect(series.points.map((point) => point.values?.bytes)).toEqual([12, 25, 0]);
  await trendBuild(14, { dataset: "plugins", pluginId: "1:Transform" });
  await trendBuild(29, { dataset: "plugins", pluginId: "99:Transform" });
  const plugins = await trends(b.projectId, "dataset=plugins");
  expect(plugins.entities).toHaveLength(1);
  const hook = await trends(b.projectId, `dataset=plugins&entity=${plugins.entities[0].id}`);
  expect(hook.points.slice(-2).map((point) => point.values?.durationMs)).toEqual([14, 29]);
});
test("trend pagination is stable for equal timestamps and rejects cross-project cursors", async () => {
  const a = await trendBuild(10);
  await trendBuild(20);
  await trendBuild(30);
  await trendBuild(40);
  sqlite.prepare("UPDATE builds SET created_at = 1000 WHERE project_id = ?").run(a.projectId);
  const first = await trends(a.projectId, "limit=2");
  expect(first.points).toHaveLength(2);
  const second = await trends(a.projectId, `limit=2&cursor=${first.nextCursor}`);
  expect(second.points).toHaveLength(2);
  expect(new Set([...first.points, ...second.points].map((point) => point.id)).size).toBe(4);
  expect(second.nextCursor).toBeNull();
  const other = await trendBuild(1, { project: "other" });
  expect((await call(`/projects/${a.projectId}/trends?cursor=${other.id}`)).status).toBe(400);
});
test("historical backfill is idempotent and chart reads never fetch R2", async () => {
  const session = await trendBuild(42);
  sqlite.prepare("DELETE FROM trend_index WHERE build_id = ?").run(session.id);
  sqlite.prepare("DELETE FROM trend_measurements WHERE build_id = ?").run(session.id);
  const before = await trends(session.projectId, "dataset=modules");
  expect(before.pending).toBe(1);
  expect(before.points[0].values).toBeNull();
  await backfillTrends([session.id]);
  const rowCount = sqlite.prepare("SELECT count(*) AS n FROM trend_measurements").get()!.n;
  await backfillTrends([session.id]);
  expect(sqlite.prepare("SELECT count(*) AS n FROM trend_measurements").get()!.n).toBe(rowCount);
  const get = vi.spyOn(memoryStorage, "get");
  try {
    const after = await trends(session.projectId, "dataset=modules");
    expect(after.pending).toBe(0);
    expect(after.points[0].values?.bytes).toBe(42);
    expect(get).not.toHaveBeenCalled();
  } finally {
    get.mockRestore();
  }
});
test("timeline reads check current private access and deletion removes indexed data", async () => {
  const session = await trendBuild(42);
  state.private = true;
  expect((await call(`/projects/${session.projectId}/trends`)).status).toBe(401);
  state.user = { id: "user", name: "Alice" };
  expect((await call(`/projects/${session.projectId}/trends`)).status).toBe(200);
  state.access = false;
  expect((await call(`/projects/${session.projectId}/trends`)).status).toBe(404);
  state.access = true;
  expect(
    (
      await call(`/builds/${session.id}`, "DELETE", undefined, undefined, {
        Origin: settings.PLATFORM_ORIGIN,
      })
    ).status,
  ).toBe(200);
  expect(
    sqlite
      .prepare("SELECT count(*) AS n FROM trend_measurements WHERE build_id = ?")
      .get(session.id)!.n,
  ).toBe(0);
  expect(
    sqlite.prepare("SELECT count(*) AS n FROM trend_index WHERE build_id = ?").get(session.id)!.n,
  ).toBe(0);
});

test("small artifact batches verify checksums, stay scoped, and publish idempotently", async () => {
  const a = await create(),
    b = await create();
  const body = JSON.stringify([
    { id: "modules-0", content: Buffer.from(contents).toString("base64") },
  ]);
  expect((await call(`/uploads/${a.id}/artifacts/batch`, "POST", b.token, body)).status).toBe(401);
  expect(
    (
      await call(
        `/uploads/${a.id}/artifacts/batch`,
        "POST",
        a.token,
        JSON.stringify([{ id: "modules-0", content: Buffer.from("tampered").toString("base64") }]),
      )
    ).status,
  ).toBe(400);
  expect((await call(`/uploads/${a.id}/artifacts/batch`, "POST", a.token, body)).status).toBe(200);
  expect((await call(`/uploads/${a.id}/artifacts/batch`, "POST", a.token, body)).status).toBe(200);
  expect((await call(`/uploads/${a.id}/complete`, "POST", a.token)).status).toBe(200);
  expect((await call(`/builds/${a.id}/datasets/modules`)).status).toBe(200);
});

test("regressions compare the preceding distinct main commit in the same project and environment", async () => {
  async function build(
    sha: string,
    size: number,
    time: number,
    options: { environment?: string; ref?: string; project?: string } = {},
  ) {
    const data = manifest();
    data.summary.outputBytes = size;
    data.summary.durationMs = time;
    data.environment = options.environment ?? "client";
    data.project = options.project ?? "web";
    const session = await create(data, {
      sha: sha.repeat(40),
      ref: options.ref ?? "refs/heads/main",
    });
    await complete(session);
    return session;
  }
  const baseline = await build("a", 100000, 1000);
  const first = (await (await call(`/builds/${baseline.id}/regressions`)).json()) as {
    status: string;
  };
  expect(first.status).toBe("baseline");
  await build("c", 999999, 9999, { environment: "ssr" });
  await build("f", 999999, 9999, { ref: "refs/heads/feature" });
  await build("d", 999999, 9999, { project: "another" });
  const after = await build("b", 120000, 1400);
  const rerun = await build("b", 120000, 1400);
  for (const id of [after.id, rerun.id]) {
    const response = await call(`/builds/${id}/regressions`);
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      status: string;
      baseline: { id: string };
      changes: { regression: boolean }[];
    };
    expect(result.status).toBe("regression");
    expect(result.baseline.id).toBe(baseline.id);
    expect(result.changes.filter((change) => change.regression)).toHaveLength(2);
  }
  state.private = true;
  expect((await call(`/builds/${after.id}/regressions`)).status).toBe(401);
  state.user = { id: "user", name: "Alice" };
  state.access = false;
  expect((await call(`/builds/${after.id}/regressions`)).status).toBe(404);
});

test("compressed dataset pages round trip and reject oversized decoded data", async () => {
  const { gzipSync } = await import("node:zlib");
  for (const oversized of [false, true]) {
    const body = gzipSync(
      oversized
        ? JSON.stringify([{ id: "big", name: "big", payload: "x".repeat(600000) }])
        : contents,
    );
    const data = manifest();
    data.artifacts[0] = {
      ...data.artifacts[0],
      contentType: "application/gzip",
      bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
    };
    const session = await create(data);
    expect(
      (
        await call(
          `/uploads/${session.id}/artifacts/batch`,
          "POST",
          session.token,
          JSON.stringify([{ id: "modules-0", content: body.toString("base64") }]),
        )
      ).status,
    ).toBe(200);
    expect((await call(`/uploads/${session.id}/complete`, "POST", session.token)).status).toBe(
      oversized ? 400 : 200,
    );
    const response = await call(`/builds/${session.id}/datasets/modules`);
    expect(response.status).toBe(oversized ? 404 : 200);
    if (!oversized)
      expect(((await response.json()) as { rows: { name: string }[] }).rows[0].name).toBe(
        "src/main.ts",
      );
  }
});

test("upload state and receipt reads use primary-consistent D1 sessions", async () => {
  const sessions = vi.spyOn(d1, "withSession");
  try {
    const session = await create();
    await complete(session);
    expect(sessions).toHaveBeenCalledWith("first-primary");
  } finally {
    sessions.mockRestore();
  }
});

test("large indexes resume checkpoints and remain unpublished until every batch is stored", async () => {
  const { gzipSync } = await import("node:zlib");
  const session = await trendBuild(42);
  sqlite.prepare("UPDATE builds SET state = 'uploading' WHERE id = ?").run(session.id);
  sqlite.prepare("DELETE FROM trend_index WHERE build_id = ?").run(session.id);
  sqlite.prepare("DELETE FROM trend_measurements WHERE build_id = ?").run(session.id);
  const prefix = `reports/${session.id}/.trend-index-1`;
  const batches = Array.from({ length: 20 }, (_, i) => [
    {
      dataset: "modules",
      entity: `entity-${i}`,
      label: `Module ${i}`,
      metrics: { records: 1, bytes: i },
    },
  ]);
  await memoryStorage.put(`${prefix}/plan`, gzipSync(JSON.stringify(batches)));
  await memoryStorage.delete(`${prefix}/cursor`);
  const finish = () => call(`/uploads/${session.id}/complete`, "POST", session.token);
  expect((await finish()).status).toBe(202);
  expect((await call(`/builds/${session.id}`)).status).toBe(404);
  expect(
    sqlite.prepare("SELECT count(*) AS n FROM trend_index WHERE build_id = ?").get(session.id)!.n,
  ).toBe(0);
  expect(
    sqlite
      .prepare("SELECT count(*) AS n FROM trend_measurements WHERE build_id = ?")
      .get(session.id)!.n,
  ).toBe(16);
  // A lost cursor receipt can repeat writes without double-counting measurements.
  await memoryStorage.delete(`${prefix}/cursor`);
  expect((await finish()).status).toBe(202);
  expect((await finish()).status).toBe(200);
  expect((await call(`/builds/${session.id}`)).status).toBe(200);
  expect(
    sqlite
      .prepare(
        "SELECT count(*) AS n, sum(json_extract(metrics, '$.records')) AS records FROM trend_measurements WHERE build_id = ?",
      )
      .get(session.id),
  ).toMatchObject({ n: 20, records: 20 });
});
