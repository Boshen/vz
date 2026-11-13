import { expect, test, vi } from "vitest";
import { request } from "../packages/vite-plugin-vz/src/upload";
test("completion retries transient receipt conflicts but initialization conflicts stay fatal", async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: "Artifact is incomplete" }, { status: 409 }))
      .mockResolvedValue(Response.json({ ok: true }));
    const pending = request("https://vz.example/complete", { method: "POST" }, fetcher, true);
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
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: false }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: false }, { status: 202 }))
      .mockResolvedValue(Response.json({ ok: true }));
    const pending = finalizeUpload("https://vz.example/complete", {}, fetcher);
    await vi.runAllTimersAsync();
    await pending;
    expect(fetcher).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});
