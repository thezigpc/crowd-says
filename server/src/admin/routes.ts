import { adminRouter as kitAdminRouter, createAdminAuth, log } from "@bargames/gamekit/server";
import type express from "express";
import type { AdminSettings } from "@crowdsays/shared";
import { ADMIN_PASSWORD, store } from "../config.js";
import { ADMIN_CLOSE_REASON, type Rooms } from "../rooms/registry.js";
import { bg, clientIp, onBox } from "../bargames.js";
import { addPack, getPack, packList, removePack } from "../content/packs.js";
import { clearSaved, savedSummary } from "../content/saved.js";
import { getAdminSettings, updateAdminSettings } from "./settings.js";

/** Largest admin request: a pack upload (CSV or JSON text). Kit 0.9.0's adminRouter bodyLimit. */
const PACK_UPLOAD_LIMIT = "512kb";

/**
 * The admin password (the kit's admin auth): ADMIN_PASSWORD, or a scrypt hash chosen once on
 * the /admin setup screen (DATA_DIR/admin.json). On a box the venue's password works too.
 */
export const adminAuth = createAdminAuth({
  store,
  envPassword: ADMIN_PASSWORD,
  saltFormat: "bytes",
  // Standalone behind Cloudflare a venue's Wi-Fi shares one public IP, so a per-IP lockout
  // would let a guest lock the admin out; the kit's global cap still slows guessing.
  failsAllowed: onBox ? undefined : Infinity,
  venuePassword: (password, ip) => bg.checkVenuePassword(password, ip),
  onBox: bg.connected,
});

/** /api/admin/*: the kit's status, setup, login and logout, then rooms, settings, packs and saved answers. */
export function adminRouter(rooms: Rooms): express.Router {
  // Staff signed in to the venue box open this page without the password (always false standalone).
  const r = kitAdminRouter({ auth: adminAuth, clientIp, trusted: (req) => bg.isStaff(req), bodyLimit: PACK_UPLOAD_LIMIT });

  r.get("/overview", (_req, res) => {
    res.json({
      rooms: rooms.overviews(),
      settings: getAdminSettings(),
      packs: packList(),
      saved: savedSummary(),
      serverTime: Date.now(),
    });
  });

  r.post("/rooms/:code/close", (req, res) => {
    const code = String(req.params.code).toUpperCase();
    const ok = rooms.closeRoom(code, ADMIN_CLOSE_REASON, "admin");
    log.info("admin", "closed room", { code, ok });
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { ok: false, error: "That room is already gone." });
  });

  r.put("/settings", async (req, res) => {
    try {
      const settings = await updateAdminSettings((req.body ?? {}) as Partial<AdminSettings>);
      rooms.sweepIdle();
      res.json({ ok: true, settings });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : "Couldn't save." });
    }
  });

  // Prompt packs: { name, text } where text is the CSV or JSON file's contents.
  r.post("/packs", async (req, res) => {
    const { name, text } = (req.body ?? {}) as { name?: unknown; text?: unknown };
    if (typeof text !== "string" || !text.trim()) {
      res.status(400).json({ ok: false, error: "Choose a CSV or JSON file first." });
      return;
    }
    try {
      const pack = await addPack(text, typeof name === "string" ? name : "");
      res.json({ ok: true, pack: { id: pack.id, name: pack.name, prompts: pack.prompts.length } });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : "Couldn't read that pack." });
    }
  });

  r.get("/packs/:id", (req, res) => {
    const pack = getPack(String(req.params.id));
    if (!pack) res.status(404).json({ ok: false, error: "No such pack." });
    else res.json({ ok: true, pack });
  });

  r.delete("/packs/:id", async (req, res) => {
    const ok = await removePack(String(req.params.id));
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { ok: false, error: "That pack is already gone." });
  });

  r.delete("/saved", (_req, res) => {
    clearSaved();
    log.info("admin", "saved answers cleared");
    res.json({ ok: true });
  });

  return r;
}
