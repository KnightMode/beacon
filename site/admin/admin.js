(() => {
  "use strict";

  const stepLabels = {
    slack: "Connect Slack",
    github: "Connect GitHub",
    repos: "Choose repos",
    indexing: "Watch indexing",
    first_answer: "First cited answer",
  };
  const stepOrder = Object.keys(stepLabels);
  const isOnboarding = document.body.dataset.adminPage === "onboarding";
  const repoPageLimit = 100;

  const state = {
    summary: null,
    repoLoading: false,
    repoLoadedOnce: false,
    repoQuery: "",
    repoFilter: "all",
    repoPage: 1,
    repoHasMore: false,
    repoSource: "empty",
    repoMessage: "",
    repoInstallation: null,
    repoInstallations: [],
    availableRepos: new Map(),
    selectedRepos: new Map(),
    searchTimer: null,
    eventSource: null,
    fallbackTimer: null,
    lastSnapshotAt: 0,
    activeJourneyStep: null,
    journeyStatuses: new Map(),
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  async function fetchJson(url, options) {
    const res = await fetch(url, {
      credentials: "include",
      headers: { "content-type": "application/json" },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function load(options = {}) {
    const data = await fetchJson("/api/admin/session");
    if (!data.authenticated) {
      renderSignedOut();
      return false;
    }
    applySnapshot(data);
    if (isOnboarding && options.loadPicker !== false) {
      await ensureRepoPicker(data);
    }
    return true;
  }

  function applySnapshot(data) {
    state.summary = data;
    syncSelectedRepos(data.repos || []);
    renderTenant(data);
    renderSteps(data.steps || {});
    renderRepos(data.repos || []);
    updateLiveVisibility();
    if (isOnboarding) renderRepoBrowser();
  }

  // The connection / "live" indicators are only meaningful once setup is finished —
  // keep them hidden until all steps complete so they aren't noise during onboarding.
  function updateLiveVisibility() {
    const complete = Boolean(state.summary?.completed);
    $$(".admin-system-state, .live-badge").forEach((el) => {
      el.hidden = !complete;
    });
  }

  function renderSignedOut() {
    state.summary = { integrations: {}, repos: [], completed: false };
    state.availableRepos.clear();
    state.selectedRepos.clear();
    state.journeyStatuses.clear();
    renderTenant(state.summary);
    renderSteps({}, { signedOut: true });
    renderRepos([]);
    renderRepoBrowser();
    updateLiveVisibility();
    setText("[data-onboarding-state]", "Needs Slack");
    setText("[data-repo-picker-status]", "Connect Slack to load repositories.");
    setText("[data-repo-form-status]", "Connect Slack first.");
    setLiveState("Admin access required", "offline");
    const submit = $("[data-repo-submit]");
    if (submit) submit.disabled = true;
  }

  async function ensureRepoPicker(onboarding) {
    if (!isOnboarding) return;
    if (!onboarding.integrations?.github) {
      state.availableRepos.clear();
      state.repoLoadedOnce = false;
      state.repoMessage = "Connect GitHub to load repositories.";
      renderRepoBrowser();
      return;
    }
    if (!state.repoLoadedOnce && !state.repoLoading) {
      await loadRepoPage({ reset: true });
    }
  }

  async function loadRepoPage({ reset = false } = {}) {
    if (!state.summary?.integrations?.github) return;

    if (reset) {
      state.repoPage = 1;
      state.repoHasMore = false;
      state.availableRepos.clear();
    } else if (state.repoLoading || !state.repoHasMore || state.repoQuery) {
      return;
    } else {
      state.repoPage += 1;
    }

    state.repoLoading = true;
    state.repoMessage = state.repoQuery ? "Searching GitHub repositories..." : "Loading repositories...";
    renderRepoBrowser();

    const params = new URLSearchParams({
      q: state.repoQuery,
      page: String(state.repoPage),
      limit: String(repoPageLimit),
    });

    try {
      const data = await fetchJson(`/api/admin/github/repos?${params.toString()}`);
      state.repoLoadedOnce = true;
      state.repoSource = data.source || "github-api";
      state.repoHasMore = Boolean(data.hasMore) && !state.repoQuery;
      state.repoInstallation = data.installation || null;
      state.repoInstallations = data.installations || [];
      state.repoMessage = data.message || "";
      mergeAvailableRepos(data.repos || []);
      mergeSelectedRepoSummaries(data.selectedRepos || []);
      renderRepoBrowser(data);
    } catch (err) {
      state.repoMessage = safeSetupError(err, "Could not load repositories right now.");
      state.repoHasMore = false;
      renderRepoBrowser();
    } finally {
      state.repoLoading = false;
      renderRepoBrowser();
    }
  }

  function mergeAvailableRepos(repos) {
    for (const repo of repos) {
      const fullName = repo.fullName;
      if (!fullName) continue;
      const existing = state.availableRepos.get(fullName) || {};
      state.availableRepos.set(fullName, { ...existing, ...repo });
      if (repo.selected) {
        state.selectedRepos.set(fullName, { ...existing, ...repo, selected: true });
      }
    }
  }

  function mergeSelectedRepoSummaries(repos) {
    for (const repo of repos) {
      if (!repo.fullName) continue;
      const existing = state.availableRepos.get(repo.fullName) || {};
      state.selectedRepos.set(repo.fullName, { ...existing, ...repo, selected: true });
    }
  }

  function syncSelectedRepos(repos) {
    for (const repo of repos) {
      if (!repo.fullName) continue;
      const existing = state.availableRepos.get(repo.fullName) || {};
      state.selectedRepos.set(repo.fullName, { ...existing, ...repo, selected: true });
    }
  }

  function renderTenant(data) {
    const tenantName = data.tenant?.name || data.tenant?.slackTeamId || "Not connected";
    setText("[data-tenant-name]", tenantName);
    setConnState("[data-slack-status]", Boolean(data.integrations?.slack));
    setConnState("[data-github-status]", Boolean(data.integrations?.github));
    setText("[data-repo-count]", String((data.repos || []).length));
    setText("[data-onboarding-state]", data.completed ? "Complete" : "In progress");
  }

  function setConnState(selector, on) {
    $$(selector).forEach((node) => {
      node.textContent = on ? "Connected" : "Disconnected";
      node.dataset.state = on ? "on" : "off";
      node.closest(".stat-tile")?.setAttribute("data-state", on ? "on" : "off");
    });
  }

  function renderSteps(steps, { signedOut = false } = {}) {
    const html = stepOrder
      .map((key, index) => {
        const status = signedOut ? "Sign in to view" : steps[key] || "PENDING";
        const stateToken = signedOut ? "unknown" : status.toLowerCase();
        return `<li data-state="${escapeHtml(stateToken)}">
          <a href="${isOnboarding ? `#step-${escapeHtml(key)}` : "/admin/onboarding/"}">
            <span>${String(index + 1).padStart(2, "0")}</span>
            <strong>${escapeHtml(stepLabels[key])}</strong>
            <em>${escapeHtml(status)}</em>
          </a>
        </li>`;
      })
      .join("");
    $$("[data-step-list]").forEach((node) => {
      node.innerHTML = html;
    });
    const completeCount = stepOrder.filter((key) => (steps[key] || "PENDING").toLowerCase() === "complete").length;
    renderJourneyProgress(completeCount, { signedOut });
    if (isOnboarding) renderJourneyCards(steps, { signedOut });
  }

  function renderJourneyCards(steps, { signedOut = false } = {}) {
    for (const key of stepOrder) {
      const status = signedOut ? "Sign in" : steps[key] || "PENDING";
      const normalized = signedOut ? "unknown" : status.toLowerCase();
      const previousStatus = state.journeyStatuses.get(key);
      const button = $(`[data-journey-card="${key}"]`);
      if (button) {
        button.dataset.state = normalized;
        if (previousStatus && previousStatus !== "complete" && previousStatus !== "unknown" && normalized === "complete") {
          flashClass(button, "just-completed", 900);
        }
      }
      state.journeyStatuses.set(key, normalized);
      setText(`[data-journey-status="${key}"]`, status);
    }
    if (!state.activeJourneyStep) {
      setActiveJourneyStep(initialJourneyStep(steps));
    }
  }

  function renderJourneyProgress(completeCount, { signedOut = false } = {}) {
    const total = stepOrder.length;
    setText("[data-journey-progress-count]", signedOut ? "–" : String(completeCount));
    setText("[data-journey-progress-total]", String(total));
    const bar = $("[data-journey-progress-bar]");
    if (bar) bar.style.setProperty("--p", `${signedOut ? 0 : Math.round((completeCount / total) * 100)}%`);
    const pct = $("[data-journey-progress-pct]");
    if (pct) pct.textContent = signedOut ? "–" : `${Math.round((completeCount / total) * 100)}%`;
  }

  function initialJourneyStep(steps) {
    const hashStep = journeyStepFromHash();
    if (hashStep) return hashStep;
    return stepOrder.find((key) => (steps[key] || "PENDING").toUpperCase() !== "COMPLETE") || stepOrder.at(-1);
  }

  function journeyStepFromHash() {
    const key = window.location.hash.replace(/^#step-/, "");
    return stepOrder.includes(key) ? key : null;
  }

  function setActiveJourneyStep(key, { updateHash = false } = {}) {
    if (!isOnboarding || !stepOrder.includes(key)) return;
    const previousStep = state.activeJourneyStep;
    state.activeJourneyStep = key;

    $$("[data-journey-card]").forEach((button) => {
      const active = button.dataset.journeyCard === key;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
      button.tabIndex = active ? 0 : -1;
      if (active) {
        button.setAttribute("aria-current", "step");
        if (previousStep && previousStep !== key) flashClass(button, "just-activated", 620);
      } else {
        button.removeAttribute("aria-current");
      }
    });

    $$("[data-journey-panel]").forEach((panel) => {
      const active = panel.dataset.journeyPanel === key;
      panel.classList.toggle("is-active", active);
      panel.hidden = !active;
    });

    if (updateHash) {
      window.history.replaceState(null, "", `#step-${key}`);
    }

    updateJourneyNav(key);
  }

  function updateJourneyNav(key) {
    const index = stepOrder.indexOf(key);
    if (index < 0) return;
    const prev = $("[data-journey-prev]");
    const next = $("[data-journey-next]");
    const hint = $("[data-journey-hint]");
    if (hint) hint.textContent = `Step ${index + 1} of ${stepOrder.length} · ${stepLabels[key]}`;
    if (prev) prev.disabled = index === 0;
    if (next) {
      const isLast = index === stepOrder.length - 1;
      next.disabled = isLast;
      const nextKey = stepOrder[index + 1];
      next.textContent = isLast ? "All steps" : `Next: ${stepLabels[nextKey]} →`;
    }
  }

  function stepJourney(delta) {
    const index = stepOrder.indexOf(state.activeJourneyStep);
    if (index < 0) return;
    const target = stepOrder[index + delta];
    if (target) setActiveJourneyStep(target, { updateHash: true });
  }

  function flashClass(node, className, duration) {
    node.classList.remove(className);
    window.requestAnimationFrame(() => {
      node.classList.add(className);
      window.setTimeout(() => node.classList.remove(className), duration);
    });
  }

  function renderRepos(repos) {
    const safeRepos = repos || [];
    const ready = safeRepos.filter((repo) => (repo.status || "").toUpperCase() === "READY").length;
    const failed = safeRepos.filter((repo) => (repo.status || "").toUpperCase() === "FAILED").length;
    const active = safeRepos.filter((repo) => !["READY", "FAILED"].includes((repo.status || "").toUpperCase())).length;
    const chunks = safeRepos.reduce((sum, repo) => sum + Number(repo.totalChunks || 0), 0);

    setText("[data-index-ready]", String(ready));
    setText("[data-index-active]", String(active));
    setText("[data-index-failed]", String(failed));
    setText("[data-index-chunks]", formatNumber(chunks));

    const html = safeRepos.length
      ? `<table>
          <thead><tr><th>Repo</th><th>Status</th><th>Progress</th><th>Chunks</th></tr></thead>
          <tbody>
            ${safeRepos.map((repo) => {
              const status = repo.status || "PENDING";
              const pct = progressPercent(repo);
              const fileText = `${repo.indexedFiles ?? 0}/${repo.totalFiles ?? "?"}`;
              return `<tr>
                <td>
                  <strong>${escapeHtml(repo.fullName)}</strong>
                  ${repo.error ? `<small>${escapeHtml(repo.error)}</small>` : ""}
                </td>
                <td><span class="status-pill" data-state="${escapeHtml(status.toLowerCase())}">${escapeHtml(status)}</span></td>
                <td>
                  <div class="progress-cell">
                    <span class="progress-bar" style="--progress:${pct}%"><i></i></span>
                    <em>${escapeHtml(fileText)} files</em>
                  </div>
                </td>
                <td>${escapeHtml(formatNumber(repo.totalChunks ?? 0))}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>`
      : `<p class="admin-empty">No repos selected yet. Continue setup to add the first pilot repo.</p>`;
    $$("[data-repo-table]").forEach((node) => {
      node.innerHTML = html;
    });
  }

  function renderRepoBrowser() {
    const picker = $("[data-repo-picker]");
    if (!picker) return;

    const status = $("[data-repo-picker-status]");
    const selectedCount = state.selectedRepos.size;
    const loadedRepos = sortedRepos(Array.from(state.availableRepos.values()));
    const visibleRepos = visibleRepoRows(loadedRepos);
    const submit = $("[data-repo-submit]");
    const loadMore = $("[data-repo-load-more]");

    if (status) {
      const statusText = repoStatusText(loadedRepos.length, visibleRepos.length);
      status.textContent = statusText;
      status.classList.toggle("repo-picker__empty", Boolean(statusText) && Boolean(state.repoMessage));
    }

    setText("[data-repo-visible-count]", String(visibleRepos.length));
    setText("[data-repo-selected-count]", String(selectedCount));
    setText("[data-repo-total-scanned]", String(loadedRepos.length));
    setText("[data-repo-selected-total]", formatNumber(selectedCount));
    const selectedRows = Array.from(state.selectedRepos.values());
    setText("[data-repo-private-count]", formatNumber(selectedRows.filter((repo) => repo.private !== false).length));
    setText("[data-repo-public-count]", formatNumber(selectedRows.filter((repo) => repo.private === false).length));
    const denominator = Math.max(loadedRepos.length, selectedCount, 1);
    setText("[data-repo-selected-percent]", `${Math.round((selectedCount / denominator) * 1000) / 10}%`);

    if (submit) submit.disabled = selectedCount === 0 || state.repoLoading;
    if (loadMore) {
      loadMore.disabled = state.repoLoading || !state.repoHasMore || Boolean(state.repoQuery);
      loadMore.textContent = state.repoLoading ? "Loading..." : "Load more";
    }

    $$("[data-repo-filter]").forEach((button) => {
      const active = button.dataset.repoFilter === state.repoFilter;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });

    renderRepoRows(visibleRepos);
    renderSelectedRepos();
  }

  function repoStatusText(loadedCount, visibleCount) {
    if (!state.summary?.integrations?.github) return "";
    if (state.repoLoading) return state.repoMessage || "Loading repositories...";
    if (state.repoMessage) return state.repoMessage;
    const account = state.repoInstallation?.accountLogin
      ? ` for ${state.repoInstallation.accountLogin}`
      : state.repoInstallations.length > 1
        ? ` across ${state.repoInstallations.length} GitHub installs`
        : "";
    const source = state.repoSource === "database" ? " from cached install data" : "";
    if (loadedCount === 0) return `No repositories loaded${account}.`;
    return `${formatNumber(loadedCount)} repos loaded${account}${source}. ${formatNumber(visibleCount)} visible in the current view.`;
  }

  function visibleRepoRows(loadedRepos) {
    if (state.repoFilter === "selected") {
      return sortedRepos(Array.from(state.selectedRepos.values()));
    }
    return loadedRepos.filter((repo) => {
      if (state.repoFilter === "private") return repo.private !== false;
      if (state.repoFilter === "public") return repo.private === false;
      return true;
    });
  }

  function renderRepoRows(repos) {
    const list = $("[data-repo-list]");
    if (!list) return;
    if (!state.summary?.integrations?.github) {
      list.innerHTML = `<p class="admin-empty">Connect GitHub to load repositories.</p>`;
      return;
    }
    if (state.repoLoading && repos.length === 0) {
      list.innerHTML = `<p class="admin-empty">Loading repositories...</p>`;
      return;
    }
    if (repos.length === 0) {
      list.innerHTML = `<p class="admin-empty">No repositories match this view.</p>`;
      return;
    }
    list.innerHTML = `<div class="repo-row repo-row--head" aria-hidden="true">
        <span></span>
        <span>Owner</span>
        <span>Repository</span>
        <span>Privacy</span>
        <span>Branch</span>
        <span>State</span>
      </div>${repos.map((repo) => {
      const selected = state.selectedRepos.has(repo.fullName);
      const persisted = persistedRepoSet().has(repo.fullName);
      const repoParts = splitRepo(repo.fullName);
      const isPublic = repo.private === false;
      const stateText = persisted ? (repo.status || "Selected") : selected ? "Draft" : "Available";
      const stateToken = persisted ? "ready" : selected ? "draft" : "available";
      return `<label class="repo-row${selected ? " is-selected" : ""}${persisted ? " is-locked" : ""}" data-repo-row>
        <input type="checkbox" class="repo-check" data-repo-checkbox value="${escapeHtml(repo.fullName)}" ${selected ? "checked" : ""} ${persisted ? "disabled" : ""} />
        <span class="repo-row__owner">${escapeHtml(repoParts.owner)}</span>
        <span class="repo-row__main">
          <strong>${escapeHtml(repoParts.name)}</strong>
          <em>${escapeHtml(repo.fullName)}</em>
          ${repo.accountLogin ? `<small>${escapeHtml(repo.accountLogin)}</small>` : ""}
        </span>
        <span class="repo-row__privacy"><span class="repo-badge ${isPublic ? "is-public" : "is-private"}">${isPublic ? "Public" : "Private"}</span></span>
        <span class="repo-row__branch">${escapeHtml(repo.defaultBranch || "main")}</span>
        <span class="repo-row__state"><span class="repo-pill" data-state="${stateToken}">${escapeHtml(stateText)}</span></span>
      </label>`;
    }).join("")}`;
  }

  function renderSelectedRepos() {
    const list = $("[data-repo-selected-list]");
    if (!list) return;
    const repos = sortedRepos(Array.from(state.selectedRepos.values()));
    if (repos.length === 0) {
      list.innerHTML = `<p class="admin-empty">No repos selected yet.</p>`;
      return;
    }
    list.innerHTML = repos.map((repo) => {
      const status = repo.status || (repo.selected ? "SELECTED" : "DRAFT");
      const persisted = persistedRepoSet().has(repo.fullName);
      const isPublic = repo.private === false;
      return `<div class="repo-selected-item${persisted ? " is-locked" : ""}">
        <span class="repo-selected-item__dot ${isPublic ? "is-public" : "is-private"}" aria-hidden="true"></span>
        <span class="repo-selected-item__name">${escapeHtml(repo.fullName)}</span>
        <em>${escapeHtml(status)}</em>
        ${persisted ? `<span class="repo-selected-item__lock" aria-label="Indexed" title="Already indexed">●</span>` : `<button type="button" class="repo-selected-item__remove" data-repo-remove="${escapeHtml(repo.fullName)}" aria-label="Remove ${escapeHtml(repo.fullName)}">×</button>`}
      </div>`;
    }).join("");
  }

  function selectedRepoPayload() {
    return Array.from(state.selectedRepos.values()).map((repo) => ({
      fullName: repo.fullName,
      installationId: repo.installationId || repo.selectedInstallationId,
    }));
  }

  function bindForms() {
    $$("[data-journey-card]").forEach((button) => {
      button.addEventListener("click", () => {
        setActiveJourneyStep(button.dataset.journeyCard, { updateHash: true });
      });
    });

    window.addEventListener("hashchange", () => {
      const hashStep = journeyStepFromHash();
      if (hashStep) setActiveJourneyStep(hashStep);
    });

    $("[data-journey-prev]")?.addEventListener("click", () => stepJourney(-1));
    $("[data-journey-next]")?.addEventListener("click", () => stepJourney(1));

    $$("[data-refresh]").forEach((button) => {
      button.addEventListener("click", () => {
        const shouldReloadPicker = isOnboarding && Boolean(state.summary?.integrations?.github);
        load({ loadPicker: false })
          .then(() => (shouldReloadPicker ? loadRepoPage({ reset: true }) : null))
          .catch(showError);
      });
    });

    $("[data-repo-form]")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const repos = selectedRepoPayload();
      if (repos.length === 0) {
        setText("[data-repo-form-status]", "Select at least one repository.");
        return;
      }
      try {
        setText("[data-repo-form-status]", "Saving repos and starting indexing...");
        const result = await fetchJson("/api/admin/repos", {
          method: "POST",
          body: JSON.stringify({ repos }),
        });
        if (result.dispatchErrors?.length) {
          const failedRepos = result.dispatchErrors.map((entry) => entry.repo).filter(Boolean);
          const failedText = failedRepos.length > 2
            ? `${failedRepos.length} repositories`
            : failedRepos.join(", ") || "the selected repositories";
          setText("[data-repo-form-status]", `Saved repos, but indexing did not start for ${failedText}. Contact an administrator.`);
        } else {
          setText("[data-repo-form-status]", `Indexing started for ${repos.length} repo${repos.length === 1 ? "" : "s"}.`);
        }
        applySnapshot({ ...state.summary, repos: result.repos || state.summary?.repos || [] });
        await load({ loadPicker: false });
        setActiveJourneyStep("indexing", { updateHash: true });
      } catch (err) {
        setText("[data-repo-form-status]", safeSetupError(err, "Could not save repositories right now."));
      }
    });

    $("[data-repo-search]")?.addEventListener("input", (event) => {
      window.clearTimeout(state.searchTimer);
      const value = event.currentTarget.value.trim();
      state.searchTimer = window.setTimeout(() => {
        state.repoQuery = value;
        loadRepoPage({ reset: true }).catch(showError);
      }, 260);
    });

    $("[data-repo-list]")?.addEventListener("change", (event) => {
      const checkbox = event.target.closest("[data-repo-checkbox]");
      if (!checkbox) return;
      const fullName = checkbox.value;
      const repo = state.availableRepos.get(fullName) || state.selectedRepos.get(fullName) || { fullName };
      if (checkbox.checked) {
        state.selectedRepos.set(fullName, { ...repo, selected: true });
      } else {
        state.selectedRepos.delete(fullName);
      }
      renderRepoBrowser();
    });

    $("[data-repo-selected-list]")?.addEventListener("click", (event) => {
      const remove = event.target.closest("[data-repo-remove]");
      if (!remove) return;
      const fullName = remove.dataset.repoRemove;
      if (persistedRepoSet().has(fullName)) return;
      state.selectedRepos.delete(fullName);
      renderRepoBrowser();
    });

    $$("[data-repo-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        state.repoFilter = button.dataset.repoFilter || "all";
        renderRepoBrowser();
      });
    });

    $("[data-repo-load-more]")?.addEventListener("click", () => {
      loadRepoPage({ reset: false }).catch(showError);
    });

    $("[data-repo-select-all]")?.addEventListener("click", () => {
      const visible = visibleRepoRows(sortedRepos(Array.from(state.availableRepos.values())));
      for (const repo of visible) {
        state.selectedRepos.set(repo.fullName, { ...repo, selected: true });
      }
      renderRepoBrowser();
    });

    $("[data-repo-clear-all]")?.addEventListener("click", () => {
      state.selectedRepos.clear();
      syncSelectedRepos(state.summary?.repos || []);
      renderRepoBrowser();
    });

    $("[data-github-complete]")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const installationId = form.installationId.value.trim();
      try {
        setText("[data-github-complete-status]", "Linking installation...");
        await fetchJson("/api/admin/github/complete", {
          method: "POST",
          body: JSON.stringify({ installationId }),
        });
        setText("[data-github-complete-status]", "GitHub connected.");
        setText("[data-github-status]", "Connected");
        await load();
        setActiveJourneyStep("repos", { updateHash: true });
      } catch (err) {
        setText("[data-github-complete-status]", safeSetupError(err, "Could not link the GitHub installation."));
      }
    });

    $("[data-channel-form]")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      try {
        setText("[data-channel-form-status]", "Saving channel...");
        await fetchJson("/api/admin/channel", {
          method: "POST",
          body: JSON.stringify({
            repo: form.repo.value.trim(),
            channelId: form.channelId.value.trim(),
          }),
        });
        setText("[data-channel-form-status]", "Channel saved.");
        await load({ loadPicker: false });
        setActiveJourneyStep("first_answer", { updateHash: true });
      } catch (err) {
        setText("[data-channel-form-status]", safeSetupError(err, "Could not save the channel right now."));
      }
    });
  }

  function startLiveUpdates() {
    if (!window.EventSource) {
      startFallbackPolling("Polling status");
      return;
    }

    setLiveState("Checking setup", "connecting");
    const source = new EventSource("/api/admin/events");
    state.eventSource = source;

    source.onopen = () => {
      setLiveState("Live", "online");
    };

    source.addEventListener("signed-out", () => {
      source.close();
      renderSignedOut();
      setLiveState("Admin access required", "offline");
    });

    source.addEventListener("snapshot", (event) => {
      state.lastSnapshotAt = Date.now();
      setLiveState("Live", "online");
      try {
        applySnapshot(JSON.parse(event.data));
      } catch {
        setLiveState("Status unavailable", "offline");
      }
    });

    source.addEventListener("error", () => {
      setLiveState("Reconnecting", "connecting");
      if (!state.lastSnapshotAt) {
        window.setTimeout(() => {
          if (!state.lastSnapshotAt) startFallbackPolling("Polling status");
        }, 6000);
        return;
      }
      if (Date.now() - state.lastSnapshotAt > 15000) {
        startFallbackPolling("Polling status");
      }
    });
  }

  function startFallbackPolling(label) {
    if (state.fallbackTimer) return;
    state.eventSource?.close();
    setLiveState(label, "connecting");
    state.fallbackTimer = window.setInterval(() => {
      if (document.hidden) return;
      load({ loadPicker: false }).catch(() => setLiveState("Status unavailable", "offline"));
    }, 5000);
  }

  function setLiveState(text, stateName = "connecting") {
    $$("[data-live-state]").forEach((node) => {
      node.textContent = text;
      node.dataset.state = stateName;
    });
  }

  function showError(err) {
    renderSteps({});
    setText("[data-tenant-name]", "Not connected");
    setText("[data-onboarding-state]", "Needs Slack");
    setText("[data-slack-status]", "Disconnected");
    setText("[data-github-status]", "Disconnected");
    setText("[data-repo-form-status]", "Could not load setup status.");
    setText("[data-github-complete-status]", "");
    setLiveState("Status unavailable", "offline");
  }

  function safeSetupError(err, fallback) {
    const message = String(err?.message || err || "").trim();
    if (!message) return fallback;
    if (/access|sign.?in|authenticated|permission/i.test(message) && message.length <= 96) return message;
    if (/not configured|secret|private key|d1_error|sqlite|cannot read properties|undefined|stack|token|binding/i.test(message)) {
      return fallback;
    }
    if (message.length > 120) return fallback;
    return message;
  }

  function setText(selector, text) {
    $$(selector).forEach((node) => {
      node.textContent = text;
    });
  }

  function renderGithubCallbackUrl() {
    setText("[data-github-callback-url]", `${window.location.origin}/oauth/github/callback`);
  }

  function progressPercent(repo) {
    const status = (repo.status || "").toUpperCase();
    if (status === "READY") return 100;
    if (status === "FAILED") return 100;
    const indexed = Number(repo.indexedFiles || 0);
    const total = Number(repo.totalFiles || 0);
    if (total > 0) return Math.max(3, Math.min(99, Math.round((indexed / total) * 100)));
    if (Number(repo.totalChunks || 0) > 0) return 70;
    return 4;
  }

  function sortedRepos(repos) {
    return repos
      .filter((repo) => repo?.fullName)
      .sort((a, b) => a.fullName.localeCompare(b.fullName, undefined, { sensitivity: "base" }));
  }

  function persistedRepoSet() {
    return new Set((state.summary?.repos || []).map((repo) => repo.fullName).filter(Boolean));
  }

  function splitRepo(fullName) {
    const [owner, name] = String(fullName).split("/");
    return { owner: owner || "", name: name || fullName };
  }

  function formatNumber(value) {
    return new Intl.NumberFormat().format(Number(value || 0));
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    })[char]);
  }

  bindForms();
  {
    const hashStep = journeyStepFromHash();
    if (hashStep) setActiveJourneyStep(hashStep);
  }
  renderGithubCallbackUrl();

  const params = new URLSearchParams(window.location.search);
  const urlError = params.get("error");
  if (urlError) {
    const safeError = safeSetupError(urlError, "Setup could not continue. Try again from this step.");
    setText("[data-slack-status]", safeError);
    setText("[data-github-status]", safeError);
    setText("[data-repo-form-status]", safeError);
  }
  if (params.get("github") === "connected") {
    setText("[data-github-status]", "Connected");
    setText("[data-github-complete-status]", "GitHub install linked to this workspace.");
  }

  load()
    .then((authenticated) => {
      if (authenticated) startLiveUpdates();
    })
    .catch(showError);
})();
