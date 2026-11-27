import type { JobSnapshot, TestWrapperResponse } from "../shared/messages.ts";
import { applyI18n, t } from "../shared/i18n.ts";
import { loadSettings } from "../shared/settings.ts";

const modeBadge = document.getElementById("mode-badge") as HTMLSpanElement;
const queueList = document.getElementById("queue-list") as HTMLElement;
const queueSummary = document.getElementById("queue-summary") as HTMLSpanElement;
const clearBtn = document.getElementById("clear-finished") as HTMLButtonElement;
const optionsBtn = document.getElementById("open-options") as HTMLButtonElement;

const jobsMap = new Map<string, JobSnapshot>();

function formatBytes(n: number): string {
  if (n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const STAGE_KEYS: Record<string, string> = {
  queued: "stageQueued",
  resolve: "stageResolve",
  manifest: "stageManifest",
  download: "stageDownload",
  keys: "stageKeys",
  decrypt: "stageDecrypt",
  remux: "stageRemux",
  tag: "stageTag",
  saving: "stageSaving",
  done: "stageDone",
  error: "stageError",
  cancelled: "stageCancelled",
};

function stageLabel(j: JobSnapshot): string {
  if (j.stage === "done" && j.codec) {
    return t("stageDoneCodec", j.codec.toUpperCase());
  }
  const key = STAGE_KEYS[j.stage];
  return key ? t(key) : j.message;
}

/** Localises the pipeline's English notes; unknown notes pass through. */
function localiseNote(note: string): string {
  if (note === "song has no lyrics") return t("noteNoLyrics");
  if (
    note.startsWith("no lyrics found") ||
    note.startsWith("the wrapper found no lyrics") ||
    note.startsWith("lyrics fetch returned an empty")
  ) {
    return t("noteLyricsNotFound");
  }
  if (note.startsWith("lyrics left out") || note.startsWith("lyrics conversion failed")) {
    return `${t("noteLyricsFailed")} (${note.replace(/^[^:]*:\s*/, "")})`;
  }
  if (note.startsWith("cover left out")) {
    return `${t("noteCoverFailed")} (${note.replace(/^[^:]*:\s*/, "")})`;
  }
  const fb = /^codec (\S+) unavailable; fell back to (\S+)$/.exec(note);
  if (fb) return t("noteCodecFallback", fb[1]!.toUpperCase(), fb[2]!.toUpperCase());
  if (/not available in the Apple Music catalog/i.test(note)) {
    return t("noteSkippedUnavailable");
  }
  return note;
}

const STAGE_SPAN: Record<string, [number, number]> = {
  queued: [0, 0],
  resolve: [0, 0.03],
  manifest: [0.03, 0.06],
  download: [0.06, 0.8],
  keys: [0.8, 0.82],
  decrypt: [0.82, 0.96],
  remux: [0.96, 0.98],
  tag: [0.98, 0.99],
  saving: [0.99, 1],
  done: [1, 1],
};

/** Overall 0..1 progress across all stages (matches the in-page rings). */
function overallProgress(j: JobSnapshot): number {
  if (j.stage === "error" || j.stage === "cancelled") return 1;
  const span = STAGE_SPAN[j.stage] ?? [0, 0];
  const frac = j.total > 0 ? Math.min(1, j.done / j.total) : 0;
  return span[0] + (span[1] - span[0]) * frac;
}

function renderJobs(): void {
  const jobs = Array.from(jobsMap.values()).sort(
    (a, b) => b.createdAt - a.createdAt,
  );

  if (jobs.length === 0) {
    queueList.innerHTML = `<div class="empty">${escapeHtml(t("emptyQueue"))}</div>`;
    queueSummary.textContent = t("summaryNone");
    clearBtn.disabled = true;
    return;
  }

  let active = 0;
  let finished = 0;
  for (const j of jobs) {
    if (j.stage === "done" || j.stage === "error" || j.stage === "cancelled") {
      finished++;
    } else {
      active++;
    }
  }
  queueSummary.textContent = t("summaryCounts", active, finished);
  clearBtn.disabled = finished === 0;

  queueList.innerHTML = "";
  for (const j of jobs) {
    const card = document.createElement("div");
    card.className = "job-card";

    const pct = Math.round(overallProgress(j) * 100);

    const fillCls =
      j.stage === "done"
        ? "progress-fill done"
        : j.stage === "error"
          ? "progress-fill error"
          : "progress-fill";

    const canCancel =
      j.stage !== "done" && j.stage !== "error" && j.stage !== "cancelled";
    const canRetry = j.stage === "error" || j.stage === "cancelled";

    const metaParts: string[] = [];
    if (j.artist) metaParts.push(j.artist);
    if (j.playlistContext?.playlistName) {
      metaParts.push(
        `${j.playlistContext.playlistName} #${String(j.playlistContext.playlistIndex).padStart(2, "0")}`,
      );
    }
    if (j.codec) metaParts.push(j.codec.toUpperCase());

    const rightStatus =
      j.total > 0 && j.stage !== "done"
        ? `${formatBytes(j.done)} / ${formatBytes(j.total)}`
        : "";

    card.innerHTML = `
      <div class="job-head">
        <div>
          <div class="job-title">${escapeHtml(j.title)}</div>
          ${metaParts.length ? `<div class="job-meta">${escapeHtml(metaParts.join(" · "))}</div>` : ""}
        </div>
        <div class="job-actions">
          ${canCancel ? `<button class="mini-btn" data-act="cancel" data-id="${escapeHtml(j.jobId)}">${escapeHtml(t("cancel"))}</button>` : ""}
          ${canRetry ? `<button class="mini-btn" data-act="retry" data-id="${escapeHtml(j.jobId)}">${escapeHtml(t("retry"))}</button>` : ""}
        </div>
      </div>
      <div class="progress-track"><div class="${fillCls}" style="width:${pct}%"></div></div>
      <div class="job-status">
        <span>${escapeHtml(stageLabel(j))}</span>
        <span>${escapeHtml(rightStatus)}</span>
      </div>
      ${j.error ? `<div class="job-error">${escapeHtml(j.error)}</div>` : ""}
      ${j.notes.length ? `<div class="job-notes">${escapeHtml(j.notes.map(localiseNote).join(" · "))}</div>` : ""}
    `;
    queueList.appendChild(card);
  }
}

queueList.addEventListener("click", (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const jobId = btn.dataset.id;
  if (!jobId) return;
  if (act === "cancel") {
    void chrome.runtime.sendMessage({ type: "cancel-job", jobId });
  } else if (act === "retry") {
    void chrome.runtime.sendMessage({ type: "retry-job", jobId });
  }
});

clearBtn.addEventListener("click", () => {
  void chrome.runtime.sendMessage({ type: "clear-finished" }).then(() => {
    for (const [id, j] of jobsMap.entries()) {
      if (j.stage === "done" || j.stage === "error" || j.stage === "cancelled") {
        jobsMap.delete(id);
      }
    }
    renderJobs();
  });
});

optionsBtn.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg: unknown) => {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as { type?: string; job?: JobSnapshot };
  if ((m.type === "offscreen-job-update" || m.type === "job-update") && m.job) {
    jobsMap.set(m.job.jobId, m.job);
    renderJobs();
  }
  return false;
});

async function init(): Promise<void> {
  const [settings, jobsResp] = await Promise.all([
    loadSettings(),
    chrome.runtime
      .sendMessage({ type: "get-jobs" })
      .catch(() => ({ ok: false, jobs: [] })) as Promise<{
      ok?: boolean;
      jobs?: JobSnapshot[];
    }>,
  ]);

  if (jobsResp?.ok && Array.isArray(jobsResp.jobs)) {
    for (const j of jobsResp.jobs) jobsMap.set(j.jobId, j);
  }
  renderJobs();

  if (!settings.wrapperUrl) {
    modeBadge.textContent = t("modeZeroConfig");
    modeBadge.className = "badge";
    return;
  }

  modeBadge.textContent = t("modeWrapperChecking");
  const test = (await chrome.runtime
    .sendMessage({
      type: "test-wrapper",
      address: settings.wrapperUrl,
      token: settings.wrapperToken,
    })
    .catch(() => ({ ok: false, error: "unreachable" }))) as TestWrapperResponse;

  if (test?.ok && test.status) {
    const regions = test.status.regions.length
      ? test.status.regions.join(", ")
      : t("modeWrapperNoAccount");
    modeBadge.textContent = t("modeWrapperRegions", regions);
    modeBadge.className = test.status.ready ? "badge ok" : "badge err";
  } else {
    modeBadge.textContent = t("modeWrapperOffline");
    modeBadge.className = "badge err";
    modeBadge.title = test?.error || t("wrapperUnreachable");
  }
}

applyI18n();
void init();
