import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import type { Provenance } from "@vz/protocol";
import { HTTPException } from "hono/http-exception";

const issuer = "https://token.actions.githubusercontent.com";
const githubKeys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`));
const oidcClaims = z.object({
  repository_id: z.string().regex(/^\d+$/),
  repository_owner_id: z.string().regex(/^\d+$/),
  repository: z.string().regex(/^[^/]+\/[^/]+$/),
  sha: z.string().regex(/^[a-f0-9]{40,64}$/),
  ref: z.string(),
  run_id: z.string().regex(/^\d+$/),
  run_attempt: z.string().regex(/^\d+$/),
  workflow_ref: z.string(),
  actor: z.string(),
});
export async function verifyActionsToken(
  token: string,
  origin: string,
  keys: JWTVerifyGetKey = githubKeys,
): Promise<Provenance> {
  const { payload } = await jwtVerify(token, keys, {
    issuer,
    audience: origin,
    algorithms: ["RS256"],
    requiredClaims: ["exp", "iat", "sub"],
  });
  const value = oidcClaims.parse(payload);
  return {
    repositoryId: value.repository_id,
    ownerId: value.repository_owner_id,
    repository: value.repository,
    sha: value.sha,
    ref: value.ref,
    runId: value.run_id,
    runAttempt: value.run_attempt,
    workflow: value.workflow_ref,
    actor: value.actor,
  };
}
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export function verifyWebhook(body: string, signature: string, secret: string) {
  if (!/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}
export async function issueUploadToken(id: string, manifestHash: string, secret: string) {
  if (new TextEncoder().encode(secret).length < 32)
    throw new HTTPException(503, { message: "UPLOAD_SECRET must contain at least 32 bytes" });
  return new SignJWT({ manifestHash })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(id)
    .setAudience("vz:upload")
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(new TextEncoder().encode(secret));
}
export async function verifyUploadToken(
  token: string,
  id: string,
  manifestHash: string,
  secret: string,
) {
  if (new TextEncoder().encode(secret).length < 32)
    throw new HTTPException(503, { message: "UPLOAD_SECRET must contain at least 32 bytes" });
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ["HS256"],
    audience: "vz:upload",
    subject: id,
  });
  if (payload.manifestHash !== manifestHash)
    throw new HTTPException(401, { message: "Upload does not match its manifest" });
}
export function bearer(header?: string) {
  const token = header?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) throw new HTTPException(401, { message: "Bearer token required" });
  return token;
}
export function required(value: string | undefined, name: string) {
  if (!value) throw new HTTPException(503, { message: `${name} is not configured` });
  return value;
}
