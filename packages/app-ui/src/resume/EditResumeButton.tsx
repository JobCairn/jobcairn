import { Button, Icons } from "@careeros/brand";
import type { JobFile } from "@careeros/contract";
import { navigate } from "../router";

/** "Edit resume": opens the Resume Studio when the job has application/resume.md. One-line hook for Apply and Job. */
export function EditResumeButton({ slug, id, files, size = "sm", variant = "secondary" }: { slug: string; id: string; files: Pick<JobFile, "path" | "exists">[]; size?: "sm" | "md"; variant?: "primary" | "secondary" }) {
  if (!files.some((f) => f.path === "application/resume.md" && f.exists !== false)) return null;
  return <Button size={size} variant={variant} icon={Icons.file} onClick={() => navigate({ screen: "resume", slug, id, file: "resume.md" })}>Edit resume</Button>;
}
