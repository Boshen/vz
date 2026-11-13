import { expect, test, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createBuilder } from "vite";
import vz from "../packages/vite-plugin-vz/src/index";
import { buildManifestSchema, type BuildManifest } from "@vz/protocol";

test.each([false, true])("real Vite capture with config reload: %s", async (reloadConfig) => {
  const fixture = await mkdtemp(resolve(".void/vz-integration-"));
  await writeFile(join(fixture, "package.json"), '{"name":"fixture","type":"module"}');
  await writeFile(join(fixture, "entry.js"), "export const answer = 42;");
  vi.stubEnv("GITHUB_ACTIONS", "true");
  vi.stubEnv(
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "https://pipelines.actions.githubusercontent.com/token",
  );
  vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "test-only");
  const manifests: BuildManifest[] = [];
  let parts = 0,
    completed = 0;
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    if (input.startsWith("https://pipelines.actions.githubusercontent.com/")) {
      expect(new URL(input).searchParams.get("audience")).toBe("https://vz.example");
      return Response.json({ value: "test-oidc" });
    }
    expect(input.startsWith("https://vz.example/api/v1/uploads")).toBe(true);
    if (input === "https://vz.example/api/v1/uploads") {
      manifests.push(buildManifestSchema.parse(JSON.parse(init.body as string)));
      return Response.json({
        id: "test-capture",
        token: "test-upload",
        reportUrl: "https://vz.example/reports/test-capture",
      });
    }
    if (init.method === "PUT") parts++;
    if (input.endsWith("/test-capture/complete")) completed++;
    return Response.json({ ok: true });
  });
  try {
    const configFile = join(fixture, "vite.config.ts");
    await writeFile(
      configFile,
      `import vz from ${JSON.stringify(resolve("packages/vite-plugin-vz/src/index.ts"))}; export default { plugins: [vz({ endpoint: "https://vz.example", strict: true })] };`,
    );
    const builder = await createBuilder(
      {
        configFile: reloadConfig ? configFile : false,
        root: fixture,
        logLevel: "silent",
        plugins: reloadConfig ? [] : [vz({ endpoint: "https://vz.example", strict: true })],
        build: {
          lib: { entry: join(fixture, "entry.js"), formats: ["es"] },
          outDir: join(fixture, "dist"),
        },
      },
      !reloadConfig,
    );
    await builder.buildApp();
    expect(manifests).toHaveLength(1);
    expect(manifests[0].producer.rolldown).toBe("1.2.18");
    expect(manifests[0].producer.vite).toBe("8.3.7");
    expect(manifests[0].summary.modules).toBeGreaterThan(0);
    expect(manifests[0].artifacts.some((artifact) => artifact.kind === "raw")).toBe(true);
    expect(parts).toBeGreaterThan(0);
    expect(completed).toBe(1);
  } finally {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(fixture, { recursive: true, force: true });
  }
});
