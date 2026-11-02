// /api/admin – köksvyn. Header x-admin-key = ADMIN_KEY.
//   GET  ?view=orders&date=YYYY-MM-DD
//   GET  ?view=bookings&from=YYYY-MM-DD
//   GET  ?view=menu
//   POST { kind: "order"|"booking", no, status }
//   POST { kind: "soldout", id, soldOut }
//   POST { kind: "reprint", no }        skriv ut kvittot igen
//   GET  ?view=settings                 förberedelsetid
//   GET  ?view=report&from&to[&by=days|months][&format=csv]   omsättning per dag/månad (lib/report.js)
//   GET  ?view=payouts&from&to[&format=csv]   utbetalningar från Stripe till bankkontot, avstämda mot webben (lib/payouts.js)
//   POST { kind: "lead", minutes }      ändrar förberedelsetiden
//   POST { kind: "paid", no, paid }     markerar en beställning som betald
//   POST { kind: "refund", no, amount? } återbetalar en onlinebetald beställning via Stripe (amount i kr, utan = allt som är kvar)
import settings from "../../data/settings.js";
import { gas } from "../gas.js";
import { wrap, send, body, HttpError, requireAdmin, isDate } from "../util.js";
import { stripe, stripeConfigured, applicationFeeOre } from "../stripe.js";
import { swishConfigured, createRefund, getRefund, SWISH_PREFIX } from "../swish.js";
import { summarize, reportCsv } from "../report.js";
import { payoutReport, payoutCsv } from "../payouts.js";

export default wrap(async (req, res) => {
  requireAdmin(req);
  const q = req.query || {};
  if (req.method === "GET") {
    if (q.view === "orders") return send(res, 200, await gas("adminOrders", { date: isDate(q.date) ? q.date : "" }));
    if (q.view === "bookings") return send(res, 200, await gas("adminBookings", { from: isDate(q.from) ? q.from : "" }));
    if (q.view === "menu") return send(res, 200, await gas("adminMenu"));
    if (q.view === "settings") return send(res, 200, await gas("adminSettings"));
    if (q.view === "report") return report(req, res, q);
    if (q.view === "payouts") return payouts(req, res, q);
  }
  if (req.method === "POST") {
    const p = body(req);
    if (p.kind === "order" || p.kind === "booking")
      return send(res, 200, await gas("adminStatus", { kind: p.kind, no: String(p.no || ""), status: String(p.status || "") }));
    if (p.kind === "reprint")
      return send(res, 200, await gas("printAgain", { no: String(p.no || "") }));
    if (p.kind === "soldout")
      return send(res, 200, await gas("adminSoldOut", { id: String(p.id || ""), soldOut: !!p.soldOut }));
    if (p.kind === "ordering")
      return send(res, 200, await gas("adminOrdering", { open: !!p.open, message: String(p.message || "").slice(0, 200) }));
    if (p.kind === "lead")
      return send(res, 200, await gas("adminLead", { minutes: Number(p.minutes) }));
    if (p.kind === "paid")
      return send(res, 200, await gas("adminPaid", { no: String(p.no || ""), paid: !!p.paid }));
    if (p.kind === "refund")
      return send(res, 200, await refund(p));
  }
  throw new HttpError(400, "Okänd förfrågan.");
});

const kr = ore => (ore / 100).toLocaleString("sv-SE", { maximumFractionDigits: 2 });

/**
 * Återbetalning från köksvyn – chefen behöver inte logga in i Stripe.
 * Stripe är facit för hur mycket som är kvar att återbetala (inte arket). reverse_transfer: pengarna dras tillbaka
 * från Hanamis Stripe-konto, inte från plattformen. Plattformsavgiften återbetalas inte (Villkor för företagskunder §4)
 * om inte STRIPE_REFUND_FEE=1. Arket och gästmejlet sköts av Apps Script (refunded); webhooken charge.refunded gör
 * samma sak om den här anteckningen skulle misslyckas, och för återbetalningar gjorda direkt i Stripe Dashboard.
 */
export async function refund(p) {
  const no = String(p.no || "").trim().slice(0, 20);
  if (!no) throw new HttpError(400, "Ordernummer saknas.");
  const o = await gas("refundInfo", { no });
  if (String(o.stripe || "").startsWith(SWISH_PREFIX)) return refundSwish(no, o, p.amount);
  if (!stripeConfigured()) throw new HttpError(503, "Onlinebetalning (Stripe) är inte aktiverad.");
  if (!/^pi_/.test(o.stripe || "")) throw new HttpError(400, `${no} är inte betald online. Swish eller kontant återbetalas direkt till gästen.`);

  const pi = await stripe("GET", `/payment_intents/${o.stripe}`, { "expand[]": "latest_charge" });
  const ch = pi.latest_charge;
  if (!ch || typeof ch !== "object" || ch.status !== "succeeded") throw new HttpError(409, `Betalningen för ${no} är inte genomförd i Stripe.`);
  const remaining = ch.amount_captured - ch.amount_refunded;
  if (remaining <= 0) throw new HttpError(409, `${no} är redan helt återbetald.`);
  const raw = p.amount;
  const want = raw === undefined || raw === null || raw === "" ? remaining : Math.round(Number(String(raw).replace(",", ".")) * 100);
  if (!Number.isFinite(want) || want < 100 || want > remaining) throw new HttpError(400, `Ange ett belopp mellan 1 och ${kr(remaining)} kr.`);

  let r;
  try {
    r = await stripe("POST", "/refunds", {
      payment_intent: pi.id, amount: want, reason: "requested_by_customer",
      reverse_transfer: true,                                          // dra tillbaka pengarna från Hanamis konto
      refund_application_fee: process.env.STRIPE_REFUND_FEE === "1",  // standard: plattformsavgiften behålls
      metadata: { order: no, source: "koksvyn" }
    }, { idempotencyKey: `refund-${pi.id}-${ch.amount_refunded}-${want}` });
  } catch (e) {
    console.error("[refund]", no, e.message);
    throw new HttpError(422, `Stripe nekade återbetalningen: ${e.stripe?.message || e.message}`);
  }
  const total = ch.amount_refunded + want;
  const noted = await gas("refunded", { no, refundedOre: total, capturedOre: ch.amount_captured, source: "köksvyn" })
    .then(() => true, e => { console.error("[refund] arket", no, e.message); return false; });
  return { ok: true, no, refund: r.id, status: r.status, amount: want / 100, refunded: total / 100, remaining: (ch.amount_captured - total) / 100, noted };
}

/**
 * Återbetalning av Swish Handel-betalning: pengarna går från Hanamis Swish-konto tillbaka till gästens Swish.
 * Arket är facit för hur mycket som redan återbetalats (Swish ger inget saldo per betalning). Svaret från Swish
 * kommer inom några sekunder; hinner det inte antecknas det av callbacken (/api/swish).
 */
async function refundSwish(no, o, raw) {
  if (!swishConfigured()) throw new HttpError(503, "Swish är inte aktiverat.");
  const totalOre = Math.round(Number(o.total) * 100), already = Math.round(Number(o.refunded || 0) * 100);
  const remaining = totalOre - already;
  if (remaining <= 0) throw new HttpError(409, `${no} är redan helt återbetald.`);
  const want = raw === undefined || raw === null || raw === "" ? remaining : Math.round(Number(String(raw).replace(",", ".")) * 100);
  if (!Number.isFinite(want) || want < 100 || want > remaining) throw new HttpError(400, `Ange ett belopp mellan 1 och ${kr(remaining)} kr.`);
  const total = already + want;
  let r;
  try {
    r = await createRefund({ originalPaymentReference: o.stripe.slice(SWISH_PREFIX.length), amountOre: want, ref: `${no}T${total}`,
      message: `Aterbetalning ${no} ${settings.name}`, callbackUrl: (process.env.SITE_URL || `https://${settings.siteHost}`).replace(/\/$/, "") + "/api/swish" });
  } catch (e) {
    console.error("[refund swish]", no, e.message);
    throw new HttpError(422, `Swish nekade återbetalningen: ${e.message}`);
  }
  let status = "CREATED";
  for (let i = 0; i < 5 && status !== "PAID" && status !== "ERROR" && status !== "DECLINED"; i++) {
    await new Promise(ok => setTimeout(ok, 1500));
    status = await getRefund(r.id).then(x => x.status, () => status);
  }
  if (status === "ERROR" || status === "DECLINED") throw new HttpError(422, `Swish kunde inte genomföra återbetalningen av ${no}. Kontrollera saldot på Swish-kontot och försök igen.`);
  const noted = status === "PAID" && await gas("refunded", { no, refundedOre: total, capturedOre: totalOre, source: "köksvyn Swish" })
    .then(() => true, e => { console.error("[refund swish] arket", no, e.message); return false; });
  return { ok: true, no, refund: r.id, status: status === "PAID" ? "succeeded" : "pending", amount: want / 100, refunded: total / 100, remaining: (totalOre - total) / 100, noted, swish: true };
}

/** Omsättningsrapport. Högst 13 månader per anrop (Apps Script läser även arkivet). */
async function payouts(req, res, q) {
  if (!isDate(q.from) || !isDate(q.to) || q.from > q.to) throw new HttpError(400, "Ange from och to som ÅÅÅÅ-MM-DD.");
  if ((Date.parse(q.to) - Date.parse(q.from)) / 864e5 > 92) throw new HttpError(400, "Högst 3 månader åt gången.");
  if (!stripeConfigured()) throw new HttpError(503, "Stripe är inte konfigurerat (STRIPE_SECRET_KEY / STRIPE_ACCOUNT).");
  const start = settings.reportFrom && q.from < settings.reportFrom ? settings.reportFrom : q.from;   // allt före reportFrom var test
  if (start > q.to) return send(res, 200, { ok: true, from: q.from, to: q.to, payouts: [], days: [], total: {}, balance: null, notInStripe: [] });
  const getOrders = async (from, to) => {
    const f = settings.reportFrom && from < settings.reportFrom ? settings.reportFrom : from;
    return (await gas("reportOrders", { from: f, to }, { timeout: 25000 })).orders || [];
  };
  let rep;
  try { rep = await payoutReport(start, q.to, getOrders, { feeOf: kr => applicationFeeOre(Math.round((Number(kr) || 0) * 100)) / 100 }); }
  catch (e) { console.error("[admin] payouts", e.message); throw new HttpError(502, "Kunde inte hämta utbetalningar från Stripe just nu. Försök igen om en stund."); }
  if (q.format === "csv") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="hanami-utbetalningar-${q.from}_${q.to}.csv"`);
    res.setHeader("Cache-Control", "no-store");
    return res.end(payoutCsv(rep));
  }
  return send(res, 200, { ok: true, ...rep });
}

async function report(req, res, q) {
  if (!isDate(q.from) || !isDate(q.to) || q.from > q.to) throw new HttpError(400, "Ange from och to som ÅÅÅÅ-MM-DD.");
  if ((Date.parse(q.to) - Date.parse(q.from)) / 864e5 > 400) throw new HttpError(400, "Högst 13 månader åt gången.");
  const data = await gas("reportOrders", { from: q.from, to: q.to }, { timeout: 25000 });
  const rep = summarize(data.orders, { vatPct: Number(process.env.STRIPE_VAT_PCT) || 6, from: settings.reportFrom || "" });
  if (q.format === "csv") {
    const by = q.by === "months" ? "months" : "days";
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="hanami-omsattning-${q.from}_${q.to}.csv"`);
    res.setHeader("Cache-Control", "no-store");
    return res.end(reportCsv(rep, by));
  }
  return send(res, 200, { ok: true, from: q.from, to: q.to, archive: data.archive, ...rep });
}
