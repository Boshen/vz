import { defineScheduled } from "void";
import { cleanupAbandoned } from "../src/server/uploads";

export const cron = "0 * * * *";
export default defineScheduled(async () => {
  await cleanupAbandoned();
});
