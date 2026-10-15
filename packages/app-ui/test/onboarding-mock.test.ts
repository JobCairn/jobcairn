import { describe, expect, it } from "vitest";
import { PRODUCT_NAME } from "@careeros/brand/identity";
import { MockBridge } from "../src/mock/MockBridge";

describe("MockBridge onboarding API", () => {
  it("suggests a new ~/<product> folder by default, and the caller can change it", async () => {
    expect(await new MockBridge().workspace.suggest()).toEqual({
      dir: `/fictional/alex-example/${PRODUCT_NAME}`, display: `~/${PRODUCT_NAME}`, existing: false, name: "",
    });
    expect(await new MockBridge({ suggestion: { existing: true, name: "Alex Example" } }).workspace.suggest()).toMatchObject({ existing: true, name: "Alex Example" });
  });

  it("Get started opens the suggested folder with no name yet, and isn't the example", async () => {
    const b = new MockBridge({ workspaceOpen: false });
    const s = await b.workspace.start();
    expect(s).toMatchObject({ root: `/fictional/alex-example/${PRODUCT_NAME}`, name: "", isSample: false });
    expect(await b.workspace.current()).toMatchObject({ isSample: false });
    expect(b.calls.at(-2)).toEqual({ method: "workspace.start", args: [] });
  });

  it("Get started keeps the name of a workspace that already exists", async () => {
    const b = new MockBridge({ workspaceOpen: false, suggestion: { existing: true } });
    expect((await b.workspace.start()).name).toBe("Alex Example");
  });

  it("the example opens flagged, and opening it again resets it", async () => {
    const b = new MockBridge({ workspaceOpen: false });
    const s = await b.workspace.openSample();
    expect(s).toMatchObject({ root: `/fictional/alex-example/${PRODUCT_NAME} Example`, name: "Alex Example", isSample: true });
    await b.settings.save("profile", [{ path: "contact.name", value: "Changed" }]);
    expect((await b.workspace.openSample()).name).toBe("Alex Example");
    await b.workspace.close();
    expect(await b.workspace.current()).toBeNull();
    expect((await b.workspace.start()).isSample).toBe(false);
  });

  it("can start with the example open, for the banner", async () => {
    expect(await new MockBridge({ isSample: true }).workspace.current()).toMatchObject({ isSample: true });
  });

  it("rejects arguments the real IPC would reject", async () => {
    const b = new MockBridge();
    await expect(b.workspace.create("/fictional/x", "a/b")).rejects.toThrow();
    await expect(b.workspace.create("/fictional/x", "")).resolves.toMatchObject({ name: "" });
  });
});
