import { useMemo, useState } from "react";
import { ToastProvider } from "@careeros/brand";
import type { CareerosBridge } from "@careeros/contract";
import { BridgeProvider, useLoad } from "./bridge-context";
import { Loading } from "./components/States";
import { ScreenBoundary } from "./components/ScreenBoundary";
import { navigate, toHash, useRoute } from "./router";
import { ExampleBanner } from "./onboarding/ExampleBanner";
import { isExample } from "./onboarding/folder";
import { OnboardingScreen, SCREENS } from "./screens/registry";
import { Shell } from "./Shell";
import { NavMemory } from "./nav";
import { PlayerProvider } from "./listen";
import { ThemeProvider } from "./theme";
import { WorkspaceFlowProvider, type WorkspaceFlow } from "./workspaces/context";
import { MailRecheckPrompt } from "./mail/Recheck";

function Gate() {
  const ws = useLoad((b) => b.workspace.current(), [], ["workspace"]);
  const route = useRoute();
  // While setup runs, the workspace already exists but the remaining steps must stay on screen.
  const [setup, setSetup] = useState(false);
  // "Start a new one" from the workspace switcher: the setup page for a new workspace, over the open one.
  const [adding, setAdding] = useState(false);
  // Bumped on every switch, so every screen (and the reading player) starts afresh: nothing from the last
  // workspace stays in memory.
  const [generation, setGeneration] = useState(0);
  const flow = useMemo<WorkspaceFlow>(() => ({
    startNew: () => setAdding(true),
    switched: () => { navigate({ screen: "home" }); setGeneration((g) => g + 1); ws.reload(); },
  }), [ws.reload]);
  if (ws.loading && ws.data === undefined) return <div className="app-loading"><Loading /></div>;
  // Setup always lands on Home, whatever screen was open before (for example after leaving the example).
  const done = () => { setSetup(false); setAdding(false); navigate({ screen: "home" }); setGeneration((g) => g + 1); ws.reload(); };
  if (!ws.data || setup || adding) {
    return <OnboardingScreen mode={adding ? "new" : "first"} onCancel={() => setAdding(false)} onCreated={() => setSetup(true)} onDone={done} />;
  }
  const Screen = SCREENS[route.screen];
  return (
    <WorkspaceFlowProvider value={flow}>
      <PlayerProvider key={`${generation}:${ws.data.root}`}>
        <Shell route={route}><NavMemory route={route} generation={generation} /><MailRecheckPrompt />{isExample(ws.data) ? <ExampleBanner /> : null}<ScreenBoundary resetKey={toHash(route)}><Screen route={route} /></ScreenBoundary></Shell>
      </PlayerProvider>
    </WorkspaceFlowProvider>
  );
}

export function App({ bridge }: { bridge: CareerosBridge }) {
  return (
    <BridgeProvider bridge={bridge}>
      <ThemeProvider>
        <ToastProvider><Gate /></ToastProvider>
      </ThemeProvider>
    </BridgeProvider>
  );
}
