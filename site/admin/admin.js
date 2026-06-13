(() => {
  "use strict";

  const stepLabels = {
    slack: "Connect Slack",
    github: "Connect GitHub",
    repos: "Choose repos",
    indexing: "Watch indexing",
    channel: "Map channel",
    first_answer: "First cited answer",
  };
  const stepOrder = Object.keys(stepLabels);
  const isOnboarding = document.body.dataset.adminPage === "onboarding";

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

  async function load() {
    const data = await fetchJson("/api/admin/session");
    if (!data.authenticated) {
      renderSignedOut();
      return;
    }
    renderTenant(data);
    renderSteps(data.steps || {});
    renderRepos(data.repos || []);
    if (isOnboarding) {
      await loadRepoPicker(data);
    }
  }

  function renderSignedOut() {
    renderTenant({ integrations: {}, repos: [], completed: false });
    renderSteps({});
    renderRepos([]);
    setText("[data-onboarding-state]", "Needs Slack");
    setText("[data-repo-picker-status]", "Connect Slack to load repositories.");
    setText("[data-repo-form-status]", "Connect Slack first.");
    const submit = $("[data-repo-submit]");
    if (submit) submit.disabled = true;
    $("[data-repo-picker]")?.querySelectorAll("[data-repo-select]").forEach((node) => node.remove());
  }

  async function loadRepoPicker(onboarding) {
    const picker = $("[data-repo-picker]");
    const status = $("[data-repo-picker-status]");
    const submit = $("[data-repo-submit]");
    if (!picker || !status) return;

    if (!onboarding.integrations?.github) {
      status.textContent = "Connect GitHub to load repositories.";
      picker.querySelectorAll("[data-repo-select]").forEach((node) => node.remove());
      if (submit) submit.disabled = true;
      return;
    }

    status.textContent = "Loading repositories...";
    if (submit) submit.disabled = true;

    try {
      const data = await fetchJson("/api/admin/github/repos");
      renderRepoPicker(data);
      if (submit) submit.disabled = (data.repos || []).length === 0;
      if (data.message && (data.repos || []).length === 0) {
        setText("[data-repo-form-status]", data.message);
        status.classList.add("repo-picker__empty");
      }
    } catch (err) {
      status.textContent = err.message;
      if (submit) submit.disabled = true;
    }
  }

  function renderRepoPicker(data) {
    const picker = $("[data-repo-picker]");
    const status = $("[data-repo-picker-status]");
    if (!picker || !status) return;

    const repos = data.repos || [];
    if (repos.length === 0) {
      picker.innerHTML = "";
      picker.appendChild(status);
      status.textContent = data.message || "No repositories available on this installation.";
      status.classList.add("repo-picker__empty");
      return;
    }

    status.classList.remove("repo-picker__empty");
    const selectedCount = repos.filter((repo) => repo.selected).length;
    status.textContent = `${repos.length} repo${repos.length === 1 ? "" : "s"} available${
      data.installation?.accountLogin ? ` for ${data.installation.accountLogin}` : ""
    }${selectedCount ? ` · ${selectedCount} already selected` : ""}.`;

    const list = document.createElement("select");
    list.className = "repo-picker__select";
    list.multiple = true;
    list.size = Math.min(Math.max(repos.length, 4), 10);
    list.setAttribute("data-repo-select", "");
    list.setAttribute("aria-label", "Repositories to index");
    list.innerHTML = repos.map((repo) => `<option value="${escapeHtml(repo.fullName)}"${repo.selected ? " selected" : ""}>
      ${escapeHtml(repo.fullName)} (${repo.private ? "private" : "public"}, ${escapeHtml(repo.defaultBranch || "main")})
    </option>`).join("");

    picker.innerHTML = "";
    picker.appendChild(status);
    picker.appendChild(list);
  }

  function selectedRepoNames() {
    const select = $("[data-repo-select]");
    if (!select) return [];
    return Array.from(select.selectedOptions).map((option) => option.value);
  }

  function renderTenant(data) {
    const tenantName = data.tenant?.name || data.tenant?.slackTeamId || "Not connected";
    setText("[data-tenant-name]", tenantName);
    setText("[data-slack-status]", data.integrations?.slack ? "Connected" : "Disconnected");
    setText("[data-github-status]", data.integrations?.github ? "Connected" : "Disconnected");
    setText("[data-repo-count]", String((data.repos || []).length));
    setText("[data-onboarding-state]", data.completed ? "Complete" : "In progress");
  }

  function renderSteps(steps) {
    const html = stepOrder
      .map((key, index) => {
        const status = steps[key] || "PENDING";
        return `<li data-state="${escapeHtml(status.toLowerCase())}">
          <span>${String(index + 1).padStart(2, "0")}</span>
          <strong>${escapeHtml(stepLabels[key])}</strong>
          <em>${escapeHtml(status)}</em>
        </li>`;
      })
      .join("");
    $$("[data-step-list]").forEach((node) => {
      node.innerHTML = html;
    });
  }

  function renderRepos(repos) {
    const html = repos.length
      ? `<table>
          <thead><tr><th>Repo</th><th>Status</th><th>Files</th><th>Chunks</th></tr></thead>
          <tbody>
            ${repos.map((repo) => `<tr>
              <td>${escapeHtml(repo.fullName)}</td>
              <td><span class="status-pill" data-state="${escapeHtml((repo.status || "PENDING").toLowerCase())}">${escapeHtml(repo.status || "PENDING")}</span></td>
              <td>${escapeHtml(String(repo.indexedFiles ?? 0))}/${escapeHtml(String(repo.totalFiles ?? "?"))}</td>
              <td>${escapeHtml(String(repo.totalChunks ?? 0))}</td>
            </tr>`).join("")}
          </tbody>
        </table>`
      : `<p class="admin-empty">No repos selected yet. Continue setup to add the first pilot repo.</p>`;
    $$("[data-repo-table]").forEach((node) => {
      node.innerHTML = html;
    });
  }

  function bindForms() {
    $("[data-refresh]")?.addEventListener("click", () => load().catch(showError));

    $("[data-repo-form]")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const repos = selectedRepoNames();
      if (repos.length === 0) {
        setText("[data-repo-form-status]", "Select at least one repository.");
        return;
      }
      try {
        setText("[data-repo-form-status]", "Starting indexing...");
        const result = await fetchJson("/api/admin/repos", {
          method: "POST",
          body: JSON.stringify({ repos }),
        });
        if (result.dispatchErrors?.length) {
          const detail = result.dispatchErrors
            .map((entry) => `${entry.repo}: ${entry.error}`)
            .join(" ");
          setText("[data-repo-form-status]", `Saved repos, but dispatch failed — ${detail}`);
        } else {
          setText("[data-repo-form-status]", `Indexing started for ${repos.length} repo${repos.length === 1 ? "" : "s"}.`);
        }
        await load();
      } catch (err) {
        setText("[data-repo-form-status]", err.message);
      }
    });

    $("[data-repo-select-all]")?.addEventListener("click", () => {
      const select = $("[data-repo-select]");
      if (!select) return;
      Array.from(select.options).forEach((option) => {
        option.selected = true;
      });
    });

    $("[data-repo-clear-all]")?.addEventListener("click", () => {
      const select = $("[data-repo-select]");
      if (!select) return;
      Array.from(select.options).forEach((option) => {
        option.selected = false;
      });
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
      } catch (err) {
        setText("[data-github-complete-status]", err.message);
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
        await load();
      } catch (err) {
        setText("[data-channel-form-status]", err.message);
      }
    });
  }

  function showError(err) {
    renderSteps({});
    setText("[data-tenant-name]", "Not connected");
    setText("[data-onboarding-state]", "Needs Slack");
    const message = err?.message || "Could not load onboarding status.";
    setText("[data-slack-status]", message);
    setText("[data-repo-form-status]", message);
  }

  function setText(selector, text) {
    $$(selector).forEach((node) => {
      node.textContent = text;
    });
  }

  function renderGithubCallbackUrl() {
    setText("[data-github-callback-url]", `${window.location.origin}/oauth/github/callback`);
  }

  function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    })[char]);
  }

  bindForms();
  renderGithubCallbackUrl();
  const params = new URLSearchParams(window.location.search);
  const urlError = params.get("error");
  if (urlError) {
    setText("[data-slack-status]", urlError);
    setText("[data-github-status]", urlError);
    setText("[data-repo-form-status]", urlError);
  }
  if (params.get("github") === "connected") {
    setText("[data-github-status]", "Connected");
    setText("[data-github-complete-status]", "GitHub install linked to this workspace.");
  }
  load().catch(showError);
})();
