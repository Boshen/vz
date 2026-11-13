import { importPKCS8, SignJWT } from "jose";
import { createPrivateKey } from "node:crypto";
import { env } from "void/env";
import { getAuth, getUser } from "void/auth";
import type { CloudContext } from "void";
import { HTTPException } from "hono/http-exception";
import { db, eq } from "void/db";
import { repositories } from "../../db/schema";
import { required } from "./security";

interface GitHubRepository {
  id: number;
  full_name: string;
  private: boolean;
  owner: { id: number };
  permissions?: { push?: boolean; admin?: boolean; maintain?: boolean };
}
export async function github<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    redirect: "error",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "vz",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new HTTPException(
      response.status === 404 || response.status === 403 || response.status === 401 ? 404 : 503,
      { message: "GitHub access could not be verified" },
    );
  return response.json() as Promise<T>;
}
async function appToken() {
  const pem = createPrivateKey(
    required(env.GITHUB_APP_PRIVATE_KEY, "GITHUB_APP_PRIVATE_KEY").replaceAll("\\n", "\n"),
  )
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const key = await importPKCS8(pem, "RS256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(required(env.GITHUB_APP_ID, "GITHUB_APP_ID"))
    .setIssuedAt(Math.floor(Date.now() / 1000) - 30)
    .setExpirationTime("9m")
    .sign(key);
}
export async function installationFor(name: string) {
  const installation = await github<{ id: number; suspended_at: string | null }>(
    `/repos/${name}/installation`,
    await appToken(),
  );
  if (installation.suspended_at)
    throw new HTTPException(403, { message: "GitHub App installation is suspended" });
  return installation.id;
}
async function installationToken(id: number) {
  const installation = await github<{ suspended_at: string | null }>(
    `/app/installations/${id}`,
    await appToken(),
  );
  if (installation.suspended_at) throw new HTTPException(404);
  return (
    await github<{ token: string }>(`/app/installations/${id}/access_tokens`, await appToken(), {
      method: "POST",
      body: JSON.stringify({ permissions: { metadata: "read", contents: "read" } }),
    })
  ).token;
}
export async function refreshRepository(id: string, installationId: number) {
  const repo = await github<GitHubRepository>(
    `/repositories/${id}`,
    await installationToken(installationId),
  );
  if (String(repo.id) !== id) throw new HTTPException(404);
  await db
    .update(repositories)
    .set({ name: repo.full_name, isPrivate: repo.private, ownerId: String(repo.owner.id) })
    .where(eq(repositories.id, id));
  return repo;
}
async function userToken(c: CloudContext) {
  if (!getUser())
    throw new HTTPException(401, { message: "Sign in with GitHub to view this repository" });
  const auth = getAuth(c);
  const accounts = await auth.api.listUserAccounts({ headers: c.req.raw.headers });
  const account = accounts.find((item) => item.providerId === "github");
  if (!account) throw new HTTPException(401);
  const token = await auth.api.getAccessToken({
    headers: c.req.raw.headers,
    body: { accountId: account.id },
  });
  return token.accessToken;
}
export async function authorizeRepository(c: CloudContext, id: string, write = false) {
  const [record] = await db.select().from(repositories).where(eq(repositories.id, id));
  if (!record?.active) throw new HTTPException(404);
  const repo = await refreshRepository(id, record.installationId);
  if (repo.private || write) {
    const permitted = await github<GitHubRepository>(`/repositories/${id}`, await userToken(c));
    if (String(permitted.id) !== id) throw new HTTPException(404);
    if (
      write &&
      !permitted.permissions?.push &&
      !permitted.permissions?.admin &&
      !permitted.permissions?.maintain
    )
      throw new HTTPException(403, { message: "Repository write access required" });
  }
  return repo;
}
