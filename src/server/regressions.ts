import { db, and, eq, desc, lt, or, sql } from "void/db";
import { builds } from "../../db/schema";
import { detectRegressions, regressionPolicy, type RegressionResult } from "../regressions";
import type { BuildRecord } from "@vz/protocol";

export async function buildRegressions(
  build: Pick<
    BuildRecord,
    "id" | "projectId" | "environment" | "provenance" | "manifest" | "createdAt"
  >,
): Promise<RegressionResult> {
  const current = { id: build.id, sha: build.provenance.sha, environment: build.environment };
  if (build.provenance.ref !== "refs/heads/main")
    return { status: "off-branch", current, baseline: null, changes: [], policy: regressionPolicy };
  const [before] = await db
    .select({ id: builds.id, provenance: builds.provenance, manifest: builds.manifest })
    .from(builds)
    .where(
      and(
        eq(builds.projectId, build.projectId),
        eq(builds.state, "ready"),
        sql`json_extract(${builds.provenance}, '$.ref') = 'refs/heads/main'`,
        sql`json_extract(${builds.provenance}, '$.sha') != ${build.provenance.sha}`,
        sql`json_extract(${builds.manifest}, '$.environment') = ${build.environment}`,
        or(
          lt(builds.createdAt, build.createdAt),
          and(eq(builds.createdAt, build.createdAt), lt(builds.id, build.id)),
        ),
      ),
    )
    .orderBy(desc(builds.createdAt), desc(builds.id))
    .limit(1);
  if (!before)
    return { status: "baseline", current, baseline: null, changes: [], policy: regressionPolicy };
  const changes = detectRegressions(before.manifest.summary, build.manifest.summary);
  return {
    status: changes.some((change) => change.regression) ? "regression" : "clean",
    current,
    baseline: { id: before.id, sha: before.provenance.sha },
    changes,
    policy: regressionPolicy,
  };
}
