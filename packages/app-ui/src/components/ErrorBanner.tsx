import { Button } from "@careeros/brand";
import { navigate } from "../router";
import { ErrorState } from "./States";

/** Turns a raw error string into a sentence: capitalised, with no trailing "..". */
export function errorSentence(e: string): string {
  const trimmed = e.trim().replace(/\.+$/, "");
  if (!trimmed) return "Something went wrong";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * Shared "this job can't be shown" banner: used both for a job that fails to load at all,
 * and inline (alongside stale data) when a job that was open gets deleted or edited by hand.
 */
export function JobErrorBanner({ error }: { error: string }) {
  return (
    <ErrorState title="This job can't be shown"
      text={`${errorSentence(error)}. The job file may have been moved, deleted or edited by hand. Run "careeros validate" to see what is wrong.`}
      action={<Button onClick={() => navigate({ screen: "jobs" })}>Open Jobs</Button>} />
  );
}
