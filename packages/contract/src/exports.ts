export const EXPORT_SOURCES = ["resume", "cover-letter"] as const;
export type ExportSource = (typeof EXPORT_SOURCES)[number];
export const EXPORT_FORMATS = ["pdf", "docx"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const EXPORT_SOURCE_TEXT: Record<ExportSource, string> = { resume: "Resume", "cover-letter": "Cover letter" };

export interface ExportSourceView { source: ExportSource; path: string; exists: boolean }
/** `problem`: something other than a plain file sits at this name (a folder or a link), so export refuses until it is moved. */
export interface ExportFileView { source: ExportSource; format: ExportFormat; name: string; path: string; exists: boolean; size: number | null; at: string; problem: string | null }
export interface ExportState { sources: ExportSourceView[]; files: ExportFileView[] }

const jobDir = (slug: string, id: string) => `companies/${slug}/jobs/${id}`;
/** The Markdown Claude writes (Task 36, tailor_application). */
export const exportSourceRel = (slug: string, id: string, source: ExportSource) => `${jobDir(slug, id)}/application/${source}.md`;
/** Where the export lands. */
export const exportRel = (slug: string, id: string, source: ExportSource, format: ExportFormat) => `${jobDir(slug, id)}/application/export/${source}.${format}`;
