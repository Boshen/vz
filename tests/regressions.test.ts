import { expect, test } from "vitest";
import { detectRegressions } from "../src/regressions";
import type { BuildSummary } from "@vz/protocol";
const summary = (outputBytes: number, durationMs: number): BuildSummary => ({
  outputBytes,
  durationMs,
  modules: 1,
  chunks: 1,
  assets: 1,
  packages: 1,
});
test.each([
  [100000, 1000, 105000, 1100, []],
  [100000, 1000, 111000, 1250, ["outputBytes", "durationMs"]],
  [1000000, 1000, 1020000, 900, []],
  [100, 100, 200, 190, []],
  [100000, 500, 90000, 600, ["durationMs"]],
  [0, 0, 10240, 100, ["outputBytes", "durationMs"]],
] as const)(
  "regression thresholds for %s B / %s ms → %s B / %s ms",
  (beforeSize, beforeTime, afterSize, afterTime, metrics) => {
    const result = detectRegressions(
      summary(beforeSize, beforeTime),
      summary(afterSize, afterTime),
    );
    expect(result.filter((change) => change.regression).map((change) => change.metric)).toEqual(
      metrics,
    );
    expect(
      result.every((change) => change.percent === null || Number.isFinite(change.percent)),
    ).toBe(true);
  },
);
