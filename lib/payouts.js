// Utbetalningar från Stripe till Hanamis bankkonto, avstämda mot webbens försäljning (köksvyn → Utbetalningar).
//
// Källa = Hanamis anslutna Stripe-konto (STRIPE_ACCOUNT), alltså exakt det som går till banken:
//   • payout            en överföring till bankkontot (arrival_date = dagen pengarna når banken, status paid/in_transit/…)
//   • balanstransaktion type payment        en kortbetalning: amount = vad gästen betalade, fee = transaktionsavgiften,
//                                            net = vad Hanami får. source = py_… → source_transfer → source_transaction
//                                            (plattformens charge) → payment_intent = kolumnen "Stripe" i arket.
//   • balanstransaktion type payment_refund  en återbetalning (negativ)
// Webbens siffror (Apps Script reportOrders, samma som Rapport) räknar vad som SKA komma: online kort − återbetalt − avgift.
// Skillnad per dag ≠ 0 betyder att något inte stämmer (t.ex. betalning som saknas i arket).
import { stripe } from "./stripe.js";
import { stockholmMidnight } from "./platform.js";

const TZ = "Europe/Stockholm";
const kr = ore => Math.round(ore) / 100;
const r2 = n => Math.round(n * 100) / 100;
const dayOf = unix => new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(unix * 1000));
const addDays = (date, n) => { const d = new Date(date + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const SALE_TYPES = new Set(["payment", "charge"]);
const REFUND_TYPES = new Set(["payment_refund", "refund", "payment_failure_refund", "transfer_refund"]);
const EXPAND = ["data.source.source_transfer.source_transaction"];

/** payment_intent för en balanstransaktion (om Stripe gav den expanderad). */
export function piOf(bt) {
  const src = bt && typeof bt.source === "object" ? bt.source : null;
  if (!src) return "";
  const ch = src.source_transfer && typeof src.source_transfer === "object" ? src.source_transfer.source_transaction : null;
  if (ch && typeof ch === "object") return typeof ch.payment_intent === "string" ? ch.payment_intent : ch.payment_intent?.id || "";
  return typeof src.payment_intent === "string" ? src.payment_intent : "";
}

/**
 * Ren avstämning (testbar).
 *   sales      balanstransaktioner skapade i perioden (anslutna kontot)
 *   payouts    payouts (med .bts = deras balanstransaktioner)
 *   orders     webbens order (reportOrders) med pi, d, no, total, refunded, online
 *   from, to   perioden (ÅÅÅÅ-MM-DD)
 *   balance    { pending, available } i öre (bara för "nu")
 */
export function reconcile({ sales = [], payouts = [], orders = [], from, to, balance = null, feeOf = () => 0 }) {
  const byPi = new Map(orders.filter(o => o.pi).map(o => [o.pi, o]));
  const btPayout = new Map();
  for (const p of payouts) for (const bt of p.bts || []) btPayout.set(bt.id, p);

  // ---- utbetalningar som når banken i perioden ----
  const list = payouts
    .filter(p => p.arrival >= from && p.arrival <= to)
    .sort((a, b) => b.arrival.localeCompare(a.arrival))
    .map(p => {
      const items = (p.bts || []).filter(bt => bt.type !== "payout").map(bt => {
        const pi = piOf(bt), o = byPi.get(pi);
        return { type: SALE_TYPES.has(bt.type) ? "sale" : REFUND_TYPES.has(bt.type) ? "refund" : "other",
          day: o?.d || dayOf(bt.created), no: o?.no || "", pi, amount: kr(bt.amount), fee: kr(bt.fee), net: kr(bt.net) };
      }).sort((a, b) => a.day.localeCompare(b.day) || a.no.localeCompare(b.no));
      const days = [...new Set(items.map(i => i.day))].sort();
      return { id: p.id, arrival: p.arrival, amount: kr(p.amount), status: p.status, method: p.method || "standard",
        bank: p.bank || "", orders: items.filter(i => i.type === "sale").length,
        gross: r2(items.filter(i => i.type === "sale").reduce((s, i) => s + i.amount, 0)),
        fee: r2(items.reduce((s, i) => s + i.fee, 0)),
        refunds: r2(-items.filter(i => i.type === "refund").reduce((s, i) => s + i.amount, 0)),
        days: days.length ? [days[0], days[days.length - 1]] : [], items };
    });

  // ---- avstämning per försäljningsdag: webben vs Stripe ----
  const blank = () => ({ webOnline: 0, webRefunded: 0, webFee: 0, webExpected: 0, stripeGross: 0, stripeFee: 0, stripeRefunds: 0, stripeNet: 0,
    paidOut: 0, inTransit: 0, waiting: 0, payoutDates: [], orders: 0, missing: [] });
  const days = new Map();
  const get = d => days.get(d) || days.set(d, blank()).get(d);
  for (let d = from; d <= to; d = addDays(d, 1)) get(d);

  for (const o of orders) {
    if (!o.online || !o.d || o.d < from || o.d > to) continue;
    const t = get(o.d), fee = feeOf(o.total), refunded = Math.min(Number(o.refunded) || 0, Number(o.total) || 0);
    t.webOnline += Number(o.total) || 0; t.webRefunded += refunded; t.webFee += fee; t.orders++;
  }
  const seenPi = new Set();
  for (const bt of sales) {
    if (bt.type === "payout" || bt.type === "payout_cancel" || bt.type === "payout_failure") continue;
    const pi = piOf(bt), o = byPi.get(pi);
    const day = (SALE_TYPES.has(bt.type) && o?.d) ? o.d : dayOf(bt.created);
    if (day < from || day > to) continue;
    const t = get(day), net = kr(bt.net);
    if (SALE_TYPES.has(bt.type)) { t.stripeGross += kr(bt.amount); t.stripeFee += kr(bt.fee); if (pi) seenPi.add(pi); if (!o && pi) t.missing.push(pi); }
    else if (REFUND_TYPES.has(bt.type)) t.stripeRefunds += -kr(bt.amount);
    t.stripeNet += net;
    const p = btPayout.get(bt.id);
    if (p && p.status === "paid") { t.paidOut += net; if (!t.payoutDates.includes(p.arrival)) t.payoutDates.push(p.arrival); }
    else if (p) { t.inTransit += net; if (!t.payoutDates.includes(p.arrival)) t.payoutDates.push(p.arrival); }
    else t.waiting += net;
  }
  const dayList = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, t]) => {
    t.webExpected = t.webOnline - t.webRefunded - t.webFee;
    for (const k of Object.keys(t)) if (typeof t[k] === "number") t[k] = r2(t[k]);
    t.diff = r2(t.stripeNet - t.webExpected);
    t.payoutDates.sort();
    return { date, ...t };
  });
  // order som är onlinebetalda i arket men saknas hos Stripe (bara för information)
  const notInStripe = orders.filter(o => o.online && o.pi && o.d >= from && o.d <= to && !seenPi.has(o.pi)).map(o => o.no);

  const sum = k => r2(dayList.reduce((s, d) => s + d[k], 0));
  return {
    from, to,
    payouts: list,
    days: dayList,
    total: {
      paidToBank: r2(list.filter(p => p.status === "paid").reduce((s, p) => s + p.amount, 0)),
      onTheWay: r2(list.filter(p => p.status === "in_transit" || p.status === "pending").reduce((s, p) => s + p.amount, 0)),
      webOnline: sum("webOnline"), webRefunded: sum("webRefunded"), webFee: sum("webFee"), webExpected: sum("webExpected"),
      stripeGross: sum("stripeGross"), stripeFee: sum("stripeFee"), stripeRefunds: sum("stripeRefunds"), stripeNet: sum("stripeNet"),
      paidOut: sum("paidOut"), inTransit: sum("inTransit"), waiting: sum("waiting"), diff: sum("diff"), orders: sum("orders")
    },
    balance: balance ? { pending: kr(balance.pending), available: kr(balance.available) } : null,
    notInStripe
  };
}

/* ---------------- hämta från Stripe ---------------- */

async function listAll(path, params, account, max = 20) {
  const out = [];
  let starting_after;
  for (let page = 0; page < max; page++) {
    const r = await stripe("GET", path, { ...params, limit: 100, starting_after }, { account });
    out.push(...r.data);
    if (!r.has_more || !r.data.length) break;
    starting_after = r.data[r.data.length - 1].id;
  }
  return out;
}

/** Balanstransaktioner med expanderad källa (för order-koppling). Faller tillbaka utan expansion om Stripe nekar. */
async function bts(params, account) {
  try { return await listAll("/balance_transactions", { ...params, expand: EXPAND }, account); }
  catch (e) { console.warn("[payouts] utan expansion:", e.message); return listAll("/balance_transactions", params, account); }
}

const sumSek = arr => (arr || []).filter(x => x.currency === "sek").reduce((s, x) => s + x.amount, 0);

/** Hämtar allt för perioden och stämmer av mot webbens order (getOrders(from, to) → reportOrders-rader). */
export async function payoutReport(from, to, getOrders, { feeOf } = {}) {
  const account = process.env.STRIPE_ACCOUNT;
  if (!account) throw new Error("STRIPE_ACCOUNT saknas.");
  const start = stockholmMidnight(from), end = stockholmMidnight(addDays(to, 1));
  const today = dayOf(Date.now() / 1000);

  // utbetalningar som når banken i perioden + de närmaste 14 dagarna (där ligger periodens sista försäljning)
  const payoutEnd = stockholmMidnight(addDays(to < today ? to : today, 15));
  const [salesBts, rawPayouts, bal] = await Promise.all([
    bts({ created: { gte: start, lt: end } }, account),
    listAll("/payouts", { arrival_date: { gte: start, lt: payoutEnd }, expand: ["data.destination"] }, account),
    to >= today ? stripe("GET", "/balance", {}, { account }).catch(() => null) : Promise.resolve(null)
  ]);
  const payouts = [];
  for (const p of rawPayouts.slice(0, 40)) {
    const dest = p.destination && typeof p.destination === "object" ? p.destination : null;
    payouts.push({ id: p.id, amount: p.amount, status: p.status, arrival: dayOf(p.arrival_date), method: p.method,
      bank: dest ? `${dest.bank_name || "Bank"} ••${dest.last4 || ""}` : "",
      bts: await bts({ payout: p.id }, account) });
  }
  // webbens order för alla dagar som förekommer (utbetalningar kan innehålla försäljning före perioden)
  let first = from;
  for (const p of payouts) for (const bt of p.bts) { const d = dayOf(bt.created); if (d < first) first = d; }
  const orders = await getOrders(first, to);
  const balance = bal ? { pending: sumSek(bal.pending), available: sumSek(bal.available) } : null;
  return reconcile({ sales: salesBts, payouts, orders, from, to, balance, feeOf });
}

/** CSV (semikolon, decimalkomma) – en rad per dag och en rad per utbetalning. */
export function payoutCsv(rep) {
  const num = n => String(n ?? "").replace(".", ",");
  const out = ["Avstämning per försäljningsdag",
    ["Dag", "Order online", "Webben: online kort", "Återbetalt", "Transaktionsavgift", "Ska till banken", "Stripe netto", "Utbetalt", "På väg", "Väntar hos Stripe", "Skillnad", "Utbetalningsdag"].join(";"),
    ...rep.days.map(d => [d.date, d.orders, d.webOnline, d.webRefunded, d.webFee, d.webExpected, d.stripeNet, d.paidOut, d.inTransit, d.waiting, d.diff, d.payoutDates.join(" ")]
      .map((v, i) => i === 0 || i === 11 ? v : num(v)).join(";")),
    "", "Utbetalningar till bankkontot",
    ["Till banken", "Belopp", "Status", "Order", "Försäljning", "Avgift", "Återbetalt", "Försäljningsdagar", "Stripe-id"].join(";"),
    ...rep.payouts.map(p => [p.arrival, num(p.amount), p.status, p.orders, num(p.gross), num(p.fee), num(p.refunds), p.days.join("–"), p.id].join(";"))];
  return "﻿" + out.join("\r\n") + "\r\n";
}
