import { defineEnv, string, url } from "void/env";

export default defineEnv({
  PLATFORM_ORIGIN: url().optional(),
  GITHUB_APP_ID: string().optional(),
  GITHUB_APP_SLUG: string().optional(),
  GITHUB_APP_PRIVATE_KEY: string().optional(),
  GITHUB_WEBHOOK_SECRET: string().optional(),
  AUTH_GITHUB_CLIENT_ID: string().optional(),
  AUTH_GITHUB_CLIENT_SECRET: string().optional(),
  UPLOAD_SECRET: string().optional(),
});
