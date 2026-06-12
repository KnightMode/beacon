/*
 * "Watch it think" — a choreographed replay of the retrieval pipeline.
 * Data-driven scenarios; each run is cancellable when the user switches
 * questions. Reduced motion renders the final state instantly.
 */
(() => {
  "use strict";

  const viz = document.getElementById("viz");
  if (!viz) return;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const SCENARIOS = [
    {
      lanes: {
        fts: [
          { path: "slack-bot/src/signature.ts", score: 0.94, keep: true },
          { path: "slack-bot/src/index.ts", score: 0.71, keep: true },
          { path: "slack-bot/test/signature.test.ts", score: 0.62, keep: false },
        ],
        vec: [
          { path: "signature.ts · verifySlackSignature", score: 0.91, keep: true },
          { path: "slackApi.ts · postMessage", score: 0.48, keep: false },
        ],
        graph: [
          { path: "index.ts → verifySlackSignature", score: 0.66, keep: true },
        ],
      },
      planner: ["planner ▸ evidence sufficient — no follow-up tools needed"],
      answer:
        "In verifySlackSignature (workers/slack-bot/src/signature.ts) [1]. It recomputes the HMAC-SHA256 of v0:{timestamp}:{rawBody} with SLACK_SIGNING_SECRET, compares against X-Slack-Signature, and rejects requests outside the allowed timestamp skew — replay protection. Every entry route calls it before any work [2].",
      cites: ["workers/slack-bot/src/signature.ts:21-44", "workers/slack-bot/src/index.ts:58-71"],
    },
    {
      lanes: {
        fts: [
          { path: "github-webhook/src/webhook.ts", score: 0.89, keep: true },
          { path: "slack-bot/src/actions/ciTriage.ts", score: 0.86, keep: true },
        ],
        vec: [
          { path: "ciTriage.ts · runTriage", score: 0.9, keep: true },
          { path: "triageMessage.ts · format", score: 0.7, keep: true },
          { path: "notifyChannels.ts", score: 0.55, keep: false },
        ],
        graph: [
          { path: "webhook.ts → enqueueTriageJob", score: 0.72, keep: true },
        ],
      },
      planner: [
        "planner ▸ missing log handling → read_file(ci/logExcerpt.ts)",
        "planner ▸ +1 chunk · extractFailureExcerpt",
      ],
      answer:
        "The webhook worker catches failed workflow_run events on indexed repos and enqueues a triage job [1]. The slack-bot consumer dedupes per run + attempt, pulls the failed jobs' logs [2], grounds a diagnosis in the log excerpt plus the head commit's diff, and posts it — cited — to the repo's mapped channel [3]. Transient signatures (timeouts, OOM, runner death) short-circuit to a re-run note before any LLM call.",
      cites: [
        "workers/github-webhook/src/webhook.ts:104-141",
        "workers/slack-bot/src/ci/logExcerpt.ts:12-58",
        "workers/slack-bot/src/actions/ciTriage.ts:61-118",
      ],
    },
    {
      lanes: {
        fts: [
          { path: "slack-bot/src/llm.ts", score: 0.84, keep: true },
          { path: "slack-bot/src/answer.ts", score: 0.78, keep: true },
        ],
        vec: [
          { path: "answer.ts · buildPrompt", score: 0.88, keep: true },
          { path: "retrieval/pack.ts · packContext", score: 0.74, keep: true },
        ],
        graph: [
          { path: "answer.ts → packContext", score: 0.6, keep: false },
        ],
      },
      planner: ["planner ▸ verifying prompt boundary → search('untrusted')", "planner ▸ confirmed · instruction-injection guard"],
      answer:
        "Retrieved code is wrapped as untrusted data: the system prompt instructs the model to treat fenced chunks strictly as evidence, never as instructions [1]. Context packing keeps chunks delimited and budgeted [2], and every [n] marker in the answer must map back to a packed chunk — anything else is dropped.",
      cites: ["workers/slack-bot/src/answer.ts:33-61", "workers/slack-bot/src/retrieval/pack.ts:18-52"],
    },
  ];

  const lanes = {
    fts: viz.querySelector('[data-lane="fts"]'),
    vec: viz.querySelector('[data-lane="vec"]'),
    graph: viz.querySelector('[data-lane="graph"]'),
  };
  const planner = document.getElementById("planner");
  const plannerLines = planner.querySelector(".planner__lines");
  const verdict = document.getElementById("verdict");
  const verdictFill = verdict.querySelector(".verdict__fill");
  const verdictText = verdict.querySelector(".verdict__text");
  const verdictCites = verdict.querySelector(".verdict__cites");
  const chips = document.querySelectorAll(".q-chip");

  let runToken = 0;

  const wait = (ms, token) =>
    new Promise((res) => setTimeout(() => res(token === runToken), ms));

  function clearStage() {
    Object.values(lanes).forEach((lane) => {
      lane.querySelector(".lane__chips").innerHTML = "";
      lane.classList.remove("is-live");
    });
    plannerLines.innerHTML = "";
    planner.classList.remove("is-live");
    verdict.classList.remove("is-live", "is-done");
    verdictFill.style.width = "0%";
    verdictText.textContent = "";
    verdictCites.innerHTML = "";
  }

  function chipEl(item) {
    const el = document.createElement("span");
    el.className = "r-chip" + (item.keep ? " will-keep" : "");
    el.innerHTML = `<i>${item.path}</i><b>${item.score.toFixed(2)}</b>`;
    return el;
  }

  function renderFinal(s) {
    clearStage();
    Object.entries(s.lanes).forEach(([key, items]) => {
      const lane = lanes[key];
      lane.classList.add("is-live");
      items.forEach((it) => {
        const el = chipEl(it);
        el.classList.add("is-in");
        if (!it.keep) el.classList.add("is-cut");
        lane.querySelector(".lane__chips").appendChild(el);
      });
    });
    planner.classList.add("is-live");
    s.planner.forEach((line) => {
      const p = document.createElement("p");
      p.textContent = line;
      p.classList.add("is-in");
      plannerLines.appendChild(p);
    });
    verdict.classList.add("is-live", "is-done");
    verdictFill.style.width = "100%";
    verdictText.textContent = s.answer;
    s.cites.forEach((c, i) => {
      const a = document.createElement("span");
      a.className = "cite is-in";
      const [path, lines_] = c.split(/:(?=[\d-]+$)/);
      a.innerHTML = `<span>[${i + 1}] ${path}</span><b>:${lines_}</b>`;
      verdictCites.appendChild(a);
    });
  }

  async function play(idx) {
    const token = ++runToken;
    const s = SCENARIOS[idx];
    clearStage();

    if (reduceMotion) { renderFinal(s); return; }

    // 1 — lanes fan out in parallel, chips staggered
    const laneKeys = ["fts", "vec", "graph"];
    laneKeys.forEach((key, li) => {
      setTimeout(() => {
        if (token !== runToken) return;
        lanes[key].classList.add("is-live");
        s.lanes[key].forEach((it, ci) => {
          setTimeout(() => {
            if (token !== runToken) return;
            const el = chipEl(it);
            lanes[key].querySelector(".lane__chips").appendChild(el);
            requestAnimationFrame(() => el.classList.add("is-in"));
          }, 260 + ci * 240);
        });
      }, li * 180);
    });

    const fanout = 260 + 180 * 2 + Math.max(...Object.values(s.lanes).map((l) => l.length)) * 240;
    if (!(await wait(fanout + 250, token))) return;

    // 2 — planner lines type in
    planner.classList.add("is-live");
    for (const line of s.planner) {
      const p = document.createElement("p");
      plannerLines.appendChild(p);
      for (let i = 0; i <= line.length; i++) {
        p.textContent = line.slice(0, i);
        if (!(await wait(9, token))) return;
      }
      p.classList.add("is-in");
      if (!(await wait(260, token))) return;
    }

    // 3 — rerank: cut the weak chips, fill the bar
    verdict.classList.add("is-live");
    document.querySelectorAll(".r-chip:not(.will-keep)").forEach((el) => el.classList.add("is-cut"));
    verdictFill.style.width = "100%";
    if (!(await wait(750, token))) return;

    // 4 — answer types out, then citations slide in
    verdict.classList.add("is-done");
    const words = s.answer.split(" ");
    for (let i = 0; i < words.length; i++) {
      verdictText.textContent = words.slice(0, i + 1).join(" ");
      if (!(await wait(26, token))) return;
    }
    for (let i = 0; i < s.cites.length; i++) {
      const c = s.cites[i];
      const a = document.createElement("span");
      a.className = "cite";
      const [path, lines_] = c.split(/:(?=[\d-]+$)/);
      a.innerHTML = `<span>[${i + 1}] ${path}</span><b>:${lines_}</b>`;
      verdictCites.appendChild(a);
      requestAnimationFrame(() => a.classList.add("is-in"));
      if (!(await wait(160, token))) return;
    }
  }

  chips.forEach((chip) =>
    chip.addEventListener("click", () => {
      chips.forEach((c) => {
        c.classList.toggle("is-active", c === chip);
        c.setAttribute("aria-selected", c === chip ? "true" : "false");
      });
      play(Number(chip.dataset.q));
    })
  );

  // Auto-play the first scenario when the section scrolls into view.
  let played = false;
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting && !played) {
          played = true;
          play(0);
          io.disconnect();
        }
      });
    },
    { threshold: 0.35 }
  );
  io.observe(viz);
})();
