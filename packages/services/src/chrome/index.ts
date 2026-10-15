import type { BoardId } from "@careeros/contract";
import type { ServiceContext } from "../context.js";
import type { HandlerTable } from "../handlers.js";
import { chromeFor } from "./service.js";
import { withInstallLock } from "../install-lock.js";

export { chromeFor, browserRequest, ChromeSearch, COPY as CHROME_COPY, type ChromeHost } from "./service.js";
export { BOARDS, boardForUrl, signInState, readControls, landingPage, cleanBoards } from "./boards.js";
export { BrowserRun, CAPS as BROWSER_CAPS, fileControl, type ControlChannel, type BrowserDeps } from "./session.js";
export { clickRefusal, fillRefusal, findRef, needsPerson } from "./guard.js";
export { localStatePath, readChromeProfiles, parseLocalState, chromeLaunch, openVerifiedTab, profileMatches, spawnLaunch, type VerifyDiag, type ChromeProfile, type Launch } from "./profile.js";
export { BrowserHelper, SESSION as BROWSER_SESSION, REMOTE_PORT, HELPER_VERSION } from "./helper.js";

/** Search in my Chrome (lane S). */
export const chromeHandlers = {
  "chrome.state": (ctx: ServiceContext, recheck: boolean) => chromeFor(ctx).state(recheck),
  "chrome.install": (ctx: ServiceContext) => withInstallLock(ctx, "browser-helper", "The browser helper", () => chromeFor(ctx).install()),
  "chrome.openRemote": (ctx: ServiceContext) => chromeFor(ctx).openRemote(),
  "chrome.connect": (ctx: ServiceContext) => chromeFor(ctx).connect(),
  "chrome.showBoard": (ctx: ServiceContext, board: BoardId) => chromeFor(ctx).showBoard(board),
  "chrome.openHome": (ctx: ServiceContext, board: BoardId) => chromeFor(ctx).openHome(board),
  "chrome.confirmSignIn": (ctx: ServiceContext, board: BoardId) => chromeFor(ctx).confirmSignIn(board),
  "chrome.setProfile": (ctx: ServiceContext, dir: string) => chromeFor(ctx).setProfile(dir),
  "chrome.removeHelper": (ctx: ServiceContext) => chromeFor(ctx).removeHelper(),
  "chrome.finish": (ctx: ServiceContext, boards: BoardId[]) => chromeFor(ctx).finish(boards),
  "chrome.setBoards": (ctx: ServiceContext, boards: BoardId[]) => chromeFor(ctx).setBoards(boards),
  "chrome.turnOff": (ctx: ServiceContext) => chromeFor(ctx).turnOff(),
  "chrome.runBoards": (ctx: ServiceContext, boards: BoardId[]) => { chromeFor(ctx).runBoards(boards); },
  "chrome.progress": (ctx: ServiceContext) => chromeFor(ctx).progress(),
  "chrome.answer": (ctx: ServiceContext, board: BoardId, answer: "continue" | "skip") => chromeFor(ctx).answer(board, answer),
} satisfies Partial<HandlerTable>;
export { chromeCli, cliScript, installChromeCli, readCliConfig, readCliRun, CLI_NAME, CLI_REL, CHROME_CONFIG_REL, CHROME_RUN_REL, type ChromeCliConfig, type ChromeCliRun } from "./cli.js";
