import type { BuildSummary } from "@vz/protocol";
export const regressionPolicy = {
  outputBytes: { label: "Output size", unit: "bytes", relative: 0.05, absolute: 10 * 1024 },
  durationMs: { label: "Build duration", unit: "ms", relative: 0.2, absolute: 100 },
} as const;
export interface RegressionChange {
  metric: keyof typeof regressionPolicy;
  label: string;
  unit: "bytes" | "ms";
  before: number;
  after: number;
  delta: number;
  percent: number | null;
  regression: boolean;
}
export interface RegressionResult {
  status: "baseline" | "clean" | "regression" | "off-branch";
  current: { id: string; sha: string; environment: string };
  baseline: { id: string; sha: string } | null;
  changes: RegressionChange[];
  policy: typeof regressionPolicy;
}
export function detectRegressions(before: BuildSummary, after: BuildSummary): RegressionChange[] {
  return (Object.keys(regressionPolicy) as (keyof typeof regressionPolicy)[]).map((metric) => {
    const policy = regressionPolicy[metric],
      delta = after[metric] - before[metric];
    const relative = before[metric] === 0 ? null : delta / before[metric];
    return {
      metric,
      label: policy.label,
      unit: policy.unit,
      before: before[metric],
      after: after[metric],
      delta,
      percent: relative === null ? null : relative * 100,
      regression: delta >= policy.absolute && (relative === null || relative >= policy.relative),
    };
  });
}
