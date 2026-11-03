// Testar Apps Script-koden mot en simulerad Google Sheet: node tests/apps-script.test.cjs
const assert = require("assert");
const { makeEnv } = require("./gas-mock.cjs");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ✓ " + name); }

const E = makeEnv();
E.api.setup();
Object.assign(E.props, { NOTIFY_EMAIL: "kok@test.se", ELKS_USER: "u", ELKS_PASSWORD: "p", VERCEL_DEPLOY_HOOK: "https://api.vercel.com/hook" });
const today = E.ctx.Utilities.formatDate(new Date(), "Europe/Stockholm", "yyyy-MM-dd");

console.log("Apps Script");
test("setup skapar flikar, triggers och nyckel", () => {
  assert.deepEqual(Object.keys(E.sheets).sort(), ["Beställningar", "Betalningar", "Bokningar", "Logg", "Meny"]);
  // sendReportMail (engång 00.01 natten efter) läggs alltid
  // engångstriggers: sendReportMail 00.01, sendPeriodReports 00.03 (bara lördag/sista dagen)
  assert.deepEqual(E.log.triggers.filter(t => t !== "sendReportMail" && t !== "sendPeriodReports"), ["handleEdit", "resetSoldOut", "nightlyCleanup", "scheduleReportMail"]);
  assert.equal(E.props.CLEANUP_ENABLED, "off");
  assert.ok(E.props.API_SECRET.length > 30);
});
test("setupCheck rapporterar utan att ändra", () => {
  const n = E.log.alerts.length; E.api.setupCheck();
  assert.match(E.log.alerts[n], /Beställningar: \d+ rader/); assert.match(E.log.alerts[n], /Triggers: /);   // mocken har inga riktiga triggers
});
test("loggen kapas i ett anrop när den blir stor", () => {
  const sh = E.sheets["Logg"]; for (let i = 0; i < 3100; i++) sh.appendRow(["2026-01-01 00:00:00", "INFO", "x", ""]);
  E.ctx.log_("INFO", "test", "efter kapning");
  assert.ok(sh.getLastRow() - 1 <= 1001, "max ~1000 rader kvar: " + (sh.getLastRow() - 1));
  assert.equal(sh.data[sh.getLastRow() - 1][2], "test");
  sh.deleteRows(2, sh.getLastRow() - 1);                   // städa efter testet
});
test("setup kan köras igen utan att dubblera menyn", () => {
  const n = E.sheets["Meny"].getLastRow(); E.api.setup(); assert.equal(E.sheets["Meny"].getLastRow(), n);
});
test("fel nyckel nekas", () => assert.equal(E.call("health", {}, "fel").status, 401));
test("menyn läses från arket", () => {
  const m = E.call("menu").menu;
  assert.ok(m.length > 10 && m[0].items.length > 0);
});
let order;
test("beställning räknar pris från arket, inte från webbläsaren", () => {
  order = E.call("order", { kind: "pickup", name: "Anna", phone: "+46701234567", email: "anna@exempel.se",
    pickupDate: today, pickupTime: "18:00", whenText: "idag kl 18:00",
    items: [{ id: "maki-1", qty: 1, price: 1, note: "utan avokado" }, { id: "poke-1", qty: 2 }] });
  assert.equal(order.ok, true); assert.equal(order.total, 145 + 2 * 165); assert.match(order.no, /^H\d+$/);
});
test("radnotering sparas och följer med till kök och utskrift", () => {
  const row = E.sheets["Beställningar"].data.find(r => r[1] === order.no);
  assert.ok(String(row.join(" ")).includes("utan avokado"));
  const job = E.call("printJob", { no: order.no }).job;
  assert.equal(job.items[0].note, "utan avokado");
  assert.equal(E.call("adminOrders", { date: today }).orders[0].items[0].note, "utan avokado");
});
test("gästen får bekräftelse per e-post", () => {
  const mail = E.log.mails.find(m => (m.to || "") === "anna@exempel.se");
  assert.ok(mail, "inget mejl till gästen");
  assert.match(mail.subject, new RegExp(order.no));
  assert.ok(mail.htmlBody.includes("utan avokado"), "radnoteringen saknas i mejlet");
  const sh = E.sheets["Beställningar"];
  const col = sh.data[0].indexOf("Bekräftelse");
  const row = sh.data.find(r => r[1] === order.no);
  assert.match(String(row[col] || ""), /^\d\d:\d\d$/, "Bekräftelse-kolumnen fylldes inte i");
});
test("okänd rätt och 0-kronorsrätt nekas", () => {
  assert.equal(E.call("order", { kind: "table", table: "1", items: [{ id: "finns-inte", qty: 1 }] }).status, 400);
  assert.equal(E.call("order", { kind: "table", table: "1", items: [{ id: "tillbehor-21", qty: 1 }] }).status, 400);
});
test("slut idag stoppar beställning och syns i availability", () => {
  E.call("adminSoldOut", { id: "maki-2", soldOut: true });
  assert.equal(E.call("availability").items["maki-2"].available, false);
  assert.equal(E.call("order", { kind: "table", table: "1", items: [{ id: "maki-2", qty: 1 }] }).status, 409);
  E.api.resetSoldOut();
  assert.equal(E.call("availability").items["maki-2"].available, true);
});
test("köksvyn listar dagens beställningar", () => {
  const list = E.call("adminOrders", { date: today }).orders;
  assert.equal(list[0].no, order.no); assert.equal(list[0].items.length, 2);
});
test("status Klar skickar sms en gång", () => {
  const before = E.log.sms.length;
  E.call("adminStatus", { kind: "order", no: order.no, status: "Klar" });
  E.call("adminStatus", { kind: "order", no: order.no, status: "Klar" });
  assert.equal(E.log.sms.length, before + 1);
  assert.match(E.log.sms.at(-1).payload.message, /klar att hämtas/);
});
test("sms via egen Android-telefon (sms-gate.app) när SMSGATE_* finns, annars 46elks", () => {
  E.props.SMSGATE_USER = "u"; E.props.SMSGATE_PASSWORD = "p";
  const hooks = E.log.hooks.length, elks = E.log.sms.length;
  assert.equal(E.ctx.sms_("+46701234567", "Hej"), true);
  const h = E.log.hooks.at(-1);
  assert.equal(E.log.hooks.length, hooks + 1); assert.equal(E.log.sms.length, elks, "46elks ska inte användas");
  assert.match(h.url, /sms-gate\.app\/3rdparty\/v1\/message$/);
  assert.deepEqual(JSON.parse(h.payload), { message: "Hej", phoneNumbers: ["+46701234567"] });
  assert.equal(h.headers.Authorization, "Basic " + Buffer.from("u:p").toString("base64"));
  delete E.props.SMSGATE_USER; delete E.props.SMSGATE_PASSWORD;
  E.ctx.sms_("+46701234567", "Hej"); assert.equal(E.log.sms.length, elks + 1);
});
test("bokning + bekräftelse via köksvyn", () => {
  const b = E.call("booking", { date: today, time: "19:00", guests: 3, name: "Erik", phone: "+46709876543", email: "erik@exempel.se", whenText: "idag kl 19:00" });
  assert.ok(E.log.mails.some(m => (m.to || "") === "erik@exempel.se"), "gästen fick ingen bokningsbekräftelse");
  assert.equal(b.ok, true);
  E.call("adminStatus", { kind: "booking", no: b.no, status: "Bekräftad" });
  assert.match(E.log.sms.at(-1).payload.message, /Ditt bord är bokat/);
  assert.equal(E.call("adminBookings", { from: today }).bookings[0].status, "Bekräftad");
});
test("ändring av Status direkt i arket skickar sms", () => {
  const b = E.call("booking", { date: today, time: "19:30", guests: 2, name: "Sara", phone: "+46700000000", whenText: "idag kl 19:30" });
  const sh = E.sheets["Bokningar"];
  const statusCol = sh.data[0].indexOf("Status") + 1;          // kolumnen kan flytta när nya fält tillkommer
  const row = sh.data.findIndex(r => r[1] === b.no) + 1;
  sh.data[row - 1][statusCol - 1] = "Avböjd";
  E.api.handleEdit({ range: sh.getRange(row, statusCol), value: "Avböjd" });
  assert.match(E.log.sms.at(-1).payload.message, /fullbokat/);
});
test("dold rätt försvinner från menyn direkt efter redigering", () => {
  const sh = E.sheets["Meny"]; const row = sh.data.findIndex(r => r[3] === "lunch-1") + 1;
  sh.data[row - 1][7] = false; E.api.handleEdit({ range: sh.getRange(row, 8), value: false });
  assert.equal(E.call("menu").menu[0].items.some(i => i.id === "lunch-1"), false);
});
test("skrivarkö: nya beställningar hämtas, markeras utskrivna och kan skrivas ut igen", () => {
  const q1 = E.call("printQueue").jobs;
  assert.ok(q1.some(j => j.no === order.no) && q1[0].items.length > 0);
  E.call("printDone", { no: order.no });
  assert.ok(!E.call("printQueue").jobs.some(j => j.no === order.no));
  assert.match(E.call("adminOrders", { date: today }).orders.find(o => o.no === order.no).printed, /^\d\d:\d\d$/);
  const job = E.call("printJob", { no: order.no }).job;
  assert.equal(job.no, order.no); assert.equal(job.total, order.total); assert.equal(job.items[0].name, "California");
  E.call("printAgain", { no: order.no });
  assert.ok(E.call("printQueue").jobs.some(j => j.no === order.no));
  E.call("printDone", { no: order.no });
});
test("publicera anropar Vercel deploy hook", () => {
  E.api.publishSite(); assert.equal(E.log.hooks.at(-1).url, "https://api.vercel.com/hook");
});
test("inga fel i loggen", () => assert.deepEqual(E.sheets["Logg"].data.slice(1).filter(r => r[1] === "ERROR"), []));
test("byte i sushimix: tillägg läggs på arkets pris och valen följer med till köket", () => {
  const o = E.call("order", { kind: "table", table: "2", items: [{ id: "sushi-4", qty: 2, extra: 10, detail: "Maki: 5 California", note: "extra ingefära" }] });
  assert.equal(o.total, 2 * (205 + 10));
  const row = E.sheets["Beställningar"].data.find(r => r[1] === o.no);
  assert.match(row[10], /Maki: 5 California · extra ingefära/);
  assert.equal(E.call("order", { kind: "table", table: "2", items: [{ id: "sushi-4", qty: 1, extra: -10 }] }).status, 400);
  assert.equal(E.call("order", { kind: "table", table: "2", items: [{ id: "varmt-1", qty: 1, extra: 15, detail: "Extra gyoza × 1" }] }).total, 129 + 15);
});
test("köket kan höja förberedelsetiden och för tidiga hämtningar nekas", () => {
  assert.equal(E.call("adminSettings").leadMinutes, 0);
  E.call("adminLead", { minutes: 90 });
  assert.equal(E.call("adminSettings").leadMinutes, 90);
  assert.equal(E.call("availability").leadMinutes, 90);
  const nowMin = Number(E.ctx.Utilities.formatDate(new Date(), "Europe/Stockholm", "HH")) * 60 +
                 Number(E.ctx.Utilities.formatDate(new Date(), "Europe/Stockholm", "mm"));
  const soon = pad2(Math.floor(((nowMin + 20) % 1440) / 60)) + ":" + pad2((nowMin + 20) % 60);
  const r = E.call("order", { kind: "pickup", name: "Anna", phone: "+46701234567", pickupDate: today, pickupTime: soon,
    whenText: "idag", items: [{ id: "maki-1", qty: 1 }] });
  assert.equal(r.status, 400);
  assert.match(r.error, /90 minuter/);
  assert.equal(E.call("adminLead", { minutes: 2 }).status, 400);
  E.call("adminLead", { minutes: 15 });
});
test("hämtning asap: tiden räknas av Apps Script från köksvyns förberedelsetid, öppning och stängning", () => {
  const nowMin = Number(E.ctx.Utilities.formatDate(new Date(), "Europe/Stockholm", "HH")) * 60 +
                 Number(E.ctx.Utilities.formatDate(new Date(), "Europe/Stockholm", "mm"));
  const hhmm = m => pad2(Math.floor(m / 60)) + ":" + pad2(m % 60);
  const base = { kind: "pickup", name: "Anna", phone: "+46701234567", asap: true, defaultLead: 30,
    pickupDate: today, pickupTime: "00:00", whenText: "x", items: [{ id: "maki-1", qty: 1 }] };
  if (nowMin > 1380) return;                                    // testet körs inte runt midnatt
  E.call("adminLead", { minutes: 45 });
  let r = E.call("order", { ...base, openFrom: 0, closeAt: 1440 });
  const want = hhmm(Math.ceil((nowMin + 45) / 5) * 5);
  assert.equal(r.pickupTime, want); assert.equal(r.whenText, "idag kl " + want);
  const row = E.sheets["Beställningar"].data.find(x => x[1] === r.no);
  assert.ok(row.includes(want), "arket får den räknade tiden, inte klientens");
  // före öppning: klar kl öppning (om köket hinner till dess)
  const open = Math.min(nowMin + 60, 1300);
  r = E.call("order", { ...base, openFrom: open, closeAt: 1440 });
  assert.equal(r.pickupTime, hhmm(Math.max(open, Math.ceil((nowMin + 45) / 5) * 5)));
  // nära stängning: tiden får bli efter stängning (beställt 20.00 → 20.15)
  r = E.call("order", { ...base, openFrom: 0, closeAt: nowMin + 20 });
  assert.equal(r.pickupTime, want);
  // vald tid (asap av) kl öppning godkänns även om förberedelsetiden inte räcker; annars nekas för tidig tid
  if (nowMin < 1300) {
    const o2 = nowMin + 10;
    r = E.call("order", { ...base, asap: false, pickupTime: hhmm(o2), openFrom: o2 });
    assert.equal(r.ok, true, JSON.stringify(r));
    r = E.call("order", { ...base, asap: false, pickupTime: hhmm(o2), openFrom: 0 });
    assert.equal(r.status, 400);
  }
  // mer än 5 minuter efter stängning: nekas
  if (nowMin >= 10) {
    r = E.call("order", { ...base, openFrom: 0, closeAt: nowMin - 6 });
    assert.equal(r.status, 400); assert.match(r.error, /stängt/);
  }
  E.call("adminLead", { minutes: 15 });
});
test("beställning när det är stängt: hämtas nästa öppna dag, 'slut idag' gäller inte", () => {
  const d = new Date(Date.now() + 36e5 * 24), tomorrow = E.ctx.Utilities.formatDate(d, "Europe/Stockholm", "yyyy-MM-dd");
  E.call("adminLead", { minutes: 30 });
  E.call("adminSoldOut", { id: "maki-1", soldOut: true });
  const base = { kind: "pickup", name: "Natt", phone: "+46701234567", asap: true, defaultLead: 30, openFrom: 660, closeAt: 1200,
    pickupTime: "11:30", whenText: "x", items: [{ id: "maki-1", qty: 1 }] };
  let r = E.call("order", { ...base, pickupDate: tomorrow });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.pickupTime, "11:00"); assert.equal(r.whenText, "imorgon kl 11:00");   // nästa dag: kl öppning
  const row = E.sheets["Beställningar"].data.find(x => x[1] === r.no), head = E.sheets["Beställningar"].data[0];
  assert.equal(row[head.indexOf("Hämtas datum")], tomorrow);
  assert.ok(E.call("printQueue").jobs.some(j => j.no === r.no && j.pickupDate === tomorrow), "skrivs ut med morgondagens datum");
  // samma rätt för idag: fortfarande slut
  r = E.call("order", { ...base, pickupDate: today, openFrom: 0, closeAt: 1440 });
  assert.equal(r.status, 409);
  // datum långt fram nekas
  r = E.call("order", { ...base, pickupDate: "2099-01-01" });
  assert.equal(r.status, 400);
  E.call("adminSoldOut", { id: "maki-1", soldOut: false });
  E.call("adminLead", { minutes: 15 });
});
test("menyändringar från koden förs in i arket en gång", () => {
  const r = E.call("applyMenuPatches", { patches: [{ id: "test-1",
    set: { "barn-1": { name: "Testsushi" } }, hide: ["bubble-3"], notes: { bubble: "Ny text" },
    add: [{ after: "tillbehor-10", id: "tillbehor-99", name: "Testrätt", price: 33 }] }] });
  assert.deepEqual(r.applied, ["test-1"]);
  const menu = E.call("menu").menu, items = menu.flatMap(c => c.items);
  assert.equal(items.find(i => i.id === "barn-1").name, "Testsushi");
  assert.equal(items.find(i => i.id === "tillbehor-99").price, 33);
  assert.equal(menu.find(c => c.id === "tillbehor").items.findIndex(i => i.id === "tillbehor-99"),
               menu.find(c => c.id === "tillbehor").items.findIndex(i => i.id === "tillbehor-10") + 1);
  assert.ok(!items.find(i => i.id === "bubble-3"));
  assert.equal(menu.find(c => c.id === "bubble").note, "Ny text");
  assert.deepEqual(E.call("applyMenuPatches", { patches: [{ id: "test-1", set: { "barn-1": { name: "Igen" } } }] }).applied, []);
  E.call("applyMenuPatches", { patches: [{ id: "test-2", cats: { sushi: { name: "Sushi mix" } } }] });
  assert.equal(E.call("menu").menu.find(c => c.id === "sushi").name, "Sushi mix");
});
function pad2(n) { return String(n).padStart(2, "0"); }
test("betald-markering sparas och följer med till kvittot", () => {
  const o = E.call("order", { kind: "table", table: "5", items: [{ id: "maki-1", qty: 1 }] });
  assert.equal(E.call("printJob", { no: o.no }).job.paid, false);
  E.call("adminPaid", { no: o.no, paid: true });
  assert.equal(E.call("printJob", { no: o.no }).job.paid, true);
  assert.equal(E.call("adminOrders", { date: today }).orders.find(x => x.no === o.no).paid, true);
  E.call("adminPaid", { no: o.no, paid: false });
  assert.equal(E.call("printJob", { no: o.no }).job.paid, false);
  assert.equal(E.call("adminPaid", { no: "H0", paid: true }).status, 404);
});
test("dricks läggs på summan och syns på kvittot", () => {
  const o = E.call("order", { kind: "table", table: "7", tip: 20, items: [{ id: "maki-1", qty: 1 }] });
  assert.equal(o.total, 145 + 20);
  assert.equal(E.call("printJob", { no: o.no }).job.tip, 20);
  const row = E.sheets["Beställningar"].data.find(r => r[1] === o.no);
  assert.equal(Number(row[11]), 20);
  assert.equal(E.call("order", { kind: "table", table: "7", tip: 5000, items: [{ id: "maki-1", qty: 1 }] }).status, 400);
  assert.equal(E.call("order", { kind: "table", table: "7", tip: -5, items: [{ id: "maki-1", qty: 1 }] }).status, 400);
});

/* ---------- onlinebeställning på/av ---------- */
test("köket kan stänga onlinebeställning: servern nekar, menyn syns, bokning fungerar", () => {
  assert.equal(E.call("availability").ordering.open, true);
  const r1 = E.call("adminOrdering", { open: false, message: "Stängt för Swish-byte, ring oss!" });
  assert.equal(r1.open, false); assert.equal(r1.message, "Stängt för Swish-byte, ring oss!");
  assert.equal(E.call("availability").ordering.open, false);
  assert.equal(E.call("adminSettings").ordering.message, "Stängt för Swish-byte, ring oss!");
  const o = E.call("order", { kind: "table", table: "1", items: [{ id: "maki-1", qty: 1 }] });
  assert.equal(o.status, 423); assert.match(o.error, /Swish-byte/);
  const b = E.call("booking", { date: today, time: "19:00", guests: 2, name: "Anna", phone: "+46701234567", whenText: "idag kl 19:00" });
  assert.equal(b.ok, true, "bordsbokning påverkas inte");
  assert.equal(E.call("health").ordering, "closed");
  E.api.testOrder();                                        // intern testbeställning går igenom ändå
  const r2 = E.call("adminOrdering", { open: true });
  assert.equal(r2.open, true); assert.match(r2.message, /tillfälligt stängd/);   // standardtext tillbaka
  assert.equal(E.call("order", { kind: "table", table: "1", items: [{ id: "maki-1", qty: 1 }] }).ok, true);
});

/* ---------- städning ---------- */
console.log("Städning");
const fmt = (d) => E.ctx.Utilities.formatDate(d, "Europe/Stockholm", "yyyy-MM-dd");
const ago = n => fmt(new Date(Date.now() - n * 864e5)) + " 12:00";
const ahead = n => fmt(new Date(Date.now() + n * 864e5));
function seedOrder(no, received, status, extra) {
  const sh = E.sheets["Beställningar"], head = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
  const o = Object.assign({ "Mottagen": received, "Ordernr": no, "Typ": "Hämtning", "Hämtas datum": received.slice(0, 10), "Hämtas tid": "18:00",
    "Namn": "Kalle Kund", "Telefon": "+46701234567", "E-post": "kalle@test.se", "Betalning": "Swish",
    "Beställning": "1 × Maki\n     ↳ utan avokado", "Summa": 145, "Kommentar": "allergisk mot nötter", "Status": status,
    "Rader (data)": JSON.stringify([{ id: "maki-1", qty: 1, note: "utan avokado" }]) }, extra || {});
  sh.appendRow(head.map(h => (o[h] === undefined ? "" : o[h])));
}
function seedBooking(no, received, date, status) {
  const sh = E.sheets["Bokningar"], head = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
  const o = { "Mottagen": received, "Boknr": no, "Datum": date, "Tid": "18:00", "Gäster": 2, "Namn": "Bokare", "Telefon": "+46701234567", "Status": status };
  sh.appendRow(head.map(h => (o[h] === undefined ? "" : o[h])));
}
const ordersBefore = E.sheets["Beställningar"].getLastRow() - 1;
seedOrder("H1", ago(45), "Hämtad");                       // gammal, klar → arkiveras
seedOrder("H2", ago(45), "Avbokad");                      // gammal, avbokad → raderas
seedOrder("H3", ago(3), "Avbokad");                       // nyligen avbokad → kvar
seedOrder("H4", ago(10), "Hämtad");                       // nyligen → kvar
seedOrder("H5", ago(45), "Ny", { "Hämtas datum": ahead(2) }); // beställd för länge sen men hämtas om 2 dagar → kvar
seedBooking("B1", ago(60), fmt(new Date(Date.now() - 50 * 864e5)), "Bekräftad"); // gammal → arkiveras
seedBooking("B2", ago(60), ahead(20), "Bekräftad");       // bokad för länge sen, besöket är om 20 dagar → kvar
E.sheets["Logg"].appendRow([ago(20).replace(" 12:00", " 03:00:00"), "INFO", "Gammal", "x"]);
const logBefore = E.sheets["Logg"].getLastRow() - 1;

test("provkörning räknar men ändrar inget", () => {
  const r = E.api.runCleanup_(true);
  assert.deepEqual([r.archivedOrders, r.archivedBookings, r.purgedCancelled, r.purgedLog], [1, 1, 1, 1]);
  assert.equal(E.sheets["Beställningar"].getLastRow() - 1, ordersBefore + 5);
  assert.equal(Object.keys(E.files).length, 1, "inget arkivark skapas vid provkörning");
  E.api.nightlyCleanup();                                   // CLEANUP_ENABLED=off → fortfarande bara provkörning
  assert.equal(E.sheets["Beställningar"].getLastRow() - 1, ordersBefore + 5);
});
test("städning på riktigt: arkiverar först, raderar sen, rör inte kommande", () => {
  E.api.cleanupEnable();
  E.api.nightlyCleanup();
  const left = E.sheets["Beställningar"].data.slice(1).map(r => r[1]);
  assert.ok(!left.includes("H1") && !left.includes("H2"), "H1 arkiverad, H2 raderad");
  assert.ok(left.includes("H3") && left.includes("H4") && left.includes("H5"), "nyligen avbokad, ny och kommande hämtning kvar");
  const bl = E.sheets["Bokningar"].data.slice(1).map(r => r[1]);
  assert.ok(!bl.includes("B1") && bl.includes("B2"));
  assert.equal(E.sheets["Logg"].data.slice(1).filter(r => r[2] === "Gammal").length, 0, "gammal loggrad borta");
  const arch = E.files[E.props.ARCHIVE_ID];
  assert.ok(arch, "arkivark skapat och id sparat");
  const a = arch.getSheetByName("Beställningar"), head = a.data[0];
  assert.ok(head.includes("Arkiverad") && head.includes("Anonymiserad"));
  const row = a.data.find(r => r[1] === "H1");
  assert.ok(row && row[head.indexOf("Namn")] === "Kalle Kund" && row[head.indexOf("Arkiverad")], "H1 i arkivet med uppgifter kvar (< 12 mån)");
  assert.ok(arch.getSheetByName("Bokningar").data.some(r => r[1] === "B1"));
  assert.ok(E.sheets["Logg"].data.some(r => r[2] === "Städning" && /Arkiverat: 1 beställningar, 1 bokningar/.test(r[3])));
});
test("avidentifiering i arkivet efter 12 månader – belopp och rätter kvar", () => {
  const arch = E.files[E.props.ARCHIVE_ID], a = arch.getSheetByName("Beställningar"), head = a.data[0];
  const row = head.map(h => ({ "Mottagen": ago(400), "Ordernr": "H0", "Hämtas datum": ago(400).slice(0, 10), "Namn": "Gammal Gäst", "Telefon": "+46700000000",
    "E-post": "g@test.se", "Beställning": "2 × Poke\n     ↳ extra chili", "Summa": 330, "Kommentar": "nötallergi", "Status": "Hämtad",
    "Rader (data)": JSON.stringify([{ id: "poke-1", qty: 2, note: "extra chili" }]), "Arkiverad": "2025-01-01 04:30" })[h] ?? "");
  a.appendRow(row);
  E.api.nightlyCleanup();
  const r = a.data.find(x => x[1] === "H0"), g = k => r[head.indexOf(k)];
  assert.equal(g("Namn"), "Gäst"); assert.equal(g("Telefon"), ""); assert.equal(g("E-post"), ""); assert.equal(g("Kommentar"), "");
  assert.equal(g("Beställning"), "2 × Poke"); assert.equal(JSON.parse(g("Rader (data)"))[0].note, "");
  assert.equal(g("Summa"), 330); assert.ok(g("Anonymiserad"));
  const h1 = a.data.find(x => x[1] === "H1");
  assert.equal(h1[head.indexOf("Namn")], "Kalle Kund", "nyare arkivrad rörs inte");
});
test("städningen stör inte beställningar och köksvy", () => {
  const r = E.call("order", { kind: "table", table: "3", items: [{ id: "maki-1", qty: 1 }] });
  assert.equal(r.ok, true);
  assert.ok(E.call("adminOrders", { date: today }).orders.some(o => o.no === r.no));
  assert.equal(E.call("health").cleanup, "on");
  assert.ok(E.call("health").rows.orders > 0);
  E.api.cleanupDisable();
  assert.equal(E.call("health").cleanup, "dry-run");
});

/* ---------------- onlinebetalning (Pay.js) ---------------- */
console.log("Onlinebetalning");
let pend;
test("payPending prissätter mot arket och skapar ingen order", () => {
  const before = E.sheets["Beställningar"].getLastRow();
  pend = E.call("payPending", { order: { kind: "pickup", name: "Bo", phone: "+46701112233", email: "bo@exempel.se", asap: true,
    openFrom: 0, closeAt: 24 * 60, defaultLead: 30, tip: 10, payment: "online", items: [{ id: "maki-1", qty: 2 }] } });
  assert.equal(pend.ok, true); assert.match(pend.ref, /^P[A-Z0-9]{12}$/);
  assert.equal(pend.total, 2 * 145 + 10); assert.equal(pend.lines[0].price, 145);
  assert.equal(E.sheets["Beställningar"].getLastRow(), before, "en order skapades före betalning");
  assert.equal(E.call("paySession", { ref: pend.ref, sessionId: "cs_test_1" }).ok, true);
});
test("payConfirm med fel belopp nekas (409) och skapar ingen order", () => {
  const r = E.call("payConfirm", { ref: pend.ref, sessionId: "cs_test_1", paymentIntent: "pi_1", method: "card", amount: 100 });
  assert.equal(r.status, 409);
  assert.equal(E.call("payStatus", { ref: pend.ref, sessionId: "cs_test_1" }).status, "väntar");
});
test("payConfirm skapar betald order, skriver ut, mejlar och sms:ar", () => {
  const mails = E.log.mails.length, sms = E.log.sms.length;
  const r = E.call("payConfirm", { ref: pend.ref, sessionId: "cs_test_1", paymentIntent: "pi_1", method: "swish", amount: pend.total * 100 });
  assert.equal(r.ok, true); assert.match(r.no, /^H\d+$/); assert.equal(r.total, pend.total);
  const sh = E.sheets["Beställningar"], head = sh.data[0], row = sh.data.find(x => x[head.indexOf("Ordernr")] === r.no);
  assert.equal(row[head.indexOf("Betalning")], "Online Swish");
  assert.match(String(row[head.indexOf("Betald")]), /^\d\d:\d\d$/, "Betald-kolumnen tom");
  assert.equal(row[head.indexOf("Stripe")], "pi_1");
  assert.ok(E.call("printQueue").jobs.some(j => j.no === r.no && j.paid === true), "saknas i utskriftskön eller ej markerad betald");
  assert.ok(E.log.mails.length > mails && E.log.sms.length > sms, "mejl/sms skickades inte");
  assert.ok(E.log.mails.at(-1).htmlBody.includes("Betald online"), "mejlet säger inte betald online");
  const st = E.call("payStatus", { ref: pend.ref, sessionId: "cs_test_1" });
  assert.equal(st.status, "betald"); assert.equal(st.no, r.no); assert.equal(st.method, "Swish");
});
test("payConfirm är idempotent – samma ref ger samma ordernummer, ingen ny order", () => {
  const before = E.sheets["Beställningar"].getLastRow();
  const r = E.call("payConfirm", { ref: pend.ref, sessionId: "cs_test_1", paymentIntent: "pi_1", method: "swish", amount: pend.total * 100 });
  assert.equal(r.already, true); assert.equal(E.sheets["Beställningar"].getLastRow(), before);
});
test("betald beställning för en senare dag: tacksidan, mejlet och arket säger samma dag (inte 'idag')", () => {
  const d = new Date(Date.now() + 864e5), tomorrow = E.ctx.Utilities.formatDate(d, "Europe/Stockholm", "yyyy-MM-dd");
  const p = E.call("payPending", { order: { kind: "pickup", name: "Sen", phone: "+46701112244", email: "sen@exempel.se", asap: false,
    pickupDate: tomorrow, pickupTime: "12:30", whenText: "imorgon kl 12:30", payment: "online", items: [{ id: "maki-1", qty: 1 }] } });
  E.call("paySession", { ref: p.ref, sessionId: "cs_test_sen" });
  const r = E.call("payConfirm", { ref: p.ref, sessionId: "cs_test_sen", paymentIntent: "pi_sen", method: "card", amount: p.total * 100 });
  assert.equal(r.whenText, "imorgon kl 12:30");
  assert.ok(E.log.mails.some(m => m.to === "sen@exempel.se" && m.htmlBody.includes("imorgon kl 12:30")), "mejlet visar fel dag");
  const kv = E.log.mails.filter(m => m.to === "sen@exempel.se").at(-1);
  assert.match(kv.subject, /kvitto och bekräftelse/);
  ["Kvitto", "Hanami Family Sushi AB", "559471-3587", "Moms 6 %", "Totalt betalt", "Kort online (betald)"].forEach(t => assert.ok(kv.htmlBody.includes(t), "kvittot saknar " + t));
  assert.ok(!/Kortkvittot skickas separat|Stripe/.test(kv.htmlBody), "hänvisar till separat kvitto");
  const vat = Math.round(p.total * 6 / 106 * 100) / 100;
  assert.ok(kv.htmlBody.includes(String(vat).replace(".", ",") + " kr"), "fel momsbelopp, väntade " + vat);
  assert.equal(E.call("payStatus", { ref: p.ref, sessionId: "cs_test_sen" }).whenText, "imorgon kl 12:30");
});
test("payStatus kräver rätt session-id", () => {
  assert.equal(E.call("payStatus", { ref: pend.ref, sessionId: "cs_fel" }).status, 404);
});
test("payFail markerar men skapar ingen order", () => {
  const p2 = E.call("payPending", { order: { kind: "table", table: "4", items: [{ id: "poke-1", qty: 1 }] } });
  E.call("paySession", { ref: p2.ref, sessionId: "cs_test_2" });
  const before = E.sheets["Beställningar"].getLastRow();
  assert.equal(E.call("payFail", { ref: p2.ref, status: "expired" }).ok, true);
  assert.equal(E.call("payStatus", { ref: p2.ref, sessionId: "cs_test_2" }).status, "utgången");
  assert.equal(E.sheets["Beställningar"].getLastRow(), before);
});
test("stängd onlinebeställning stoppar ny betalning men inte en redan betald", () => {
  // Betalning startad medan öppet …
  const p3 = E.call("payPending", { order: { kind: "table", table: "6", items: [{ id: "poke-1", qty: 1 }] } });
  E.call("paySession", { ref: p3.ref, sessionId: "cs_test_3" });
  E.call("adminOrdering", { open: false });
  // … ny betalning nekas med 423 (inga pengar tas)
  const blocked = E.call("payPending", { order: { kind: "table", table: "6", items: [{ id: "poke-1", qty: 1 }] } });
  assert.equal(blocked.status, 423);
  // … men den som redan betalat får sin order (pengarna är tagna)
  const ok = E.call("payConfirm", { ref: p3.ref, sessionId: "cs_test_3", paymentIntent: "pi_3", method: "card", amount: Math.round(p3.total * 100) });
  assert.match(ok.no, /^H\d+$/);
  E.call("adminOrdering", { open: true });
});

/* ---------------- återbetalning (Refund.js) ---------------- */
test("återbetalning: refundInfo, delbelopp, hela, idempotent, via webhook (payment intent), mejl till gästen", () => {
  const sh = E.sheets["Beställningar"], head = sh.data[0];
  const row = sh.data.find(x => x[head.indexOf("Stripe")] === "pi_1"), no = row[head.indexOf("Ordernr")];
  const info = E.call("refundInfo", { no });
  assert.equal(info.stripe, "pi_1"); assert.equal(info.total, 300); assert.equal(info.refunded, 0);
  assert.equal(E.call("refundInfo", { no: "H0" }).status, 404);

  const mails = E.log.mails.length;
  const r1 = E.call("refunded", { no, refundedOre: 5000, capturedOre: 30000, source: "köksvyn" });
  assert.equal(r1.refunded, 50); assert.equal(r1.full, false);
  assert.match(String(row[head.indexOf("Återbetald")]), /^50 kr \d{4}-\d\d-\d\d \d\d:\d\d$/);
  assert.equal(E.log.mails.length, mails + 1); assert.equal(E.log.mails.at(-1).to, "bo@exempel.se");
  assert.ok(E.log.mails.at(-1).htmlBody.includes("50 kr"), "mejlet saknar beloppet");

  // samma totalsumma igen (t.ex. webhooken efter köksvyn) → ingen ny anteckning, inget nytt mejl
  assert.equal(E.call("refunded", { stripe: "pi_1", refundedOre: 5000, capturedOre: 30000 }).already, true);
  assert.equal(E.log.mails.length, mails + 1);

  // resten via Stripe Dashboard → webhook hittar ordern på payment intent
  const r2 = E.call("refunded", { stripe: "pi_1", refundedOre: 30000, capturedOre: 30000, source: "Stripe" });
  assert.equal(r2.no, no); assert.equal(r2.refunded, 300); assert.equal(r2.full, true);
  assert.match(String(row[head.indexOf("Återbetald")]), /^300 kr .*\(hela\)$/);
  assert.ok(E.log.mails.at(-1).htmlBody.includes("250 kr"), "andra mejlet ska gälla mellanskillnaden");

  const listed = E.call("adminOrders", {}).orders.find(o => o.no === no);
  assert.equal(listed.online, true); assert.equal(listed.refunded, 300);
  assert.equal(E.call("refunded", { stripe: "pi_okand", refundedOre: 100 }).status, 404);
  assert.equal(E.call("refunded", { no, refundedOre: 0 }).status, 400);
});

/* ---------------- omsättningsrapport (Report.js) ---------------- */
test("reportOrders: driftark + arkiv, inga personuppgifter, datumfilter, ogiltigt intervall", () => {
  const today = E.call("health").time.slice(0, 10);
  const r = E.call("reportOrders", { from: today, to: today });
  assert.equal(r.ok, true);
  const o = r.orders.find(x => x.online && x.refunded === 300);
  assert.ok(o, "onlineordern med återbetalning saknas"); assert.equal(o.total, 300); assert.equal(o.d, today);
  r.orders.forEach(x => { assert.equal(x.d, today); assert.equal(x.name, undefined); assert.equal(x.phone, undefined); });
  assert.equal(E.call("reportOrders", { from: today, to: "2000-01-01" }).status, 400);
  assert.equal(E.call("reportOrders", { from: "x", to: today }).status, 400);

  // arkivet (nattstädningen flyttade äldre rader dit tidigare i testerna)
  const arch = E.files[E.props.ARCHIVE_ID];
  if (arch) {
    const a = arch.getSheetByName("Beställningar"), head = a.data[0];
    const archived = a.data.slice(1).map(x => String(x[head.indexOf("Mottagen")]).slice(0, 10)).filter(d => /^\d{4}-/.test(d));
    assert.ok(archived.length > 0, "arkivet är tomt i testet");
    const all = E.call("reportOrders", { from: "2000-01-01", to: today });
    assert.equal(all.archive, "ok");
    archived.forEach(d => assert.ok(all.orders.some(x => x.d === d), "arkiverad dag " + d + " saknas i rapporten"));
  }
});

/* ---------------- happy hour: hämtning 16–17 vald av gästen ---------------- */
test("happy hour-order med vald dag/tid (asap av) sparas med den tiden, även en senare dag", () => {
  const today = E.call("health").time.slice(0, 10);
  const d = new Date(today + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 1);
  const tomorrow = d.toISOString().slice(0, 10);
  const r = E.call("order", { kind: "pickup", name: "Hh", phone: "+46701112233", asap: false, happy: true,
    pickupDate: tomorrow, pickupTime: "16:30", whenText: "imorgon kl 16:30", payment: "swish", tip: 0, items: [{ id: "happy-1", qty: 1 }] });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.match(r.no, /^H\d+$/);
  const sh = E.sheets["Beställningar"], head = sh.data[0], row = sh.data.find(x => x[head.indexOf("Ordernr")] === r.no);
  assert.equal(String(row[head.indexOf("Hämtas datum")]), tomorrow);
  assert.equal(String(row[head.indexOf("Hämtas tid")]), "16:30");
  assert.match(String(row[head.indexOf("Beställning")]), / HH\b/, "happy hour-rätten saknar HH i namnet");
  assert.ok(!/ HH/.test(String(sh.data.find(x => /maki/i.test(String(x[head.indexOf("Beställning")])) && !/HH/.test(String(x[head.indexOf("Beställning")])))?.[head.indexOf("Beställning")] || "")));
});

/* ---------------- rapporter per e-post (ReportMail.js) ---------------- */
test("rapport-mejl: summering = lib/report.js, dagsrapport skickas en gång, månadsrapport sista dagen", () => {
  const orders = [
    { d: "2026-10-14", kind: "pickup", payment: "Online kort", status: "Klar", paid: true, total: 212, tip: 0, online: true, refunded: 0 },
    { d: "2026-10-14", kind: "table", payment: "Swish", status: "Klar", paid: true, total: 150, tip: 10, online: false, refunded: 0 },
    { d: "2026-10-14", kind: "pickup", payment: "Kort i kassan", status: "Klar", paid: false, total: 100, tip: 0, online: false, refunded: 0 },
    { d: "2026-10-15", kind: "pickup", payment: "Swish", status: "Avbokad", paid: false, total: 999, tip: 0, online: false, refunded: 0 },
    { d: "2026-10-15", kind: "pickup", payment: "Online kort", status: "Avbokad", paid: true, total: 100, tip: 0, online: true, refunded: 100 }
  ];
  const t = E.ctx.summarizeReport_(orders, 6).total;
  // samma siffror som tests/report.test.mjs räknar fram med lib/report.js
  assert.equal(t.orders, 3); assert.equal(t.gross, 462); assert.equal(t.net, 362); assert.equal(t.fee, undefined); assert.equal(t.payout, undefined);
  assert.equal(t.unpaid, 0); assert.equal(t.kassa, undefined); assert.equal(t.cancelled, 1); assert.equal(t.tips, 10);
  assert.equal(t.vat, Math.round((362 - 10) * 6 / 106 * 100) / 100);

  assert.equal(E.ctx.summarizeReport_([{ d: "2026-10-12", total: 500, online: true, status: "Klar" }], 6).total.orders, 0, "före REPORT_FROM räknas inte");
  E.props.REPORT_EMAIL = "agare@exempel.se";
  delete E.props.REPORT_SENT;
  const before = E.log.mails.length;
  E.ctx.sendReportMail();
  const sent = E.log.mails.slice(before);
  assert.ok(sent.length >= 1, "ingen dagsrapport");
  assert.equal(sent[0].to, "agare@exempel.se"); assert.match(sent[0].subject, /^📊 Dagsrapport /);
  assert.doesNotMatch(sent[0].htmlBody, /Q89|avgift|Via Stripe/i, "plattformsavgiften får inte synas i ägarens rapport");
  const today = E.call("health").time.slice(0, 10), d = new Date(today + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 1);
  const lastDay = d.toISOString().slice(5, 7) !== today.slice(5, 7);
  assert.equal(sent.length, 1, "kvällsmejlet är bara dagsrapporten (månaden kommer som PDF den 1:a)"); void lastDay;
  E.ctx.sendReportMail();
  assert.equal(E.log.mails.length, before + sent.length, "skickades två gånger samma dag");

  const m0 = E.log.mails.length;
  E.ctx.mailReport_("månad", today.slice(0, 8) + "01", today, "test");
  assert.match(E.log.mails[m0].htmlBody, /Per dag/);
});

test("rapporten gäller dygnet som slutade 23.59.59 (skickas 00.01 natten efter)", () => {
  const real = E.ctx.nowParts_, today = E.call("health").time.slice(0, 10);
  const y = new Date(today + "T12:00:00Z"); y.setUTCDate(y.getUTCDate() - 1); const yesterday = y.toISOString().slice(0, 10);
  try {
    E.ctx.nowParts_ = () => ({ date: today, minutes: 1 });          // 00.01 → gårdagen
    assert.equal(E.ctx.reportDay_(), yesterday);
    E.ctx.nowParts_ = () => ({ date: today, minutes: 20 });         // trigger försenad till 00.20 → fortfarande gårdagen
    assert.equal(E.ctx.reportDay_(), yesterday);
    E.ctx.nowParts_ = () => ({ date: today, minutes: 14 * 60 });    // test från menyn mitt på dagen → idag
    assert.equal(E.ctx.reportDay_(), today);
    const n = E.log.triggers.length;
    E.ctx.nowParts_ = () => ({ date: today, minutes: 12 * 60 });
    E.ctx.scheduleReportMail();
    assert.ok(E.log.triggers.slice(n).includes("sendReportMail"), "ingen engångstrigger för natten");
  } finally { E.ctx.nowParts_ = real; }
});

test("säkerhetsnät: missad dagsrapport skickas i efterhand, och kontroll i menyn", () => {
  const today = E.call("health").time.slice(0, 10), y = new Date(today + "T12:00:00Z"); y.setUTCDate(y.getUTCDate() - 1);
  const yesterday = y.toISOString().slice(0, 10), real = E.ctx.nowParts_;
  E.props.REPORT_EMAIL = "agare@exempel.se";
  try {
    E.ctx.nowParts_ = () => ({ date: today, minutes: 12 * 60 });
    E.props.REPORT_SENT = "2000-01-01";
    let n = E.log.mails.length; E.ctx.scheduleReportMail();
    assert.equal(E.log.mails.length, n + 1, "gårdagens rapport skickades inte i efterhand");
    assert.equal(E.props.REPORT_SENT, yesterday);
    n = E.log.mails.length; E.ctx.scheduleReportMail();
    assert.equal(E.log.mails.length, n, "skickades två gånger");
  } finally { E.ctx.nowParts_ = real; }
  const a = E.log.alerts.length; E.ctx.reportMailStatus();
  assert.ok(E.log.alerts.length > a && /Mottagare: agare@exempel.se/.test(String(E.log.alerts.at(-1))), "kontrollen visar mottagaren");
});

test("dagsrapport som PDF: grupper per kategori med rätter, bifogas dagsmejlet", () => {
  const today = E.call("health").time.slice(0, 10);
  E.props.REPORT_FROM = "2000-01-01";
  E.call("order", { kind: "pickup", name: "Pdf", phone: "+46701112233", asap: false, pickupDate: today, pickupTime: "18:00", whenText: "idag",
    payment: "swish", tip: 0, items: [{ id: "maki-1", qty: 2 }, { id: "happy-1", qty: 1 }] });
  const d = E.ctx.dailyDetail_(today);
  const maki = d.groups.find(g => g.id === "maki"), happy = d.groups.find(g => g.id === "happy");
  assert.ok(maki && maki.qty >= 2 && maki.items.some(i => /California/.test(i.name)), "maki-gruppen saknas");
  assert.ok(happy && happy.items.some(i => / HH$/.test(i.name)), "happy hour-gruppen saknas eller saknar HH");
  assert.equal(d.items, d.groups.reduce((s, g) => s + g.qty, 0));
  const html = E.ctx.dailyPdfHtml_(d);
  assert.match(html, /Dagsrapport/); assert.match(html, /559471-3587/); assert.match(html, /Grand total netto/);
  assert.doesNotMatch(html, /Q89|avgift/i);
  const n = E.log.mails.length;
  E.ctx.mailReport_("dag", today, today, "test");
  const att = E.log.mails[n].attachments;
  assert.ok(att && att[0].name === "Hanami_dagsrapport_" + today + ".pdf" && att[0].type === "application/pdf", "PDF bifogas inte");
  delete E.props.REPORT_FROM;
});

test("Q89 plattformsrapport: bara till PLATFORM_EMAIL, aldrig till restaurangens adresser, inget belopp i Logg", () => {
  const orig = E.ctx.platformData_;
  E.ctx.platformData_ = () => ({ ok: true, date: "2026-10-13", charges: 501, chargeCount: 2, stripeFees: 11.12, refunds: 12, refundCount: 1, toRestaurants: 501,
    fromRestaurants: 12, appFees: 24.04, appFeeCount: 2, appFeeRefunds: 0, otherFees: 0, payouts: 0, other: 0, net: 12.92, profit: 12.92, marginPct: 2.58,
    balance: { available: 0, pending: 26.54 }, orders: [{ time: 1791901465, desc: "Hanami Sushi Bar – hämtning – P8A", amount: 489, refunded: 0, appFee: 21.56, stripeFee: 9.14, margin: 12.42 }] });
  delete E.props.PLATFORM_EMAIL;
  assert.throws(() => E.ctx.platformMail_("2026-10-13"), /PLATFORM_EMAIL/);
  E.props.PLATFORM_EMAIL = "ekonomi@q89.se";
  const n = E.log.mails.length;
  E.ctx.platformMail_("2026-10-13");
  const m = E.log.mails[n];
  assert.equal(m.to, "ekonomi@q89.se"); assert.match(m.subject, /Q89 Pay 2026-10-13/);
  assert.match(m.htmlBody, /12,92 kr/); assert.match(m.htmlBody, /21,56 kr/); assert.match(m.htmlBody, /9,14 kr/);
  const logg = E.sheets["Logg"].data.map(r => r.join(" ")).join("\n");
  assert.doesNotMatch(logg, /12,92|24,04/);
  E.ctx.platformData_ = orig;
});

test("avstämningsrapport per vecka: momssatser, betalsätt, transaktionsavgift, utbetalning till bankkontot", () => {
  const orig = E.ctx.reportOrders_;
  E.ctx.reportOrders_ = () => ({ archive: "ok", orders: [
    { d: "2026-10-14", online: true, payment: "Online kort", status: "Klar", paid: true, total: 489, tip: 0, refunded: 0 },
    { d: "2026-10-14", online: true, payment: "Online kort", status: "Klar", paid: true, total: 12, tip: 0, refunded: 12 },
    { d: "2026-10-15", online: true, payment: "Online kort", status: "Klar", paid: true, total: 310, tip: 10, refunded: 0 },
    { d: "2026-10-15", online: false, payment: "Swish", status: "Klar", paid: true, total: 200, tip: 0, refunded: 0 },
    { d: "2026-10-16", online: false, payment: "Kort i kassan", status: "Klar", paid: true, total: 999, tip: 0, refunded: 0 },
    { d: "2026-10-16", online: false, payment: "Swish", status: "Avbokad", paid: false, total: 150, tip: 0, refunded: 0 }
  ] });
  const w = E.ctx.weeklyData_("2026-10-11", "2026-10-17");   // söndag–lördag
  assert.equal(w.week, 42); assert.equal(w.label, "vecka 42"); assert.equal(w.orders, 4); assert.equal(w.cancelled, 1);
  assert.equal(w.sales.total, 1011); assert.equal(w.sales.tips, 10); assert.equal(w.refunds.total, 12);
  // avgift: 489 → 21,56; 12 → 2,48; 310 → 14,40  = 38,44 (inkl. 25 % moms: 30,75 + 7,69)
  assert.equal(w.fee.total, 38.44); assert.equal(w.fee.ex, 30.75); assert.equal(w.fee.vat, 7.69); assert.equal(w.fee.n, 3);
  assert.equal(w.payout.cards, 811); assert.equal(w.payout.total, 811 - 12 - 38.44);
  assert.equal(w.swishDirect, 200);
  const html = E.ctx.weeklyPdfHtml_(w);
  ["Avstämningsrapport", "Försäljning per momssats", "Försäljning per betalmetod", "Avgifter per betalmetod", "Utbetalningssummering", "Transaktionsavgift", "Till ert bankkonto för perioden", "vecka 42"]
    .forEach(t => assert.ok(html.includes(t), "saknar " + t));
  assert.doesNotMatch(html, /Q89|plattform|application|Stripe/i);
  E.props.REPORT_EMAIL = "agare@exempel.se";
  const n = E.log.mails.length; E.ctx.weeklyMail_("2026-10-11", "2026-10-17");
  const m = E.log.mails[n];
  assert.equal(m.to, "agare@exempel.se"); assert.match(m.subject, /Avstämningsrapport vecka 42/);
  assert.equal(m.attachments[0].name, "Hanami_avstamning_v42_2026-10-11.pdf");
  // månad: samma uppställning, etikett "oktober 2026", filnamn per månad
  const mo = E.ctx.weeklyData_("2026-10-01", "2026-10-31");
  assert.equal(mo.label, "oktober 2026"); assert.equal(mo.fee.total, 38.44);
  assert.match(E.ctx.weeklyPdfHtml_(mo), /2026-10-01 till 2026-10-31 \(oktober 2026\)/);
  const k = E.log.mails.length; E.ctx.avstamningMail_("2026-10-01", "2026-10-31");
  assert.match(E.log.mails[k].subject, /Avstämningsrapport oktober 2026/);
  assert.equal(E.log.mails[k].attachments[0].name, "Hanami_avstamning_2026-10.pdf");
  assert.equal(E.ctx.weeklyData_("2026-10-12", "2026-10-31").label, "vecka 44", "delmånad är ingen månad");
  E.ctx.reportOrders_ = orig;
});

console.log("\n" + passed + " tester OK");
