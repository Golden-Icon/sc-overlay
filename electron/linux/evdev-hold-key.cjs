"use strict";
const fs = require("node:fs");
const path = require("node:path");
const EV_KEY = 0x01;
const KEY_CODES = Object.freeze({ F: 33, RIGHTALT: 100, ALTRIGHT: 100 });
function normalizeAccelerator(accel) { return String(accel || "").replace(/[+\s_-]/g, "").toUpperCase(); }
function keyCodeForAccelerator(accel) { return KEY_CODES[normalizeAccelerator(accel)] ?? null; }
function listKeyboardEventDevices() {
  const candidates = [];
  for (const dir of ["/dev/input/by-id", "/dev/input/by-path"]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) if (name.endsWith("-event-kbd")) candidates.push(path.join(dir, name));
  }
  const seen = new Set(), result = [];
  for (const candidate of candidates) {
    let real; try { real = fs.realpathSync(candidate); } catch { continue; }
    if (seen.has(real)) continue;
    seen.add(real); result.push({ displayPath: candidate, realPath: real });
  }
  return result;
}
function parseInputEvents(buffer, eventSize = 24) {
  const events = [];
  if (!Buffer.isBuffer(buffer) || eventSize < 8) return events;
  const typeOffset = eventSize - 8, codeOffset = eventSize - 6, valueOffset = eventSize - 4;
  for (let offset = 0; offset + eventSize <= buffer.length; offset += eventSize) {
    events.push({ type: buffer.readUInt16LE(offset + typeOffset), code: buffer.readUInt16LE(offset + codeOffset), value: buffer.readInt32LE(offset + valueOffset) });
  }
  return events;
}
function startEvdevHoldKey({ accelerator, onDown, onUp, log = console } = {}) {
  const targetCode = keyCodeForAccelerator(accelerator);
  if (targetCode == null || typeof onDown !== "function" || typeof onUp !== "function") return { supported: false, stop() {} };
  let stopped = false, scanTimer = null, held = false;
  const streams = new Map(), denied = new Set();
  const releaseIfNeeded = () => { if (!held) return; held = false; try { onUp("evdev"); } catch {} };
  const openDevice = (device) => {
    if (stopped || streams.has(device.realPath)) return;
    const stream = fs.createReadStream(device.realPath, { highWaterMark: 24 * 32 });
    let carry = Buffer.alloc(0);
    streams.set(device.realPath, stream);
    stream.on("open", () => { denied.delete(device.realPath); log.log?.(`[evdev] keyboard input fallback active on ${device.displayPath} for ${accelerator}`); });
    stream.on("data", (chunk) => {
      carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const usable = carry.length - (carry.length % 24); if (usable <= 0) return;
      const parsed = parseInputEvents(carry.subarray(0, usable), 24); carry = carry.subarray(usable);
      for (const event of parsed) {
        if (event.type !== EV_KEY || event.code !== targetCode) continue;
        if (event.value === 1 && !held) { held = true; try { onDown("evdev"); } catch {} }
        else if (event.value === 0 && held) { held = false; try { onUp("evdev"); } catch {} }
      }
    });
    stream.on("error", (error) => {
      streams.delete(device.realPath);
      if (!denied.has(device.realPath)) { denied.add(device.realPath); log.warn?.(`[evdev] cannot read ${device.displayPath}: ${error.message}`); }
      releaseIfNeeded();
    });
    stream.on("close", () => { streams.delete(device.realPath); releaseIfNeeded(); });
  };
  const scan = () => {
    if (stopped) return;
    const devices = listKeyboardEventDevices();
    for (const device of devices) openDevice(device);
    if (!devices.length) log.warn?.("[evdev] no *-event-kbd devices found under /dev/input/by-id or /dev/input/by-path");
    scanTimer = setTimeout(scan, 5000); scanTimer.unref?.();
  };
  scan();
  return { supported: true, stop() { stopped = true; if (scanTimer) clearTimeout(scanTimer); for (const stream of streams.values()) try { stream.destroy(); } catch {}; streams.clear(); releaseIfNeeded(); } };
}
module.exports = { EV_KEY, keyCodeForAccelerator, listKeyboardEventDevices, normalizeAccelerator, parseInputEvents, startEvdevHoldKey };
