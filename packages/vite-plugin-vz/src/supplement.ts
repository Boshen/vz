import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { ResolvedConfig, Rollup } from "vite";
import type { DiagnosticRow } from "@vz/protocol";
import { describeArtifact, normalizeId, type LocalArtifact } from "./capture";

export interface Supplement {
  artifacts: LocalArtifact[];
  modules: DiagnosticRow[];
  chunks: DiagnosticRow[];
  assets: DiagnosticRow[];
}
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Copy lazy native objects before the bundler releases their memory. */
export async function collectBundle(
  directory: string,
  config: ResolvedConfig,
  options: Rollup.NormalizedOutputOptions,
  bundle: Rollup.OutputBundle,
  infos: Iterable<Rollup.ModuleInfo>,
  root: string,
  number: number,
  environment: string,
): Promise<Supplement> {
  const result: Supplement = { artifacts: [], modules: [], chunks: [], assets: [] };
  const stored = new Set<string>();
  const compressedSizes = new Map<string, number>();
  const id = (value: string) => normalizeId(value, root);
  async function store(
    content: string | Uint8Array,
    kind: "source" | "output" | "sourcemap",
    name?: string,
  ) {
    const compressed = kind !== "source";
    const data = compressed ? gzipSync(content) : content || "\n";
    const key = `${kind}-${hash(content)}`;
    if (!stored.has(key)) {
      stored.add(key);
      const path = join(directory, key);
      if (compressed) compressedSizes.set(key, Buffer.byteLength(data));
      await writeFile(path, data);
      result.artifacts.push(
        await describeArtifact(path, {
          id: key,
          kind,
          name,
          contentType: compressed ? "application/gzip" : "text/plain",
        }),
      );
    }
    return key;
  }
  for (const info of infos) {
    const source = info.code === null ? undefined : await store(info.code, "source");
    result.modules.push({
      id: id(info.id),
      name: id(info.id),
      source,
      imports: info.importedIds.map(id),
      details: {
        importers: info.importers.map(id),
        dynamicImporters: info.dynamicImporters.map(id),
        dynamicImports: info.dynamicallyImportedIds.map(id),
        exports: info.exports,
        entry: info.isEntry,
        sideEffects: info.moduleSideEffects,
      },
    });
  }
  const moduleRows = new Map(result.modules.map((row) => [row.id, row]));
  for (const output of Object.values(bundle)) {
    const content = output.type === "chunk" ? output.code : output.source;
    const contentBytes =
      typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
    const outputArtifact = await store(
      content,
      output.fileName.endsWith(".map") ? "sourcemap" : "output",
      output.fileName,
    );
    const key = `${number}:${output.fileName}`;
    const details: Record<string, unknown> = {
      filename: output.fileName,
      format: options.format,
      output: number,
      outputArtifact,
      gzipBytes: compressedSizes.get(outputArtifact),
    };
    const text = typeof content === "string" ? await store(content, "source") : undefined;
    result.assets.push({
      id: key,
      name: output.fileName,
      bytes: contentBytes,
      source: text,
      details,
    });
    if (output.type !== "chunk") continue;
    const rendering = [];
    for (const [moduleId, rendered] of Object.entries(output.modules)) {
      const renderedSource =
        rendered.code === null ? undefined : await store(rendered.code, "source");
      const renderedInfo = {
        id: id(moduleId),
        renderedLength: rendered.renderedLength,
        renderedExports: rendered.renderedExports,
        source: renderedSource,
      };
      rendering.push(renderedInfo);
      const module = moduleRows.get(id(moduleId));
      if (module) {
        module.rendered = renderedSource ?? module.rendered;
        const prior = (module.details?.rendering ?? []) as unknown[];
        module.details = {
          ...module.details,
          rendering: [...prior, { ...renderedInfo, chunk: output.fileName, output: number }],
        };
      }
    }
    const sourceMap = output.map
      ? await store(
          output.map.toString(),
          "sourcemap",
          output.sourcemapFileName ?? `${output.fileName}.map`,
        )
      : undefined;
    result.chunks.push({
      id: key,
      name: output.fileName,
      bytes: contentBytes,
      source: text,
      imports: output.imports,
      modules: output.moduleIds.map(id),
      details: {
        ...details,
        sourceMap,
        entry: output.isEntry,
        async: output.isDynamicEntry,
        entryModule: output.facadeModuleId ? id(output.facadeModuleId) : null,
        dynamicImports: output.dynamicImports,
        exports: output.exports,
        rendering,
        importedCss: [...(output.viteMetadata?.importedCss ?? [])],
        importedAssets: [...(output.viteMetadata?.importedAssets ?? [])],
      },
    });
  }
  const snapshot = {
    version: 1,
    environment,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    config: {
      root: id(config.root),
      mode: config.mode,
      base: config.base,
      command: config.command,
      appType: config.appType,
      publicDir: id(config.publicDir),
      plugins: config.plugins.map((plugin) => ({
        name: plugin.name,
        enforce: plugin.enforce,
        apply: typeof plugin.apply === "string" ? plugin.apply : undefined,
      })),
      build: {
        target: config.build.target,
        minify: config.build.minify,
        cssMinify: config.build.cssMinify,
        cssCodeSplit: config.build.cssCodeSplit,
        sourcemap: config.build.sourcemap,
        assetsInlineLimit:
          typeof config.build.assetsInlineLimit === "number"
            ? config.build.assetsInlineLimit
            : "function",
        ssr: config.build.ssr,
        manifest: config.build.manifest,
        ssrManifest: config.build.ssrManifest,
      },
    },
    output: { format: options.format, sourcemap: options.sourcemap },
    files: result.assets,
    modules: result.modules,
    chunks: result.chunks,
  };
  const path = join(directory, `vite-output-${number}.json.gz`);
  await writeFile(path, gzipSync(JSON.stringify(snapshot)));
  result.artifacts.push(
    await describeArtifact(path, {
      id: `vite-output-${number}`,
      kind: "metadata",
      name: `vite-output-${number}.json.gz`,
      contentType: "application/gzip",
    }),
  );
  return result;
}
