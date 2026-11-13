import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const PART_BYTES = 8 * 1024 * 1024;
export const PAGE_BYTES = 512 * 1024;
export const datasets = ["modules", "chunks", "assets", "packages", "plugins", "events"] as const;
export const datasetSchema = z.enum(datasets);
export type Dataset = z.infer<typeof datasetSchema>;
const key = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9._-]+$/);
export const artifactSchema = z
  .object({
    id: key,
    kind: z.enum(["dataset", "source", "raw", "metadata", "output", "sourcemap"]),
    name: z.string().min(1).max(1024).optional(),
    bytes: z
      .number()
      .int()
      .positive()
      .max(5 * 1024 ** 3),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    contentType: z.enum(["application/json", "application/gzip", "text/plain"]),
    dataset: datasetSchema.optional(),
    page: z.number().int().min(0).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.kind === "dataset" &&
      (value.page === undefined || value.dataset === undefined || value.bytes > PAGE_BYTES)
    ) {
      ctx.addIssue({ code: "custom", message: "Dataset pages must be named and bounded" });
    }
  });
export const summarySchema = z.object({
  durationMs: z.number().finite().nonnegative(),
  outputBytes: z.number().int().nonnegative(),
  modules: z.number().int().nonnegative(),
  chunks: z.number().int().nonnegative(),
  assets: z.number().int().nonnegative(),
  packages: z.number().int().nonnegative(),
});
export const buildManifestSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    captureId: z.uuid(),
    project: z.string().trim().min(1).max(160),
    environment: key,
    checkoutSha: z.string().regex(/^[a-f0-9]{40,64}$/),
    producer: z.object({
      plugin: z.string().max(100),
      vite: z.string().max(100),
      rolldown: z.string().max(100),
    }),
    summary: summarySchema,
    artifacts: z.array(artifactSchema).min(1).max(20000),
  })
  .superRefine(({ artifacts }, ctx) => {
    if (new Set(artifacts.map((a) => a.id)).size !== artifacts.length)
      ctx.addIssue({ code: "custom", message: "Duplicate artifact ids" });
    const pages = artifacts
      .filter((a) => a.kind === "dataset")
      .map((a) => `${a.dataset}:${a.page}`);
    if (new Set(pages).size !== pages.length)
      ctx.addIssue({ code: "custom", message: "Duplicate dataset pages" });
    for (const dataset of datasets) {
      const sequence = artifacts
        .filter((a) => a.dataset === dataset)
        .map((a) => a.page!)
        .sort((a, b) => a - b);
      if (sequence.some((page, index) => page !== index))
        ctx.addIssue({ code: "custom", message: "Non-contiguous dataset pages" });
    }
  });
export type BuildManifest = z.infer<typeof buildManifestSchema>;
export type BuildSummary = z.infer<typeof summarySchema>;
export type ArtifactManifest = z.infer<typeof artifactSchema>;
export interface DiagnosticRow {
  id: string;
  name: string;
  bytes?: number;
  durationMs?: number;
  imports?: string[];
  modules?: string[];
  source?: string;
  rendered?: string;
  before?: string;
  after?: string;
  plugin?: string;
  hook?: string;
  startMs?: number;
  calls?: number;
  version?: string;
  details?: Record<string, unknown>;
}
export interface Provenance {
  repositoryId: string;
  ownerId: string;
  repository: string;
  sha: string;
  ref: string;
  runId: string;
  runAttempt: string;
  workflow: string;
  actor: string;
}
export interface UploadSession {
  id: string;
  token: string;
  reportUrl: string;
}
export interface BuildRecord {
  id: string;
  projectId: string;
  project: string;
  repository: string;
  environment: string;
  createdAt: number;
  manifest: BuildManifest;
  provenance: Provenance;
}
export function compareSummaries(before: BuildSummary, after: BuildSummary) {
  return Object.fromEntries(
    Object.keys(after).map((key) => {
      const metric = key as keyof BuildSummary;
      return [
        key,
        { before: before[metric], after: after[metric], delta: after[metric] - before[metric] },
      ];
    }),
  );
}

/** Stable record keys and quantitative fields shared by capture and indexing. */
export function diagnosticIdentity(dataset: Dataset, row: DiagnosticRow) {
  if (dataset === "plugins")
    return {
      key: JSON.stringify([row.plugin ?? row.name, row.hook]),
      label: `${row.plugin ?? row.name} / ${row.hook ?? "all hooks"}`,
    };
  if (dataset === "events")
    return {
      key: JSON.stringify([row.plugin, row.hook, row.name]),
      label: row.hook ? `${row.plugin ?? ""} / ${row.hook} / ${row.name}` : row.name,
    };
  if (dataset === "packages")
    return { key: `${row.name}@${row.version ?? ""}`, label: `${row.name}@${row.version ?? ""}` };
  if (dataset === "chunks") {
    const name =
      typeof row.details?.entryModule === "string" && row.details.entryModule
        ? row.details.entryModule
        : row.name;
    return { key: name, label: name };
  }
  return { key: dataset === "assets" ? row.name : row.id, label: row.name };
}
export function diagnosticMetrics(row: DiagnosticRow): Record<string, number> {
  const length = (value: unknown) => (Array.isArray(value) ? value.length : 0);
  const metrics: Record<string, number> = {
    records: 1,
    imports: row.imports?.length ?? 0,
    moduleCount: row.modules?.length ?? 0,
    entries: row.details?.entry === true ? 1 : 0,
    sideEffects:
      row.details?.sideEffects === true || row.details?.sideEffects === "no-treeshake" ? 1 : 0,
    cssAssets: length(row.details?.importedCss),
    assetDependencies: length(row.details?.importedAssets),
  };
  for (const field of ["bytes", "durationMs", "calls", "startMs"] as const)
    if (typeof row[field] === "number" && Number.isFinite(row[field])) metrics[field] = row[field]!;
  for (const field of ["importers", "dynamicImports", "dynamicImporters", "exports"] as const)
    metrics[field] = length(row.details?.[field]);
  if (typeof row.details?.gzipBytes === "number") metrics.gzipBytes = row.details.gzipBytes;
  if (row.details?.duplicated) metrics.duplicates = 1;
  if (Array.isArray(row.details?.rendering))
    for (const rendered of row.details.rendering as {
      renderedLength?: number;
      renderedExports?: string[];
    }[]) {
      metrics.renderedBytes =
        (metrics.renderedBytes ?? 0) +
        (typeof rendered.renderedLength === "number" ? rendered.renderedLength : 0);
      metrics.renderedExports = (metrics.renderedExports ?? 0) + length(rendered.renderedExports);
    }
  return metrics;
}
