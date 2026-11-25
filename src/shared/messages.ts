import type { Codec, PipelineStage } from "../core/types.ts";
import type { WrapperStatus } from "../core/wrapper-client.ts";
import type { ExtensionSettings } from "./settings.ts";

export interface PageTokens {
  developerToken?: string;
  musicUserToken?: string;
  storefrontId?: string;
  language?: string;
}

export type JobStage = "queued" | PipelineStage | "saving" | "cancelled";

export interface JobSnapshot {
  jobId: string;
  songId: string;
  storefront: string;
  title: string;
  artist?: string;
  album?: string;
  stage: JobStage;
  message: string;
  done: number;
  total: number;
  error?: string;
  notes: string[];
  codec?: Codec;
  fileName?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AlbumTrackSummary {
  id: string;
  name: string;
  artistName: string;
  trackNumber: number;
  discNumber: number;
}

export interface ResolvedAlbumSummary {
  id: string;
  name: string;
  artist: string;
  tracks: AlbumTrackSummary[];
}

export type RuntimeRequest =
  | {
      type: "enqueue-song";
      storefront: string;
      songId: string;
      titleHint?: string;
      artistHint?: string;
      tokens?: PageTokens;
    }
  | {
      type: "enqueue-album";
      storefront: string;
      albumId: string;
      tokens?: PageTokens;
    }
  | {
      type: "resolve-album";
      storefront: string;
      albumId: string;
      tokens?: PageTokens;
    }
  | { type: "get-jobs" }
  | { type: "cancel-job"; jobId: string }
  | { type: "retry-job"; jobId: string }
  | { type: "clear-finished" }
  | { type: "test-wrapper"; address: string; token?: string }
  | { type: "settings-updated"; settings: ExtensionSettings }
  | { type: "content-get-tokens" }
  | { type: "offscreen-job-update"; job: JobSnapshot }
  | {
      type: "offscreen-save-blob";
      jobId: string;
      blobUrl: string;
      filename: string;
      saveAs: boolean;
    }
  | { type: "offscreen-revoke-blob"; blobUrl: string }
  | { type: "offscreen-refresh-tokens" }
  | { type: "job-update"; job: JobSnapshot };

export interface OffscreenForwardEnvelope {
  target: "offscreen";
  payload: RuntimeRequest;
  settings?: ExtensionSettings;
  tokens?: PageTokens;
}

export interface TestWrapperResponse {
  ok: boolean;
  status?: WrapperStatus;
  error?: string;
}
