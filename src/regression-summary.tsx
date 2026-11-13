import { useEffect, useState } from "react";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatTrend } from "./trends/model";
import type { RegressionResult } from "./regressions";
export function RegressionSummary({
  buildId,
  revision = "",
}: {
  buildId: string;
  revision?: string;
}) {
  const [result, setResult] = useState<RegressionResult | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    setError("");
    void fetch(`/api/v1/builds/${buildId}/regressions`, { signal: controller.signal })
      .then(async (response) => {
        const data = (await response.json()) as RegressionResult & { error?: string };
        if (!response.ok) throw new Error(data.error ?? "Regression check unavailable");
        if (!controller.signal.aborted) setResult(data);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : "Regression check unavailable");
      });
    return () => controller.abort();
  }, [buildId, revision]);
  if (error)
    return (
      <p role="alert" className="mb-4 text-xs text-muted-foreground">
        Regression check unavailable: {error}
      </p>
    );
  if (!result || result.status === "off-branch") return null;
  const flagged = result.status === "regression";
  return (
    <Card className={`mb-4 gap-3 px-5 py-4 ${flagged ? "border-amber-300 bg-amber-50/50" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          {flagged ? (
            <TriangleAlert size={16} className="text-amber-700" />
          ) : (
            <CircleCheck size={16} className="text-muted-foreground" />
          )}
          {flagged
            ? "Regression detected"
            : result.status === "baseline"
              ? "Main baseline established"
              : "Within regression thresholds"}
        </div>
        <Badge variant="secondary" className="font-normal">
          {result.current.environment} · warning only
        </Badge>
      </div>
      {result.baseline ? (
        <>
          <p className="mb-0 text-xs text-muted-foreground">
            Compared with the previous main commit{" "}
            <a className="font-mono underline" href={`/reports/${result.baseline.id}`}>
              {result.baseline.sha.slice(0, 7)}
            </a>
            . Reruns of the same commit are skipped.
          </p>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {result.changes.map((change) => (
              <span
                key={change.metric}
                className={`text-xs ${change.regression ? "font-medium text-amber-800" : "text-muted-foreground"}`}
              >
                {change.label}: {change.delta > 0 ? "+" : ""}
                {formatTrend(change.delta, change.unit)}
                {change.percent !== null
                  ? ` (${change.percent > 0 ? "+" : ""}${change.percent.toFixed(1)}%)`
                  : " (from zero)"}
                {change.regression ? " · flagged" : ""}
              </span>
            ))}
          </div>
        </>
      ) : (
        <p className="mb-0 text-xs text-muted-foreground">
          No earlier completed main commit exists for this environment. Future commits will use this
          history as their baseline.
        </p>
      )}
      <p className="mb-0 text-xs text-muted-foreground">
        Flags require both a relative increase and an absolute increase: output ≥5% and ≥10 kB;
        duration ≥20% and ≥100 ms.
      </p>
    </Card>
  );
}
