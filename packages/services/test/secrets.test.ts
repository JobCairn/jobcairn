import { describe, expect, it } from "vitest";
import { readMeta } from "@careeros/core";
import { isSafeLink, isSecretKey, linkHandlers as L, secretHandlers as S } from "../src/secrets.js";
import { openSample } from "./helpers.js";

describe("secrets", () => {
  it("stores a secret in the open workspace and only ever reports whether it is set", async () => {
    const { ctx, host, root } = openSample();
    const value = "sk-" + "fictional-" + "key";
    const r = await S["secrets.set"](ctx, "anthropic_api_key", value);
    expect(r).toEqual({ name: "anthropic_api_key", available: true, set: true });
    expect(JSON.stringify(r)).not.toContain(value);
    expect(host.secrets.values.get(`ws.${readMeta(root).workspace_id}.anthropic_api_key`)).toBe(value);
    expect(host.secrets.values.has("anthropic_api_key")).toBe(false);
    expect(S["secrets.remove"](ctx, "anthropic_api_key").set).toBe(false);
  });
  it("refuses to store when secure storage is missing", async () => {
    const { ctx } = openSample({ secretsAvailable: false });
    expect(S["secrets.status"](ctx, "anthropic_api_key")).toEqual({ name: "anthropic_api_key", available: false, set: false });
    await expect(S["secrets.set"](ctx, "anthropic_api_key", "x")).rejects.toThrow(/Secure storage isn't available/);
    expect(() => S["secrets.remove"](ctx, "anthropic_api_key")).toThrow(/Secure storage isn't available/);
  });
});

describe("secret store keys", () => {
  it("accepts only a known secret name, alone or under a workspace id", () => {
    expect(isSecretKey("gmail_app_password")).toBe(true);
    expect(isSecretKey("ws.0b6f2c9e-1d2a-4c3b-8e7f-123456789abc.anthropic_api_key")).toBe(true);
    for (const bad of ["ws..anthropic_api_key", "ws.x.anthropic_api_key", "other", "ws.0b6f2c9e-1d2a-4c3b-8e7f-123456789abc.other", "__proto__"]) expect(isSecretKey(bad), bad).toBe(false);
  });
});

describe("links", () => {
  it("opens only plain https links", async () => {
    const { ctx, host } = openSample({ claude: true });
    for (const u of ["http://jobs.example.com", "javascript:alert(1)", "file:///etc/passwd", "https://user:pw" + "@jobs.example.com", "https://", "careeros-file://ws/x"]) {
      expect(isSafeLink(u), u).toBe(false);
      expect(await L["links.open"](ctx, u)).toBe(false);
    }
    expect(await L["links.open"](ctx, "https://jobs.example.com/acme/1")).toBe(true);
    expect(host.shell.opened).toEqual(["https://jobs.example.com/acme/1"]);
    expect(await L["claude.openDesktop"](ctx)).toBe(true);
  });
});
