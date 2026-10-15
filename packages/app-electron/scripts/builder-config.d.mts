export interface Resource { from: string; to: string }
export const RESOURCES: { plugin: Resource; guides: Resource; example: Resource; setupRunner: Resource; setupComponents: Resource; licenses: Resource };
export const ASAR_UNPACK: string[];
export const FONT_PACKAGES: string[];
export const RUNTIME_MODULES_DIR: string;
export const MAC_ENTITLEMENTS: string;
export const PUBLISH: { provider: "github"; owner: string; repo: string };
export function notarizeMode(env?: Record<string, string | undefined>): "apple-id" | "api-key" | "keychain-profile" | null;
export function runtimeRequires(code: string): string[];
export function builderConfig(o: {
  identity: { internalId: string; name: string; shortName: string; tagline: string; appId: string };
  electronVersion: string;
  env?: Record<string, string | undefined>;
  pkgDir?: string;
  appDir?: string;
  output?: string;
  icons?: { icns?: string; png?: string };
  runtimeModules?: string;
}): Record<string, any>;
