import { expect, test } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ProjectTrends } from "../src/trends/project-trends";
import type { TrendResponse, TrendPoint } from "../src/trends/model";

test("initial charts survive server title extraction and keep accessible report links", () => {
  const summary = {
    outputBytes: 1000,
    durationMs: 100,
    modules: 1,
    chunks: 1,
    assets: 1,
    packages: 1,
  };
  const point: TrendPoint = {
    id: "a".repeat(32),
    createdAt: 1794570000000,
    provenance: {
      sha: "b".repeat(40),
      ref: "refs/heads/main",
      repositoryId: "1",
      ownerId: "2",
      repository: "acme/app",
      runId: "1",
      runAttempt: "1",
      workflow: "build.yml",
      actor: "alice",
    },
    summary,
    values: summary,
    indexed: true,
  };
  const initial: TrendResponse = {
    branch: "refs/heads/main",
    environment: "client",
    environments: ["client"],
    dataset: "build",
    points: [point],
    entities: [],
    moreEntities: false,
    nextCursor: null,
    pending: 0,
  };
  const html = renderToString(createElement(ProjectTrends, { projectId: "project", initial }));
  expect(html.match(/<svg[^>]*role="group"/g)).toHaveLength(6);
  expect(html).toContain(`href="/reports/${point.id}"`);
  expect(html).toContain('aria-label="bbbbbbb:');
  expect(html).toContain("UTC");
  expect(html.replace(/<title>[\s\S]*?<\/title>/g, "")).toBe(html);
});
