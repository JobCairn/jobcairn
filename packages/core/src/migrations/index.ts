import { privacyMigration } from "./0001-privacy.js";
import { mailMigration } from "./0002-mail.js";
import { placesMigration } from "./0003-one-places-list.js";
import { placeModesMigration } from "./0004-place-work-modes.js";

export interface Migration {
  id: number;
  name: string;
  /** Absolute paths of files this migration may change; they are backed up first. */
  files(root: string): string[];
  run(root: string): void;
}

// Append new migrations here with increasing ids. Never edit or remove a shipped one.
export const MIGRATIONS: Migration[] = [privacyMigration, mailMigration, placesMigration, placeModesMigration];

export const LATEST_DATA_VERSION = MIGRATIONS.reduce((m, x) => Math.max(m, x.id), 0);
