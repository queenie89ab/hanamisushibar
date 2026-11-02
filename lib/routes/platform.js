// GET /api/platform?date=YYYY-MM-DD – plattformsrapport för Queenie89 AB (lib/platform.js).
// Bara för Apps Script (PlatformReport.js): header x-report-key = GAS_SECRET. Köksvyns lösenord räcker INTE –
// restaurangen ska inte se plattformens intäkter.
import crypto from "node:crypto";
import { wrap, send, HttpError, isDate } from "../util.js";
import { stripeConfigured } from "../stripe.js";
import { platformDay } from "../platform.js";
import { payoutReport } from "../payouts.js";
import { applicationFeeOre } from "../stripe.js";
import { gas } from "../gas.js";

export default wrap(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const want = process.env.GAS_SECRET || "", got = String(req.headers?.["x-report-key"] || "");
  if (!want || got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) throw new HttpError(401, "Fel nyckel.");
  if (req.method !== "GET") throw new HttpError(405, "Endast GET.");
  if (!stripeConfigured()) throw new HttpError(503, "Stripe är inte konfigurerat.");
  // ?kind=payouts&from&to – Hanamis utbetalningar till banken + avstämning mot webben (dagsrapportens mejl, ReportMail.js)
  if (req.query?.kind === "payouts") {
    const from = String(req.query.from || ""), to = String(req.query.to || "");
    if (!isDate(from) || !isDate(to) || from > to) throw new HttpError(400, "Ange from och to.");
    const rep = await payoutReport(from, to, async (f, t) => (await gas("reportOrders", { from: f, to: t }, { timeout: 25000 })).orders || [],
      { feeOf: kr => applicationFeeOre(Math.round((Number(kr) || 0) * 100)) / 100 });
    return send(res, 200, { ok: true, ...rep });
  }
  const date = String(req.query?.date || "");
  if (!isDate(date)) throw new HttpError(400, "Ange date=ÅÅÅÅ-MM-DD.");
  return send(res, 200, { ok: true, ...(await platformDay(date)) });
});
