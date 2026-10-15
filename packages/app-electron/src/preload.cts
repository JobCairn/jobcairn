// Runs in the sandboxed preload. Exposes exactly one object; no Node or Electron APIs reach the page.
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import { mailUrlFor, type ChangeEvent, type Transport } from "@careeros/contract";
import { CALL, CHANGE, fileUrlFor } from "./channels.js";

const transport: Transport = {
  call: (method, args) => ipcRenderer.invoke(CALL, method, args),
  onChange: (cb) => {
    const h = (_e: IpcRendererEvent, ev: ChangeEvent) => cb(ev);
    ipcRenderer.on(CHANGE, h);
    return () => { ipcRenderer.removeListener(CHANGE, h); };
  },
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file as File) || null; } catch { return null; }
  },
  fileUrl: fileUrlFor,
  // Pure string work (no IPC): the main process checks every careeros-mail: request again before answering it.
  mailUrl: (ref) => mailUrlFor(ref),
};

contextBridge.exposeInMainWorld("careerosTransport", transport);
