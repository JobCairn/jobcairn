export interface BundleIdentity { internalId: string; name: string; shortName: string; appId: string }
export function xmlEscape(s: string): string;
export function patchPlistXml(xml: string, values: Record<string, string>): string;
export function appleEventsWhy(name: string): string;
export function devPlistValues(identity: BundleIdentity, iconFile: string): Record<string, string>;
export function icnsFromPngs(pngs: Record<number, Buffer>): Buffer;
export function devBundlePath(pkgDir: string, identity: BundleIdentity): string;
export function devStamp(o: { electronVersion: string; identity: BundleIdentity; iconHash?: string | null }): string;
export function needsRebuild(existingStamp: string | null, wanted: string): boolean;
