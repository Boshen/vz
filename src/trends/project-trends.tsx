import { useEffect, useId, useRef, useState } from "react";
import { ArrowDownRight, ArrowUpRight, GitBranch, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RegressionSummary } from "../regression-summary";
import { detectRegressions } from "../regressions";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  formatTrend,
  trendDatasets,
  trendMetrics,
  type TrendDataset,
  type TrendMetric,
  type TrendPoint,
  type TrendResponse,
} from "./model";
const names: Record<TrendDataset, string> = {
  build: "Build",
  modules: "Modules",
  chunks: "Chunks",
  assets: "Assets",
  packages: "Packages",
  plugins: "Plugins",
  events: "Events",
  artifacts: "Stored files",
  runtime: "Runtime",
};
const reportLink = (point: TrendPoint, dataset: TrendDataset) =>
  `/reports/${point.id}${["build", "runtime", "artifacts"].includes(dataset) ? "" : `?dataset=${dataset}`}`;

function SeriesChart({
  points,
  metric,
  dataset,
  compact = false,
}: {
  points: TrendPoint[];
  metric: TrendMetric;
  dataset: TrendDataset;
  compact?: boolean;
}) {
  const titleId = useId();
  const container = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(600);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setChartWidth(Math.max(280, Math.round(entry.contentRect.width))),
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const [focused, setFocused] = useState<number | null>(null);
  const available = points
    .map((point, index) => ({ point, index, value: point.values?.[metric.key] }))
    .filter((entry) => typeof entry.value === "number" && Number.isFinite(entry.value));
  const current = available.at(-1),
    previous = available.at(-2);
  const delta = current && previous ? current.value! - previous.value! : null;
  const regressions = new Set<string>();
  if (dataset === "build")
    for (let index = 1; index < points.length; index++) {
      const point = points[index];
      const before = points
        .slice(0, index)
        .reverse()
        .find((candidate) => candidate.provenance.sha !== point.provenance.sha);
      if (
        point.provenance.ref === "refs/heads/main" &&
        before &&
        detectRegressions(before.summary, point.summary).some(
          (change) => change.metric === metric.key && change.regression,
        )
      )
        regressions.add(point.id);
    }
  const active =
    focused === null ? current : (available.find((entry) => entry.index === focused) ?? current);
  const width = chartWidth,
    height = compact ? 180 : 270,
    left = 66,
    right = width - 16,
    top = 20,
    bottom = height - 32;
  const firstTime = points[0]?.createdAt ?? 0,
    lastTime = points.at(-1)?.createdAt ?? 0;
  const values = available.map((entry) => entry.value!);
  const low = Math.min(0, ...values),
    high = Math.max(1, ...values);
  const x = (point: TrendPoint) =>
    firstTime === lastTime
      ? (left + right) / 2
      : left + ((point.createdAt - firstTime) / (lastTime - firstTime)) * (right - left);
  const y = (value: number) => bottom - ((value - low) / (high - low)) * (bottom - top);
  let path = "",
    connected = false;
  for (const point of points) {
    const value = point.values?.[metric.key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      connected = false;
      continue;
    }
    path += `${connected ? "L" : "M"}${x(point)},${y(value)} `;
    connected = true;
  }
  const timeLabel = (time: number) =>
    new Date(time).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      ...(lastTime - firstTime < 172800000 ? { hour: "2-digit", minute: "2-digit" } : {}),
    });
  return (
    <Card ref={container} className={`gap-0 overflow-hidden py-0 ${compact ? "" : "mt-4"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
        <div>
          <h3 id={titleId} className="mb-1 text-sm font-medium">
            {metric.label}
          </h3>
          <div className="text-2xl font-semibold tracking-tight">
            {current ? formatTrend(current.value!, metric.unit) : "—"}
          </div>
        </div>
        {delta !== null && (
          <Badge variant="secondary" className="gap-1 font-normal">
            {delta > 0 ? <ArrowUpRight /> : delta < 0 ? <ArrowDownRight /> : null}
            {delta > 0 ? "+" : ""}
            {formatTrend(delta, metric.unit)}
          </Badge>
        )}
      </div>
      {available.length ? (
        <>
          <svg
            className="mt-2 block w-full"
            viewBox={`0 0 ${width} ${height}`}
            role="group"
            aria-labelledby={titleId}
          >
            <title>
              {metric.label} across {points.length} uploaded builds
            </title>
            {[0, 1, 2].map((tick) => {
              const value = low + ((high - low) * tick) / 2,
                at = y(value);
              return (
                <g key={tick}>
                  <line
                    x1={left}
                    x2={right}
                    y1={at}
                    y2={at}
                    stroke="var(--border)"
                    strokeDasharray="3 5"
                  />
                  <text
                    x={left - 10}
                    y={at + 4}
                    textAnchor="end"
                    fontSize="10"
                    fill="var(--muted-foreground)"
                  >
                    {formatTrend(value, metric.unit)}
                  </text>
                </g>
              );
            })}
            <path d={path} fill="none" stroke="#2563eb" strokeWidth="2" strokeLinejoin="round" />
            {available.map(({ point, index, value }) => (
              <a
                key={point.id}
                href={reportLink(point, dataset)}
                aria-label={`${point.provenance.sha.slice(0, 7)}: ${formatTrend(value!, metric.unit)}, ${new Date(point.createdAt).toLocaleString()}`}
                onFocus={() => setFocused(index)}
                onBlur={() => setFocused(null)}
                onMouseEnter={() => setFocused(index)}
                onMouseLeave={() => setFocused(null)}
              >
                <title>
                  {regressions.has(point.id) ? "Regression · " : ""}
                  {point.provenance.sha.slice(0, 7)} · {formatTrend(value!, metric.unit)} ·{" "}
                  {new Date(point.createdAt).toLocaleString()}
                </title>
                <circle cx={x(point)} cy={y(value!)} r="8" fill="transparent" />
                <circle
                  cx={x(point)}
                  cy={y(value!)}
                  r={active?.index === index ? 4 : 2.5}
                  fill={
                    regressions.has(point.id)
                      ? "#d97706"
                      : active?.index === index
                        ? "#2563eb"
                        : "var(--background)"
                  }
                  stroke={regressions.has(point.id) ? "#d97706" : "#2563eb"}
                  strokeWidth="1.5"
                />
              </a>
            ))}
            <text x={left} y={height - 9} fontSize="10" fill="var(--muted-foreground)">
              {timeLabel(firstTime)}
            </text>
            {firstTime !== lastTime && (
              <text
                x={right}
                y={height - 9}
                textAnchor="end"
                fontSize="10"
                fill="var(--muted-foreground)"
              >
                {timeLabel(lastTime)}
              </text>
            )}
          </svg>
          <div
            aria-live="polite"
            className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-t px-5 py-2 text-xs text-muted-foreground"
          >
            {active && (
              <>
                <a
                  href={reportLink(active.point, dataset)}
                  className="font-mono underline underline-offset-4"
                >
                  {active.point.provenance.sha.slice(0, 7)}
                </a>
                <span>
                  {timeLabel(active.point.createdAt)} · {formatTrend(active.value!, metric.unit)}
                </span>
              </>
            )}
          </div>
        </>
      ) : (
        <div className="flex h-40 items-center justify-center px-5 text-center text-sm text-muted-foreground">
          {points.length
            ? "No measurements available for this series yet."
            : "Upload a build on this branch to start its timeline."}
        </div>
      )}
    </Card>
  );
}

export function ProjectTrends({ projectId }: { projectId: string }) {
  const [dataset, setDataset] = useState<TrendDataset>("build"),
    [entity, setEntity] = useState("");
  const [metric, setMetric] = useState(trendMetrics.build[0].key);
  const [environment, setEnvironment] = useState("client");
  const [branch, setBranch] = useState("main"),
    [branchDraft, setBranchDraft] = useState("main");
  const [search, setSearch] = useState(""),
    [debouncedSearch, setDebouncedSearch] = useState("");
  const [response, setResponse] = useState<TrendResponse | null>(null);
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0),
    [requestWindows, setRequestWindows] = useState<{ key: string; cursors: string[] }>({
      key: "",
      cursors: [],
    });
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const query = new URLSearchParams({
    branch,
    environment,
    dataset,
    limit: "100",
    ...(entity ? { entity } : {}),
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
  }).toString();
  const requestKey = `${projectId}?${query}`;
  const cursorKey = requestWindows.key === requestKey ? requestWindows.cursors.join(",") : "";
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const windows = await Promise.all(
          ["", ...cursorKey.split(",").filter(Boolean)].map(async (cursor) => {
            const result = await fetch(
              `/api/v1/projects/${projectId}/trends?${query}${cursor ? `&cursor=${cursor}` : ""}`,
              { signal: controller.signal },
            );
            const data = (await result.json()) as TrendResponse & { error?: string };
            if (!result.ok) {
              if ([401, 403, 404].includes(result.status) && !controller.signal.aborted)
                setResponse(null);
              throw new Error(data.error ?? "Unable to load trends");
            }
            return data;
          }),
        );
        const points = [
          ...new Map(
            windows.flatMap((window) => window.points).map((point) => [point.id, point]),
          ).values(),
        ].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
        const entities = [
          ...new Map(
            windows.flatMap((window) => window.entities).map((entity) => [entity.id, entity]),
          ).values(),
        ].sort((a, b) => a.label.localeCompare(b.label));
        const data: TrendResponse = {
          ...windows[0],
          points,
          entities,
          moreEntities: windows.some((window) => window.moreEntities),
          nextCursor: windows.at(-1)!.nextCursor,
          pending: points.filter((point) => !point.indexed).length,
        };
        if (controller.signal.aborted) return;
        setResponse(data);
        setError("");
        if (data.environments.length && !data.environments.includes(environment))
          setEnvironment(data.environments[0]);
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : "Unable to load trends");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    setLoading(true);
    setResponse(null);
    void load();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15000);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [projectId, query, refresh, environment, cursorKey]);
  const points = response?.points ?? [];
  const selectedMetric =
    trendMetrics[dataset].find((item) => item.key === metric) ?? trendMetrics[dataset][0];
  return (
    <section aria-label="Build trends" className="mb-8">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-base font-semibold">Trends</h2>
          <p className="mb-0 text-xs text-muted-foreground">
            Each completed upload adds a point. Select a point to inspect its report.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (branchDraft.trim()) setBranch(branchDraft.trim());
            }}
          >
            <GitBranch size={14} className="text-muted-foreground" />
            <Input
              className="h-8 w-28 text-xs"
              aria-label="Trend branch"
              value={branchDraft}
              onChange={(event) => setBranchDraft(event.target.value)}
            />
            <Button type="submit" size="sm" variant="outline">
              Apply
            </Button>
          </form>
          <select
            className="h-8 max-w-40 py-1 text-xs"
            aria-label="Trend environment"
            value={environment}
            onChange={(event) => {
              setEnvironment(event.target.value);
              setEntity("");
            }}
          >
            {[...new Set([environment, ...(response?.environments ?? [])])].map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="Refresh trends"
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw size={14} />
          </Button>
        </div>
      </div>
      <div
        className="mb-4 flex max-w-full gap-1 overflow-x-auto border-b pb-2"
        role="group"
        aria-label="Trend datasets"
      >
        {trendDatasets.map((name) => (
          <Button
            key={name}
            size="sm"
            variant={dataset === name ? "secondary" : "ghost"}
            aria-pressed={dataset === name}
            onClick={() => {
              setDataset(name);
              setEntity("");
              setSearch("");
              setMetric(trendMetrics[name][0].key);
            }}
          >
            {names[name]}
          </Button>
        ))}
      </div>
      {error && (
        <div role="alert" className="notice error">
          {error}
        </div>
      )}
      {loading ? (
        <div role="status" aria-label="Loading trends" className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-60 rounded-xl" />
          <Skeleton className="h-60 rounded-xl" />
        </div>
      ) : (
        <>
          {response?.pending ? (
            <p role="status" className="text-xs text-muted-foreground">
              Indexing {response.pending} historical builds in the background. Charts update
              automatically.
            </p>
          ) : null}
          {dataset === "build" && points.at(-1) && (
            <RegressionSummary
              buildId={points.at(-1)!.id}
              revision={points.map((point) => point.id).join(",")}
            />
          )}
          {dataset === "build" ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {trendMetrics.build.map((item) => (
                <SeriesChart
                  key={item.key}
                  points={points}
                  metric={item}
                  dataset={dataset}
                  compact
                />
              ))}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Trend metric"
                  className="h-9 max-w-full py-1 text-xs"
                  value={metric}
                  onChange={(event) => setMetric(event.target.value)}
                >
                  {trendMetrics[dataset].map((item) => (
                    <option value={item.key} key={item.key}>
                      {item.label}
                    </option>
                  ))}
                </select>
                {dataset !== "runtime" && (
                  <>
                    <Input
                      aria-label="Search trend records"
                      placeholder="Find a module, file, or plugin…"
                      className="h-9 max-w-full sm:w-64"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                    <select
                      aria-label="Trend record"
                      className="h-9 max-w-full truncate py-1 text-xs sm:max-w-96"
                      value={entity}
                      onChange={(event) => setEntity(event.target.value)}
                    >
                      <option value="">All records</option>
                      {entity && !response?.entities.some((item) => item.id === entity) && (
                        <option value={entity}>Selected record</option>
                      )}
                      {response?.entities.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </div>
              {response?.moreEntities && (
                <p className="mt-2 mb-0 text-xs">
                  More records are available in this history. Refine the search to find a record.
                </p>
              )}
              {dataset === "assets" && (
                <p className="mt-2 mb-0 text-xs">
                  Content-hashed file names are separate records; use All records for total output
                  trends.
                </p>
              )}
              {dataset === "runtime" && (
                <p className="mt-2 mb-0 text-xs">
                  Process snapshots are available for plugin 0.2+ uploads. CPU includes profiling
                  and process startup.
                </p>
              )}
              <SeriesChart points={points} metric={selectedMetric} dataset={dataset} />
            </>
          )}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>
              {points.length} builds · {branch} · {environment} · refreshes every 15 seconds
            </span>
            {response?.nextCursor && (
              <Button
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={() => {
                  if (response?.nextCursor)
                    setRequestWindows({
                      key: requestKey,
                      cursors: [...cursorKey.split(",").filter(Boolean), response.nextCursor],
                    });
                }}
              >
                Load older builds
              </Button>
            )}
          </div>
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              View chart data and reports
            </summary>
            <div className="table-scroll mt-3 max-h-80 overflow-auto rounded-lg border">
              <table>
                <thead>
                  <tr>
                    <th>Commit</th>
                    <th>Uploaded</th>
                    <th>{selectedMetric.label}</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {[...points].reverse().map((point) => (
                    <tr key={point.id}>
                      <td>
                        <a
                          className={buttonVariants({ variant: "link", size: "xs" })}
                          href={reportLink(point, dataset)}
                        >
                          {point.provenance.sha.slice(0, 7)}
                        </a>
                      </td>
                      <td>{new Date(point.createdAt).toLocaleString()}</td>
                      <td>
                        {point.values?.[selectedMetric.key] === undefined
                          ? "—"
                          : formatTrend(point.values[selectedMetric.key], selectedMetric.unit)}
                      </td>
                      <td>{point.indexed ? "Indexed" : "Indexing"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
