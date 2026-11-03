/**
 * Omsättningsrapport per e-post till ägaren.
 *   • Dagsrapport för hela dygnet 00.00.00–23.59.59. Beställningar tas emot dygnet runt, därför skickas rapporten
 *     först när dygnet är slut: kl 00.01 natten efter (sendReportMail) – då har sista sekunden 23.59.59 räknats med.
 *   • Avstämningsrapport (PDF): vecka sön–lör efter lördagens slut, månad efter månadens sista dag (00.03) – se WeeklyReport.js.
 *
 * Exakt klockslag: Apps Scripts dagliga triggers går bara "ungefär" (±15 min). Därför körs scheduleReportMail
 * en gång mitt på dagen och lägger ENGÅNGS-triggers på exakt 00.01 / 00.03 natten efter.
 * Vilken dag rapporten gäller: reportDay_() – körs den före kl 06 gäller den gårdagen (dygnet som just tog slut).
 * Mottagare: skriptegenskapen REPORT_EMAIL (flera adresser med komma), annars NOTIFY_EMAIL.
 * Siffrorna räknas som i köksvyns Rapport (lib/report.js) – samma regler, även arkivet läses (Report.js).
 * Plattformsavgiften (Q89) ingår inte – den följs upp i Stripe.
 */
const REPORT_AT = { h: 0, m: 1 };    // dagsrapporten för dygnet 00.00.00–23.59.59 som just tog slut
const PERIOD_AT = { h: 0, m: 3 };    // vecko- (efter lördagen) och månadsrapport (efter sista dagen)

/** Dagen rapporten gäller: före kl 06 = gårdagen (dygnet som just slutade 23.59.59), annars idag (test från menyn). */
function reportDay_() {
  const today = now_('yyyy-MM-dd');
  return nowParts_().minutes < 6 * 60 ? addDays_(today, -1) : today;
}
const REPORT_FROM_DEFAULT = '2026-10-13';   // allt före var test (samma som reportFrom i data/settings.js); skriptegenskap REPORT_FROM går före

/* ---------------- summering (samma regler som lib/report.js) ---------------- */

function summarizeReport_(orders, vatPct) {
  const K = ['orders', 'gross', 'tips', 'refunded', 'online', 'swish', 'unpaid', 'pickup', 'table', 'cancelled'];
  const blank = () => K.reduce((o, k) => (o[k] = 0, o), {});
  const t = blank(), days = {};
  const from = prop_('REPORT_FROM', REPORT_FROM_DEFAULT);
  (orders || []).forEach(o => {
    if (from && String(o.d) < from) return;                                    // före start = test
    if (!o.online && !/swish/i.test(o.payment || '')) return;                  // "Kort i kassan" räknas inte (test)
    const targets = [t, days[o.d] || (days[o.d] = blank())];
    if (o.status === 'Avbokad' && !o.online) { targets.forEach(x => x.cancelled++); return; }
    const amount = Number(o.total) || 0, tip = Number(o.tip) || 0, refunded = Math.min(Number(o.refunded) || 0, amount);
    const method = o.online ? 'online' : 'swish';
    targets.forEach(x => {
      x.orders++; x.gross += amount; x.tips += tip; x.refunded += refunded; x[method] += amount;
      x[o.kind === 'table' ? 'table' : 'pickup']++;
      if (!o.online && !o.paid) x.unpaid += amount;
    });
  });
  const fin = x => {
    x.net = x.gross - x.refunded;
    x.vat = Math.max(0, (x.net - x.tips) * vatPct / (100 + vatPct));
    x.avg = x.orders ? x.net / x.orders : 0;
    Object.keys(x).forEach(k => { x[k] = Math.round(x[k] * 100) / 100; });
    return x;
  };
  Object.keys(days).forEach(d => fin(days[d]));
  return { total: fin(t), days: days };
}

/* ---------------- e-post ---------------- */

const krR_ = n => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2).replace(/\.00$/, '').replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' kr';
const MONTHS_SV = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december'];

function reportRecipients_() { return prop_('REPORT_EMAIL') || prop_('NOTIFY_EMAIL'); }

/** Avsnittet "Kort online → bankkontot" i dagsrapporten. */
function stripeSection_(date, row) {
  const s = stripePayoutDay_(date);
  if (!s || !s.total) return '';
  const t = s.total, d = (s.days || [])[0] || {}, paid = (s.payouts || []).filter(p => p.status === 'paid');
  const diffBad = Math.abs(t.diff || 0) >= 0.5;
  const status = d.waiting ? 'väntar hos Stripe, betalas ut automatiskt' : d.inTransit ? 'på väg till banken (' + d.payoutDates.join(', ') + ')'
    : d.paidOut ? 'utbetald ' + d.payoutDates.join(', ') : '–';
  return '<h3 style="margin:22px 0 6px;font-size:15px">Kort online → ert bankkonto (Stripe)</h3><table style="border-collapse:collapse;width:100%;font-size:15px">' +
    row('Dagens kortförsäljning (webben)', krR_(t.webOnline)) +
    row('Ska till banken (efter avgift och återbetalt)', krR_(t.webExpected)) +
    row('Stripe har bokat för dagen', krR_(t.stripeNet)) +
    row('Skillnad', diffBad ? '<span style="color:#B6493E">' + krR_(t.diff) + '</span>' : '0 kr ✓', true) +
    row('Status för dagens pengar', status) +
    row('Utbetalt till banken idag', paid.length ? krR_(paid.reduce((a, p) => a + p.amount, 0)) + ' (' + paid.length + ' st)' : '0 kr') +
    '</table>' + (diffBad ? '<p style="font-size:13px;color:#9B2C2C">Skillnaden betyder att webben och Stripe inte stämmer – öppna Utbetalningar i köksvyn.</p>' : '');
}

/** Stripe → bankkontot för dagsrapporten (via Vercel /api/platform?kind=payouts). null om det inte går – mejlet går ändå. */
function stripePayoutDay_(date) {
  const site = prop_('SITE_URL').replace(/\/$/, '');
  if (!site) return null;
  try {
    const res = UrlFetchApp.fetch(site + '/api/platform?kind=payouts&from=' + date + '&to=' + date,
      { headers: { 'x-report-key': prop_('API_SECRET') }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) { log_('WARN', 'Rapport-Stripe', res.getResponseCode() + ' ' + res.getContentText().slice(0, 200)); return null; }
    return JSON.parse(res.getContentText());
  } catch (e) { log_('WARN', 'Rapport-Stripe', e.message); return null; }
}

/** Bygger och skickar en rapport för from–to. kind: 'dag' | 'månad'. Returnerar summeringen. */
function mailReport_(kind, from, to, title) {
  const to_ = reportRecipients_();
  if (!to_) { log_('WARN', 'Rapport-mejl', 'REPORT_EMAIL/NOTIFY_EMAIL saknas'); return null; }
  const data = reportOrders_(from, to), vat = Number(prop_('STRIPE_VAT_PCT', 6)) || 6;
  const r = summarizeReport_(data.orders, vat), t = r.total;
  const row = (k, v, strong) => '<tr><td style="padding:7px 14px 7px 0;color:#4B5261">' + k + '</td><td style="padding:7px 0;text-align:right;white-space:nowrap' + (strong ? ';font-weight:700' : '') + '">' + v + '</td></tr>';
  let daysTable = '';
  if (kind === 'månad') {
    const keys = Object.keys(r.days).sort(), max = Math.max.apply(null, keys.map(d => r.days[d].net).concat([1]));
    daysTable = '<h3 style="margin:22px 0 6px;font-size:15px">Per dag</h3><table style="border-collapse:collapse;width:100%;font-size:14px">' +
      keys.map(d => { const x = r.days[d], w = Math.round(x.net / max * 100);
        return '<tr><td style="padding:5px 10px 5px 0;white-space:nowrap">' + d.slice(8) + '/' + Number(d.slice(5, 7)) + '</td>' +
          '<td style="padding:5px 10px 5px 0;text-align:right;white-space:nowrap">' + x.orders + ' order</td>' +
          '<td style="padding:5px 10px 5px 0;text-align:right;white-space:nowrap">' + krR_(x.net) + '</td>' +
          '<td style="padding:5px 0;width:40%"><div style="height:10px;width:' + w + '%;background:#1873BC;border-radius:0 4px 4px 0"></div></td></tr>'; }).join('') +
      '</table>';
  }
  const site = prop_('SITE_URL');
  const html = '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#161B26">' +
    '<div style="background:#161B26;color:#fff;padding:18px 22px;border-radius:12px 12px 0 0">' +
    '<div style="font-size:13px;opacity:.8">' + esc_(APP.NAME) + ' · ' + (kind === 'dag' ? 'Dagsrapport' : 'Månadsrapport') + '</div>' +
    '<div style="font-size:22px;font-weight:600;margin-top:2px">' + esc_(title) + '</div>' +
    (kind === 'dag' ? '<div style="font-size:13px;opacity:.8">00.00 – 23.59.59</div>' : '') +
    '<div style="font-size:30px;font-weight:700;margin-top:10px">' + krR_(t.net) + '</div>' +
    '<div style="font-size:13px;opacity:.8">netto · ' + t.orders + ' order · snitt ' + krR_(t.avg) + '</div></div>' +
    '<div style="border:1px solid #e5e7eb;border-top:0;padding:14px 22px 20px;border-radius:0 0 12px 12px">' +
    '<table style="border-collapse:collapse;width:100%;font-size:15px">' +
      row('Online kort', krR_(t.online)) + row('Swish', krR_(t.swish)) +
      row('Dricks', krR_(t.tips)) + row('Återbetalt', krR_(t.refunded)) + row('Moms ' + vat + ' % (ingår)', krR_(t.vat)) +
      row('Hämtning / bord', t.pickup + ' / ' + t.table) + (t.cancelled ? row('Avbokade (räknas inte)', t.cancelled) : '') +
      (t.unpaid ? '<tr><td colspan="2" style="padding:10px 12px;background:#FFF8DB;border-radius:8px;font-size:14px">⚠️ <b>Ej markerad betald: ' + krR_(t.unpaid) + '</b> – Swish där köket inte bockat Betald. Stäm av mot Swish.</td></tr>' : '') +
    '</table>' + daysTable + (kind === 'dag' ? stripeSection_(from, row) : '') +
    (data.archive === 'error' ? '<p style="color:#9B2C2C;font-size:13px">Arkivet gick inte att läsa – äldre dagar kan saknas.</p>' : '') +
    '<p style="margin-top:18px;font-size:13px;color:#4B5261">Netto = brutto − återbetalt. Moms räknas på netto utan dricks. Datum = när beställningen togs emot.</p>' +
    (site ? '<a href="' + site + '/kok" style="display:inline-block;background:#161B26;color:#fff;padding:10px 16px;border-radius:999px;text-decoration:none;font-weight:600">Öppna Rapport i köksvyn</a>' : '') +
    '</div></div>';
  const text = [APP.NAME + ' – ' + title, 'Netto: ' + krR_(t.net) + ' (' + t.orders + ' order)', 'Online kort: ' + krR_(t.online),
    'Swish: ' + krR_(t.swish), 'Dricks: ' + krR_(t.tips), 'Återbetalt: ' + krR_(t.refunded),
    'Moms ' + vat + ' %: ' + krR_(t.vat),
    t.unpaid ? 'Ej markerad betald: ' + krR_(t.unpaid) : ''].filter(Boolean).join('\n');
  const mail = { to: to_, subject: (kind === 'dag' ? '📊 Dagsrapport ' : '📅 Månadsrapport ') + title + ' · ' + krR_(t.net), htmlBody: html, body: text, name: APP.NAME + ' rapport' };
  if (kind === 'dag') {
    try { mail.attachments = [dailyPdf_(from).blob]; }                     // PDF i kassastil (Dagsrapport_ÅÅÅÅ-MM-DD.pdf)
    catch (e) { log_('WARN', 'Rapport-PDF', e.message); }                  // mejlet går iväg ändå
  }
  MailApp.sendEmail(mail);
  log_('INFO', 'Rapport-mejl', kind + ' ' + from + '–' + to + ' → ' + to_ + ' · netto ' + t.net);
  return r;
}

/* ---------------- schemaläggning ---------------- */

/** Engångstriggern kl 00.01: dagsrapport för dygnet som just slutade 23.59.59. Skickar högst en gång per dag. */
function sendReportMail(day) {
  const props = PropertiesService.getScriptProperties(), today = /^\d{4}-\d{2}-\d{2}$/.test(day || '') ? day : reportDay_();
  if (props.getProperty('REPORT_SENT') === today) return;
  props.setProperty('REPORT_SENT', today);
  try {
    const d = new Date(today + 'T12:00:00Z');
    mailReport_('dag', today, today, d.getUTCDate() + ' ' + MONTHS_SV[d.getUTCMonth()] + ' ' + d.getUTCFullYear());
    // månadsrapporten skickas som avstämningsrapport (PDF) den 1:a, se WeeklyReport.js
  } catch (e) { log_('ERROR', 'Rapport-mejl', e.stack || e.message); props.deleteProperty('REPORT_SENT'); throw e; }
}

/** Engångstrigger nästa gång klockan är at (Stockholm) – idag om den inte passerat, annars i natt/imorgon. */
function oneShotNext_(fn, at) {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === fn) ScriptApp.deleteTrigger(t); });
  const nowP = nowParts_();
  let diff = at.h * 60 + at.m - nowP.minutes;
  if (diff <= 0) diff += 1440;
  ScriptApp.newTrigger(fn).timeBased().at(new Date(Math.floor(Date.now() / 60000) * 60000 + diff * 60000)).create();
  return true;
}

/** Daglig trigger (~kl 12): i natt kl 00.01 dagsrapport för idag (t.o.m. 23.59.59);
 *  är idag lördag eller månadens sista dag även avstämningsrapport kl 00.03. */
function scheduleReportMail() {
  // Säkerhetsnät: har gårdagens dagsrapport inte gått iväg (engångstriggern missades, fel, kod inte uppdaterad) – skicka den nu
  const yesterday = addDays_(now_('yyyy-MM-dd'), -1), sent = prop_('REPORT_SENT');
  if (nowParts_().minutes >= 6 * 60 && (!sent || sent < yesterday)) {
    try { sendReportMail(yesterday); log_('INFO', 'Rapport-mejl', 'Gårdagens dagsrapport skickades i efterhand (' + yesterday + ')'); }
    catch (e) { log_('ERROR', 'Rapport-mejl', 'Efterhand ' + yesterday + ': ' + e.message); }
  }
  // dygnet som nästa 00.01-körning rapporterar: idag – utom precis efter midnatt (00.00), då är det gårdagen
  const today = nowParts_().minutes < REPORT_AT.m ? addDays_(now_('yyyy-MM-dd'), -1) : now_('yyyy-MM-dd');
  const sat = new Date(today + 'T12:00:00Z').getUTCDay() === 6;
  const lastDay = addDays_(today, 1).slice(0, 7) !== today.slice(0, 7);
  if (sat || lastDay) oneShotNext_('sendPeriodReports', PERIOD_AT);
  else ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'sendPeriodReports') ScriptApp.deleteTrigger(t); });
  return oneShotNext_('sendReportMail', REPORT_AT);
}

/* ---------------- meny: Hanami → Rapporter ---------------- */

function reportMailEnable() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (['scheduleReportMail', 'sendReportMail', 'weeklyReportTick', 'sendPeriodReports'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('scheduleReportMail').timeBased().atHour(12).everyDays(1).inTimezone(APP.TZ).create();
  scheduleReportMail();
  say_('E-postrapporter är PÅ ✅\n\nDagsrapport för hela dygnet 00.00–23.59.59, skickas kl 00.01 natten efter. Avstämningsrapport (PDF): veckan (sön–lör) efter lördagens slut och månaden efter sista dagen, kl 00.03.\nMottagare: ' +
    (reportRecipients_() || '(saknas – fyll i REPORT_EMAIL eller NOTIFY_EMAIL)') + '\n\nFörsta rapporten kommer i natt kl 00.01.');
}
function reportMailDisable() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (['scheduleReportMail', 'sendReportMail', 'weeklyReportTick', 'sendPeriodReports'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  say_('E-postrapporter är AV.');
}
/** Menyn: skicka gårdagens dagsrapport (räknas som skickad, så den inte går två gånger). */
function reportMailYesterday() {
  const y = addDays_(now_('yyyy-MM-dd'), -1);
  PropertiesService.getScriptProperties().deleteProperty('REPORT_SENT');
  sendReportMail(y);
  say_('Dagsrapporten för ' + y + ' är skickad till ' + reportRecipients_() + '.');
}

/** Menyn: visar om rapporterna är rätt inställda – triggers, mottagare, senast skickad och senaste händelser i Logg. */
function reportMailStatus() {
  const trig = ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction());
  const has = n => trig.indexOf(n) >= 0;
  const logSh = sheet_(SHEET.LOG), last = logSh.getLastRow();
  const logs = last > 1 ? logSh.getRange(Math.max(2, last - 199), 1, Math.min(199, last - 1), 4).getDisplayValues()
    .filter(r => /Rapport|Avstämning/.test(r[2])).slice(-6).map(r => r[0] + ' ' + r[1] + ' ' + r[2] + ': ' + String(r[3]).slice(0, 140)) : [];
  say_([
    'Mottagare: ' + (reportRecipients_() || 'SAKNAS – fyll i REPORT_EMAIL eller NOTIFY_EMAIL'),
    'Daglig planering (scheduleReportMail, ~kl 12): ' + (has('scheduleReportMail') ? 'finns ✅' : 'SAKNAS ❌ – tryck Slå på'),
    'Nattens dagsrapport (sendReportMail, 00.01): ' + (has('sendReportMail') ? 'inlagd ✅' : 'inte inlagd ❌ – tryck Slå på'),
    'Senast skickad dagsrapport gäller: ' + (prop_('REPORT_SENT') || '–'),
    'SITE_URL: ' + (prop_('SITE_URL') || 'saknas (Stripe-delen hoppas över)'),
    '', 'Senaste i Logg:', logs.length ? logs.join('\n') : '(inget om rapporter)'
  ].join('\n'));
}

function reportMailTestDay() {
  const today = now_('yyyy-MM-dd'); mailReport_('dag', today, today, 'idag (test) ' + today);
  say_('Dagsrapport skickad till ' + reportRecipients_());
}
function reportMailTestMonth() {
  const today = now_('yyyy-MM-dd'); mailReport_('månad', today.slice(0, 8) + '01', today, 'hittills denna månad (test)');
  say_('Månadsrapport skickad till ' + reportRecipients_());
}

/* ---------------- Dagsrapport som PDF (som en Z-rapport från kassan) ---------------- */

const ORG = { company: 'Hanami Family Sushi AB', orgnr: '559471-3587', street: 'Östergatan 53', city: '262 31 Ängelholm' };
const kr2_ = n => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ').replace('.', ',') + ' SEK';

/** Räknar dagens försäljning per varugrupp och rätt. Samma urval som rapporten (från REPORT_FROM, ej kort i kassan, ej avbokat utom online). */
function dailyDetail_(date) {
  const from = prop_('REPORT_FROM', REPORT_FROM_DEFAULT);
  const data = reportOrders_(date, date, true);
  const counted = data.orders.filter(o => !(from && o.d < from) && (o.online || /swish/i.test(o.payment || '')) && !(o.status === 'Avbokad' && !o.online));
  const menu = readMenuRows_(), catName = {}, catOrder = {}, itemOrder = {};
  menu.forEach((m, i) => { catName[m.categoryId] = m.category; if (!(m.categoryId in catOrder)) catOrder[m.categoryId] = i; itemOrder[m.id] = i; });
  const groups = {};
  let items = 0, goods = 0;
  counted.forEach(o => (o.lines || []).forEach(l => {
    const qty = Number(l.qty) || 0, sum = qty * (Number(l.price) || 0);
    const cid = l.categoryId || String(l.id || '').split('-')[0] || 'ovrigt';
    const g = groups[cid] || (groups[cid] = { id: cid, name: catName[cid] || cid, qty: 0, sum: 0, items: {} });
    const key = l.name + '|' + (l.price || 0);
    const it = g.items[key] || (g.items[key] = { id: l.id, name: l.name, qty: 0, sum: 0 });
    g.qty += qty; g.sum += sum; it.qty += qty; it.sum += sum; items += qty; goods += sum;
  }));
  const list = Object.keys(groups).map(k => groups[k]).sort((a, b) => (catOrder[a.id] ?? 999) - (catOrder[b.id] ?? 999));
  list.forEach(g => { g.items = Object.keys(g.items).map(k => g.items[k]).sort((a, b) => (itemOrder[a.id] ?? 999) - (itemOrder[b.id] ?? 999)); });
  const vat = Number(prop_('STRIPE_VAT_PCT', 6)) || 6;
  return { date: date, sum: summarizeReport_(data.orders, vat).total, groups: list, items: items, goods: goods, vatPct: vat, archive: data.archive };
}

function dailyPdfHtml_(d) {
  const t = d.sum;
  const row = (k, v, n, cls) => '<tr class="' + (cls || '') + '"><td>' + esc_(k) + '</td><td class="n">' + (n == null ? '' : n) + '</td><td class="n">' + v + '</td></tr>';
  const grp = d.groups.map(g => row(g.name, kr2_(g.sum), g.qty, 'grp') +
    g.items.map(i => row(i.name, kr2_(i.sum), i.qty, 'it')).join('')).join('');
  const logo = reportLogo_();
  return '<html><head><meta charset="utf-8"><style>' +
    '@page{size:A4;margin:16mm 14mm}' +
    'body{font-family:Helvetica,Arial,sans-serif;color:#1B2A3A;font-size:10.5pt}' +
    '.head{width:100%;border-collapse:collapse;margin-bottom:8mm}.head td{vertical-align:top}' +
    'h1{font-size:22pt;font-weight:normal;color:#1873BC;margin:0 0 2pt}' +
    '.sub{font-weight:bold;font-size:11pt;margin-bottom:10pt}.meta{line-height:1.7;color:#4B5261}.meta b{color:#1B2A3A}' +
    '.right{text-align:right;line-height:1.7;color:#4B5261}.right b{color:#1B2A3A}' +
    'table.r{width:100%;border-collapse:collapse}table.r th{background:#ECEEF1;text-align:left;font-weight:normal;color:#4B5261;padding:6pt}' +
    'table.r th.n,table.r td.n{text-align:right}table.r td{padding:6pt;border-bottom:1px solid #D8DAD3}' +
    'tr.grp td{background:#F3F4F6;font-weight:bold;border-bottom:1px solid #E5E7EB}tr.it td{color:#4B5261;border-bottom:1px solid #EEF0F2}tr.it td:first-child{padding-left:18pt}' +
    'tr.tot td{border-top:1.5px solid #1B2A3A;font-weight:bold}tr.warn td{background:#FFF8DB}' +
    '.foot{margin-top:10mm;font-size:8.5pt;color:#7A8794}' +
    '</style></head><body>' +
    '<table class="head"><tr><td>' +
      '<h1>Dagsrapport</h1><div class="sub">' + esc_(APP.NAME) + '</div>' +
      '<div class="meta">' + esc_(ORG.company) + '<br>Org.nr: ' + ORG.orgnr + '<br><b>Försäljningsdag:</b> ' + d.date + '<br><b>Framtagen:</b> ' + now_('yyyy-MM-dd HH:mm') + '</div>' +
    '</td><td class="right">' + (logo ? '<img src="' + logo + '" width="70" height="70"><br>' : '') +
      '<b>' + esc_(APP.NAME) + '</b><br>' + esc_(ORG.street) + '<br>' + esc_(ORG.city) + '<br>' + esc_(APP.PHONE) + '</td></tr></table>' +
    '<table class="r"><tr><th>Grupp</th><th class="n">Antal</th><th class="n">Summa</th></tr>' +
      row('Total försäljning', kr2_(t.gross), t.orders + ' order') +
      row('Total moms ' + d.vatPct + '% (ingår, netto utan dricks)', kr2_(t.vat)) +
      row('Försäljning med kort online (kort, Apple Pay, Google Pay)', kr2_(t.online)) +
      row('Försäljning med Swish', kr2_(t.swish)) +
      row('Dricks', kr2_(t.tips)) +
      row('Sålda varor', kr2_(d.goods), d.items) +
      row('Returer (återbetalt)', kr2_(t.refunded)) +
      (t.cancelled ? row('Avbokade (ej räknade)', '', t.cancelled) : '') +
      (t.unpaid ? row('Swish ej markerad betald – stäm av', kr2_(t.unpaid), null, 'warn') : '') +
      grp +
      row('Grand total försäljning', kr2_(t.gross), null, 'tot') +
      row('Grand total retur', kr2_(t.refunded), null, 'tot') +
      row('Grand total netto', kr2_(t.net), null, 'tot') +
    '</table>' +
    (d.archive === 'error' ? '<p style="color:#9B2C2C">Arkivet kunde inte läsas – siffrorna kan vara ofullständiga.</p>' : '') +
    '<div class="foot">Datum = när beställningen togs emot. Beställningar via ' + esc_(prop_('SITE_URL') || 'webbplatsen').replace(/^https?:\/\//, '') + '. Priser inkl. moms.</div>' +
    '</body></html>';
}

/** Logotypen som data-URI (hämtas från webbplatsen en gång och cachas). */
function reportLogo_() {
  try {
    const cache = CacheService.getScriptCache(), hit = cache.get('REPORT_LOGO');
    if (hit) return hit;
    const site = prop_('SITE_URL'); if (!site) return '';
    const res = UrlFetchApp.fetch(site.replace(/\/$/, '') + '/logo.png', { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200 || !res.getBlob) return '';
    const uri = 'data:image/png;base64,' + Utilities.base64Encode(res.getBlob().getBytes());
    if (uri.length < 90000) cache.put('REPORT_LOGO', uri, 21600);
    return uri;
  } catch (e) { return ''; }
}

function dailyPdf_(date) {
  const d = dailyDetail_(date);
  return { detail: d, blob: Utilities.newBlob(dailyPdfHtml_(d), 'text/html', 'rapport.html').getAs('application/pdf').setName('Hanami_dagsrapport_' + date + '.pdf') };
}
