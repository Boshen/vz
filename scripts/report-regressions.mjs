import { readFile, appendFile } from "node:fs/promises";
import assert from "node:assert/strict";
assert.equal(process.env.GITHUB_REF, "refs/heads/main");
const output = await readFile(process.argv[2], "utf8");
/* eslint-disable no-control-regex */
const urls = [
  ...new Set([...output.matchAll(/report:\s+(https:\/\/[^\s\x1b]+)/g)].map((match) => match[1])),
];
assert.ok(urls.length, "The main build must publish at least one VZ report");
let summary = "## VZ build diagnostics\n\n| Environment | Result | Report |\n| --- | --- | --- |\n";
let details = "";
for (const link of urls) {
  const url = new URL(link);
  assert.equal(url.origin, "https://vz.void.app");
  const id = url.pathname.split("/").at(-1);
  const response = await fetch(new URL(`/api/v1/builds/${id}/regressions`, url), {
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok, `Regression check HTTP ${response.status}`);
  const result = await response.json();
  summary += `| ${result.current.environment} | ${result.status} | [${result.current.sha.slice(0, 7)}](${link}) |\n`;
  for (const change of result.changes.filter((change) => change.regression)) {
    const message = `${result.current.environment}: ${change.label} increased by ${change.delta.toFixed(1)} ${change.unit}${change.percent === null ? " from zero" : ` (${change.percent.toFixed(1)}%)`}. ${link}`;
    console.log(
      `::warning title=VZ regression::${message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`,
    );
    details += `- ${message}\n`;
  }
}
summary += `\n${details}\n`;
summary +=
  "\nWarnings require output growth of at least 5% and 10 kB, or duration growth of at least 20% and 100 ms. Diagnostics do not fail CI for regressions.\n";
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
