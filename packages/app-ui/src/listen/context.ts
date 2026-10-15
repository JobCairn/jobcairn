import { createContext, useContext } from "react";

/**
 * One spoken chunk and the index of the rendered block it highlights (-1: nothing to highlight). A chunk joined from
 * several short blocks lists where each block's words start (`from`, 0..1 of the text), so the highlight can move
 * along with the voice.
 */
export interface ListenChunk { text: string; block: number; parts?: { block: number; from: number }[] }
export interface StartRequest {
  /** Identifies what is being read, so its Listen button can show the playing state. */
  key: string;
  title: string;
  chunks: ListenChunk[];
  /** Workspace file the text came from, or "" (the services check locks with it). */
  source: string;
  /** Element id of the rendered text, for the paragraph highlight, or null. */
  targetId: string | null;
}
export type ListenStatus = "idle" | "preparing" | "playing" | "paused" | "error";
export interface PlayerView {
  status: ListenStatus; key: string | null; title: string; index: number; total: number; speed: number;
  error: string | null;
  /** Shown when the voice isn't the one chosen (Supertonic missing or warming up, the Mac voice chosen). */
  note: string | null;
  /** Why it is taking a while, once a wait passes two seconds; null otherwise. */
  wait: string | null;
  /** The person chose the Mac voice for this reading. */
  macVoice: boolean;
}
export interface PlayerApi {
  view: PlayerView;
  start(req: StartRequest): void;
  toggle(): void;
  next(): void;
  prev(): void;
  stop(): void;
  setSpeed(speed: number): void;
  /** Reads the rest with the Mac's own voice (quick to start), for when the natural voice is slow or failing. */
  switchToMac(): void;
  /** The audio factory, shared with the voice previews in Settings. */
  createAudio: () => AudioLike;
}

/** The part of HTMLAudioElement the player uses (a fake stands in for it in tests). */
export interface AudioLike {
  src: string;
  playbackRate: number;
  defaultPlaybackRate: number;
  preservesPitch?: boolean;
  currentTime?: number;
  duration?: number;
  preload?: string;
  play(): Promise<void> | void;
  pause(): void;
  load?(): void;
  addEventListener(type: "ended" | "error" | "timeupdate", cb: () => void): void;
  removeAttribute?(name: string): void;
}

export const ListenCtx = createContext<PlayerApi | null>(null);
/** The read-aloud player, or null outside a PlayerProvider (Listen buttons then render nothing). */
export function useListenPlayer(): PlayerApi | null { return useContext(ListenCtx); }

