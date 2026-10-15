import { Card, Icons, SectionTitle, Text } from "@careeros/brand";
import { ANNUALISE, BENCHMARK_MIN_ADS, type JobDetail, type SalaryBenchmarkRow } from "@careeros/contract";
import "./extras.css";

/** "$128k" */
export const kAud = (n: number) => `$${Math.round(n / 1_000).toLocaleString("en-AU")}k`;
const HOW = `Yearly base pay from the ads you've saved that state it: the middle of a range, day rates × ${ANNUALISE.day} and hourly rates × ${ANNUALISE.hour.toLocaleString("en-AU")}, super taken out of packages. Needs ${BENCHMARK_MIN_ADS} or more similar ads.`;

/** The job's stated pay with how it compares to similar saved ads ("Above the median of 14 similar ads you've saved"). */
export function PayBenchmark({ d }: { d: Pick<JobDetail, "job" | "salaryBenchmark"> }) {
  const pay = d.job.salary.text.trim();
  const b = d.salaryBenchmark;
  if (!pay) return null;
  return (
    <p className="pay-line">
      <span className="pay-line__label">Pay</span>
      <span>{pay}</span>
      {b ? (
        <span className={`pay-line__bench pay-line__bench--${b.position}`} title={`${b.label} in ${b.city}: middle half ${kAud(b.p25)} to ${kAud(b.p75)}, median ${kAud(b.p50)}. This ad works out at about ${kAud(b.pay)} a year. ${HOW}`}>
          {b.text}
        </span>
      ) : null}
    </p>
  );
}

/** Home: pay percentiles by role and city from the saved ads. Hidden until one bucket has enough ads. */
export function PayBenchmarkCard({ rows }: { rows: SalaryBenchmarkRow[] | undefined }) {
  if (!rows?.length) return null;
  const shown = rows.slice(0, 8);
  return (
    <Card aria-label="Pay in your saved ads" className="home-card">
      <div className="home-card__head">
        <SectionTitle icon={Icons.salary} title="Pay in your saved ads" />
        <Text role="body-sm" muted>{HOW}</Text>
      </div>
      <table className="bench-table">
        <caption className="sr-only">Pay percentiles by role and city</caption>
        <thead><tr><th scope="col">Role</th><th scope="col">City</th><th scope="col" className="num">Ads</th><th scope="col" className="num">25th</th><th scope="col" className="num">Median</th><th scope="col" className="num">75th</th></tr></thead>
        <tbody>
          {shown.map((r) => (
            <tr key={`${r.family}|${r.city}`}>
              <th scope="row">{r.label}</th><td>{r.city}</td><td className="num">{r.count}</td>
              <td className="num">{kAud(r.p25)}</td><td className="num">{kAud(r.p50)}</td><td className="num">{kAud(r.p75)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
