import type { AccessRequestView, AgencyRecordView, ApprovalView, FieldDef, JobRecord, LearnItem, LearnTopic, LockableDir, SettingsKind } from "@careeros/contract";

export type ApprovalRecord = Omit<ApprovalView, "digest" | "from_app">;

export interface FixtureJob {
  job: JobRecord;
  company: { name: string; slug: string; website: string; sponsor_status: string };
  description: string;
  interview: LearnItem[];
}
export interface FixtureCompany { name: string; slug: string; sponsor: { status: string; evidence: { date: string; note: string; url: string }[]; last_checked: string } }
export interface Fixture {
  workspace: { root: string; name: string; dataVersion: number; locked: LockableDir[] };
  profile: Record<string, unknown>;
  search: Record<string, unknown>;
  integrations: Record<string, unknown>;
  fields: Record<SettingsKind, FieldDef[]>;
  jobs: FixtureJob[];
  companies: FixtureCompany[];
  employers: Record<string, unknown>[];
  searches: { at: string; site: string; query: string; location: string; results: string; kept: string; notes: string }[];
  /** `recaps` is optional so older fixtures still load. */
  learning: { topics: LearnTopic[]; recaps?: LearnItem[] };
  /** Workspace-relative path -> text, for files.readText. */
  texts: Record<string, string>;
  /** Approval records as on disk: the bridge adds `digest` and `from_app` when it hands them out. */
  approvals: ApprovalRecord[];
  requests: AccessRequestView[];
  /** Recruitment agencies (recruiters/<slug>/agency.json). Optional so older fixtures still load. */
  agencies?: AgencyRecordView[];
}
