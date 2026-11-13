import { useParams } from "@void/react";
import { Dashboard } from "../../src/dashboard";
export default function ReportPage() {
  const { id } = useParams<"/reports/[id]">();
  return <Dashboard reportId={id} />;
}
