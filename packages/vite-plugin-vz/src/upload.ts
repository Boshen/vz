import { open } from "node:fs/promises";
import { PART_BYTES, type BuildManifest, type UploadSession } from "@vz/protocol";
import type { LocalArtifact } from "./capture";

export async function request(url: string, init: RequestInit, fetcher = fetch) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetcher(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(120000),
      });
      if (response.ok) return response;
      const message = `VZ HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`;
      if (response.status < 500 && response.status !== 429) throw new FatalUploadError(message);
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
  const queue = [...artifacts];
  const results = await Promise.allSettled(
    Array.from({ length: 3 }, async () => {
      for (let artifact = queue.shift(); artifact; artifact = queue.shift()) {
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
