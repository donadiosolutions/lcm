import { describe, expect, it } from "vitest";
import { isSensitiveKey } from "../src/secret-key.js";

describe("isSensitiveKey", () => {
  it.each([
    "apiKey",
    "apikey",
    "apikeys",
    "api_key",
    "x-api-key",
    "apiKeys",
    "access_token",
    "accessToken",
    "accessTokens",
    "refreshToken",
    "token",
    "tokens",
    "Authorization",
    "Proxy-Authorization",
    "proxyAuthorization",
    "cookie",
    "Set-Cookie",
    "sessionCookie",
    "privateKey",
    "privatekey",
    "privatekeys",
    "private_key",
    "private-key",
    "credential",
    "credentialsPath",
    "bearer",
    "bearerToken",
    "clientSecret",
    "databasePassword",
  ])("matches sensitive key %s", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    "leafTokens",
    "autoCompactMinTokens",
    "tokenCount",
    "token_count",
    "tokensBefore",
    "tokensAfter",
    "maxTokens",
    "minTokens",
    "tokenBudget",
    "estimatedTokenCount",
    "tokenizer",
    "privateKeyboardLayout",
    "secretaryName",
    "credentialedFeatureCount",
  ])("does not match non-secret key %s", (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});
