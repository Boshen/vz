import { defineAuth } from "void/auth";

export default defineAuth(({ defaults, env }) => ({
  ...defaults,
  emailAndPassword: { enabled: false },
  socialProviders:
    typeof env.AUTH_GITHUB_CLIENT_ID === "string" &&
    typeof env.AUTH_GITHUB_CLIENT_SECRET === "string"
      ? {
          github: {
            clientId: env.AUTH_GITHUB_CLIENT_ID,
            clientSecret: env.AUTH_GITHUB_CLIENT_SECRET,
          },
        }
      : {},
  account: { ...defaults.account, encryptOAuthTokens: true },
}));
