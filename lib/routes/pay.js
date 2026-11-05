// Onlinebetalning: kort/wallets med Stripe (Q89 Pay, Stripe Connect – Hanami är säljare, Queenie89 AB är plattform)
// och Swish Handel (lib/swish.js – pengarna går direkt till Hanamis Swish-nummer, ingen plattformsavgift).
//
//   POST /api/pay            samma kropp som /api/submit, payment "online" (kort) eller "swishapi" (Swish)
//                            → kontrollerar beställningen, prissätter i arket
//                            → kort: Stripe Checkout → { url, ref }
//                            → Swish: betalningsförfrågan → { url (tacksidan), ref, sid, token }
//   GET  /api/pay?ref&sid    tacksidan frågar om betalningen är klar → { status, no, total, … }
//                            Swish (sid sw_…): frågar Swish direkt om callbacken inte har kommit än.
//   GET  /api/pay?qr=<token> Swish-QR (SVG) för gäster på dator
//
// Ordern skapas INTE här. Den skapas av Apps Script payConfirm när Stripe (webhooken) eller Swish (callback
// /api/swish eller statusfrågan) bekräftat pengarna. Köket ser därför aldrig obetalda onlinebeställningar.
import settings from "../../data/settings.js";
import { gas } from "../gas.js";
import { wrap, send, body, HttpError, clean } from "../util.js";
import { buildOrder } from "./submit.js";
import { stripe, stripeConfigured, applicationFeeOre, taxRateId } from "../stripe.js";
import { swishConfigured, createPayment, getPayment, qrSvg, SWISH_PREFIX } from "../swish.js";

const SITE = () => (process.env.SITE_URL || `https://${settings.siteHost}`).replace(/\/$/, "");

export default wrap(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") return req.query?.qr ? qr(req, res) : status(req, res);
  if (req.method !== "POST") throw new HttpError(405, "Endast POST.");
  if (body(req).payment === "swishapi") return swishStart(req, res);
  if (!stripeConfigured()) throw new HttpError(503, `Onlinebetalning är inte aktiverad just nu. ${settings.paySwish ? "Välj Swish, eller ring" : "Ring"} ${settings.phone}.`);

  const p = body(req);
  if (p.website) return send(res, 200, { ok: true, url: SITE() + "/meny", ref: "P0000" }); // honungsfälla
  if (p.type !== "pickup-order" && p.type !== "table-order") throw new HttpError(400, "Okänd typ.");
  p.payment = "online";

  // 1) Samma kontroller som /api/submit (öppettider, lunch/happy hour, format)
  const order = buildOrder(p);

  // 2) Prissättning i arket + väntande rad i fliken Betalningar
  const pend = await gas("payPending", { order });
  const totalOre = Math.round(pend.total * 100);

  // 3) Stripe Checkout – destination charge till Hanamis konto, Q89:s avgift dras automatiskt
  // Moms (inkluderad i priset) – utan momssats går betalningen ändå igenom, bara utan momsrad på Stripes kvitto
  const txr = await taxRateId().catch(e => { console.warn("[pay] momssats:", e.message); return undefined; });
  const taxRate = txr ? [txr] : undefined;
  const line_items = pend.lines.map(l => ({
    quantity: l.qty,
    price_data: { currency: "sek", unit_amount: Math.round(l.price * 100),
      product_data: { name: clean(l.name, 120), description: l.note ? clean(l.note, 200) : undefined, metadata: { id: l.id } } },
    tax_rates: taxRate
  }));
  if (pend.tip > 0) line_items.push({ quantity: 1, price_data: { currency: "sek", unit_amount: Math.round(pend.tip * 100), product_data: { name: "Dricks till köket" } } });

  const isTable = order.kind === "table";
  const success = `${SITE()}/tack?ref=${encodeURIComponent(pend.ref)}&sid={CHECKOUT_SESSION_ID}`;
  const cancel = `${SITE()}/meny?avbruten=${encodeURIComponent(pend.ref)}${isTable ? `&bord=${encodeURIComponent(order.table)}` : ""}`;

  let session;
  try {
    session = await stripe("POST", "/checkout/sessions", {
      mode: "payment",
      locale: "sv",
      currency: "sek",
      // Bara kort (inkl. Apple Pay/Google Pay). Swish går via restaurangens eget Swish-nummer utan plattformsavgift –
      // billigare för Hanami. Vill man ha Swish i Stripe senare: lägg till "swish" här och aktivera i Dashboard.
      payment_method_types: ["card"],
      line_items,
      customer_email: order.email || undefined,
      client_reference_id: pend.ref,
      metadata: { ref: pend.ref, kind: order.kind, table: order.table || "", restaurant: "hanami" },
      payment_intent_data: {
        transfer_data: { destination: process.env.STRIPE_ACCOUNT },
        on_behalf_of: process.env.STRIPE_ACCOUNT,          // Hanami står som säljare på kontoutdrag och i Swish-appen
        application_fee_amount: applicationFeeOre(totalOre),
        description: `${settings.name} – ${isTable ? "bord " + order.table : "hämtning"} – ${pend.ref}`,
        metadata: { ref: pend.ref, restaurant: "hanami" }
      },
      custom_text: { submit: { message: isTable ? `Bord ${order.table}. Maten skickas till köket så fort betalningen är klar.` : "Du får ett mejl när maten är klar att hämtas." } },
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      success_url: success,
      cancel_url: cancel
    }, { idempotencyKey: `checkout-${pend.ref}` });
  } catch (e) {
    console.error("[pay] stripe", e.message);
    await gas("payFail", { ref: pend.ref, status: "failed" }).catch(() => {});
    throw new HttpError(502, `Betalningen kunde inte startas. Försök igen om en stund${settings.paySwish ? ", välj Swish" : ""} eller ring ${settings.phone}.`);
  }
  await gas("paySession", { ref: pend.ref, sessionId: session.id });
  return send(res, 200, { ok: true, url: session.url, ref: pend.ref, total: pend.total });
});

async function status(req, res) {
  const ref = clean(req.query?.ref, 20), sid = clean(req.query?.sid, 80);
  if (!/^P[A-Z0-9]{12}$/.test(ref) || !/^(cs_[A-Za-z0-9_]+|sw_[0-9A-F]{32})$/.test(sid)) throw new HttpError(400, "Ogiltig förfrågan.");
  let r = await gas("payStatus", { ref, sessionId: sid }, { timeout: 12000 });
  // Swish: callbacken kan dröja (eller inte nå fram) – fråga Swish själva medan betalningen väntar
  if (sid.startsWith("sw_") && r.status === "väntar" && swishConfigured()) {
    const changed = await swishSync(ref, sid.slice(3)).catch(e => { console.warn("[pay] swish status", ref, e.message); return false; });
    if (changed) r = await gas("payStatus", { ref, sessionId: sid }, { timeout: 12000 });
  }
  return send(res, 200, { ok: true, status: r.status, no: r.no, total: r.total, method: r.method, kind: r.kind, table: r.table, phone: r.phone, email: r.email, when: r.whenText });
}

/* ---------------- Swish Handel ---------------- */

async function swishStart(req, res) {
  if (!swishConfigured()) throw new HttpError(503, `Swish är inte aktiverat just nu. Betala med kort eller ring ${settings.phone}.`);
  const p = body(req);
  if (p.website) return send(res, 200, { ok: true, url: SITE() + "/meny", ref: "P0000" }); // honungsfälla
  if (p.type !== "pickup-order" && p.type !== "table-order") throw new HttpError(400, "Okänd typ.");
  p.payment = "online";
  const order = buildOrder(p);
  const pend = await gas("payPending", { order });
  let sw;
  try {
    sw = await createPayment({ ref: pend.ref, amountOre: Math.round(pend.total * 100),
      message: `${settings.name} ${order.kind === "table" ? "bord " + order.table : "hamtning"} ${pend.ref}`,
      callbackUrl: SITE() + "/api/swish" });
  } catch (e) {
    console.error("[pay] swish", pend.ref, e.message);
    await gas("payFail", { ref: pend.ref, status: "failed" }).catch(() => {});
    throw new HttpError(502, `Swish kunde inte startas. Försök igen om en stund, betala med kort eller ring ${settings.phone}.`);
  }
  const sid = "sw_" + sw.id;
  await gas("paySession", { ref: pend.ref, sessionId: sid });
  const url = `${SITE()}/tack?ref=${encodeURIComponent(pend.ref)}&sid=${sid}&tok=${encodeURIComponent(sw.token)}`;
  return send(res, 200, { ok: true, swish: true, url, ref: pend.ref, sid, token: sw.token, total: pend.total });
}

/**
 * Läser betalningen hos Swish (aldrig callbackens kropp – den är inte signerad) och för över resultatet till arket.
 * Returnerar true om något ändrades. Används av callbacken och av tacksidans statusfråga. Idempotent.
 */
export async function swishSync(ref, id) {
  const sw = await getPayment(id);
  if (sw.payeePaymentReference && sw.payeePaymentReference !== ref) throw new Error(`Swish ${id} hör till ${sw.payeePaymentReference}, inte ${ref}`);
  if (sw.status === "PAID") {
    await gas("payConfirm", { ref, sessionId: "sw_" + id, paymentIntent: SWISH_PREFIX + sw.paymentReference, method: "swish",
      amount: Math.round(Number(sw.amount) * 100) }, { timeout: 25000 });
    return true;
  }
  if (sw.status === "DECLINED" || sw.status === "ERROR" || sw.status === "CANCELLED") {
    await gas("payFail", { ref, status: sw.errorCode === "TM01" ? "expired" : "failed" }, { timeout: 12000 });
    return true;
  }
  return false;   // CREATED – gästen har inte betalat än
}

async function qr(req, res) {
  const token = clean(req.query.qr, 64);
  if (!/^[A-Za-z0-9]{10,64}$/.test(token)) throw new HttpError(400, "Ogiltig förfrågan.");
  const svg = await qrSvg(token).catch(e => { throw new HttpError(502, "QR-koden kunde inte hämtas: " + e.message); });
  res.statusCode = 200;
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "private, max-age=300");
  return res.end(svg);
}
