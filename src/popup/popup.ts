import type { JobSnapshot, TestWrapperResponse } from "../shared/messages.ts";
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

function renderJobs(): void {
  const jobs = Array.from(jobsMap.values()).sort(
    (a, b) => b.createdAt - a.createdAt,
  );

  if (jobs.length === 0) {
    queueList.innerHTML = `<div class="empty">No active downloads.<br/>Open an album or song on <strong>music.apple.com</strong> and click Download.</div>`;
    queueSummary.textContent = "No downloads";
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
  queueSummary.textContent = `${active} active · ${finished} finished`;
  clearBtn.disabled = finished === 0;

  queueList.innerHTML = "";
  for (const j of jobs) {
    const card = document.createElement("div");
    card.className = "job-card";

    const pct =
      j.stage === "done"
        ? 100
        : j.total > 0
          ? Math.min(100, Math.round((j.done / j.total) * 100))
          : j.stage === "queued"
            ? 0
            : 15;

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
    if (j.codec) metaParts.push(j.codec.toUpperCase());

    const rightStatus =
      j.total > 0 && j.stage !== "done"
        ? `${formatBytes(j.done)} / ${formatBytes(j.total)}`
        : j.stage.toUpperCase();

    card.innerHTML = `
      <div class="job-head">
        <div>
          <div class="job-title">${escapeHtml(j.title)}</div>
          ${metaParts.length ? `<div class="job-meta">${escapeHtml(metaParts.join(" · "))}</div>` : ""}
        </div>
        <div class="job-actions">
          ${canCancel ? `<button class="mini-btn" data-act="cancel" data-id="${escapeHtml(j.jobId)}">Cancel</button>` : ""}
          ${canRetry ? `<button class="mini-btn" data-act="retry" data-id="${escapeHtml(j.jobId)}">Retry</button>` : ""}
        </div>
      </div>
      <div class="progress-track"><div class="${fillCls}" style="width:${pct}%"></div></div>
      <div class="job-status">
        <span>${escapeHtml(j.message)}</span>
        <span>${escapeHtml(rightStatus)}</span>
      </div>
      ${j.error ? `<div class="job-error">${escapeHtml(j.error)}</div>` : ""}
      ${j.notes.length ? `<div class="job-notes">${escapeHtml(j.notes.join(" · "))}</div>` : ""}
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
    modeBadge.textContent = "Zero-config AAC-LC";
    modeBadge.className = "badge";
    return;
  }

  modeBadge.textContent = "Wrapper: checking…";
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
      : "no account";
    modeBadge.textContent = `Wrapper: ${regions}`;
    modeBadge.className = test.status.ready ? "badge ok" : "badge err";
  } else {
    modeBadge.textContent = "Wrapper: offline";
    modeBadge.className = "badge err";
    modeBadge.title = test?.error || "Wrapper unreachable";
  }
}

void init();
