import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/redaction.js";

describe("redactSecrets", () => {
  it("passes through short or empty content unchanged", () => {
    expect(redactSecrets("").content).toBe("");
    expect(redactSecrets("hi there").content).toBe("hi there");
    expect(redactSecrets("hi there").hits).toHaveLength(0);
  });

  it("passes through benign content without matches", () => {
    const text = "Let's look at commit 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b and call it done.";
    const result = redactSecrets(text);
    expect(result.content).toBe(text);
    expect(result.hits).toHaveLength(0);
  });

  it("redacts an OpenAI-style key", () => {
    const key = "sk-proj-" + "a".repeat(40);
    const text = `please use ${key} as the token`;
    const result = redactSecrets(text);
    expect(result.content).toBe("please use [REDACTED:openai-key] as the token");
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].type).toBe("openai-key");
  });

  it("redacts an Anthropic-style key ahead of the generic openai pattern", () => {
    const key = "sk-ant-api03-" + "Z".repeat(50);
    const result = redactSecrets(`token=${key} end`);
    expect(result.content).toBe("token=[REDACTED:anthropic-key] end");
    expect(result.hits[0].type).toBe("anthropic-key");
  });

  it("redacts a github token", () => {
    const token = "ghp_" + "A".repeat(36);
    const result = redactSecrets(`export GH_TOKEN=${token}`);
    expect(result.content).toContain("[REDACTED:github-token]");
    expect(result.content).not.toContain(token);
  });

  it("redacts AWS access keys", () => {
    const result = redactSecrets("access=AKIAABCDEFGHIJKLMNOP here");
    expect(result.content).toBe("access=[REDACTED:aws-access-key] here");
  });

  it("redacts Google API keys", () => {
    const key = "AIza" + "B".repeat(35);
    const result = redactSecrets(`key=${key}!`);
    expect(result.content).toBe("key=[REDACTED:google-api-key]!");
  });

  it("redacts Slack tokens", () => {
    const result = redactSecrets("xoxb-1234567890-abcdefghij test");
    expect(result.content).toContain("[REDACTED:slack-token]");
  });

  it("redacts a bearer token", () => {
    const result = redactSecrets("Authorization header: Bearer abcdef1234567890XYZ and rest");
    // 'Authorization' line match takes the whole line; check content was changed.
    expect(result.content).not.toContain("Bearer abcdef1234567890XYZ");
    expect(result.content.includes("[REDACTED:")).toBe(true);
  });

  it("redacts a full Authorization header line", () => {
    const result = redactSecrets("line1\nAuthorization: Token deadbeefcafebabe1234\nline3");
    expect(result.content).toContain("[REDACTED:auth-header]");
    expect(result.content).not.toContain("deadbeefcafebabe1234");
  });

  it("redacts a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijABCDEFGHIJ123";
    const result = redactSecrets(`token: ${jwt}; end`);
    expect(result.content).toBe("token: [REDACTED:jwt]; end");
  });

  it("redacts a PEM block and everything inside it", () => {
    const pem = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC",
      "sk-proj-nestedShouldNotEscape1234567890",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const result = redactSecrets(`before\n${pem}\nafter`);
    expect(result.content).toBe("before\n[REDACTED:pem-block]\nafter");
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].type).toBe("pem-block");
  });

  it("handles multiple different secrets in one message", () => {
    const text = `ghp_${"A".repeat(36)} plus AKIAABCDEFGHIJKLMNOP`;
    const result = redactSecrets(text);
    expect(result.content).toBe("[REDACTED:github-token] plus [REDACTED:aws-access-key]");
    expect(result.hits).toHaveLength(2);
  });
});
