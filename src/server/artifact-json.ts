import { HTTPException } from "hono/http-exception";
import { PAGE_BYTES, type ArtifactManifest } from "@vz/protocol";
export async function readArtifactJson(
  object: { body: ReadableStream<Uint8Array<ArrayBuffer>> },
  artifact: ArtifactManifest,
): Promise<unknown> {
  const stream =
    artifact.contentType === "application/gzip"
      ? object.body.pipeThrough(new DecompressionStream("gzip"))
      : object.body;
  if (artifact.kind !== "dataset") return new Response(stream).json();
  const reader = stream.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > PAGE_BYTES) {
        await reader.cancel();
        throw new HTTPException(400, { message: "Dataset page exceeds decoded size limit" });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const result: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(result))
    throw new HTTPException(400, { message: "Invalid diagnostic dataset" });
  return result;
}
