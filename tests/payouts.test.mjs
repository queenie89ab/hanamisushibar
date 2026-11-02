// Utbetalningar från Stripe avstämda mot webben (lib/payouts.js + /api/admin?view=payouts).
import assert from "node:assert/strict";
process.env.STRIPE_SECRET_KEY = "sk_test_x"; process.env.STRIPE_ACCOUNT = "acct_h"; process.env.ADMIN_KEY = "admin";
process.env.GAS_URL = "https://script.google.com/macros/s/x/exec"; process.env.GAS_SECRET = "hemlig";
const { reconcile, piOf, payoutReport, payoutCsv } = await import("../lib/payouts.js");
const { stockholmMidnight } = await import("../lib/platform.js");
let n = 0; const ok = s => { n++; console.log("  ✓", s); };
console.log("Utbetalningar (Stripe → bank)");

const at = (date, hh) => stockholmMidnight(date) + hh * 3600;
const pay = (id, date, hh, amountKr, feeKr, pi) => ({ id, type: "payment", created: at(date, hh), amount: amountKr * 100, fee: feeKr * 100, net: (amountKr - feeKr) * 100,
  source: { id: "py_" + id, source_transfer: { id: "tr_" + id, source_transaction: { id: "ch_" + id, payment_intent: pi } } } });
const fee = kr => Math.round(kr * 4) / 100 + 2;                 // 4 % + 2 kr

// två dagar försäljning: 1/11 två order, 2/11 en order + en återbetalning
const b1 = pay("a", "2026-11-01", 12, 200, fee(200), "pi_a");
const b2 = pay("b", "2026-11-01", 18, 300, fee(300), "pi_b");
const b3 = pay("c", "2026-11-02", 13, 150, fee(150), "pi_c");
const r1 = { id: "r1", type: "payment_refund", created: at("2026-11-02", 15), amount: -5000, fee: 0, net: -5000, source: { id: "pyr_1" } };
const orders = [
  { d: "2026-11-01", no: "H1100", online: true, pi: "pi_a", total: 200, refunded: 0 },
  { d: "2026-11-01", no: "H1101", online: true, pi: "pi_b", total: 300, refunded: 0 },
  { d: "2026-11-01", no: "H1102", online: false, pi: "", total: 99, refunded: 0 },          // Swish – inte Stripe
  { d: "2026-11-02", no: "H1103", online: true, pi: "pi_c", total: 150, refunded: 50 }
];
const po1 = { id: "po_1", arrival: "2026-11-03", status: "paid", amount: b1.net + b2.net, bts: [b1, b2, { id: "x", type: "payout", amount: -(b1.net + b2.net), fee: 0, net: -(b1.net + b2.net), created: at("2026-11-03", 1) }] };
const po2 = { id: "po_2", arrival: "2026-11-04", status: "in_transit", amount: b3.net + r1.net, bts: [b3, r1] };

assert.equal(piOf(b1), "pi_a"); assert.equal(piOf({ source: "py_x" }), "");
ok("payment_intent hittas via py → transfer → charge");

const rep = reconcile({ sales: [b1, b2, b3, r1], payouts: [po1, po2], orders, from: "2026-11-01", to: "2026-11-04", feeOf: fee });
const d1 = rep.days.find(d => d.date === "2026-11-01"), d2 = rep.days.find(d => d.date === "2026-11-02");
assert.equal(d1.orders, 2); assert.equal(d1.webOnline, 500); assert.equal(d1.webFee, fee(200) + fee(300));
assert.equal(d1.stripeNet, d1.webExpected); assert.equal(d1.diff, 0);
assert.equal(d1.paidOut, d1.stripeNet); assert.deepEqual(d1.payoutDates, ["2026-11-03"]);
assert.equal(d2.webExpected, 150 - 50 - fee(150)); assert.equal(d2.stripeNet, d2.webExpected); assert.equal(d2.diff, 0);
assert.equal(d2.inTransit, d2.stripeNet); assert.equal(d2.paidOut, 0);
ok("per dag: webben (online − återbetalt − avgift) = Stripe netto, utbetalt / på väg");

assert.equal(rep.payouts.length, 2); assert.equal(rep.payouts[0].id, "po_2", "senaste först");
const p1 = rep.payouts.find(p => p.id === "po_1");
assert.equal(p1.orders, 2); assert.equal(p1.gross, 500); assert.deepEqual(p1.days, ["2026-11-01", "2026-11-01"]);
assert.deepEqual(p1.items.map(i => i.no), ["H1100", "H1101"]);
assert.equal(rep.total.paidToBank, 500 - fee(200) - fee(300)); assert.equal(rep.total.onTheWay, (b3.net + r1.net) / 100);
assert.equal(rep.total.diff, 0);
ok("utbetalningar: belopp, order, försäljningsdagar, status");

// betalning som saknas i arket → skillnad syns
const rep2 = reconcile({ sales: [b1, b2, pay("z", "2026-11-01", 19, 100, fee(100), "pi_z")], payouts: [], orders, from: "2026-11-01", to: "2026-11-01", feeOf: fee });
assert.equal(rep2.days[0].diff, 100 - fee(100)); assert.deepEqual(rep2.days[0].missing, ["pi_z"]); assert.equal(rep2.days[0].waiting, rep2.days[0].stripeNet);
ok("betalning som saknas i arket ger skillnad och väntar hos Stripe");

const csv = payoutCsv(rep);
assert.match(csv, /Avstämning per försäljningsdag/); assert.match(csv, /2026-11-03;[\d,]+;paid;2;500/);
ok("CSV");

// payoutReport mot ett låtsas-Stripe
const calls = [];
globalThis.fetch = async (url, opt) => {
  calls.push({ url: String(url), account: opt.headers["Stripe-Account"] });
  const u = new URL(url), path = u.pathname.replace("/v1", "");
  const json = d => ({ ok: true, status: 200, text: async () => JSON.stringify(d) });
  if (path === "/payouts") return json({ data: [{ id: "po_1", amount: po1.amount, status: "paid", arrival_date: at("2026-11-03", 2), method: "standard", destination: { bank_name: "NORDEA", last4: "1234" } }], has_more: false });
  if (path === "/balance") return json({ pending: [{ currency: "sek", amount: 12345 }], available: [{ currency: "sek", amount: 0 }] });
  if (path === "/balance_transactions" && u.searchParams.get("payout") === "po_1") return json({ data: po1.bts, has_more: false });
  if (path === "/balance_transactions") return json({ data: [b1, b2, b3], has_more: false });
  throw new Error("okänt anrop " + url);
};
const got = await payoutReport("2026-11-01", "2026-11-02", async () => orders, { feeOf: fee });
assert.ok(calls.every(c => c.account === "acct_h"), "alla anrop mot Hanamis konto");
assert.equal(got.payouts.length, 0, "po_1 når banken 3/11, utanför perioden");
assert.equal(got.days[0].paidOut, got.days[0].stripeNet); assert.deepEqual(got.days[0].payoutDates, ["2026-11-03"]);
assert.equal(got.days[1].waiting, got.days[1].stripeNet);
ok("hämtar från Stripe med Stripe-Account och kopplar försäljningen till utbetalningen");

// /api/platform?kind=payouts – för dagsrapportens mejl (Apps Script, x-report-key)
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opt) => {
  if (String(url).startsWith("https://script.google.com")) return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, orders }), json: async () => ({ ok: true, orders }) };
  return realFetch(url, opt);
};
const { default: platform } = await import("../lib/routes/platform.js");
const res = { statusCode: 200, headers: {}, body: "" };
res.status = c => { res.statusCode = c; return res; }; res.setHeader = (k, v) => { res.headers[k] = v; return res; }; res.end = b => { res.body = String(b ?? ""); return res; };
await platform({ method: "GET", headers: { "x-report-key": "hemlig" }, query: { kind: "payouts", from: "2026-11-01", to: "2026-11-01" } }, res);
assert.equal(res.statusCode, 200, res.body); const body = JSON.parse(res.body);
assert.equal(body.days[0].date, "2026-11-01"); assert.equal(body.days[0].diff, 0);
const res2 = { ...res, statusCode: 200 }; res2.status = c => { res2.statusCode = c; return res2; }; res2.setHeader = () => res2; res2.end = b => { res2.body = b; return res2; };
await platform({ method: "GET", headers: { "x-report-key": "fel" }, query: { kind: "payouts", from: "2026-11-01", to: "2026-11-01" } }, res2);
assert.equal(res2.statusCode, 401);
ok("/api/platform?kind=payouts kräver nyckeln och ger dagens avstämning");

console.log(`payouts.test: ${n} tester OK`);
