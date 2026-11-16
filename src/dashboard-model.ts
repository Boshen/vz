import type { BuildRecord, BuildSummary, Provenance, DiagnosticRow } from "@vz/protocol";
export interface Project {
  id: string;
  key: string;
  repository: string;
  private: boolean;
}
export interface BuildListItem {
  id: string;
  createdAt: number;
  environment: string;
  summary: BuildSummary;
  provenance: Provenance;
}
export interface History {
  project: Project;
  builds: BuildListItem[];
  nextPage: number | null;
}
export interface Session {
  authConfigured?: boolean;
  user: { name: string; image?: string | null } | null;
  appSlug: string | null;
}
export interface DashboardInitial {
  session: Session;
  projects: Project[];
  nextProjectPage: number | null;
  history: History | null;
  report: BuildRecord | null;
  trends: import("./trends/model").TrendResponse | null;
  regression: import("./regressions").RegressionResult | null;
  error: string;
  overview: { rows: DiagnosticRow[]; pages: number } | null;
}
