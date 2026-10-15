import { describe, expect, it } from "vitest";
import * as services from "@careeros/services";

describe("@careeros/services public surface", () => {
  it("does not expose setPath, a raw path writer with no schema allowlist of its own", () => {
    expect(Object.hasOwn(services, "setPath")).toBe(false);
    expect("setPath" in services).toBe(false);
  });
  it("still exposes the settings handlers other packages rely on", () => {
    expect(services.settingsHandlers).toBeDefined();
    expect(typeof services.settingsFile).toBe("function");
  });
});
