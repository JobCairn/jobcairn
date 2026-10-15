/**
 * A stylised map of Australia for map-pin scenes: a coarse outline (hand-simplified from public-domain coastline
 * shapes, accurate to about 50 km, which is all a dot map needs) and the places a job ad usually names. A place not
 * in this list is shown on a plain globe instead: nothing is looked up online.
 */
export const MAP_BOX = { w: 820, h: 740 };
const LON0 = 112.5, LON1 = 154.5, LAT0 = -9.5, LAT1 = -44.2;

export function project(lon: number, lat: number): { x: number; y: number } {
  return { x: ((lon - LON0) / (LON1 - LON0)) * MAP_BOX.w, y: ((lat - LAT0) / (LAT1 - LAT0)) * MAP_BOX.h };
}

export const AU_OUTLINE: [number, number][] = [
  [142.5, -10.7], [143.8, -14.0], [145.3, -15.0], [146.0, -17.5], [146.3, -19.0], [148.8, -20.3], [150.5, -22.5], [151.3, -23.8],
  [153.0, -25.3], [153.6, -28.0], [153.0, -31.0], [152.5, -32.5], [151.3, -33.9], [150.2, -35.7], [149.9, -37.5], [147.5, -37.9],
  [146.3, -39.1], [144.9, -37.9], [143.5, -38.8], [141.0, -38.1], [139.7, -37.2], [139.3, -35.6], [138.1, -35.6], [138.5, -34.6],
  [137.8, -33.2], [137.4, -34.8], [135.9, -34.8], [135.6, -34.6], [134.2, -32.8], [131.1, -31.5], [128.9, -31.7], [126.0, -32.3],
  [124.0, -33.0], [121.9, -33.8], [119.9, -34.0], [117.9, -35.1], [115.0, -34.3], [115.7, -33.3], [115.7, -31.6], [115.0, -29.5],
  [114.2, -26.4], [113.4, -24.5], [113.7, -22.6], [114.2, -21.8], [116.7, -20.6], [118.8, -20.3], [121.0, -19.5], [122.2, -18.2],
  [123.6, -17.0], [125.2, -15.0], [126.9, -13.8], [128.4, -14.9], [129.6, -14.9], [130.3, -12.4], [131.3, -12.2], [132.6, -11.5],
  [133.9, -11.8], [135.9, -12.0], [136.9, -12.3], [136.5, -13.3], [135.4, -14.7], [136.8, -15.9], [139.3, -17.4], [140.8, -17.4],
  [141.6, -15.0], [141.5, -13.0],
];
export const AU_TAS: [number, number][] = [[144.6, -40.7], [148.3, -40.9], [148.3, -42.2], [147.0, -43.6], [145.9, -43.5], [145.2, -42.2]];

interface Place { name: string; lon: number; lat: number; region: string }
const P = (name: string, lon: number, lat: number, region: string): Place => ({ name, lon, lat, region });
export const PLACES: Place[] = [
  P("Sydney", 151.21, -33.87, "New South Wales"), P("Melbourne", 144.96, -37.81, "Victoria"), P("Brisbane", 153.03, -27.47, "Queensland"),
  P("Perth", 115.86, -31.95, "Western Australia"), P("Adelaide", 138.6, -34.93, "South Australia"), P("Canberra", 149.13, -35.28, "ACT"),
  P("Hobart", 147.33, -42.88, "Tasmania"), P("Darwin", 130.84, -12.46, "Northern Territory"), P("Gold Coast", 153.4, -28.0, "Queensland"),
  P("Newcastle", 151.78, -32.93, "New South Wales"), P("Wollongong", 150.89, -34.42, "New South Wales"), P("Geelong", 144.36, -38.15, "Victoria"),
  P("Townsville", 146.82, -19.26, "Queensland"), P("Cairns", 145.77, -16.92, "Queensland"), P("Sunshine Coast", 153.07, -26.65, "Queensland"),
  P("Toowoomba", 151.95, -27.56, "Queensland"), P("Ballarat", 143.85, -37.56, "Victoria"), P("Launceston", 147.14, -41.43, "Tasmania"),
  P("Parramatta", 151.0, -33.82, "New South Wales"), P("North Sydney", 151.21, -33.84, "New South Wales"),
];
const REGIONS: Place[] = [
  P("New South Wales", 147.0, -32.5, "New South Wales"), P("NSW", 147.0, -32.5, "New South Wales"), P("Victoria", 144.5, -36.9, "Victoria"), P("VIC", 144.5, -36.9, "Victoria"),
  P("Queensland", 144.5, -22.5, "Queensland"), P("QLD", 144.5, -22.5, "Queensland"), P("Western Australia", 122.0, -26.0, "Western Australia"), P("WA", 122.0, -26.0, "Western Australia"),
  P("South Australia", 135.5, -30.0, "South Australia"), P("SA", 135.5, -30.0, "South Australia"), P("Tasmania", 146.6, -42.0, "Tasmania"), P("TAS", 146.6, -42.0, "Tasmania"),
  P("Northern Territory", 133.5, -19.5, "Northern Territory"), P("NT", 133.5, -19.5, "Northern Territory"), P("ACT", 149.13, -35.28, "ACT"), P("Australia", 134.0, -25.5, "Australia"),
];

const key = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

/** A known Australian place by city, else by region (state, territory or "Australia"); null when neither is known. */
export function findPlace(city: string, region?: string): Place | null {
  const c = key(city);
  const hit = PLACES.find((p) => key(p.name) === c) ?? PLACES.find((p) => c.startsWith(key(p.name)));
  if (hit) return hit;
  for (const r of [city, region ?? ""]) {
    const k = key(r);
    const reg = REGIONS.find((p) => key(p.name) === k);
    if (reg) return reg;
  }
  return null;
}
