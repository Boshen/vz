import { defineHandler, type InferProps } from "void";
import { dashboardData } from "../src/server/api";
export const loader = defineHandler(async (c) => {
  const selection = {};
  return { ...selection, initial: await dashboardData(c, selection) };
});
export type Props = InferProps<typeof loader>;
