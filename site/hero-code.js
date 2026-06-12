/*
 * "Sea of code" hero: real source from this repo, rendered as a dim field.
 * The lighthouse beam sweeps across and illuminates it; the cursor acts as a
 * second spotlight. Two pre-rendered text layers (dim/bright) composited
 * through a light map — ~4 drawImage ops per frame, comfortably 60fps.
 */
(() => {
  "use strict";

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const canvas = document.getElementById("codesea");
  if (!canvas || reduceMotion) return; // static gradient fallback stays

  // Real code from workers/slack-bot — the product indexes this very text.
  const CODE = `/**
 * Slack request signature verification.
 * Slack signs \`v0:{timestamp}:{rawBody}\` with SLACK_SIGNING_SECRET (HMAC-SHA256)
 * and sends \`X-Slack-Signature: v0=<hex>\` plus \`X-Slack-Request-Timestamp\`.
 */
export async function verifySlackSignature(input: SlackVerifyInput): Promise<boolean> {
  const { signingSecret, signatureHeader, timestampHeader, rawBody } = input;
  if (!signatureHeader || !timestampHeader) return false;
  if (!signatureHeader.startsWith('v0=')) return false;
  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts)) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > SLACK_TIMESTAMP_SKEW_SECONDS) return false;

/**
 * Merge + rerank retrieved chunks from lexical / vector / graph sources.
 * Heuristics: dedupe by id (keep best score + content), boost exact symbol
 * matches, reward semantic score, and apply a light diversity pass.
 */
const SOURCE_WEIGHT: Record<RetrievedChunk['source'], number> = {
  vector: 1.0,
  lexical: 0.85,
  graph: 0.6,
};
export function rerank(query: ParsedQuery, groups: RetrievedChunk[][], topN = MAX_CONTEXT_CHUNKS) {
  const merged = new Map<string, RetrievedChunk>();
  for (const group of groups) {
    for (const chunk of group) {

/**
 * Retrieval pipeline orchestration:
 *   query understanding -> lexical + vector search -> hydrate -> graph expansion
 *   -> rerank -> context packing.
 */
import { lexicalSearch } from './lexical.js';
import { vectorSearch } from './vector.js';
import { graphExpand } from './graph.js';
import { hydrateContent } from './db.js';
import { rerank } from './rerank.js';
import { packContext, type PackedContext } from './pack.js';
import { agenticRetrieve, type ProgressFn } from './agent.js';
export interface RetrievalOutcome {
  parsed: ParsedQuery;
  chunks: RetrievedChunk[];
  packed: PackedContext;
}`;

  const ctx = canvas.getContext("2d", { alpha: true });
  const FONT_SIZE = 12;
  const LINE_H = 19;
  const CHAR_W = 7.25;

  let W = 0, H = 0, dpr = 1;
  let dimLayer, brightLayer, lightMap, lit;
  let lines = [];

  const mouse = { x: -9999, y: -9999, tx: -9999, ty: -9999 };
  let running = false;
  let rafId = 0;
  let t0 = performance.now();

  function buildLines() {
    // Tile the code to fill the full height, skipping blank-ish lines at seams.
    const src = CODE.split("\n");
    const needed = Math.ceil(H / LINE_H) + 2;
    lines = [];
    for (let i = 0; lines.length < needed; i++) lines.push(src[i % src.length]);
  }

  function renderTextLayer(color) {
    const layer = document.createElement("canvas");
    layer.width = W * dpr;
    layer.height = H * dpr;
    const c = layer.getContext("2d");
    c.scale(dpr, dpr);
    c.font = `${FONT_SIZE}px "JetBrains Mono", monospace`;
    c.textBaseline = "top";
    c.fillStyle = color;
    const cols = Math.ceil(W / CHAR_W) + 2;
    lines.forEach((line, row) => {
      // Stagger horizontal start per row block for a woven texture
      const text = (line || " ").padEnd(cols, "  ").slice(0, cols);
      c.fillText(text, 8, row * LINE_H + 6);
    });
    return layer;
  }

  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.ceil(rect.width);
    H = Math.ceil(rect.height);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    buildLines();
    dimLayer = renderTextLayer("rgba(126, 156, 196, 0.085)");
    brightLayer = renderTextLayer("rgba(244, 220, 165, 0.78)");

    lightMap = document.createElement("canvas");
    lightMap.width = W * dpr; lightMap.height = H * dpr;
    lit = document.createElement("canvas");
    lit.width = W * dpr; lit.height = H * dpr;
  }

  function drawLightMap(time) {
    const c = lightMap.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);

    // --- Sweeping beam cone from above the top-left ---
    const ox = W * 0.28, oy = -H * 0.55;
    const sweep = Math.sin(time * 0.00022) * 0.42; // slow pendulum
    const angle = Math.PI / 2 + sweep;              // pointing mostly down
    const reach = H * 1.9;
    const half = 0.16;                              // cone half-angle (rad)

    const x1 = ox + Math.cos(angle - half) * reach;
    const y1 = oy + Math.sin(angle - half) * reach;
    const x2 = ox + Math.cos(angle + half) * reach;
    const y2 = oy + Math.sin(angle + half) * reach;

    const grad = c.createLinearGradient(ox, oy, ox + Math.cos(angle) * reach, oy + Math.sin(angle) * reach);
    grad.addColorStop(0, "rgba(255,255,255,0.95)");
    grad.addColorStop(0.55, "rgba(255,255,255,0.40)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    c.save();
    c.filter = "blur(26px)"; // soft cone edges
    c.fillStyle = grad;
    c.beginPath();
    c.moveTo(ox, oy);
    c.lineTo(x1, y1);
    c.lineTo(x2, y2);
    c.closePath();
    c.fill();
    c.restore();

    // --- Cursor spotlight (eased follow) ---
    mouse.x += (mouse.tx - mouse.x) * 0.12;
    mouse.y += (mouse.ty - mouse.y) * 0.12;
    if (mouse.tx > -9000) {
      const r = 170;
      const spot = c.createRadialGradient(mouse.x, mouse.y, 0, mouse.x, mouse.y, r);
      spot.addColorStop(0, "rgba(255,255,255,0.9)");
      spot.addColorStop(0.5, "rgba(255,255,255,0.35)");
      spot.addColorStop(1, "rgba(255,255,255,0)");
      c.fillStyle = spot;
      c.beginPath();
      c.arc(mouse.x, mouse.y, r, 0, Math.PI * 2);
      c.fill();
    }
  }

  function frame(time) {
    if (!running) return;
    drawLightMap(time - t0);

    // bright text masked by the light map
    const lc = lit.getContext("2d");
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.clearRect(0, 0, lit.width, lit.height);
    lc.globalCompositeOperation = "source-over";
    lc.drawImage(brightLayer, 0, 0);
    lc.globalCompositeOperation = "destination-in";
    lc.drawImage(lightMap, 0, 0);

    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(dimLayer, 0, 0, W, H);
    ctx.drawImage(lit, 0, 0, W, H);

    rafId = requestAnimationFrame(frame);
  }

  function start() { if (!running) { running = true; rafId = requestAnimationFrame(frame); } }
  function stop() { running = false; cancelAnimationFrame(rafId); }

  // Only animate while the hero is on screen and the tab is visible.
  const io = new IntersectionObserver(
    (entries) => entries.forEach((e) => (e.isIntersecting ? start() : stop())),
    { threshold: 0.05 }
  );
  io.observe(canvas);
  document.addEventListener("visibilitychange", () =>
    document.hidden ? stop() : start()
  );

  const hero = canvas.closest(".hero");
  hero.addEventListener("pointermove", (e) => {
    const rect = canvas.getBoundingClientRect();
    mouse.tx = e.clientX - rect.left;
    mouse.ty = e.clientY - rect.top;
  });
  hero.addEventListener("pointerleave", () => { mouse.tx = -9999; mouse.ty = -9999; });

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 150);
  });

  // Fonts affect glyph rendering; rebuild once mono font is ready.
  resize();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(resize);
})();
