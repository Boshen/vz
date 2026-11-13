import { useEffect, useState, type ReactNode } from "react";
import { auth } from "void/client";
import {
  datasets,
  type BuildRecord,
  type BuildSummary,
  type Dataset,
  type DiagnosticRow,
  type Provenance,
} from "@vz/protocol";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  ArrowUpRight,
  ArrowRight,
  Boxes,
  FolderGit2,
  LockKeyhole,
  LayoutGrid,
  GitBranch,
} from "lucide-react";
import "../pages/style.css";

interface Project {
  id: string;
  key: string;
  repository: string;
  private: boolean;
}
interface BuildListItem {
  id: string;
  createdAt: number;
  environment: string;
  summary: BuildSummary;
  provenance: Provenance;
}
interface History {
  project: Project;
  builds: BuildListItem[];
  nextPage: number | null;
}
interface Session {
  authConfigured?: boolean;
  user: { name: string; image?: string | null } | null;
  appSlug: string | null;
}
type Comparison = {
  before: string | null;
  metrics: Record<string, { before: number; after: number; delta: number }> | null;
};
const labels: Record<string, string> = {
  modules: "Modules",
  chunks: "Chunks",
  assets: "Assets",
  packages: "Packages",
  plugins: "Plugins",
  events: "Timeline",
  overview: "Overview",
  compare: "Compare",
};
async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { signal });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}
const bytes = (n: number) =>
  `${n < 0 ? "−" : ""}${Math.abs(n) >= 1024 ** 2 ? `${(Math.abs(n) / 1024 ** 2).toFixed(2)} MB` : Math.abs(n) >= 1024 ? `${(Math.abs(n) / 1024).toFixed(1)} kB` : `${Math.abs(n)} B`}`;
const time = (n: number) =>
  Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${n.toFixed(1)} ms`;
const date = (n: number) => new Date(n).toLocaleString();
function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <div role={error ? "alert" : "status"} className={`notice ${error ? "error" : ""}`}>
      {children}
    </div>
  );
}
function Metric({ name, value, hint }: { name: string; value: string | number; hint?: string }) {
  return (
    <Card className="metric gap-2">
      <span>{name}</span>
      <strong>{value}</strong>
      {hint && <small className="text-muted-foreground">{hint}</small>}
    </Card>
  );
}

export function Dashboard({ projectId, reportId }: { projectId?: string; reportId?: string }) {
  const [session, setSession] = useState<Session>({ user: null, appSlug: null });
  const [projects, setProjects] = useState<Project[]>([]);
  const [nextProjectPage, setNextProjectPage] = useState<number | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [report, setReport] = useState<BuildRecord | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [projectFilter, setProjectFilter] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const handleError = (failure: unknown) => {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : "Unable to load dashboard");
    };
    // Sidebar and identity should not block the selected report.
    void api<Session>("/session", controller.signal).then(setSession).catch(handleError);
    void api<{ projects: Project[]; nextPage: number | null }>("/projects", controller.signal)
      .then((listing) => {
        setProjects(listing.projects);
        setNextProjectPage(listing.nextPage);
        if (!projectId && !reportId) setLoading(false);
      })
      .catch((failure: unknown) => {
        handleError(failure);
        if (!projectId && !reportId && !controller.signal.aborted) setLoading(false);
      });
    if (reportId) {
      void api<BuildRecord>(`/builds/${reportId}`, controller.signal)
        .then((build) => {
          setReport(build);
          setLoading(false);
          return api<History>(`/projects/${build.projectId}/builds`, controller.signal).then(
            setHistory,
          );
        })
        .catch(handleError)
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    } else if (projectId) {
      void api<History>(`/projects/${projectId}/builds`, controller.signal)
        .then(setHistory)
        .catch(handleError)
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }
    return () => controller.abort();
  }, [projectId, reportId]);
  async function loadProjects() {
    try {
      const result = await api<{ projects: Project[]; nextPage: number | null }>(
        `/projects?page=${nextProjectPage}`,
      );
      setProjects((old) => [...old, ...result.projects]);
      setNextProjectPage(result.nextPage);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to load projects");
    }
  }
  async function signIn() {
    const result = await auth.signIn.social({
      provider: "github",
      callbackURL: window.location.href,
    });
    if (result.error) setError(result.error.message ?? "GitHub sign-in failed");
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a href="/" className="brand">
          <span className="brand-mark">
            vz<span>↗</span>
          </span>
          <span>Build diagnostics</span>
        </a>
        <div className="workspace-label">
          Workspace <GitBranch size={13} />
        </div>
        <Input
          className="project-search"
          aria-label="Filter projects"
          placeholder="Find a project…"
          value={projectFilter}
          onChange={(event) => setProjectFilter(event.target.value)}
        />
        <nav className="project-nav" aria-label="Projects">
          <a href="/" className={!projectId && !reportId ? "active" : ""}>
            <LayoutGrid size={16} />
            All projects
          </a>
          {projects
            .filter((item) =>
              `${item.key} ${item.repository}`.toLowerCase().includes(projectFilter.toLowerCase()),
            )
            .map((item) => (
              <a
                key={item.id}
                href={`/projects/${item.id}`}
                className={item.id === (projectId ?? report?.projectId) ? "active" : ""}
              >
                {item.private ? <LockKeyhole size={16} /> : <FolderGit2 size={16} />}
                <div>
                  {item.key}
                  <small>{item.repository}</small>
                </div>
              </a>
            ))}
        </nav>
        {nextProjectPage !== null && (
          <Button variant="outline" className="text-button" onClick={loadProjects}>
            Load more projects
          </Button>
        )}
        <div className="sidebar-bottom">
          <span className="status-dot" />
          Full diagnostics · GitHub Actions<a href="/setup">Setup guide ↗</a>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div>
            <a href="/">Projects</a>
            {history && (
              <>
                <span>/</span>
                <a href={`/projects/${history.project.id}`}>{history.project.key}</a>
              </>
            )}
            {report && (
              <>
                <span>/</span>
                <span>{report.provenance.sha.slice(0, 7)}</span>
              </>
            )}
          </div>
          <div className="identity">
            {session.user ? (
              <>
                <span>{session.user.name}</span>
                <Button
                  variant="outline"
                  className="text-button"
                  onClick={async () => {
                    await auth.signOut();
                    window.location.href = "/";
                  }}
                >
                  Sign out
                </Button>
              </>
            ) : session.authConfigured ? (
              <Button variant="outline" className={buttonVariants({ size: "sm" })} onClick={signIn}>
                Sign in with GitHub
              </Button>
            ) : (
              <a className={buttonVariants({ variant: "outline", size: "sm" })} href="/setup">
                Setup guide ↗
              </a>
            )}
          </div>
        </header>
        <main>
          {error && <Notice error>{error}</Notice>}
          {loading ? (
            <div role="status" aria-label="Loading workspace" className="space-y-6">
              <Skeleton className="h-9 w-52" />
              <Skeleton className="h-4 w-80 max-w-full" />
              <div className="grid gap-4 sm:grid-cols-2">
                <Skeleton className="h-48 rounded-xl" />
                <Skeleton className="h-48 rounded-xl" />
              </div>
            </div>
          ) : report ? (
            <Report report={report} builds={history?.builds ?? []} onError={setError} />
          ) : history ? (
            <>
              <div className="eyebrow">
                {history.project.repository}{" "}
                <Badge variant="secondary">{history.project.private ? "Private" : "Public"}</Badge>
              </div>
              <div className="page-heading">
                <div>
                  <h1>{history.project.key}</h1>
                  <p>Every build. Every module. The full picture.</p>
                </div>
                <a className={buttonVariants({ variant: "outline" })} href="/setup">
                  Configure uploads ↗
                </a>
              </div>
              <BuildHistory builds={history.builds} />
              {history.nextPage !== null && (
                <Button
                  variant="outline"
                  className={buttonVariants({ variant: "outline" })}
                  onClick={async () => {
                    try {
                      const next = await api<History>(
                        `/projects/${history.project.id}/builds?page=${history.nextPage}`,
                      );
                      setHistory({ ...next, builds: [...history.builds, ...next.builds] });
                    } catch (failure) {
                      setError(
                        failure instanceof Error ? failure.message : "Unable to load builds",
                      );
                    }
                  }}
                >
                  Load older builds
                </Button>
              )}
            </>
          ) : (
            <>
              <div className="eyebrow">
                <span className="status-dot" /> Workspace overview
              </div>
              <div className="page-heading">
                <div>
                  <h1>Projects</h1>
                  <p>Explore your builds. Understand every byte.</p>
                </div>
                <a
                  className={buttonVariants()}
                  href={
                    session.appSlug
                      ? `https://github.com/apps/${encodeURIComponent(session.appSlug)}/installations/new`
                      : "/setup"
                  }
                >
                  <GitBranch size={15} /> Connect repository <ArrowUpRight size={14} />
                </a>
              </div>
              <div className="section-title">
                <h2>Connected projects</h2>
                <span>{projects.length} visible</span>
              </div>
              {projects.length ? (
                <div className="project-grid">
                  {projects.map((item) => (
                    <Card className="project-card gap-0 py-0" key={item.id}>
                      <a href={`/projects/${item.id}`} className="project-card-link">
                        <span className="project-icon">
                          <Boxes size={19} />
                        </span>
                        <Badge variant="secondary">{item.private ? "Private" : "Public"}</Badge>
                        <h2>{item.key}</h2>
                        <p>{item.repository}</p>
                        <div className="project-card-bottom">
                          Explore builds <ArrowRight size={15} />
                        </div>
                      </a>
                    </Card>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <div className="empty-icon">⌘</div>
                  <h2>Your next build starts here.</h2>
                  <p>
                    Install the GitHub App, add the Vite plugin, and run your workflow.
                    <br />
                    Your first successful upload creates a project automatically.
                  </p>
                  <a className={buttonVariants()} href="/setup">
                    Set up your first project →
                  </a>
                  <code>vite-plugin-vz</code>
                </div>
              )}
              <div className="feature-grid">
                <div>
                  <span>01 / INSPECT</span>
                  <h3>Follow every byte</h3>
                  <p>
                    Explore modules, chunks, packages, and the source that makes it into your
                    bundle.
                  </p>
                </div>
                <div>
                  <span>02 / UNDERSTAND</span>
                  <h3>Find the expensive work</h3>
                  <p>Break down plugin hooks and transformations in a build timeline.</p>
                </div>
                <div>
                  <span>03 / COMPARE</span>
                  <h3>Know what changed</h3>
                  <p>Compare builds to see where size and timing regressions begin.</p>
                </div>
              </div>
            </>
          )}
        </main>
        <footer>
          VZ <span>Built with Vite+ · Powered by Rolldown</span>
        </footer>
      </div>
    </div>
  );
}
function BuildHistory({ builds }: { builds: BuildListItem[] }) {
  return (
    <div className="panel">
      <div className="panel-heading">
        <h2>Build history</h2>
        <span className="muted">Completed uploads</span>
      </div>
      {builds.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Commit</th>
                <th>Branch / environment</th>
                <th>Output</th>
                <th>Build time</th>
                <th>Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {builds.map((build) => (
                <tr key={build.id}>
                  <td>
                    <a className="commit" href={`/reports/${build.id}`}>
                      {build.provenance.sha.slice(0, 7)} ↗
                    </a>
                    <small>{build.provenance.actor}</small>
                  </td>
                  <td>
                    {build.provenance.ref.replace("refs/heads/", "")}
                    <small>{build.environment}</small>
                  </td>
                  <td>{bytes(build.summary.outputBytes)}</td>
                  <td>{time(build.summary.durationMs)}</td>
                  <td className="muted">{date(build.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Notice>
          No completed builds yet. Run an enabled GitHub Actions build to upload a report.
        </Notice>
      )}
    </div>
  );
}

function Report({
  report,
  builds,
  onError,
}: {
  report: BuildRecord;
  builds: BuildListItem[];
  onError: (message: string) => void;
}) {
  const [tab, setTab] = useState<string>("overview");
  const [selected, setSelected] = useState<DiagnosticRow | null>(null);
  const [rows, setRows] = useState<DiagnosticRow[]>([]);
  const [page, setPage] = useState(0),
    [pages, setPages] = useState(0);
  const [rowPage, setRowPage] = useState(0);
  const [loading, setLoading] = useState(false),
    [query, setQuery] = useState("");
  const [comparison, setComparison] = useState<Comparison | null>(null),
    [baseline, setBaseline] = useState("");
  const [compareDataset, setCompareDataset] = useState<Dataset>("modules");
  const [differences, setDifferences] = useState<DiagnosticRow[]>([]);
  const dataset = tab === "overview" ? "assets" : tab;
  useEffect(() => {
    if (!(datasets as readonly string[]).includes(dataset)) return;
    const controller = new AbortController();
    setLoading(true);
    setRows([]);
    setSelected(null);
    setRowPage(0);
    void api<{ rows: DiagnosticRow[]; pages: number }>(
      `/builds/${report.id}/datasets/${dataset}?page=${page}`,
      controller.signal,
    )
      .then((data) => {
        setRows(data.rows);
        setPages(data.pages);
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) onError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [dataset, page, report.id, onError]);
  useEffect(() => {
    const controller = new AbortController();
    void api<Comparison>(
      `/builds/${report.id}/compare${baseline ? `?before=${baseline}` : ""}`,
      controller.signal,
    )
      .then(setComparison)
      .catch((error: Error) => {
        if (!controller.signal.aborted) onError(error.message);
      });
    return () => controller.abort();
  }, [baseline, report.id, onError]);
  useEffect(() => {
    if (tab !== "compare" || !comparison?.before) return;
    const controller = new AbortController();
    setLoading(true);
    setDifferences([]);
    async function all(id: string) {
      const output = new Map<string, DiagnosticRow>();
      for (let current = 0, total = 1; current < total; current++) {
        const data = await api<{ rows: DiagnosticRow[]; pages: number }>(
          `/builds/${id}/datasets/${compareDataset}?page=${current}`,
          controller.signal,
        );
        total = data.pages;
        for (const row of data.rows)
          output.set(row.id, {
            id: row.id,
            name: row.name,
            bytes: row.bytes,
            durationMs: row.durationMs,
          });
      }
      return output;
    }
    void Promise.all([all(comparison.before), all(report.id)])
      .then(([before, after]) => {
        const ids = new Set([...before.keys(), ...after.keys()]);
        setDifferences(
          [...ids]
            .map((id) => {
              const a = before.get(id),
                b = after.get(id);
              return {
                id,
                name: b?.name ?? a!.name,
                bytes: (b?.bytes ?? 0) - (a?.bytes ?? 0),
                durationMs: (b?.durationMs ?? 0) - (a?.durationMs ?? 0),
                details: { change: !a ? "Added" : !b ? "Removed" : "Changed" },
              };
            })
            .filter((row) => row.bytes || row.durationMs || row.details?.change !== "Changed")
            .sort(
              (a, b) =>
                Math.abs(b.bytes || b.durationMs || 0) - Math.abs(a.bytes || a.durationMs || 0),
            ),
        );
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) onError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [tab, comparison?.before, compareDataset, report.id, onError]);
  const summary = report.manifest.summary;
  const filtered = rows.filter((row) =>
    `${row.name} ${row.plugin ?? ""}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <div className="eyebrow">
        {report.repository} <Badge variant="secondary">Completed</Badge>
      </div>
      <div className="page-heading">
        <div>
          <h1>
            Build <span className="mono">{report.provenance.sha.slice(0, 7)}</span>
          </h1>
          <p>
            {report.project} <span className="separator">/</span> {report.environment}{" "}
            <span className="separator">/</span> {report.provenance.ref.replace("refs/heads/", "")}
          </p>
        </div>
        <a
          className={buttonVariants({ variant: "outline" })}
          href={`https://github.com/${report.repository}/actions/runs/${report.provenance.runId}`}
          target="_blank"
          rel="noreferrer"
        >
          GitHub workflow ↗
        </a>
      </div>
      <div className="metrics-grid">
        <Metric
          name="TOTAL OUTPUT"
          value={bytes(summary.outputBytes)}
          hint={`${summary.assets} output assets`}
        />
        <Metric
          name="BUILD DURATION"
          value={time(summary.durationMs)}
          hint="Native diagnostic interval"
        />
        <Metric
          name="MODULES"
          value={summary.modules.toLocaleString()}
          hint={`${summary.chunks} chunks`}
        />
        <Metric
          name="PACKAGES"
          value={summary.packages.toLocaleString()}
          hint="From the Rolldown package graph"
        />
      </div>
      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(value);
          setPage(0);
          setQuery("");
        }}
        className="mt-7 gap-4"
      >
        <TabsList
          aria-label="Report sections"
          className="h-auto max-w-full justify-start overflow-x-auto"
        >
          {["overview", ...datasets, "compare"].map((item) => (
            <TabsTrigger key={item} value={item}>
              {labels[item]}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent key={tab} value={tab}>
          {tab === "compare" ? (
            <>
              <div className="toolbar">
                <h2>Build comparison</h2>
                <select
                  aria-label="Baseline build"
                  value={baseline}
                  onChange={(event) => setBaseline(event.target.value)}
                >
                  <option value="">Previous build on this branch</option>
                  {builds
                    .filter(
                      (build) => build.id !== report.id && build.environment === report.environment,
                    )
                    .map((build) => (
                      <option key={build.id} value={build.id}>
                        {build.provenance.sha.slice(0, 7)} · {date(build.createdAt)}
                      </option>
                    ))}
                </select>
              </div>
              {comparison?.metrics ? (
                <>
                  <div className="panel table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Metric</th>
                          <th>Baseline</th>
                          <th>This build</th>
                          <th>Change</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(comparison.metrics).map(([key, value]) => (
                          <tr key={key}>
                            <td>{key}</td>
                            <td>
                              {key === "outputBytes"
                                ? bytes(value.before)
                                : key === "durationMs"
                                  ? time(value.before)
                                  : value.before}
                            </td>
                            <td>
                              {key === "outputBytes"
                                ? bytes(value.after)
                                : key === "durationMs"
                                  ? time(value.after)
                                  : value.after}
                            </td>
                            <td className={value.delta > 0 ? "regression" : "improvement"}>
                              {value.delta > 0 ? "+" : ""}
                              {key === "outputBytes"
                                ? bytes(value.delta)
                                : key === "durationMs"
                                  ? time(value.delta)
                                  : value.delta}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="toolbar">
                    <select
                      aria-label="Compare dataset"
                      value={compareDataset}
                      onChange={(event) => {
                        setCompareDataset(event.target.value as Dataset);
                        setPage(0);
                      }}
                    >
                      {datasets
                        .filter((item) => item !== "events")
                        .map((item) => (
                          <option key={item} value={item}>
                            {labels[item]}
                          </option>
                        ))}
                    </select>
                    <span className="muted">{differences.length} changed records</span>
                  </div>
                  {loading ? (
                    <Notice>Comparing datasets…</Notice>
                  ) : (
                    <>
                      <Rows
                        rows={differences.slice(page * 100, (page + 1) * 100)}
                        onSelect={setSelected}
                        delta
                      />
                      <Pagination
                        page={page}
                        pages={Math.ceil(differences.length / 100)}
                        onChange={setPage}
                      />
                    </>
                  )}
                </>
              ) : (
                <Notice>
                  No compatible baseline yet. Upload another build for this app and environment.
                </Notice>
              )}
            </>
          ) : (
            <>
              {tab === "overview" && (
                <div className="report-overview">
                  <div className="panel">
                    <div className="panel-heading">
                      <h2>Output composition</h2>
                      <span>BYTES</span>
                    </div>
                    <SizeMap rows={rows} onSelect={setSelected} />
                  </div>
                  <div className="panel build-context">
                    <h2>Build context</h2>
                    <dl>
                      <dt>Uploaded</dt>
                      <dd>{date(report.createdAt)}</dd>
                      <dt>Actor</dt>
                      <dd>{report.provenance.actor}</dd>
                      <dt>Checkout</dt>
                      <dd className="mono">{report.manifest.checkoutSha.slice(0, 12)}</dd>
                      <dt>Workflow attempt</dt>
                      <dd>{report.provenance.runAttempt}</dd>
                      <dt>Producer</dt>
                      <dd>Vite {report.manifest.producer.vite}</dd>
                    </dl>
                  </div>
                </div>
              )}
              <div className="toolbar">
                <h2>{tab === "overview" ? "Output assets" : labels[tab]}</h2>
                <Input
                  aria-label="Filter current page"
                  placeholder="Filter this page…"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setRowPage(0);
                  }}
                />
              </div>
              {loading ? (
                <Notice>Loading diagnostics…</Notice>
              ) : filtered.length ? (
                <>
                  <div className="diagnostic-layout">
                    <div>
                      <Rows
                        rows={filtered.slice(rowPage * 100, (rowPage + 1) * 100)}
                        onSelect={setSelected}
                      />
                      <Pagination
                        page={rowPage}
                        pages={Math.ceil(filtered.length / 100)}
                        onChange={setRowPage}
                      />
                      {tab === "events" && <Timeline rows={filtered} />}
                      {(tab === "modules" || tab === "chunks") && selected && (
                        <Graph row={selected} />
                      )}
                      {(tab === "packages" || tab === "modules") && (
                        <SizeMap rows={filtered} onSelect={setSelected} />
                      )}
                    </div>
                    {selected && (
                      <Details
                        row={selected}
                        reportId={report.id}
                        onClose={() => setSelected(null)}
                      />
                    )}
                  </div>
                  <Pagination page={page} pages={pages} onChange={setPage} />
                </>
              ) : (
                <Notice>
                  {query
                    ? "No matching records on this page."
                    : "This diagnostic dataset is unavailable for this build."}
                </Notice>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>
      <CapturedArtifacts report={report} />
      <div className="report-footer">
        <div>
          <span className="status-dot" /> Full Rolldown diagnostics{" "}
          <span className="muted">· Retained until deleted</span>
        </div>
        <div>
          {report.manifest.artifacts
            .filter((artifact) => artifact.kind === "raw")
            .map((artifact) => (
              <a key={artifact.id} href={`/api/v1/builds/${report.id}/artifacts/${artifact.id}`}>
                Download {artifact.name ?? artifact.id} ↓
              </a>
            ))}
          <Button
            variant="outline"
            className="text-button danger"
            onClick={async () => {
              if (!confirm("Delete this report and all its diagnostic artifacts?")) return;
              const response = await fetch(`/api/v1/builds/${report.id}`, { method: "DELETE" });
              if (response.ok) window.location.href = `/projects/${report.projectId}`;
              else onError(((await response.json()) as { error: string }).error);
            }}
          >
            Delete report
          </Button>
        </div>
      </div>
    </>
  );
}
function CapturedArtifacts({ report }: { report: BuildRecord }) {
  const [limit, setLimit] = useState(50);
  const files = report.manifest.artifacts.filter(
    (artifact) => artifact.kind !== "source" && artifact.kind !== "dataset",
  );
  return (
    <details className="panel mt-6 overflow-hidden">
      <summary className="cursor-pointer px-5 py-4 text-sm font-medium">
        Captured files <span className="ml-2 text-muted-foreground">{files.length}</span>
      </summary>
      <div className="table-scroll max-h-96 overflow-auto">
        <table>
          <thead>
            <tr>
              <th>File</th>
              <th>Kind</th>
              <th>Stored size</th>
              <th>Download</th>
            </tr>
          </thead>
          <tbody>
            {files.slice(0, limit).map((file) => (
              <tr key={file.id}>
                <td title={file.id}>{file.name ?? file.id}</td>
                <td>{file.kind}</td>
                <td>{bytes(file.bytes)}</td>
                <td>
                  <a
                    className="underline underline-offset-4"
                    href={`/api/v1/builds/${report.id}/artifacts/${file.id}`}
                  >
                    Download{file.contentType === "application/gzip" ? " .gz" : ""} ↓
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {files.length > limit && (
        <Button className="m-4" variant="outline" size="sm" onClick={() => setLimit(limit + 50)}>
          Show more files
        </Button>
      )}
    </details>
  );
}

function Pagination({
  page,
  pages,
  onChange,
}: {
  page: number;
  pages: number;
  onChange: (page: number) => void;
}) {
  return pages > 1 ? (
    <div className="pagination">
      <Button
        variant="outline"
        className="button secondary small"
        disabled={!page}
        onClick={() => onChange(page - 1)}
      >
        ← Previous
      </Button>
      <span>
        Page {page + 1} of {pages}
      </span>
      <Button
        variant="outline"
        className="button secondary small"
        disabled={page >= pages - 1}
        onClick={() => onChange(page + 1)}
      >
        Next →
      </Button>
    </div>
  ) : null;
}
function Rows({
  rows,
  onSelect,
  delta = false,
}: {
  rows: DiagnosticRow[];
  onSelect: (row: DiagnosticRow) => void;
  delta?: boolean;
}) {
  return (
    <div className="panel table-scroll">
      <table>
        <thead>
          <tr>
            <th>Name / module</th>
            <th>{delta ? "Size Δ" : "Size"}</th>
            <th>{delta ? "Time Δ" : "Time"}</th>
            <th>{delta ? "Change" : "Details"}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <Button
                  variant="outline"
                  className="row-link"
                  onClick={() => onSelect(row)}
                  title={row.name}
                >
                  {row.name}
                </Button>
                {(row.plugin || row.version) && (
                  <small>
                    {row.plugin} {row.hook} {row.version}
                  </small>
                )}
              </td>
              <td>{row.bytes === undefined ? "—" : bytes(row.bytes)}</td>
              <td>{row.durationMs === undefined ? "—" : time(row.durationMs)}</td>
              <td className="muted">
                {delta
                  ? String(row.details?.change)
                  : row.details?.duplicated
                    ? "Multiple versions"
                    : row.calls
                      ? `${row.calls} calls`
                      : row.imports
                        ? `${row.imports.length} imports`
                        : row.modules
                          ? `${row.modules.length} modules`
                          : "Inspect →"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function SizeMap({
  rows,
  onSelect,
}: {
  rows: DiagnosticRow[];
  onSelect: (row: DiagnosticRow) => void;
}) {
  const items = rows.filter((row) => row.bytes).slice(0, 16),
    total = items.reduce((n, row) => n + row.bytes!, 0);
  return (
    <div className="size-map">
      {items.length ? (
        items.map((row, index) => (
          <Button
            variant="outline"
            key={row.id}
            style={{
              flexGrow: (row.bytes! / total) * 100,
              flexBasis: 0,
              background: `hsl(${160 + index * 4} 32% ${24 + (index % 4) * 8}%)`,
            }}
            onClick={() => onSelect(row)}
            title={`${row.name}: ${bytes(row.bytes!)}`}
          >
            <strong>{row.name.split("/").at(-1)}</strong>
            <span>{bytes(row.bytes!)}</span>
          </Button>
        ))
      ) : (
        <p className="muted">No size measurements available.</p>
      )}
    </div>
  );
}
function Graph({ row }: { row: DiagnosticRow }) {
  const nodes = (row.imports ?? row.modules ?? []).slice(0, 16);
  return (
    <div className="panel graph">
      <h3>Dependency neighborhood</h3>
      <svg viewBox="0 0 800 360" role="img" aria-label={`Dependencies of ${row.name}`}>
        <title>{row.name}</title>
        {nodes.map((id, index) => {
          const angle = (index / nodes.length) * Math.PI * 2,
            x = 400 + Math.cos(angle) * 280,
            y = 180 + Math.sin(angle) * 130;
          return (
            <g key={id}>
              <line x1="400" y1="180" x2={x} y2={y} />
              <circle cx={x} cy={y} r="7" />
              <text x={x} y={y + 20} textAnchor="middle">
                {id.split("/").at(-1)?.slice(0, 24)}
              </text>
              <title>{id}</title>
            </g>
          );
        })}
        <circle cx="400" cy="180" r="12" className="graph-root" />
        <text x="400" y="207" textAnchor="middle">
          {row.name.split("/").at(-1)?.slice(0, 30)}
        </text>
      </svg>
      <small className="muted">
        Showing {nodes.length} of {(row.imports ?? row.modules ?? []).length} connections. Full
        relationships appear in record details.
      </small>
    </div>
  );
}
function Timeline({ rows }: { rows: DiagnosticRow[] }) {
  const calls = rows.filter((row) => row.durationMs !== undefined).slice(0, 40),
    max = Math.max(1, ...calls.map((row) => (row.startMs ?? 0) + row.durationMs!));
  return (
    <div className="panel timeline">
      <h3>Hook timeline</h3>
      <p className="muted">Elapsed time; overlapping hooks run concurrently.</p>
      {calls.map((row) => (
        <div key={row.id} className="timeline-row">
          <span title={row.name}>
            {row.plugin} / {row.hook}
          </span>
          <div>
            <i
              style={{
                left: `${((row.startMs ?? 0) / max) * 100}%`,
                width: `${Math.max(0.5, (row.durationMs! / max) * 100)}%`,
              }}
              title={time(row.durationMs!)}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
function Details({
  row,
  reportId,
  onClose,
}: {
  row: DiagnosticRow;
  reportId: string;
  onClose: () => void;
}) {
  const [sources, setSources] = useState<Record<string, string>>({}),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setSources({});
    setError("");
    void Promise.all(
      (["source", "before", "after", "rendered"] as const)
        .filter((key) => row[key])
        .map(async (key) => {
          const response = await fetch(`/api/v1/builds/${reportId}/artifacts/${row[key]}`, {
            headers: { Range: "bytes=0-131071" },
            signal: controller.signal,
          });
          if (!response.ok) throw new Error("Source could not be loaded");
          return [key, await response.text()];
        }),
    )
      .then((entries) => setSources(Object.fromEntries(entries)))
      .catch((failure: Error) => {
        if (!controller.signal.aborted) setError(failure.message);
      });
    return () => controller.abort();
  }, [row, reportId]);
  return (
    <aside className="panel details">
      <div className="panel-heading">
        <h3>Record details</h3>
        <Button
          variant="outline"
          className="text-button"
          aria-label="Close record details"
          onClick={onClose}
        >
          ×
        </Button>
      </div>
      <h4>{row.name}</h4>
      {error && <Notice error>{error}</Notice>}
      {Object.entries(sources).map(([key, source]) => (
        <div key={key}>
          <h4>
            {key === "before"
              ? "Before transform"
              : key === "after"
                ? "After transform"
                : key === "rendered"
                  ? "Rendered module"
                  : "Source"}
          </h4>
          <pre>{source}</pre>
          <small>
            Preview limited to 128 kB.{" "}
            <a
              href={`/api/v1/builds/${reportId}/artifacts/${row[key as "source" | "before" | "after" | "rendered"]}`}
            >
              Download full source ↓
            </a>
          </small>
        </div>
      ))}
      {typeof row.details?.fullRecord === "string" && (
        <a
          className={buttonVariants({ variant: "outline", size: "sm" })}
          href={`/api/v1/builds/${reportId}/artifacts/${row.details.fullRecord}`}
        >
          Download complete record (.json.gz)
        </a>
      )}
      <h4>Metadata</h4>
      <pre>{JSON.stringify(row, null, 2)}</pre>
    </aside>
  );
}
