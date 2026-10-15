import { useEffect } from "react";
import { Button, Text, SectionTitle, Icons } from "@careeros/brand";
import { useAction, useBridge, useLoad } from "../bridge-context";
import { JourneyVideos } from "./JourneyVideos";
import { setTourProgress, useTourStore } from "./store";

/** Settings › Appearance › Help: replay every page's tour, stop them starting by themselves, and the guide videos. */
export function TourSettings() {
  const bridge = useBridge();
  const { progress } = useTourStore();
  const loaded = useLoad((b) => b.tour.state(), [], ["workspace"]);
  useEffect(() => { if (loaded.data) setTourProgress(loaded.data); }, [loaded.data]);
  const { busy, run } = useAction();
  const st = progress ?? loaded.data;
  if (!st) return null;

  const replay = () => void run("tour-replay", () => bridge.tour.replayAll().then(setTourProgress),
    "Tours are back. Each page will show you around the next time you open it.");
  const setOff = (off: boolean) => void run("tour-off", () => bridge.tour.setOff(off).then(setTourProgress),
    off ? "Tour tips are off. The help button (?) in the sidebar still shows you around any page." : "Tour tips are back on.");

  return (
    <section className="stack tour-help-section" aria-labelledby="tour-help-title">
      <SectionTitle icon={Icons.help} title="Help" id="tour-help-title" />
      <div className="row row--between tour-setting">
        <div className="stack">
          <Text role="body" className="t-strong">Tours</Text>
          <Text role="body-sm" muted>
            {st.off ? "Tour tips are off. Use the help button (?) at the foot of the sidebar whenever you like." : "Short walkthroughs of each page. The help button (?) at the foot of the sidebar starts one any time."}
          </Text>
        </div>
        <div className="tour-setting__actions">
          <Button size="sm" loading={busy === "tour-replay"} onClick={replay}>Replay tours</Button>
          {st.off
            ? <Button size="sm" variant="ghost" loading={busy === "tour-off"} title="Turn tour tips back on" onClick={() => setOff(false)}>Tips on</Button>
            : <Button size="sm" variant="ghost" loading={busy === "tour-off"} title="Turn off tour tips" onClick={() => setOff(true)}>Tips off</Button>}
        </div>
      </div>
      <JourneyVideos variant="settings" />
    </section>
  );
}
