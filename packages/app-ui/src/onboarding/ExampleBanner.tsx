import { Button } from "@careeros/brand";
import { useAction, useBridge } from "../bridge-context";
import { requestStartOwn } from "./folder";
import "./onboarding.css";

/** Shown across the app while the made-up example is open, so nobody mistakes it for their own job search. */
export function ExampleBanner() {
  const bridge = useBridge();
  const { busy, run } = useAction();
  const leave = (startOwn: boolean) => run(startOwn ? "start-own" : "leave", async () => {
    if (startOwn) requestStartOwn();
    await bridge.workspace.close();
  });
  return (
    <section className="example-banner" aria-label="Example job search">
      <p className="example-banner__text">You're exploring an example job search. Nothing here is real.</p>
      <div className="example-banner__actions">
        <Button size="sm" variant="ghost" loading={busy === "leave"} disabled={!!busy} onClick={() => void leave(false)}>Leave example</Button>
        <Button size="sm" variant="primary" loading={busy === "start-own"} disabled={!!busy} title="Leave the example and start your own" onClick={() => void leave(true)}>Start fresh</Button>
      </div>
    </section>
  );
}
