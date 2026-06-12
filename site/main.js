(() => {
  "use strict";
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---- Sticky nav state ---- */
  const nav = document.getElementById("nav");
  const onScroll = () => nav.classList.toggle("is-stuck", window.scrollY > 40);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  /* ---- Scroll beam (JS fallback when scroll-driven CSS is unsupported) ---- */
  const beamFill = document.getElementById("scrollBeamFill");
  const cssScrollTimeline = CSS.supports?.("animation-timeline: scroll()");
  if (beamFill && !cssScrollTimeline && !reduceMotion) {
    let ticking = false;
    const updateBeam = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      beamFill.style.transform = `scaleY(${max > 0 ? window.scrollY / max : 0})`;
      ticking = false;
    };
    window.addEventListener("scroll", () => {
      if (!ticking) { ticking = true; requestAnimationFrame(updateBeam); }
    }, { passive: true });
    updateBeam();
  }

  /* ---- Hero sky parallax (cheap: transform only) ---- */
  const sky = document.querySelector(".hero__sky");
  if (sky && !reduceMotion) {
    let ticking = false;
    const updateSky = () => {
      const y = Math.min(window.scrollY, window.innerHeight);
      sky.style.transform = `translateY(${y * 0.25}px)`;
      ticking = false;
    };
    window.addEventListener("scroll", () => {
      if (!ticking) { ticking = true; requestAnimationFrame(updateSky); }
    }, { passive: true });
  }

  /* ---- Scroll reveals ---- */
  const reveals = document.querySelectorAll(".reveal");
  if (reduceMotion || !("IntersectionObserver" in window)) {
    reveals.forEach((el) => el.classList.add("is-in"));
  } else {
    const io = new IntersectionObserver(
      (entries, obs) => {
        entries.forEach((entry, i) => {
          if (!entry.isIntersecting) return;
          const siblings = Array.from(entry.target.parentElement?.children || []);
          const delay = Math.min(siblings.indexOf(entry.target), 6) * 70;
          setTimeout(() => entry.target.classList.add("is-in"), delay);
          obs.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );
    reveals.forEach((el) => io.observe(el));
  }

  /* ---- Typed demo answer ---- */
  const answer =
    "Because Cloudflare cancels waitUntil work ~30s after the response is sent, " +
    "and PR creation (LLM edit generation + GitHub API calls) can exceed that [1][2]. " +
    "The slash handler enqueues a job instead.";
  const typedEl = document.getElementById("typed");
  const sourcesEl = document.getElementById("sources");
  if (!typedEl) return;

  const showInstant = () => {
    typedEl.textContent = answer;
    if (sourcesEl) sourcesEl.hidden = false;
  };

  if (reduceMotion) {
    showInstant();
    return;
  }

  const cursor = document.createElement("span");
  cursor.className = "cursor";

  let started = false;
  const run = () => {
    if (started) return;
    started = true;
    typedEl.appendChild(cursor);
    let i = 0;
    const tick = () => {
      if (i <= answer.length) {
        cursor.insertAdjacentText("beforebegin", answer[i - 1] || "");
        i++;
        // vary cadence slightly for a natural feel
        setTimeout(tick, answer[i - 2] === "." ? 180 : 14 + Math.random() * 22);
      } else {
        cursor.remove();
        if (sourcesEl) {
          sourcesEl.hidden = false;
          sourcesEl.style.opacity = "0";
          sourcesEl.style.transition = "opacity 0.5s ease";
          requestAnimationFrame(() => (sourcesEl.style.opacity = "1"));
        }
      }
    };
    setTimeout(tick, 500);
  };

  if ("IntersectionObserver" in window) {
    const demoIo = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && run()),
      { threshold: 0.5 }
    );
    demoIo.observe(typedEl);
  } else {
    run();
  }
})();
