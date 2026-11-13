import { useParams } from "@void/react";
import { Dashboard } from "../../src/dashboard";
export default function ProjectPage() {
  const { id } = useParams<"/projects/[id]">();
  return <Dashboard projectId={id} />;
}
