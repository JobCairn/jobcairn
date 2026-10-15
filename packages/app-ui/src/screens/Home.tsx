import { useState } from "react";
import { Button, Card, Icons, Text } from "@careeros/brand";
import { AddJobDialog } from "../addjob/AddJobDialog";
import { useLoad } from "../bridge-context";
import { ActionButton, WORKSPACE } from "../components/ActionButton";
import { ErrorState, Loading } from "../components/States";
import { firstName, greeting } from "../format";
import { GettingStarted } from "../guide";
import { ResumeFillNotice } from "../resumefill";
import { FunnelCard, NextUpCard, SalaryCard, SourcesCard, StaleCard, TodayCard } from "../home/cards";
import { PayBenchmarkCard } from "../jobs/PayBenchmark";
import { OpportunityMap, SponsorshipMix, WeeklyActivity } from "../home/charts";
import "../home/home.css";
import { JustFinished } from "../home/JustFinished";
import { PageSettings } from "../components/PageSettings";

/**
 * Action-first dashboard: what to do today, then how the search is going. Every number comes from home.summary.
 * Sponsorship cards follow the candidate's work rights (candidate.ts): the mix and 482 bands for people who need
 * sponsorship, the mix as plain info on a temporary visa, and nothing about sponsorship for everyone else.
 */
export function HomeScreen() {
  const [adding, setAdding] = useState(false);
  const { data: h, error } = useLoad((b) => b.home.summary(), [], ["home", "jobs", "inbox", "approvals", "privacy", "settings", "searches", "mail"]);
  if (error && !h) return <ErrorState title="Home can't load" text={error} />;
  if (!h) return <Loading />;
  const a = h.analytics;
  const focus = a.sponsorship;
  const empty = h.total === 0;

  return (
    <>
      <header className="screen-head">
        <Text role="display">{greeting(new Date())}, <em>{firstName(h.name)}.</em></Text>
        <div className="screen-head__actions">
          {focus === "off" ? null : (
            <div className="home-visa" data-tour="home-visa">
              {h.visaDaysLeft === null ? <Text role="body" muted>No visa date set</Text> : (
                <><Text role="hero" as="div" className="num">{h.visaDaysLeft}</Text><Text role="label" as="div">days left on visa</Text></>
              )}
            </div>
          )}
          <Button icon={Icons.add} data-tour="home-add-job" onClick={() => setAdding(true)}>Add job</Button>
          <PageSettings page="home" />
        </div>
      </header>

      <AddJobDialog open={adding} onClose={() => setAdding(false)} />
      <ResumeFillNotice />
      <GettingStarted compact setup />

      <div className={`home-grid${empty ? " home-grid--empty" : ""}`}>
        <div className="home-col">
          <TodayCard h={h} />
          <JustFinished />
          {empty ? null : <FunnelCard f={a.funnel} />}
          <NextUpCard jobs={a.nextUp} total={a.nextUpTotal} focus={focus} />
          {empty ? null : <WeeklyActivity weeks={a.weekly} goal={a.weeklyGoal} />}
        </div>
        <div className="home-col">
          {empty ? null : (
            <>
              {focus === "off" ? null : <SponsorshipMix mix={a.mix} plain={focus === "secondary"} />}
              <OpportunityMap map={a.map} sponsorship={focus !== "off"} />
              {focus === "primary" ? <SalaryCard s={a.salary} /> : null}
              <StaleCard jobs={a.stale} />
              <PayBenchmarkCard rows={h.salaryBenchmarks} />
              <SourcesCard rows={a.sources} />
              <Card aria-label="Weekly recap" className="stack">
                <Text role="heading-2">Weekly recap</Text>
                <Text role="body-sm" muted>A short narrated video of this week: jobs found, applications, replies and what&apos;s next.</Text>
                <div><ActionButton action="weekly_recap_video" target={WORKSPACE} /></div>
              </Card>
            </>
          )}
        </div>
      </div>
    </>
  );
}
