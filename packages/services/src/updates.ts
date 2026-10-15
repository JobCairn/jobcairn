import type { UpdateView } from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";

/**
 * In-app updates (app.updates.*). Main owns the updater (`host.updates`); the services add this app's version and the
 * person's "check automatically" choice, kept per computer in the app state (`autoUpdate`, on unless turned off).
 * Without `host.updates` (development, tests) the view says unsupported and nothing is ever checked.
 */
export function updateView(ctx: ServiceContext): UpdateView {
  const u = ctx.host.updates;
  return {
    current: ctx.host.info.version,
    supported: !!u?.supported,
    auto: autoUpdates(ctx),
    status: u ? u.status() : { kind: "idle" },
  };
}

export function autoUpdates(ctx: ServiceContext): boolean {
  return ctx.host.state.read().autoUpdate !== false;
}

async function check(ctx: ServiceContext): Promise<UpdateView> {
  const u = ctx.host.updates;
  if (!u?.supported) throw new Error("Updates work in the installed app. Download the newest version from GitHub instead.");
  await u.check();
  return updateView(ctx);
}

function install(ctx: ServiceContext): void {
  const u = ctx.host.updates;
  if (u?.status().kind !== "ready") throw new Error("There's no downloaded update to install yet.");
  u.install();
}

function setAuto(ctx: ServiceContext, on: boolean): UpdateView {
  ctx.host.state.write({ ...ctx.host.state.read(), autoUpdate: on });
  ctx.host.updates?.setAuto(on);
  return updateView(ctx);
}

export const updateHandlers = {
  "app.updates.state": updateView,
  "app.updates.check": check,
  "app.updates.install": install,
  "app.updates.setAuto": setAuto,
} satisfies Partial<HandlerTable>;
