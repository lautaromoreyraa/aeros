import { describe, expect, it } from "vitest";
import { findSecrets } from "../src/secrets";

// Every credential below is made up for the test; none is real.
const rules = (text: string) => findSecrets(text).map((f) => f.rule);

describe("findSecrets", () => {
  it.each([
    ["-----BEGIN OPENSSH PRIVATE KEY-----\nabc", "private key block"],
    ["use ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8", "GitHub token"],
    ["key AKIAIOSFODNN7EXAMPLE leaked", "AWS access key id"],
    ["bot 1234567890:" + "AAE_abcdefghijklmnopqrstuvwxyz01234", "Telegram bot token"],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abc", "bearer credential"],
    ["secret " + "0123456789abcdef".repeat(4), "long hexadecimal secret"],
    ["se pegó Zk3Qw9Xr2Lm8Vn5Bt7Yp4Hc6Jd1Gs0Fa en el chat", "high-entropy token"],
    ["client_secret = s3cr3tValue-abc123", "credential assignment"],
  ])("rejects %s", (text, rule) => {
    expect(rules(text)).toContain(rule);
  });

  it("accepts ordinary prompts", () => {
    expect(
      findSecrets("Sí, reencauzar: usar aeros fetch de David y descartar el recorte rectangular."),
    ).toEqual([]);
  });

  it("keeps git SHAs, branch names and file paths quotable", () => {
    const refs =
      "feature/prompt-decision-log, cd12ffd2a76c93026edb360a3360df386a4b933f, infra/mcp/src/store.ts";
    expect(findSecrets(refs)).toEqual([]);
  });

  it("allows naming a secret by its variable without revealing it", () => {
    expect(findSecrets("faltan AEROS_MCP_CLIENT_SECRET y token: ${AEROS_MCP_TOKEN}")).toEqual([]);
    expect(findSecrets("token = ************")).toEqual([]);
  });
});
