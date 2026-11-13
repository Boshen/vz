import type { BuildSummary, Provenance } from "@vz/protocol";
export const trendDatasets = [
  "build",
  "modules",
  "chunks",
  "assets",
  "packages",
  "plugins",
  "events",
  "artifacts",
  "runtime",
] as const;
export type TrendDataset = (typeof trendDatasets)[number];
export type TrendValues = Record<string, number>;
export interface TrendMetric {
  key: string;
  label: string;
  unit: "bytes" | "ms" | "count";
}
const records: TrendMetric = { key: "records", label: "Records", unit: "count" };
const size: TrendMetric = { key: "bytes", label: "Size", unit: "bytes" };
const duration: TrendMetric = { key: "durationMs", label: "Duration", unit: "ms" };
const calls: TrendMetric = { key: "calls", label: "Calls", unit: "count" };
const count = (key: string, label: string): TrendMetric => ({ key, label, unit: "count" });
const byteMetric = (key: string, label: string): TrendMetric => ({ key, label, unit: "bytes" });
const average: TrendMetric = {
  key: "averageDurationMs",
  label: "Average call duration",
  unit: "ms",
};
const compressed: TrendMetric = { key: "gzipBytes", label: "Gzip size", unit: "bytes" };
export const trendMetrics: Record<TrendDataset, TrendMetric[]> = {
  build: [
    { key: "outputBytes", label: "Output size", unit: "bytes" },
    { key: "durationMs", label: "Build duration", unit: "ms" },
    ...["modules", "chunks", "assets", "packages"].map((key) => ({
      key,
      label: key[0].toUpperCase() + key.slice(1),
      unit: "count" as const,
    })),
  ],
  modules: [
    size,
    byteMetric("sourceBytes", "Transformed source size"),
    byteMetric("renderedBytes", "Rendered size across outputs"),
    records,
    count("imports", "Static imports"),
    count("importers", "Static importers"),
    count("dynamicImports", "Dynamic imports"),
    count("dynamicImporters", "Dynamic importers"),
    count("exports", "Exports"),
    count("renderedExports", "Rendered exports"),
    count("entries", "Entry modules"),
    count("sideEffects", "Modules with side effects"),
  ],
  chunks: [
    size,
    compressed,
    records,
    count("moduleCount", "Included modules"),
    count("imports", "Static imports"),
    count("dynamicImports", "Dynamic imports"),
    count("exports", "Exports"),
    count("cssAssets", "CSS dependencies"),
    count("assetDependencies", "Asset dependencies"),
    count("entries", "Entry chunks"),
  ],
  assets: [size, compressed, records],
  packages: [
    size,
    records,
    { key: "duplicates", label: "Multiple-version packages", unit: "count" },
    count("moduleCount", "Included modules"),
  ],
  plugins: [duration, average, calls, records],
  events: [
    duration,
    average,
    calls,
    records,
    byteMetric("beforeBytes", "Input source size"),
    byteMetric("afterBytes", "Output source size"),
    { key: "startMs", label: "First activity", unit: "ms" },
  ],
  artifacts: [
    { ...size, label: "Stored size" },
    { ...records, label: "Files" },
  ],
  runtime: [
    ...["rss", "heapUsed", "heapTotal", "external", "arrayBuffers"].map((key) => ({
      key,
      label: {
        rss: "Resident memory",
        heapUsed: "Heap used",
        heapTotal: "Heap allocated",
        external: "External memory",
        arrayBuffers: "Array buffers",
      }[key]!,
      unit: "bytes" as const,
    })),
    { key: "cpuUserMs", label: "Process user CPU", unit: "ms" },
    { key: "cpuSystemMs", label: "Process system CPU", unit: "ms" },
    { key: "warnings", label: "Warnings", unit: "count" },
  ],
};
export interface TrendPoint {
  id: string;
  createdAt: number;
  provenance: Provenance;
  summary: BuildSummary;
  values: TrendValues | null;
  indexed: boolean;
}
export interface TrendResponse {
  branch: string;
  environment: string;
  environments: string[];
  dataset: TrendDataset;
  entities: { id: string; label: string }[];
  moreEntities: boolean;
  points: TrendPoint[];
  nextCursor: string | null;
  pending: number;
}
export function formatTrend(value: number, unit: TrendMetric["unit"]) {
  if (unit === "bytes")
    return Math.abs(value) >= 1048576
      ? `${(value / 1048576).toFixed(2)} MB`
      : Math.abs(value) >= 1024
        ? `${(value / 1024).toFixed(1)} kB`
        : `${value.toLocaleString()} B`;
  if (unit === "ms")
    return Math.abs(value) >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(1)} ms`;
  return value.toLocaleString();
}
