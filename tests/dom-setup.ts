import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { installFastLabels } from "./fast-labels";

// SLOW_LABELS=1 turns it off, to compare against stock jsdom.
if (!process.env.SLOW_LABELS) installFastLabels();

afterEach(() => { cleanup(); window.location.hash = ""; localStorage.clear(); });
