import { Button, Card, Icons, Pill, Text } from "@careeros/brand";
import { useAction, useBridge, useLoad } from "../bridge-context";
import { fmtDay, parseDay } from "../reading/dates";

/**
 * Settings › Connections › LinkedIn connections: the person picks Connections.csv from LinkedIn's own data export.
 * The app keeps the names, companies and positions on this computer to show "People you know here" on job and
 * company pages. Nothing is looked up online or sent to Claude.
 */
export function LinkedInImport() {
  const bridge = useBridge();
  const { busy, run } = useAction();
  const st = useLoad((b) => b.network.status(), [], ["settings"]);
  const s = st.data;
  const pick = () => run("linkedin-import", async () => {
    const p = await bridge.files.pick();
    if (!p) return;
    const r = await bridge.network.importLinkedIn(p);
    st.reload();
    return r;
  }, "LinkedIn connections imported");
  const forget = () => run("linkedin-forget", async () => { await bridge.network.forget(); st.reload(); }, "LinkedIn connections removed from this computer");
  const day = s?.imported_at ? parseDay(s.imported_at) : null;
  return (
    <Card className="stack" id="settings-linkedin" aria-label="LinkedIn connections">
      <div className="row row--between">
        <Text role="heading-2" as="h3">LinkedIn connections</Text>
        {s?.count ? <Pill tone="success">{`${s.count.toLocaleString("en-AU")} imported`}</Pill> : <Pill tone="neutral">Not imported</Pill>}
      </div>
      <Text role="body-sm" muted>
        See who you already know at a company, so you can ask for a referral. In LinkedIn, go to Settings › Data privacy › Get a copy of your data,
        choose Connections, and pick the Connections.csv file it sends you. It stays on this computer and is never sent to Claude.
      </Text>
      {s?.count ? <Text role="body-sm" muted>{`From ${s.file || "your export"}${day ? `, ${fmtDay(day)}` : ""}.`}</Text> : null}
      <div className="row">
        <Button size="sm" icon={Icons.attach} loading={busy === "linkedin-import"} onClick={() => void pick()}>{s?.count ? "Import again" : "Import LinkedIn"}</Button>
        {s?.count ? <Button size="sm" variant="ghost" loading={busy === "linkedin-forget"} onClick={() => void forget()}>Remove</Button> : null}
      </div>
    </Card>
  );
}
