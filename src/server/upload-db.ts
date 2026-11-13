import { createDb } from "void/db";
import { requireRuntimeBinding } from "void/_env";

/** Upload receipts and state transitions must observe all previous requests. */
export function uploadDb() {
  return createDb(requireRuntimeBinding<D1Database>("DB"), { session: "first-primary" });
}
