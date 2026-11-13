import { defineScheduled } from "void";
import { cleanupAbandoned } from "../src/server/uploads";

import { backfillTrends } from "../src/server/trends";

export const cron = "0 * * * *";
export default defineScheduled(async () => {
  await cleanupAbandoned();
  await backfillTrends();
});
