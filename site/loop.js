/*
 * The Loop spine: a sticky rail whose beam tracks scroll progress and lights
 * the active stage. State updates (active node) run regardless of motion
 * preference — they're not animation; only the beam's glow easing is motion.
 */
(() => {
  "use strict";

  const grid = document.querySelector(".loop__grid");
  const stages = Array.from(document.querySelectorAll(".stage"));
  const nodes = Array.from(document.querySelectorAll(".spine__node"));
  const beam = document.getElementById("spineBeam");
  const track = document.querySelector(".spine__track");
  if (!grid || !stages.length || !nodes.length) return;

  let active = -1;
  let ticking = false;

  function setActive(i) {
    if (i === active) return;
    active = i;
    nodes.forEach((n, k) => n.classList.toggle("is-active", k === i));
    stages.forEach((s, k) => s.classList.toggle("is-active", k === i));
  }

  function update() {
    ticking = false;
    const vh = window.innerHeight;
    const focus = vh * 0.42; // the line the active stage should cross

    // Active stage = last one whose top has passed the focus line.
    let idx = 0;
    for (let i = 0; i < stages.length; i++) {
      if (stages[i].getBoundingClientRect().top <= focus) idx = i;
    }
    setActive(idx);

    // Beam position = scroll progress through the loop grid, mapped to track.
    if (beam && track) {
      const g = grid.getBoundingClientRect();
      const total = g.height - vh;
      const progress = total > 0 ? Math.min(Math.max((focus - g.top) / (g.height - focus), 0), 1) : 0;
      const reach = track.clientHeight - beam.offsetHeight;
      beam.style.transform = `translateY(${progress * reach}px)`;
    }
  }

  function onScroll() {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });

  // Spine nodes jump to their stage.
  nodes.forEach((node) => {
    node.style.cursor = "pointer";
    node.setAttribute("role", "link");
    node.setAttribute("tabindex", "0");
    const go = () => {
      const s = stages[Number(node.dataset.stage)];
      if (s) s.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    node.addEventListener("click", go);
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
  });

  update();
})();
