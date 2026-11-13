import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import {
  datasets,
  PAGE_BYTES,
  type ArtifactManifest,
  type BuildSummary,
  type Dataset,
  type DiagnosticRow,
} from "@vz/protocol";

export interface LocalArtifact extends ArtifactManifest {
  path: string;
}
type NativeEvent = Record<string, unknown> & {
  action: string;
  timestamp?: number;
  call_id?: string;
};
type NativeItem = Record<string, unknown>;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const scalar = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
export function normalizeId(id: string, root: string) {
  const clean = id.replaceAll("\\", "/");
  return clean.startsWith(root.replaceAll("\\", "/") + "/")
    ? clean.slice(root.length + 1)
    : clean.replaceAll("\0", "virtual:");
}
export async function describeArtifact(
  path: string,
  info: Omit<ArtifactManifest, "bytes" | "sha256">,
): Promise<LocalArtifact> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return { ...info, path, bytes: (await stat(path)).size, sha256: digest.digest("hex") };
}

/** Native JSONL is decoded one event at a time. Large source strings live on disk. */
export async function capture(directory: string, output: string, root: string) {
  await mkdir(output, { recursive: true });
  const meta = JSON.parse(await readFile(join(directory, "meta.json"), "utf8")) as {
    build_id?: string;
  };
  const rows = {
    modules: [],
    chunks: [],
    assets: [],
    packages: [],
    plugins: [],
    events: [],
  } as Record<Dataset, DiagnosticRow[]>;
  const artifacts: LocalArtifact[] = [];
  const strings = new Map<string, string>();
  const sources = new Set<string>();
  const calls = new Map<string, { event: NativeEvent; source?: string }>();
  const timings = new Map<string, DiagnosticRow>();
  const modules = new Map<string, DiagnosticRow>();
  let start = Infinity,
    end = 0,
    sequence = 0,
    eventBytes = 2,
    eventPage = 0;
  const id = (value: unknown) => normalizeId(scalar(value), root);
  async function source(content: unknown): Promise<string | undefined> {
    if (content && typeof content === "object") {
      const ref = content as Record<string, unknown>;
      return strings.get(scalar(ref.id ?? ref.value ?? ref.StringRef ?? ref.string_ref));
    }
    if (typeof content !== "string") return undefined;
    if (/^\$ref:[a-f0-9]{64}$/.test(content)) {
      const reference = strings.get(content.slice(5));
      if (!reference) throw new Error("Unresolved Rolldown source reference");
      return reference;
    }
    const name = `source-${hash(content)}`;
    if (!sources.has(name)) {
      sources.add(name);
      const path = join(output, name);
      // Empty sources are meaningful; store a newline rather than a zero-byte multipart upload.
      await writeFile(path, content || "\n");
      artifacts.push(
        await describeArtifact(path, { id: name, kind: "source", contentType: "text/plain" }),
      );
    }
    return name;
  }
  async function page(dataset: Dataset, data: DiagnosticRow[], number: number) {
    const name = `${dataset}-${number}`;
    const path = join(output, name);
    await writeFile(path, JSON.stringify(data));
    artifacts.push(
      await describeArtifact(path, {
        id: name,
        kind: "dataset",
        dataset,
        page: number,
        contentType: "application/json",
      }),
    );
  }
  async function addEvent(row: DiagnosticRow) {
    const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (eventBytes + bytes > PAGE_BYTES && rows.events.length) {
      await page("events", rows.events, eventPage++);
      rows.events = [];
      eventBytes = 2;
    }
    rows.events.push(row);
    eventBytes += bytes;
  }
  for await (const line of createInterface({
    input: createReadStream(join(directory, "logs.json")),
    crlfDelay: Infinity,
  })) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as NativeEvent;
    if (e.action === "StringRef") {
      const ref = await source(e.content);
      if (ref) strings.set(String(e.id), ref);
      continue;
    }
    if (meta.build_id && e.build_id !== meta.build_id) continue;
    if (e.timestamp) {
      start = Math.min(start, e.timestamp);
      end = Math.max(end, e.timestamp);
    }
    if (e.action === "ModuleGraphReady")
      for (const item of e.modules as NativeItem[]) {
        const key = id(item.id);
        modules.set(key, {
          ...modules.get(key),
          id: key,
          name: key,
          imports: ((item.imports as NativeItem[]) ?? []).map((edge) => id(edge.module_id)),
          details: { external: item.is_external },
        });
      }
    if (e.action === "ModuleRenderedReady")
      for (const item of e.modules as NativeItem[]) {
        const key = id(item.id);
        modules.set(key, { ...modules.get(key), id: key, name: key, bytes: Number(item.bytes) });
      }
    if (e.action === "ChunkGraphReady")
      rows.chunks = (e.chunks as NativeItem[]).map((item) => ({
        id: String(item.chunk_id),
        name: String(item.name ?? item.chunk_id),
        modules: (item.modules as string[]).map(id),
        imports: ((item.imports as unknown[]) ?? []).map((edge) =>
          String(typeof edge === "object" && edge ? (edge as NativeItem).chunk_id : edge),
        ),
        details: {
          entry: item.is_user_defined_entry,
          async: item.is_async_entry,
          reason: item.reason,
          entryModule: id(item.entry_module),
        },
      }));
    if (e.action === "PackageGraphReady")
      rows.packages = (e.packages as NativeItem[]).map((item) => ({
        id: id(item.package_id),
        name: String(item.name),
        version: String(item.version),
        bytes: Number(item.size ?? 0),
        modules: (item.modules as string[]).map(id),
        details: { dependencyType: item.dependency_type },
      }));
    if (e.action === "AssetsReady")
      for (const item of e.assets as NativeItem[]) {
        const sourceId = await source(item.content);
        rows.assets.push({
          id: String(item.filename),
          name: String(item.filename),
          bytes: Number(item.size),
          source: sourceId,
        });
        const chunk = rows.chunks.find((row) => row.id === String(item.chunk_id));
        if (chunk) {
          chunk.bytes = Number(item.size);
          chunk.details = { ...chunk.details, filename: item.filename };
        }
      }
    const hook = e.action.match(/^Hook(.+?)(?:Call)?(Start|End)$/);
    if (hook && e.call_id) {
      const text = await source(e.content);
      if (hook[2] === "Start") calls.set(e.call_id, { event: e, source: text });
      else {
        const call = calls.get(e.call_id);
        if (call) {
          const durationMs = Math.max(0, Number(e.timestamp) - Number(call.event.timestamp));
          const plugin = scalar(e.plugin_name),
            key = `${scalar(e.plugin_id)}:${hook[1]}`;
          const timing = timings.get(key) ?? {
            id: key,
            name: plugin,
            plugin,
            hook: hook[1],
            durationMs: 0,
            calls: 0,
          };
          timing.durationMs! += durationMs;
          timing.calls!++;
          timings.set(key, timing);
          const moduleId = id(e.module_id ?? call.event.module_id ?? call.event.module_request);
          await addEvent({
            id: e.call_id,
            name: moduleId || hook[1],
            plugin,
            hook: hook[1],
            startMs: Number(call.event.timestamp) - start,
            durationMs,
            before: call.source,
            after: text,
          });
          const module = modules.get(moduleId) ?? { id: moduleId, name: moduleId };
          if (text) module.source = text;
          if (moduleId) modules.set(moduleId, module);
          calls.delete(e.call_id);
        }
      }
    } else
      await addEvent({
        id: String(sequence++),
        name: e.action,
        startMs: Number(e.timestamp ?? start) - start,
      });
  }
  if (!Number.isFinite(start) || !rows.chunks.length)
    throw new Error("Unsupported or incomplete Rolldown diagnostic capture");
  rows.modules = [...modules.values()];
  rows.plugins = [...timings.values()];
  const versions = new Map<string, Set<string>>();
  for (const row of rows.packages) {
    const entries = versions.get(row.name) ?? new Set<string>();
    entries.add(row.version ?? "");
    versions.set(row.name, entries);
  }
  for (const row of rows.packages)
    row.details = { ...row.details, duplicated: (versions.get(row.name)?.size ?? 0) > 1 };
  if (rows.events.length) await page("events", rows.events, eventPage);
  for (const dataset of datasets.filter((name) => name !== "events")) {
    const sorted = rows[dataset].sort(
      (a, b) => (b.bytes ?? b.durationMs ?? 0) - (a.bytes ?? a.durationMs ?? 0),
    );
    let buffer: DiagnosticRow[] = [],
      bytes = 2,
      number = 0;
    for (const row of sorted) {
      const size = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (size > PAGE_BYTES - 2) throw new Error(`Diagnostic record exceeds page limit: ${row.id}`);
      if (bytes + size > PAGE_BYTES && buffer.length) {
        await page(dataset, buffer, number++);
        buffer = [];
        bytes = 2;
      }
      buffer.push(row);
      bytes += size;
    }
    if (buffer.length) await page(dataset, buffer, number);
  }
  const raw = join(output, "logs.json.gz");
  await pipeline(
    createReadStream(join(directory, "logs.json")),
    createGzip(),
    createWriteStream(raw),
  );
  artifacts.push(
    await describeArtifact(raw, { id: "raw-logs", kind: "raw", contentType: "application/gzip" }),
  );
  artifacts.push(
    await describeArtifact(join(directory, "meta.json"), {
      id: "metadata",
      kind: "metadata",
      contentType: "application/json",
    }),
  );
  const summary: BuildSummary = {
    durationMs: end - start,
    outputBytes: rows.assets.reduce((sum, row) => sum + (row.bytes ?? 0), 0),
    modules: modules.size,
    chunks: rows.chunks.length,
    assets: rows.assets.length,
    packages: rows.packages.length,
  };
  return { summary, artifacts };
}
