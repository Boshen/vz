import { Dashboard } from "../../src/dashboard";
import type { Props } from "./[id].server";
export default function Page(props: Props) {
  return <Dashboard key={props.projectId} {...props} />;
}
