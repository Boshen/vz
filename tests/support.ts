import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import type { CloudContext } from "void";

export const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys=ON");
for (const file of readdirSync("db/migrations")
  .filter((file) => file.endsWith(".sql"))
  .sort())
  sqlite.exec(readFileSync(`db/migrations/${file}`, "utf8"));
function statement(query: string, params: SQLInputValue[] = []) {
  return {
    bind: (...values: SQLInputValue[]) => statement(query, values),
    async all() {
      return { results: sqlite.prepare(query).all(...params), success: true, meta: {} };
    },
    async raw() {
      const prepared = sqlite.prepare(query);
      prepared.setReturnArrays(true);
      return prepared.all(...params);
    },
    async run() {
      return { success: true, meta: sqlite.prepare(query).run(...params) };
    },
  };
}
export const d1 = {
  prepare: statement,
  withSession() {
    return this;
  },
} as unknown as D1Database;
const objects = new Map<string, Uint8Array>();
const multiparts = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
export const memoryStorage = {
  async createMultipartUpload(key: string) {
    const id = crypto.randomUUID();
    multiparts.set(id, { key, parts: new Map() });
    return this.resumeMultipartUpload(key, id);
  },
  resumeMultipartUpload(key: string, id: string) {
    return {
      uploadId: id,
      async uploadPart(part: number, buffer: ArrayBuffer) {
        const entry = multiparts.get(id);
        if (!entry || entry.key !== key) throw new Error("Missing multipart");
        const bytes = new Uint8Array(buffer);
        entry.parts.set(part, bytes);
        return { partNumber: part, etag: createHash("sha256").update(bytes).digest("hex") };
      },
      async complete(parts: { partNumber: number; etag: string }[]) {
        const entry = multiparts.get(id)!;
        objects.set(
          key,
          new Uint8Array(
            Buffer.concat(parts.map((part) => Buffer.from(entry.parts.get(part.partNumber)!))),
          ),
        );
        multiparts.delete(id);
      },
      async abort() {
        multiparts.delete(id);
      },
    };
  },
  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    const value = objects.get(key);
    if (!value) return null;
    const bytes = options?.range
      ? value.slice(options.range.offset, options.range.offset + options.range.length)
      : value;
    return {
      size: value.length,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    };
  },
  async list({ prefix }: { prefix: string }) {
    return {
      objects: [...objects].filter(([key]) => key.startsWith(prefix)).map(([key]) => ({ key })),
      truncated: false,
    };
  },
  async delete(keys: string | string[]) {
    for (const key of typeof keys === "string" ? [keys] : keys) objects.delete(key);
  },
};
export const state = {
  private: false,
  access: true,
  write: true,
  active: true,
  user: null as { id: string; name: string } | null,
  requests: [] as string[],
};
export const settings = {
  PLATFORM_ORIGIN: "https://vz.example",
  UPLOAD_SECRET: "unit-test-only-secret-at-least-32-characters",
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: "",
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
};
export const fakeContext = { req: { raw: new Request("https://vz.example") } } as CloudContext;
export function reset() {
  sqlite.exec(
    "DELETE FROM builds; DELETE FROM projects; DELETE FROM repositories; DELETE FROM webhook_deliveries;",
  );
  objects.clear();
  multiparts.clear();
  Object.assign(state, {
    private: false,
    access: true,
    write: true,
    active: true,
    user: null,
    requests: [],
  });
}
