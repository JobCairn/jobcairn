import { Button, Card, Icons, Text, useToast } from "@careeros/brand";
import { referralTemplate, type DraftInput, type NetworkPerson } from "@careeros/contract";
import { useBridge, useLoad } from "../bridge-context";
import { EMPTY_DRAFT } from "../components/DraftEditor";
import { navigate } from "../router";
import { copyText } from "./copy";
import "./outreach.css";

const fullName = (p: NetworkPerson) => [p.first, p.last].filter(Boolean).join(" ");

/**
 * "People you know here": the person's own LinkedIn connections whose company matches this one, each with an
 * "Ask for a referral" draft. With `onMail` (a job page) it opens a Mail draft; otherwise the text is copied to paste
 * into a LinkedIn message. Nothing is sent from here.
 */
export function PeopleYouKnow({ company, title, onMail }: { company: string; title?: string; onMail?: (d: DraftInput) => void }) {
  const bridge = useBridge();
  const toast = useToast();
  const st = useLoad((b) => b.network.status(), [], ["settings"]);
  const people = useLoad((b) => (company.trim() ? b.network.people(company.trim()) : Promise.resolve([])), [company], ["settings"]);
  if (!st.data) return null;
  const job = { title: title || "open", company };
  const copy = async (p: NetworkPerson) => {
    const t = referralTemplate(p, job);
    toast(await copyText(t.body) ? { tone: "success", text: `Referral request for ${p.first || fullName(p)} copied. Paste it into a LinkedIn message.` } : { tone: "danger", text: "Couldn't copy the text." });
  };
  return (
    <Card className="stack" aria-label="People you know here">
      <Text role="heading-2" as="h3">People you know here</Text>
      {!st.data.count ? (
        <div className="row">
          <Text role="body-sm" muted>Import your LinkedIn connections to see who you already know at {company}.</Text>
          <Button size="sm" variant="ghost" onClick={() => navigate({ screen: "settings", tab: "connections", section: "linkedin" })}>Import connections</Button>
        </div>
      ) : !people.data?.length ? (
        <Text role="body-sm" muted>{people.data ? `None of your LinkedIn connections list ${company} as their company.` : people.error ? "Your connections can't be read right now." : "Checking your connections…"}</Text>
      ) : (
        <>
          <Text role="body-sm" muted>A referral from someone who knows you is one of the best ways in. Ask plainly, and make it easy to say no.</Text>
          <ul className="outreach__people">
            {people.data.map((p, i) => (
              <li key={`${fullName(p)}-${i}`} className="row row--between">
                <span className="grow">
                  <Text role="body" as="div">{p.url ? <a href={p.url} onClick={(e) => { e.preventDefault(); void bridge.links.open(p.url); }}>{fullName(p)}</a> : fullName(p)}</Text>
                  {p.position ? <Text role="body-sm" muted as="div">{p.position}</Text> : null}
                </span>
                <span className="row">
                  {onMail ? (
                    <Button size="sm" icon={Icons.mail} aria-label={`Ask ${fullName(p)} for a referral`}
                      onClick={() => onMail({ ...EMPTY_DRAFT, ...referralTemplate(p, job), to: p.email })}>Ask</Button>
                  ) : null}
                  <Button size="sm" variant="ghost" aria-label={`Copy a referral request for ${fullName(p)}`} onClick={() => void copy(p)}>Copy</Button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
