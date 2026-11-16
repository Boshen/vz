import { expect, test, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildManifestSchema } from "@vz/protocol";
import { upload, request } from "../packages/vite-plugin-vz/src/upload";
test("completion retries transient receipt conflicts but initialization conflicts stay fatal", async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: "Artifact is incomplete" }, { status: 409 }))
      .mockResolvedValue(Response.json({ ok: true }));
    const pending = request("https://vz.example/complete", { method: "POST" }, fetcher, {
      retryConflict: true,
    });
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const conflict = vi
      .fn()
      .mockResolvedValue(Response.json({ error: "Capture id already used" }, { status: 409 }));
    await expect(
      request("https://vz.example/uploads", { method: "POST" }, conflict),
    ).rejects.toThrow("409");
    expect(conflict).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

test("finalization waits for checkpointed indexing before returning a report", async () => {
  const { finalizeUpload } = await import("../packages/vite-plugin-vz/src/upload");
  vi.useFakeTimers();
  try {
    const responses = [
      Response.json({ ok: false }, { status: 202 }),
      Response.json({ ok: false }, { status: 202 }),
      Response.json({ ok: true }),
    ];
    const fetcher = vi
      .fn()
      .mockImplementation(async () => responses[fetcher.mock.calls.length - 1]);
    const pending = finalizeUpload("https://vz.example/complete", {}, fetcher);
    await vi.runAllTimersAsync();
    await pending;
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(responses.every((response) => response.bodyUsed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("caller cancellation stops an active request without retrying", async () => {
  const controller = new AbortController(),
    reason = new Error("Build cancelled");
  const fetcher: typeof fetch = vi.fn(
    async (_input, init) =>
      new Promise<Response>((_resolve, reject) =>
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }),
      ),
  );
  const pending = request(
    "https://vz.example/uploads",
    { method: "POST", signal: controller.signal },
    fetcher,
  );
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("the finalization deadline also aborts a stalled request", async () => {
  const { finalizeUpload } = await import("../packages/vite-plugin-vz/src/upload");
  vi.useFakeTimers();
  try {
    const fetcher: typeof fetch = vi.fn(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) =>
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), {
            once: true,
          }),
        ),
    );
    const pending = expect(
      finalizeUpload("https://vz.example/complete", {}, fetcher),
    ).rejects.toThrow("within 15 minutes");
    await vi.runAllTimersAsync();
    await pending;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("a failed artifact aborts active uploads and leaves queued artifacts untouched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vz-upload-cancel-"));
  try {
    const path = join(directory, "source.txt");
    await writeFile(path, "x");
    const artifacts = Array.from({ length: 7 }, (_, index) => ({
      path,
      id: `source-${index}`,
      kind: "source" as const,
      bytes: 1,
      sha256: createHash("sha256").update("x").digest("hex"),
      contentType: "text/plain" as const,
    }));
    const manifest = buildManifestSchema.parse({
      version: 1,
      captureId: crypto.randomUUID(),
      project: "fixture",
      environment: "client",
      checkoutSha: "a".repeat(40),
      producer: { plugin: "0.3.2", vite: "8.0.0", rolldown: "1.2.0" },
      summary: { durationMs: 1, outputBytes: 1, modules: 1, chunks: 1, assets: 1, packages: 1 },
      artifacts: artifacts.map(({ path: _path, ...file }) => file),
    });
    const signals: AbortSignal[] = [];
    let failFirst: () => void;
    const fetcher: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://pipelines.actions.githubusercontent.com/"))
        return Response.json({ value: "oidc" });
      if (url === "https://vz.example/api/v1/uploads")
        return Response.json({
          id: "session",
          token: "token",
          reportUrl: "https://vz.example/reports/session",
          batch: { maxFiles: 1, maxBytes: 128 * 1024 },
        });
      if (!url.endsWith("/artifacts/batch")) throw new Error(`Unexpected request: ${url}`);
      signals.push(init!.signal!);
      return new Promise<Response>((resolve, reject) => {
        if (signals.length === 1)
          failFirst = () => resolve(Response.json({ error: "Forbidden" }, { status: 403 }));
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
        if (signals.length === 3) failFirst();
      });
    });
    await expect(
      upload(
        "https://vz.example",
        manifest,
        artifacts,
        {
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.githubusercontent.com/token",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "token",
        },
        fetcher,
      ),
    ).rejects.toThrow("403");
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a lost acknowledgement body retries the idempotent finalization request", async () => {
  const { finalizeUpload } = await import("../packages/vite-plugin-vz/src/upload");
  vi.useFakeTimers();
  try {
    const lost = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("Connection lost"));
        },
      }),
    );
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(lost)
      .mockResolvedValue(Response.json({ ok: true }));
    const pending = finalizeUpload("https://vz.example/complete", {}, fetcher);
    await vi.runAllTimersAsync();
    await pending;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
