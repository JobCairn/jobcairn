import type { JobRecord, SponsorshipFocus } from "@careeros/contract";
import { SponsorCell, sponsorReasons } from "./cells/cells";

/**
 * Job › Description: the sponsor estimate with its top reasons, for someone sponsorship matters to.
 * The same reasons as the Sponsor chip's tooltip on the Jobs list.
 */
export function JobSponsor({ job, focus }: { job: JobRecord; focus: SponsorshipFocus }) {
  // Same gate as the Score tab: reasons are for someone who needs sponsorship.
  if (focus !== "primary") return null;
  const sp = job.scores.sponsor;
  const reasons = sponsorReasons(sp.reasons);
  if (sp.value === null && job.work_rights.label !== "sponsorship_offered" && !reasons.length) return null;
  return (
    <section className="job-sponsor" aria-labelledby="job-sponsor-h">
      <div className="job-sponsor__head">
        <h2 id="job-sponsor-h" className="job-sponsor__h">Sponsorship</h2>
        <SponsorCell score={sp.value} label={job.work_rights.label} reasons={reasons} />
      </div>
      {reasons.length
        ? <ul className="job-sponsor__reasons" aria-label="Why">{reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
        : <p className="job-sponsor__none">No reasons were saved with this score. The company's page has its evidence.</p>}
    </section>
  );
}
