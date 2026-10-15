/**
 * The regions the sponsor list can record an employer's presence in. Today the list keeps one such fact (`qld`),
 * so there is one entry; a new region is a new line here, never a hard-coded filter on the screen.
 */
export interface SponsorRegion { id: "qld"; name: string; match: RegExp }
export const SPONSOR_REGIONS: readonly SponsorRegion[] = [
  { id: "qld", name: "Queensland", match: /\b(qld|queensland|brisbane|gold coast|sunshine coast|townsville|cairns|toowoomba|ipswich|logan|mackay|rockhampton|bundaberg)\b/i },
];

/** The recorded region the person looks for work in (from their preferred places), or null. */
export function regionForPlaces(places: readonly string[]): SponsorRegion | null {
  for (const p of places) {
    const r = SPONSOR_REGIONS.find((x) => x.match.test(p));
    if (r) return r;
  }
  return null;
}

/** The place names in a profile's `locations` list, ignoring anything malformed. */
export function placesOf(profile: Record<string, unknown> | undefined): string[] {
  const list = profile?.locations;
  if (!Array.isArray(list)) return [];
  return list.map((l) => (l && typeof l === "object" && typeof (l as { place?: unknown }).place === "string" ? (l as { place: string }).place : "")).filter(Boolean);
}
