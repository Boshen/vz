import { Dashboard } from "../src/dashboard";
import type { Props } from "./index.server";
export default function Page(props: Props) {
  return <Dashboard key={"home"} {...props} />;
}
