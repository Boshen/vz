import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { version as viteVersion, type Plugin, type ResolvedConfig } from "vite";
import { buildManifestSchema } from "@vz/protocol";
import { capture, describeArtifact } from "./capture";
import { collectBundle, type Supplement } from "./supplement";
import { gzipSync } from "node:zlib";
import { upload } from "./upload";

export interface VzOptions {
  endpoint: string;
  project?: string;
  enabled?: boolean;
  strict?: boolean;
}
export default function vz(options: VzOptions): Plugin {
  const sessions = new Map<string, { id: string; cwd: string }>();
  const prefix = randomUUID();
  let config: ResolvedConfig;
  let active = false;
  const supplements = new Map<string, Supplement[]>();
  const pending = new Set<Promise<void>>();
  const outputNumbers = new Map<string, number>();
  const directories = new Set<string>();
  const warnings: Record<string, unknown>[] = [];
  let captureError: unknown;

  function failure(error: unknown) {
    const message = `[vz] ${error instanceof Error ? error.message : String(error)}`;
    if (options.strict) throw new Error(message);
    (config?.logger ?? console).warn(message);
  }
  return {
    name: "vite-plugin-vz",
    enforce: "post",
    sharedDuringBuild: true,
    apply: "build",
    config(userConfig) {
      if (options.enabled === false || process.env.GITHUB_ACTIONS !== "true") return;
      if (
        !process.env.ACTIONS_ID_TOKEN_REQUEST_URL ||
        !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
      ) {
        failure("Uploads skipped: set permissions.id-token: write in GitHub Actions.");
        return;
      }
      try {
        if (new URL(options.endpoint).protocol !== "https:")
          throw new Error("The upload endpoint must use HTTPS.");
      } catch (error) {
        failure(error);
        return;
      }
      active = true;
      const originalBuildApp = userConfig.builder?.buildApp;
      return {
        builder: {
          async buildApp(builder) {
            if (originalBuildApp) await originalBuildApp(builder);
            // Vite's default builder builds environments after post hooks. Move that
            // same fallback here so native logs are closed before our upload hook.
            if (Object.values(builder.environments).every((environment) => !environment.isBuilt)) {
              for (const environment of Object.values(builder.environments))
                await builder.build(environment);
            }
          },
        },
      };
    },
    configResolved(resolved) {
      config = resolved;
    },
    configEnvironment(name, environment) {
      if (!active) return;
      const id = `vz-${prefix}-${name}`;
      sessions.set(name, {
        id,
        cwd: resolve(environment.build?.rolldownOptions?.cwd ?? process.cwd()),
      });
      return { build: { rolldownOptions: { devtools: { mode: "full", sessionId: id } } } };
    },
    onLog(level, log) {
      if (active)
        warnings.push({
          level,
          code: log.code,
          message: log.message,
          plugin: log.plugin,
          id: log.id,
          hook: log.hook,
          loc: log.loc,
          frame: log.frame,
        });
    },
    writeBundle: {
      order: "post",
      async handler(options, bundle) {
        if (!active || captureError) return;
        const environment = this.environment.name;
        const number = outputNumbers.get(environment) ?? 0;
        outputNumbers.set(environment, number + 1);
        const infos = [...this.getModuleIds()]
          .map((id) => this.getModuleInfo(id))
          .filter((info) => info !== null);
        const task = (async () => {
          const directory = await mkdtemp(join(tmpdir(), "vz-output-"));
          directories.add(directory);
          const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
            cwd: this.environment.config.root,
            encoding: "utf8",
          }).trim();
          const records = supplements.get(environment) ?? [];
          supplements.set(environment, records);
          const result = await collectBundle(
            directory,
            this.environment.config,
            options,
            bundle,
            infos,
            root,
            number,
            environment,
          );
          records.push(result);
        })().catch((error: unknown) => {
          captureError = error;
        });
        pending.add(task);
        await task;
        pending.delete(task);
      },
    },
    buildApp: {
      order: "post",
      async handler(builder) {
        if (!active) return;
        // Vite can reload config for each environment, creating another plugin
        // instance before sharing hooks. Read the session used by the built config.
        for (const [name, environment] of Object.entries(builder.environments)) {
          const native = environment.config.build.rolldownOptions;
          const devtools = native.devtools;
          if (devtools && typeof devtools === "object" && devtools.sessionId)
            sessions.set(name, {
              id: devtools.sessionId,
              cwd: resolve(native.cwd ?? process.cwd()),
            });
        }
        let temporary: string | undefined;
        try {
          await Promise.all(pending);
          if (captureError) throw captureError;
          temporary = await mkdtemp(join(tmpdir(), "vz-"));
          const checkoutRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
            cwd: config.root,
            encoding: "utf8",
          }).trim();
          const checkoutSha = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: config.root,
            encoding: "utf8",
          }).trim();
          const require = createRequire(join(config.root, "package.json"));
          const vitePackagePath = require.resolve("vite/package.json");
          const vitePackage = JSON.parse(await readFile(vitePackagePath, "utf8")) as {
            name: string;
          };
          const resolver = createRequire(vitePackagePath);
          const rolldownPath =
            vitePackage.name === "@voidzero-dev/vite-plus-core"
              ? require.resolve("vite/rolldown")
              : resolver.resolve("rolldown");
          const { VERSION: rolldownVersion } = (await import(pathToFileURL(rolldownPath).href)) as {
            VERSION: string;
          };
          if (!rolldownVersion.startsWith("1.2."))
            throw new Error(`Rolldown ${rolldownVersion} is not supported by this capture adapter`);
          for (const [environment, session] of sessions) {
            if (!builder.environments[environment]?.isBuilt) continue;
            const directory = join(session.cwd, "node_modules/.rolldown", session.id);
            await stat(join(directory, "logs.json"));
            const result = await capture(
              directory,
              join(temporary, environment),
              checkoutRoot,
              supplements.get(environment),
            );
            const contextPath = join(temporary, `${environment}-context.json.gz`);
            await writeFile(
              contextPath,
              gzipSync(
                JSON.stringify({
                  version: 1,
                  environment,
                  warnings,
                  memory: process.memoryUsage(),
                  cpu: process.cpuUsage(),
                }),
              ),
            );
            result.artifacts.push(
              await describeArtifact(contextPath, {
                id: "build-context",
                kind: "metadata",
                name: "build-context.json.gz",
                contentType: "application/gzip",
              }),
            );
            const manifest = buildManifestSchema.parse({
              version: 1,
              captureId: randomUUID(),
              project:
                options.project ??
                (relative(checkoutRoot, config.root).replaceAll("\\", "/") || "."),
              environment,
              checkoutSha,
              producer: { plugin: "0.2.0", vite: viteVersion, rolldown: rolldownVersion },
              summary: result.summary,
              artifacts: result.artifacts.map(({ path: _path, ...artifact }) => artifact),
            });
            const url = await upload(options.endpoint, manifest, result.artifacts);
            config.logger.info(`[vz] ${environment} report: ${url}`);
          }
        } catch (error) {
          failure(error);
        } finally {
          const paths = [...sessions.values()].map((session) =>
            join(session.cwd, "node_modules/.rolldown", session.id),
          );
          if (temporary) paths.push(temporary);
          paths.push(...directories);
          await Promise.all(
            paths.map((path) =>
              rm(path, { recursive: true, force: true }).catch(() =>
                config.logger.warn("[vz] Could not clean up a temporary diagnostic capture"),
              ),
            ),
          );
        }
      },
    },
  };
}
