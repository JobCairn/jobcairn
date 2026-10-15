export const CALL = "careeros:call";
export const CHANGE = "careeros:change";

/**
 * The careeros-file: URL for a workspace-relative path. Each segment is encoded exactly once with
 * encodeURIComponent; `fileUrlToRel` in security.ts decodes exactly once. Shared by the preload and the tests.
 */
export const fileUrlFor = (rel: string): string => `careeros-file://ws/${rel.split("/").map(encodeURIComponent).join("/")}`;
