import { expect, test } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
test("CI emits escaped regression warnings and a job summary without failing the build", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vz-regression-ci-"));
  try {
    const log = join(directory, "build.log"),
      preload = join(directory, "fetch.mjs"),
      summary = join(directory, "summary.md");
    await writeFile(log, "[vz] client report: https://vz.void.app/reports/" + "a".repeat(32));
    await writeFile(
      preload,
      `globalThis.fetch = async () => Response.json(${JSON.stringify({ status: "regression", current: { sha: "b".repeat(40), environment: "client" }, changes: [{ regression: true, label: "Output size", delta: 20000, unit: "bytes", percent: 20 }] })});`,
    );
    const output = execFileSync(
      process.execPath,
      ["--import", preload, "scripts/report-regressions.mjs", log],
      {
        encoding: "utf8",
        env: { ...process.env, GITHUB_REF: "refs/heads/main", GITHUB_STEP_SUMMARY: summary },
      },
    );
    expect(output).toContain("::warning title=VZ regression::");
    expect(output).toContain("20.0%25");
    const markdown = await readFile(summary, "utf8");
    expect(markdown).toContain("| client | regression |");
    expect(markdown).toContain("Diagnostics do not fail CI for regressions");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
