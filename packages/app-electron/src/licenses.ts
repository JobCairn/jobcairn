import path from "node:path";

/**
 * The third-party licence texts (repo `licenses/`), shipped as Resources/licenses (builder-config RESOURCES.licenses).
 * In development: the repo's own folder.
 */
export function licensesDir(o: { packaged: boolean; resourcesPath: string; here: string }): string {
  return o.packaged ? path.join(o.resourcesPath, "licenses") : path.resolve(o.here, "..", "..", "..", "licenses");
}
