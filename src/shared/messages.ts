import type { PlaylistContext } from "../core/naming.ts";
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
  dedupKey: string;
  storefront: string;
  title: string;
  artist?: string;
  album?: string;
  playlistContext?: PlaylistContext;
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

export type CollectionKind =
  | "album"
  | "library-album"
  | "playlist"
  | "library-playlist";

export interface AlbumTrackSummary {
  /** Catalog song ID when available; empty string when unavailable in catalog or non-song. */
  id: string;
  libraryId?: string;
  name: string;
  artistName: string;
  trackNumber: number;
  discNumber: number;
  playlistIndex?: number;
  unavailableInCatalog?: boolean;
  nonSong?: boolean;
}

export interface ResolvedAlbumSummary {
  id: string;
  kind?: CollectionKind;
  storefront?: string;
  name: string;
  artist: string;
  catalogAlbumId?: string;
  tracks: AlbumTrackSummary[];
  skippedUnavailableCount?: number;
  skippedNonSongCount?: number;
}

export type RuntimeRequest =
  | {
      type: "enqueue-song";
      storefront: string;
      songId: string;
      titleHint?: string;
      artistHint?: string;
      playlistContext?: PlaylistContext;
      /** True when originating from a library page whose URL storefront cannot be trusted. */
      useAccountStorefront?: boolean;
      tokens?: PageTokens;
    }
  | {
      type: "enqueue-album";
      storefront: string;
      albumId: string;
      tokens?: PageTokens;
    }
  | {
      type: "enqueue-library-album";
      libraryAlbumId: string;
      tokens?: PageTokens;
    }
  | {
      type: "enqueue-playlist";
      storefront: string;
      playlistId: string;
      tokens?: PageTokens;
    }
  | {
      type: "enqueue-library-playlist";
      libraryPlaylistId: string;
      tokens?: PageTokens;
    }
  | {
      type: "resolve-album";
      storefront: string;
      albumId: string;
      tokens?: PageTokens;
    }
  | {
      type: "resolve-collection";
      kind: CollectionKind;
      storefront: string;
      id: string;
      tokens?: PageTokens;
    }
  | {
      type: "resolve-library-lockup";
      source: "albums" | "recently-added";
      title: string;
      subtitle?: string;
      artworkStem?: string;
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

export interface EnqueueCollectionResponse {
  ok: boolean;
  jobs?: JobSnapshot[];
  collection?: ResolvedAlbumSummary;
  skippedCount?: number;
  skippedNonSongCount?: number;
  totalCount?: number;
  message?: string;
  error?: string;
}
