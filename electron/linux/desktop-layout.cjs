"use strict";

const { execFileSync } = require("node:child_process");

function integerEnv(env, name, fallback = null) {
  const raw = env?.[name];
  if (raw == null || raw === "" || /^(auto|detected)$/i.test(String(raw).trim())) return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : fallback;
}

function rectUnion(rects) {
  if (!Array.isArray(rects) || !rects.length) return null;
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.width));
  const maxY = Math.max(...rects.map((r) => r.y + r.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function normalizeMonitor(m) {
  if (!m) return null;
  const x = Number(m.x), y = Number(m.y), width = Number(m.width), height = Number(m.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return {
    name: String(m.name || "display"),
    id: m.id == null ? null : String(m.id),
    x, y, width, height,
    primary: !!m.primary,
    priority: m.priority == null ? null : (Number.isFinite(Number(m.priority)) ? Number(m.priority) : null),
  };
}

function parseKScreenDoctor(output) {
  const monitors = [];
  let current = null;
  const flush = () => {
    if (!current || current.enabled === false || !current.geometry) return;
    const n = normalizeMonitor({
      name: current.name, id: current.id,
      x: current.geometry.x, y: current.geometry.y,
      width: current.geometry.width, height: current.geometry.height,
      priority: current.priority, primary: current.priority === 1,
    });
    if (n) monitors.push(n);
  };
  for (const raw of String(output || "").split(/\r?\n/)) {
    const line = raw.trim();
    let m = line.match(/^Output:\s+(\d+)\s+(\S+)/);
    if (m) { flush(); current = { id: m[1], name: m[2], enabled: null, priority: null, geometry: null }; continue; }
    if (!current) continue;
    if (line === "enabled") current.enabled = true;
    else if (line === "disabled") current.enabled = false;
    else if ((m = line.match(/^priority\s+(-?\d+)/i))) current.priority = Number(m[1]);
    else if ((m = line.match(/^Geometry:\s*(-?\d+)\s*,\s*(-?\d+)\s+(\d+)x(\d+)/i))) {
      current.geometry = { x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]) };
    }
  }
  flush();
  return monitors;
}

function parseXRandRListMonitors(output) {
  const monitors = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const m = line.match(/^\s*\d+:\s+([^\s]+)\s+(\d+)\/[0-9.]+x(\d+)\/[0-9.]+([+-]\d+)([+-]\d+)\s+(\S+)/);
    if (!m) continue;
    const n = normalizeMonitor({
      name: m[6], x: Number(m[4]), y: Number(m[5]), width: Number(m[2]), height: Number(m[3]),
      primary: m[1].includes("*"), priority: m[1].includes("*") ? 1 : null,
    });
    if (n) monitors.push(n);
  }
  return monitors;
}

function parseXRandRQuery(output) {
  const monitors = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+connected(\s+primary)?\s+(\d+)x(\d+)([+-]\d+)([+-]\d+)/);
    if (!m) continue;
    const n = normalizeMonitor({ name: m[1], x: Number(m[5]), y: Number(m[6]), width: Number(m[3]), height: Number(m[4]), primary: !!m[2], priority: m[2] ? 1 : null });
    if (n) monitors.push(n);
  }
  return monitors;
}

function choosePrimary(monitors, electronPrimary = null) {
  if (!monitors.length) return electronPrimary;
  const direct = monitors.find((m) => m.primary) || monitors.find((m) => m.priority === 1);
  if (direct) return direct;
  if (electronPrimary) {
    const cx = electronPrimary.x + electronPrimary.width / 2;
    const cy = electronPrimary.y + electronPrimary.height / 2;
    const hit = monitors.find((m) => cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height);
    if (hit) return hit;
  }
  return monitors[0];
}

function runText(command, args) {
  return String(execFileSync(command, args, { encoding: "utf8", timeout: 2500, stdio: ["ignore", "pipe", "ignore"] }));
}

function electronMonitors(screen) {
  const primaryId = screen.getPrimaryDisplay()?.id;
  return screen.getAllDisplays().map((d) => normalizeMonitor({
    id: d.id, name: d.label || `display-${d.id}`,
    x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
    primary: d.id === primaryId, priority: d.id === primaryId ? 1 : null,
  })).filter(Boolean);
}

function detectMonitors(screen, platform = process.platform) {
  if (platform === "linux") {
    for (const command of ["kscreen-doctor", "kscreen-doctor6"]) {
      try { const monitors = parseKScreenDoctor(runText(command, ["-o"])); if (monitors.length) return { monitors, source: command }; } catch {}
    }
    try { const monitors = parseXRandRListMonitors(runText("xrandr", ["--listmonitors"])); if (monitors.length) return { monitors, source: "xrandr --listmonitors" }; } catch {}
    try { const monitors = parseXRandRQuery(runText("xrandr", ["--query"])); if (monitors.length) return { monitors, source: "xrandr --query" }; } catch {}
  }
  return { monitors: electronMonitors(screen), source: "electron" };
}

function buildLayout({ screen, env = process.env, platform = process.platform } = {}) {
  const detected = detectMonitors(screen, platform);
  const monitors = detected.monitors.sort((a, b) => (a.x - b.x) || (a.y - b.y));
  const desktop = rectUnion(monitors) || { x: 0, y: 0, width: 1920, height: 1080 };
  const pb = screen.getPrimaryDisplay().bounds;
  const electronPrimary = { x: pb.x, y: pb.y, width: pb.width, height: pb.height };
  const primary = choosePrimary(monitors, electronPrimary) || { ...electronPrimary, name: "primary", primary: true };
  const canvas = {
    x: integerEnv(env, "SC_OVERLAY_CANVAS_X", desktop.x),
    y: integerEnv(env, "SC_OVERLAY_CANVAS_Y", desktop.y),
    width: Math.max(1, integerEnv(env, "SC_OVERLAY_CANVAS_WIDTH", desktop.width)),
    height: Math.max(1, integerEnv(env, "SC_OVERLAY_CANVAS_HEIGHT", desktop.height)),
  };
  const zoneWidth = Math.min(canvas.width, Math.max(320, integerEnv(env, "SC_OVERLAY_DEFAULT_ZONE_WIDTH", 1920)));
  const zoneHeight = Math.min(canvas.height, Math.max(240, integerEnv(env, "SC_OVERLAY_DEFAULT_ZONE_HEIGHT", 1080)));
  const defaultZone = { x: Math.round((canvas.width - zoneWidth) / 2), y: Math.round((canvas.height - zoneHeight) / 2), width: zoneWidth, height: zoneHeight };
  return { source: detected.source, monitors, desktop, primary, canvas, defaultZone };
}

module.exports = {
  integerEnv, rectUnion, normalizeMonitor, parseKScreenDoctor, parseXRandRListMonitors,
  parseXRandRQuery, choosePrimary, detectMonitors, buildLayout,
};
