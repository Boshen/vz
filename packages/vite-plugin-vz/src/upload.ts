import { open, readFile } from "node:fs/promises";
import {
  BATCH_FILES,
  SMALL_ARTIFACT_BYTES,
  PART_BYTES,
  type BuildManifest,
  type UploadSession,
} from "@vz/protocol";
import type { LocalArtifact } from "./capture";

export async function request(
  url: string,
  init: RequestInit,
  fetcher = fetch,
  policy: { retryConflict?: boolean; discardBody?: boolean } = {},
) {
  for (let attempt = 0; ; attempt++) {
    init.signal?.throwIfAborted();
    try {
      const response = await fetcher(url, {
        ...init,
        redirect: "error",
        signal: init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(120000)])
          : AbortSignal.timeout(120000),
      });
      if (response.ok) {
        if (policy.discardBody) await response.arrayBuffer();
        return response;
      }
      const message = `VZ HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`;
      if (
        response.status < 500 &&
        response.status !== 429 &&
        !(policy.retryConflict && response.status === 409)
      )
        throw new FatalUploadError(message);
      throw new Error(message);
    } catch (error) {
      init.signal?.throwIfAborted();
      if (error instanceof FatalUploadError || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}
async function acknowledge(
  url: string,
  init: RequestInit,
  fetcher: typeof fetch,
  retryConflict = false,
) {
  const response = await request(url, init, fetcher, { retryConflict, discardBody: true });
  return response.status;
}
class FatalUploadError extends Error {}
export async function oidcToken(endpoint: string, environment: NodeJS.ProcessEnv, fetcher = fetch) {
  const url = new URL(environment.ACTIONS_ID_TOKEN_REQUEST_URL!);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".actions.githubusercontent.com"))
    throw new Error("Invalid GitHub OIDC request URL");
  url.searchParams.set("audience", new URL(endpoint).origin);
  const response = await request(
    url.href,
    { headers: { Authorization: `Bearer ${environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } },
    fetcher,
  );
  const data = (await response.json()) as { value: string };
  if (!data.value) throw new Error("GitHub did not issue an OIDC token");
  return data.value;
}
export async function upload(
  endpoint: string,
  manifest: BuildManifest,
  artifacts: LocalArtifact[],
  environment = process.env,
  fetcher = fetch,
) {
  const base = new URL("/api/v1/uploads", endpoint).href;
  const oidc = await oidcToken(endpoint, environment, fetcher);
  const response = await request(
    base,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${oidc}`, "Content-Type": "application/json" },
      body: JSON.stringify(manifest),
    },
    fetcher,
  );
  const session = (await response.json()) as UploadSession;
  const headers = { Authorization: `Bearer ${session.token}` };
  const maxFiles = Math.min(BATCH_FILES, session.batch?.maxFiles ?? 1);
  const maxBytes = Math.min(SMALL_ARTIFACT_BYTES, session.batch?.maxBytes ?? 0);
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || !Number.isInteger(maxBytes) || maxBytes < 0)
    throw new Error("Invalid batch upload capabilities");
  const small = artifacts.filter((artifact) => artifact.bytes <= maxBytes);
  const queue: LocalArtifact[][] = artifacts
    .filter((artifact) => artifact.bytes > maxBytes)
    .map((artifact) => [artifact]);
  for (let offset = 0; offset < small.length; offset += maxFiles)
    queue.push(small.slice(offset, offset + maxFiles));
  const controller = new AbortController();
  const next = () => (controller.signal.aborted ? undefined : queue.shift());
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      try {
        for (let files = next(); files; files = next()) {
          if (files.every((file) => file.bytes <= maxBytes)) {
            const body = await Promise.all(
              files.map(async (file) => {
                const bytes = await readFile(file.path, { signal: controller.signal });
                if (bytes.length !== file.bytes)
                  throw new Error("Diagnostic artifact changed during upload");
                return { id: file.id, content: bytes.toString("base64") };
              }),
            );
            await acknowledge(
              `${base}/${session.id}/artifacts/batch`,
              {
                method: "POST",
                signal: controller.signal,
                headers: { ...headers, "Content-Type": "application/json" },
                body: JSON.stringify(body),
              },
              fetcher,
            );
            continue;
          }
          const artifact = files[0];
          const handle = await open(artifact.path, "r");
          try {
            for (let offset = 0, part = 1; offset < artifact.bytes; offset += PART_BYTES, part++) {
              const buffer = Buffer.alloc(Math.min(PART_BYTES, artifact.bytes - offset));
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
              if (bytesRead !== buffer.length)
                throw new Error("Diagnostic artifact changed during upload");
              await acknowledge(
                `${base}/${session.id}/artifacts/${artifact.id}/parts/${part}`,
                { method: "PUT", headers, body: buffer, signal: controller.signal },
                fetcher,
              );
            }
            await acknowledge(
              `${base}/${session.id}/artifacts/${artifact.id}/complete`,
              { method: "POST", headers, signal: controller.signal },
              fetcher,
              true,
            );
          } finally {
            await handle.close();
          }
        }
      } catch (error) {
        controller.abort(error);
      }
    }),
  );
  controller.signal.throwIfAborted();
  await finalizeUpload(`${base}/${session.id}/complete`, headers, fetcher);
  return session.reportUrl;
}

export async function finalizeUpload(url: string, headers: HeadersInit, fetcher = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("VZ indexing did not complete within 15 minutes")),
    15 * 60 * 1000,
  );
  try {
    for (;;) {
      const status = await acknowledge(
        url,
        { method: "POST", headers, signal: controller.signal },
        fetcher,
      );
      if (status !== 202) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } finally {
    clearTimeout(timeout);
  }
}
