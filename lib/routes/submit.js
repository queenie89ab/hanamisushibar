// POST /api/submit – beställning (hämtning/bord) och bordsbokning.
// Här kontrolleras format, öppettider och tider. Priser och rätter kontrolleras i Apps Script mot fliken Meny.
import settings from "../../data/settings.js";
import { gas } from "../gas.js";
import { wrap, send, body, HttpError, clean, cleanMultiline, phoneE164, email, nowLocal, addDays, toMinutes, hoursFor, isDate } from "../util.js";
import { whenText } from "../when.js";
import { mixPrice } from "../mix.js";
import { pickupSlot, pickLaterSlot } from "../pickup.js";
import { isHappyId, pickHappySlot } from "../happy.js";
import { stripeConfigured } from "../stripe.js";

export default wrap(async (req, res) => {
  if (req.method !== "POST") throw new HttpError(405, "Endast POST.");
  const p = body(req);
  if (p.website) return send(res, 200, { ok: true, no: "H0000", total: 0 }); // honungsfälla
  if (p.payment === "online") throw new HttpError(400, "Onlinebetalning går via /api/pay.");
  if (p.type === "pickup-order" || p.type === "table-order") {
    // Manuell Swish avstängd (data/settings.js paySwish: false) → beställningar betalas online via /api/pay.
    // Gäller bara när onlinebetalningen faktiskt fungerar, annars vore det omöjligt att beställa.
    if (!settings.paySwish && settings.payOnline && stripeConfigured())
      throw new HttpError(400, `Betala med kort, Apple Pay eller Google Pay i beställningen. Ladda om sidan om du inte ser det valet, eller ring ${settings.phone}.`);
    return send(res, 200, await order(p));
  }
  if (p.type === "booking") return send(res, 200, await booking(p));
  throw new HttpError(400, "Okänd typ.");
});

async function order(p) {
  const out = buildOrder(p);
  const r = await gas("order", out);
  return { ok: true, no: r.no, total: r.total, when: out.kind === "table" ? "" : (r.whenText || out.whenText) };
}

/**
 * Kontrollerar en beställning från webben och bygger objektet som Apps Script tar emot.
 * Delas med onlinebetalningen (lib/routes/pay.js) så att samma regler gäller oavsett hur gästen betalar.
 */
export function buildOrder(p) {
  const isTable = p.type === "table-order";
  const now = nowLocal();
  if (!Array.isArray(p.items) || !p.items.length) throw new HttpError(400, "Varukorgen är tom.");
  if (p.items.length > 60) throw new HttpError(400, "För många rader.");
  const items = p.items.map(r => ({ id: clean(r.id, 40), qty: Math.floor(Number(r.qty)), note: clean(r.note, 120), opts: r.opts || null }));
  if (items.some(i => !/^[a-z0-9-]+$/.test(i.id) || !(i.qty >= 1 && i.qty <= 50))) throw new HttpError(400, "Ogiltig beställning.");
  // Byten i sushimixar: tillägget räknas här och läggs på arkets pris i Apps Script
  for (const i of items) {
    try {
      const m = mixPrice(i.id, i.opts); i.extra = m.extra; i.detail = m.detail;
      if (m.pieces && m.pieces !== i.qty) throw new Error("Antalet nigiri stämmer inte. Uppdatera sidan och försök igen.");
    }
    catch (e) { throw new HttpError(400, e.message); }
    delete i.opts;
  }

  const tip = Math.round(Number(p.tip) || 0);
  if (!(tip >= 0 && tip <= 2000)) throw new HttpError(400, "Ogiltig dricks.");

  const payment = p.payment === "kort" ? "kort" : p.payment === "online" ? "online" : "swish";
  const mail = email(p.email);
  if (!mail) throw new HttpError(400, "Fyll i din e-post – där får du bekräftelse och kvitto.");
  const out = { kind: isTable ? "table" : "pickup", items, tip, payment,
    message: cleanMultiline(p.message, 500), email: mail };

  if (isTable) {
    const table = clean(p.table, 10);
    if (!/^[A-Za-z0-9-]{1,10}$/.test(table)) throw new HttpError(400, "Ogiltigt bordsnummer.");
    const h = hoursFor(now.date);
    if (!h || now.minutes < h[0] * 60 || now.minutes >= h[1] * 60) throw new HttpError(400, `Restaurangen är stängd just nu. Ring ${settings.phone}.`);
    checkTimedMenus(items, now.date, now.minutes, now, { table: true });
    Object.assign(out, { table, name: clean(p.name, 80), phone: phoneE164(p.phone, { required: false }) });
  } else {
    // Hämtning: gästen väljer inte tid och kan beställa dygnet runt (lib/pickup.js).
    //   Öppet nu → idag så snart som möjligt. Stängt eller för sent för köket → nästa öppna dag vid öppning.
    // Apps Script räknar den slutliga tiden med köksvyns förberedelsetid; här räknas en preliminär tid.
    const name = clean(p.name, 80);
    if (name.length < 2) throw new HttpError(400, "Ange ditt namn.");
    const hh = settings.happyHour, hhText = `${String(hh.from).padStart(2, "0")}.00–${String(hh.to).padStart(2, "0")}.00`;

    if (items.some(i => isHappyId(i.id))) {
      // Happy hour: beställ när som helst, hämta bara 16–17. Gästen väljer dag och tid i kassan (lib/happy.js).
      if (items.some(i => i.id.startsWith("lunch-")))
        throw new HttpError(400, `Lunch hämtas ${settings.lunch.from}.00–${settings.lunch.to}.00 och happy hour ${hhText}. Beställ dem var för sig.`);
      const pick = pickHappySlot(clean(p.happyDate, 10), clean(p.happyTime, 5), now);
      if (pick === null) throw new HttpError(400, `Det finns ingen hämtningstid för happy hour de närmaste dagarna. Ring ${settings.phone}.`);
      if (!pick) throw new HttpError(400, `Den hämtningstiden går inte längre. Happy hour hämtas ${hhText} – välj en ny tid.`);
      if (pick.asap) {
        // Under happy hour: så snart som möjligt med köksvyns förberedelsetid (Apps Script räknar den slutliga tiden)
        const slot = pickupSlot(now);
        if (!slot || slot.date !== now.date) throw new HttpError(400, `Köket hinner inte idag. Välj en annan dag eller ring ${settings.phone}.`);
        const t = hhmm(slot.minutes);
        Object.assign(out, { name, phone: phoneE164(p.phone), asap: true, happy: true, openFrom: slot.openFrom, closeAt: slot.closeAt,
          defaultLead: settings.pickupLeadMinutes, pickupDate: slot.date, later: false, pickupTime: t, whenText: whenText(slot.date, t) });
        return out;
      }
      checkTimedMenus(items, pick.date, toMinutes(pick.time), now);
      Object.assign(out, { name, phone: phoneE164(p.phone), asap: false, happy: true,
        pickupDate: pick.date, pickupTime: pick.time, later: pick.date !== now.date, whenText: whenText(pick.date, pick.time) });
      return out;
    }

    // Gästen valde en senare tid (dag + tid i kassan) → den gäller överallt: kvitto, köksvyn, mejl, sms, tacksidan, TV:n
    const laterDate = clean(p.laterDate, 10), laterTime = clean(p.laterTime, 5);
    if (laterDate || laterTime) {
      const pick = pickLaterSlot(laterDate, laterTime, now);
      if (!pick) throw new HttpError(400, "Den hämtningstiden går inte längre. Välj en ny tid.");
      checkTimedMenus(items, pick.date, toMinutes(pick.time), now);
      const hp = hoursFor(pick.date);
      Object.assign(out, { name, phone: phoneE164(p.phone), asap: false, pickupDate: pick.date, pickupTime: pick.time,
        openFrom: hp ? hp[0] * 60 : undefined, later: pick.date !== now.date, whenText: whenText(pick.date, pick.time) });
      return out;
    }

    const slot = pickupSlot(now);
    if (!slot) throw new HttpError(400, `Vi tar inte emot beställningar just nu. Ring ${settings.phone}.`);
    const { openFrom, closeAt } = slot;
    checkTimedMenus(items, slot.date, slot.base, now);
    const t = hhmm(slot.minutes);
    // Äldre sidor: önskad tid som fritext skrivs in i meddelandet till köket (syns under KOMMENTAR på kvittot)
    const wish = clean(p.wishTime, 40);
    if (wish) out.message = cleanMultiline(`Önskar hämta: ${wish}${out.message ? "\n" + out.message : ""}`, 560);
    Object.assign(out, { name, phone: phoneE164(p.phone), asap: true, openFrom, closeAt, defaultLead: settings.pickupLeadMinutes,
      pickupDate: slot.date, later: slot.later, pickupTime: t, whenText: whenText(slot.date, t) });
  }
  return out;
}

const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// Lunch- och happy hour-rätter har id som börjar med kategorins id.
// Lunch: hämtningstiden ska ligga inom lunchtiden.
// Happy hour vid bordet: beställningen måste läggas medan happy hour pågår (en öppen dag).
// Happy hour för hämtning kontrolleras i buildOrder (lib/happy.js): beställ när som helst, hämta 16–17.
export function checkTimedMenus(items, date, minutes, now = nowLocal(), { table = false } = {}) {
  const { lunch, happyHour } = settings;
  const wd = new Date(date + "T12:00:00Z").getUTCDay();
  if (items.some(i => i.id.startsWith("lunch-")) && !(lunch.days.includes(wd) && minutes >= lunch.from * 60 && minutes < lunch.to * 60))
    throw new HttpError(400, date === nowLocal().date
      ? `Lunchmenyn gäller måndag–fredag ${lunch.from}:00–${lunch.to}:00. Ta bort lunchrätten eller välj en annan tid.`
      : `Din beställning hämtas ${whenText(date, "").replace(/ kl $/, "")}, och lunchmenyn gäller bara måndag–fredag ${lunch.from}:00–${lunch.to}:00. Ta bort lunchrätten för att fortsätta.`);
  if (table && items.some(i => i.id.startsWith("happy-"))) {
    const open = !!hoursFor(now.date);
    const during = open && now.minutes >= happyHour.from * 60 && now.minutes < happyHour.to * 60;
    const t = `${String(happyHour.from).padStart(2, "0")}:00–${String(happyHour.to).padStart(2, "0")}:00`;
    if (!during) throw new HttpError(400, `Happy hour-rätter kan bara beställas under happy hour, ${t}. Ta bort dem ur varukorgen för att fortsätta.`);
    if (date !== now.date) throw new HttpError(400, "Happy hour-rätter hämtas samma dag. Köket hinner inte idag – ta bort dem ur varukorgen.");
  }
}

async function booking(p) {
  const now = nowLocal();
  const { date, time } = p;
  const guests = Math.floor(Number(p.guests));
  if (!isDate(date) || date < now.date || date > addDays(now.date, settings.bookingDaysAhead)) throw new HttpError(400, "Välj ett giltigt datum.");
  const h = hoursFor(date), m = toMinutes(time);
  if (!h) throw new HttpError(400, "Vi har stängt den dagen.");
  if (isNaN(m) || m < h[0] * 60 || m > h[1] * 60 - 60) throw new HttpError(400, "Välj en tid inom öppettiderna.");
  if (date === now.date && m < now.minutes + 30) throw new HttpError(400, `Den tiden har redan passerat. Ring ${settings.phone} för bord inom en halvtimme.`);
  if (!(guests >= 1 && guests <= settings.maxBookingGuests)) throw new HttpError(400, `Online kan du boka för 1–${settings.maxBookingGuests} personer. Ring oss för större sällskap.`);
  const name = clean(p.name, 80);
  if (name.length < 2) throw new HttpError(400, "Ange ditt namn.");
  const mail = email(p.email);
  if (!mail) throw new HttpError(400, "Fyll i din e-post – dit skickar vi bekräftelsen.");
  const r = await gas("booking", {
    date, time, guests, name, phone: phoneE164(p.phone), email: mail,
    message: cleanMultiline(p.message, 500), whenText: whenText(date, time)
  });
  return { ok: true, no: r.no };
}
