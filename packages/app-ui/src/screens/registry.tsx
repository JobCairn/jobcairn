import type { JSX } from "react";
import type { Route, ScreenName } from "../router";
import { ApplicationsScreen } from "./Applications";
import { ApplyScreen } from "./Apply";
import { ApprovalsScreen } from "./Approvals";
import { CompaniesScreen } from "./Companies";
import { CompanyScreen } from "./Company";
import { RecruiterScreen } from "./Recruiter";
import { RecruitersScreen } from "./Recruiters";
import { HomeScreen } from "./Home";
import { InboxScreen } from "./Inbox";
import { JobScreen } from "./Job";
import { JobsScreen } from "./Jobs";
import { LearnScreen } from "./Learn";
import { ResearchScreen } from "./Research";
import { MailScreen } from "./Mail";
import { PrivacyScreen } from "./Privacy";
import { ResumeStudioScreen } from "./ResumeStudio";
import { ResumesScreen } from "./Resumes";
import { SearchesScreen } from "./Searches";
import { SettingsScreen } from "./Settings";
import { VideoScreen } from "./Video";
import { VideosScreen } from "./Videos";

export { OnboardingScreen } from "./Onboarding";

export const SCREENS: Record<ScreenName, (p: { route: Route }) => JSX.Element> = {
  home: HomeScreen, jobs: JobsScreen, job: JobScreen, apply: ApplyScreen, resume: ResumeStudioScreen, "resume-variant": ResumeStudioScreen, resumes: ResumesScreen, applications: ApplicationsScreen, inbox: InboxScreen, learn: LearnScreen, research: ResearchScreen, mail: MailScreen,
  companies: CompaniesScreen, company: CompanyScreen, recruiters: RecruitersScreen, recruiter: RecruiterScreen, searches: SearchesScreen, settings: SettingsScreen, privacy: PrivacyScreen, approvals: ApprovalsScreen, video: VideoScreen, videos: VideosScreen,
};
