import { gunzipSync } from "node:zlib";
import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture } from "../packages/vite-plugin-vz/src/capture";
import vz from "../packages/vite-plugin-vz/src/index";
import { buildManifestSchema, PAGE_BYTES } from "@vz/protocol";
const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
test("normalizes native graphs, timings, and deduplicated source without losing raw events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vz-test-"));
  temporary.push(directory);
  await writeFile(join(directory, "meta.json"), JSON.stringify({ build_id: "one" }));
  const events = [
    { action: "BuildStart", timestamp: 100 },
    { action: "StringRef", id: "a".repeat(64), content: "export const x = 1;" },
    {
      action: "HookTransformCallStart",
      timestamp: 101,
      call_id: "call",
      plugin_id: 1,
      plugin_name: "transform",
      module_id: "/app/src/main.ts",
      content: "$ref:" + "a".repeat(64),
    },
    {
      action: "HookTransformCallEnd",
      timestamp: 104,
      call_id: "call",
      plugin_id: 1,
      plugin_name: "transform",
      module_id: "/app/src/main.ts",
      content: "export const x = 2;",
    },
    {
      action: "ModuleGraphReady",
      modules: [{ id: "/app/src/main.ts", imports: [], is_external: false }],
    },
    { action: "ModuleRenderedReady", modules: [{ id: "/app/src/main.ts", bytes: 19 }] },
    {
      action: "ChunkGraphReady",
      chunks: [{ chunk_id: 0, name: "main", modules: ["/app/src/main.ts"], imports: [] }],
    },
    { action: "PackageGraphReady", packages: [] },
    {
      action: "AssetsReady",
      assets: [{ chunk_id: 0, filename: "main.js", size: 19, content: "export const x = 2;" }],
    },
    { action: "FutureEvent", timestamp: 110 },
    { action: "BuildEnd", timestamp: 120 },
  ];
  await writeFile(
    join(directory, "logs.json"),
    events.map((event) => JSON.stringify({ build_id: "one", ...event })).join("\n") + "\n",
  );
  const result = await capture(directory, join(directory, "output"), "/app");
  expect(result.summary).toEqual({
    durationMs: 20,
    outputBytes: 19,
    modules: 1,
    chunks: 1,
    assets: 1,
    packages: 0,
  });
  const modules = JSON.parse(
    gunzipSync(
      await readFile(result.artifacts.find((artifact) => artifact.id === "modules-0")!.path),
    ).toString(),
  );
  expect(modules[0].id).toBe("src/main.ts");
  expect(modules[0].source).toMatch(/^source-/);
  const plugins = JSON.parse(
    gunzipSync(
      await readFile(result.artifacts.find((artifact) => artifact.id === "plugins-0")!.path),
    ).toString(),
  );
  expect(plugins[0].durationMs).toBe(3);
  expect(result.artifacts.filter((artifact) => artifact.kind === "source")).toHaveLength(2);
  expect(
    result.artifacts
      .filter((artifact) => artifact.kind === "dataset")
      .every((artifact) => artifact.bytes <= PAGE_BYTES),
  ).toBe(true);
  expect(result.artifacts.some((artifact) => artifact.kind === "raw")).toBe(true);
});
test("disabled and local plugin configurations never enable collection", async () => {
  vi.stubEnv("GITHUB_ACTIONS", "false");
  const plugin = vz({ endpoint: "https://vz.example" });
  const configHook = plugin.config;
  if (typeof configHook !== "function") throw new Error("Expected config hook");
  await configHook.call({} as never, {}, { command: "build", mode: "production" });
  if (typeof plugin.configEnvironment !== "function") throw new Error("Expected environment hook");
  expect(
    await plugin.configEnvironment.call(
      {} as never,
      "client",
      {},
      { command: "build", mode: "production" },
    ),
  ).toBeUndefined();
  vi.stubEnv("GITHUB_ACTIONS", "true");
  vi.stubEnv(
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "https://pipelines.actions.githubusercontent.com/token",
  );
  vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "test");
  const disabled = vz({ endpoint: "https://vz.example", enabled: false });
  if (typeof disabled.config === "function")
    await disabled.config.call({} as never, {}, { command: "build", mode: "production" });
  if (typeof disabled.configEnvironment === "function")
    expect(
      await disabled.configEnvironment.call(
        {} as never,
        "client",
        {},
        { command: "build", mode: "production" },
      ),
    ).toBeUndefined();
});
test("manifest validation rejects duplicate or unsafe artifacts and unsupported schemas", () => {
  expect(buildManifestSchema.safeParse({ version: 99 }).success).toBe(false);
});

test("oversized graphs and future events remain lossless without exceeding dataset pages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vz-large-record-"));
  temporary.push(directory);
  await writeFile(join(directory, "meta.json"), JSON.stringify({ build_id: "large" }));
  const imports = Array.from({ length: 30000 }, (_, index) => ({
    module_id: `/app/dependency-${index}.ts`,
    kind: "dynamic-import",
  }));
  const payload = "future-payload".repeat(PAGE_BYTES / 4);
  const events = [
    { action: "BuildStart", timestamp: 0 },
    {
      action: "ModuleGraphReady",
      modules: [
        {
          id: "/app/main.ts",
          imports,
          importers: ["/app/entry.ts"],
          is_external: false,
          future: { retained: true },
        },
      ],
    },
    {
      action: "ChunkGraphReady",
      chunks: [{ chunk_id: 0, name: "main", modules: ["/app/main.ts"], imports: [] }],
    },
    { action: "FutureEvent", timestamp: 10, payload },
    { action: "BuildEnd", timestamp: 20 },
  ];
  await writeFile(
    join(directory, "logs.json"),
    events.map((event) => JSON.stringify({ build_id: "large", ...event })).join("\n"),
  );
  const result = await capture(directory, join(directory, "output"), "/app");
  expect(result.summary.durationMs).toBe(20);
  const pages = result.artifacts.filter((artifact) => artifact.kind === "dataset");
  expect(pages.every((artifact) => artifact.bytes <= PAGE_BYTES)).toBe(true);
  const modules = JSON.parse(
    gunzipSync(
      await readFile(result.artifacts.find((artifact) => artifact.id === "modules-0")!.path),
    ).toString(),
  );
  expect(modules[0].details.trendValues.imports).toBe(30000);
  const artifact = result.artifacts.find(
    (artifact) => artifact.id === modules[0].details.fullRecord,
  )!;
  const full = JSON.parse(gunzipSync(await readFile(artifact.path)).toString());
  expect(full.imports).toHaveLength(30000);
  expect(full.details.imports[0].kind).toBe("dynamic-import");
  expect(full.details.importers).toEqual(["/app/entry.ts"]);
  expect(full.details.future.retained).toBe(true);
  const eventRows = (
    await Promise.all(
      pages
        .filter((page) => page.dataset === "events")
        .map(async (page) => JSON.parse(gunzipSync(await readFile(page.path)).toString())),
    )
  ).flat();
  const event = eventRows.find((row) => row.name === "FutureEvent");
  const eventArtifact = result.artifacts.find(
    (artifact) => artifact.id === event.details.fullRecord,
  )!;
  expect(
    JSON.parse(gunzipSync(await readFile(eventArtifact.path)).toString()).details.payload,
  ).toBe(payload);
});
