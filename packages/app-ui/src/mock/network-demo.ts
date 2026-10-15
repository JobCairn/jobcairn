import { parseLinkedInConnections, peopleAt, type NetworkPerson, type NetworkStatus } from "@careeros/contract";

/** A fictional LinkedIn Connections.csv for the preview and tests (same shape as LinkedIn's export, Notes preamble included). */
export const DEMO_CONNECTIONS_CSV = [
  "Notes:",
  "\"When exporting your connection data, you may notice that some of the email addresses are missing.\"",
  "",
  "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
  "Sam,Sample,https://www.linkedin.com/in/sam-sample,,Acme Corp,Engineering Manager,14 Jan 2026",
  "Jo,Placeholder,https://www.linkedin.com/in/jo-placeholder,,Example Labs Pty Ltd,Recruiter,02 Feb 2025",
].join("\n");

/** The mock's referral finder: one in-memory list, imported from `csv` (the picked file's text stands in for the file). */
export class MockNetwork {
  people: NetworkPerson[] = [];
  status: NetworkStatus = { count: 0, imported_at: "", file: "" };
  constructor(public csv: string = DEMO_CONNECTIONS_CSV) {}
  import(path: string, now: string): NetworkStatus {
    if (!/\.csv$/i.test(path)) throw new Error(`"${path.split(/[\\/]/).pop()}" isn't a CSV file. Pick Connections.csv from your LinkedIn data export.`);
    this.people = parseLinkedInConnections(this.csv);
    this.status = { count: this.people.length, imported_at: now, file: path.split(/[\\/]/).pop() ?? "" };
    return this.status;
  }
  at(company: string): NetworkPerson[] { return peopleAt(this.people, [company]); }
  forget(): NetworkStatus { this.people = []; this.status = { count: 0, imported_at: "", file: "" }; return this.status; }
}
