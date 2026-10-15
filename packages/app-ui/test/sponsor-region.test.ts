import { describe, expect, it } from "vitest";
import { placesOf, regionForPlaces } from "../src/sponsors/region";

describe("sponsor office region", () => {
  it("finds the recorded region from the person's places, in any of them", () => {
    expect(regionForPlaces(["Sampletown NSW", "Remote Australia"])).toBeNull();
    expect(regionForPlaces(["Sampletown NSW", "Brisbane QLD"])?.name).toBe("Queensland");
    expect(regionForPlaces(["Gold Coast"])?.id).toBe("qld");
    expect(regionForPlaces([])).toBeNull();
  });
  it("reads place names from a profile safely", () => {
    expect(placesOf({ locations: [{ place: "Cairns" }, { modes: [] }, null, "x"] })).toEqual(["Cairns"]);
    expect(placesOf({})).toEqual([]);
    expect(placesOf(undefined)).toEqual([]);
  });
});
