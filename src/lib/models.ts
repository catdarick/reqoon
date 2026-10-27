import type { Json } from "./schema";
import type { GroupMode } from "./tree";

export interface KV {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

export interface CollectionSource {
  kind: "url" | "file" | "paste";
  location?: string; // URL or absolute file path
}

export interface PendingUpdate {
  specText: string;
  hash: string;
  detectedAt: number;
}

export interface Collection {
  id: string;
  name: string;
  version: string;
  source: CollectionSource;
  hash: string;
  importedAt: number;
  syncedAt: number;
  checkedAt?: number;
  fileModifiedMs?: number;
  /** Files a split spec references, with their modification times, so edits to them are noticed. */
  refFilesModifiedMs?: Record<string, number>;
  baseUrl: string; // may contain {{vars}}
  monitor: boolean;
  /** How the sidebar groups this collection's endpoints; falls back to the app default. */
  groupMode?: GroupMode;
  /** Hide rules, one per line (see lib/hide.ts). */
  hideRules?: string;
  /** Which security alternative to send when endpoints accept several (see authChoiceKey). */
  authChoice?: string;
  /** Auth methods the user added; offered on every endpoint alongside the spec's own. */
  customAuth?: CustomAuth[];
  headers?: CollectionHeaders;
  pending?: PendingUpdate; // newer spec detected, waiting for review
  dismissedHash?: string; // a version the user chose to ignore
  checkError?: string;
  /** Endpoints removed by a sync whose saved request data is kept. */
  orphanedEndpoints?: string[];
  previous?: { hash: string; version: string; syncedAt: number }; // last version before sync, for revert
}

export interface CollectionHeaders {
  /** Per automatic client header (lower-case name): turned off, or sent with another value. */
  client?: Record<string, { off?: boolean; value?: string }>;
  /** Sent with every request of the collection; a request's own header of that name wins. */
  extra?: KV[];
}

export interface CustomAuth {
  id: string;
  title: string;
  kind: "bearer" | "basic" | "apiKey";
  /** apiKey only: where the key goes and under which name. */
  in?: "header" | "query" | "cookie";
  param?: string;
}

export interface RequestState {
  params: Record<string, string>; // key "in:name"
  paramEnabled: Record<string, boolean>; // optional params toggled on
  extraQuery: KV[];
  extraHeaders: KV[];
  contentType?: string;
  bodyText: string; // source of truth for the body in both modes
  bodyMode: "form" | "raw";
  updatedAt: number;
  /** Name the user gave this tab (shown instead of the path). */
  tabTitle?: string;
  /** Collection-wide and automatic client headers not sent with this request (lower-case names). */
  offHeaders?: string[];
}

export interface EnvVar {
  id: string;
  key: string;
  value: string; // empty in persisted state when secret (value lives in the keychain)
  secret: boolean;
  enabled: boolean;
  /** Pinned to the toolbar for quick edits (e.g. a user_id that changes all the time). */
  hot?: boolean;
  /** Recent values of a hot variable, newest first (never kept for secrets). */
  recent?: string[];
}

export interface Environment {
  id: string;
  name: string;
  color: string;
  vars: EnvVar[];
  /** Collections this environment is meant for; empty or missing = all of them. */
  collections?: string[];
}

/** Whether `env` may be used to send requests of a collection (no environment always may). */
export function envSupports(env: Environment | undefined, collectionId: string): boolean {
  return !env?.collections?.length || env.collections.includes(collectionId);
}

/** Per collection, per security scheme credentials; values may contain {{vars}}. Stored in the keychain. */
export type AuthConfig = Record<string, Record<string, { value: string; username?: string; password?: string }>>;

export type ThemePref = "system" | "light" | "dark";

export interface Settings {
  theme: ThemePref;
  shortcuts: Record<string, string>;
  monitorEnabled: boolean;
  remoteCheckMinutes: number;
  fileCheckSeconds: number;
  requestTimeoutSec: number;
  /** Grouping for collections that haven't chosen their own. */
  defaultGroupMode: GroupMode;
  wrapResponse: boolean;
  fontSize: number;
  sidebarWidth: number;
  showAutoHeaders: boolean;
}

export interface ResponseData {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  size: number;
  timeMs: number;
  at: number;
  url: string;
  method: string;
}

export interface SavedValueConflict {
  key: string; // "in:name" or body pointer
  label: string;
  value: Json;
  reason: string;
}

export function uid(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export function requestKey(collectionId: string, endpointId: string): string {
  return `${collectionId}::${endpointId}`;
}

/** Splits a request (tab) key into collection and endpoint ids; copies map to their endpoint. */
export function splitRequestKey(key: string): [string, string] {
  const i = key.indexOf("::");
  return [key.slice(0, i), key.slice(i + 2).split(COPY_MARK)[0]];
}

// Extra tabs of an endpoint ("copies") have keys like "<collection>::<endpoint>##<id>" and their
// own request state. The endpoint's main tab keeps the plain key.
const COPY_MARK = "##";

export function isCopyKey(key: string): boolean {
  return key.includes(COPY_MARK);
}

/** Key of the endpoint's main tab for any of its tabs. */
export function baseRequestKey(key: string): string {
  return key.split(COPY_MARK)[0];
}

export function newCopyKey(key: string): string {
  return `${baseRequestKey(key)}${COPY_MARK}${uid()}`;
}
