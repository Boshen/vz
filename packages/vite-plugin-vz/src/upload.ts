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
  retryConflict = false,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetcher(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(120000),
      });
      if (response.ok) return response;
      const message = `VZ HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`;
      if (
        response.status < 500 &&
        response.status !== 429 &&
        !(retryConflict && response.status === 409)
      )
        throw new FatalUploadError(message);
      throw new Error(message);
    } catch (error) {
      if (error instanceof FatalUploadError || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
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
  const results = await Promise.allSettled(
    Array.from({ length: 3 }, async () => {
      for (let files = queue.shift(); files; files = queue.shift()) {
        if (files.every((file) => file.bytes <= maxBytes)) {
          const body = await Promise.all(
            files.map(async (file) => {
              const bytes = await readFile(file.path);
              if (bytes.length !== file.bytes)
                throw new Error("Diagnostic artifact changed during upload");
              return { id: file.id, content: bytes.toString("base64") };
            }),
          );
          await request(
            `${base}/${session.id}/artifacts/batch`,
            {
              method: "POST",
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
            await request(
              `${base}/${session.id}/artifacts/${artifact.id}/parts/${part}`,
              { method: "PUT", headers, body: buffer },
              fetcher,
            );
          }
          await request(
            `${base}/${session.id}/artifacts/${artifact.id}/complete`,
            { method: "POST", headers },
            fetcher,
            true,
          );
        } finally {
          await handle.close();
        }
      }
    }),
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  await request(`${base}/${session.id}/complete`, { method: "POST", headers }, fetcher);
  return session.reportUrl;
}
