/**
 * Avstämningsrapport till restaurangen – som PDF, samma uppställning för vecka och månad:
 *   • vecka söndag–lördag t.o.m. 23.59.59, skickas kl 00.03 natten efter lördagen (restaurangen har stängt på söndagar,
 *     men beställningar för senare dagar kan läggas på söndagen – därför räknas söndagen in i veckan som slutar på lördagen)
 *   • månad 1:a–sista t.o.m. 23.59.59, skickas kl 00.03 natten efter sista dagen
 * Schemaläggs av scheduleReportMail (ReportMail.js) med en engångstrigger på exakt 00.03.
 * Visar försäljning per momssats och betalsätt, transaktionsavgifter för kortbetalning online och
 * vad som betalas ut via Stripe för veckans försäljning. Swish går direkt till restaurangen utan avgift.
 *
 * Transaktionsavgiften = samma formel som Stripe drar per order (STRIPE_FEE_PCT % + STRIPE_FEE_FIXED kr, standard 4 % + 2 kr),
 * behålls vid återbetalning. Avgiften anges inkl. 25 % moms (FEE_VAT_PCT) och delas upp i ex. moms + moms.
 * Mottagare som dagsrapporten (REPORT_EMAIL, annars NOTIFY_EMAIL).
 */

function txFeeKr_(amountKr) {
  const ore = Math.round((Number(amountKr) || 0) * 100);
  const pct = Number(prop_('STRIPE_FEE_PCT', 4)), fixed = Math.round(Number(prop_('STRIPE_FEE_FIXED', 2)) * 100);
  return ore > 0 ? Math.min(ore, Math.round(ore * pct / 100) + fixed) / 100 : 0;
}

/** Måndag–söndag för veckan som innehåller date. */
function weekRange_(date) {
  const d = new Date(date + 'T12:00:00Z'), dow = (d.getUTCDay() + 6) % 7;
  const mon = addDays_(date, -dow);
  return { from: mon, to: addDays_(mon, 6), week: isoWeek_(mon) };
}
function isoWeek_(date) {
  const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 3 - (d.getUTCDay() + 6) % 7);
  const w1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4, 12));
  return 1 + Math.round(((d - w1) / 864e5 - 3 + (w1.getUTCDay() + 6) % 7) / 7);
}

function weeklyData_(from, to) {
  const vat = Number(prop_('STRIPE_VAT_PCT', 6)) || 6, feeVat = Number(prop_('FEE_VAT_PCT', 25));
  const start = prop_('REPORT_FROM', REPORT_FROM_DEFAULT);
  const data = reportOrders_(from, to);
  const r2 = n => Math.round(n * 100) / 100;
  const m = { online: { n: 0, gross: 0, tips: 0, refunded: 0, fee: 0 }, swish: { n: 0, gross: 0, tips: 0, refunded: 0, fee: 0 } };
  let cancelled = 0;
  data.orders.forEach(o => {
    if (start && o.d < start) return;
    if (!o.online && !/swish/i.test(o.payment || '')) return;                       // "kort i kassan" = test
    if (o.status === 'Avbokad' && !o.online) { cancelled++; return; }
    const x = m[o.online ? 'online' : 'swish'], amount = Number(o.total) || 0;
    x.n++; x.gross += amount; x.tips += Number(o.tip) || 0; x.refunded += Math.min(Number(o.refunded) || 0, amount);
    if (o.online) x.fee += txFeeKr_(amount);
  });
  const split = (gross, tips) => { const goods = gross - tips, ex = goods / (1 + vat / 100); return { goods: r2(goods), goodsEx: r2(ex), goodsVat: r2(goods - ex), tips: r2(tips), ex: r2(ex + tips), total: r2(gross) }; };
  const all = { gross: m.online.gross + m.swish.gross, tips: m.online.tips + m.swish.tips, refunded: m.online.refunded + m.swish.refunded };
  const sales = split(all.gross, all.tips), ref = split(all.refunded, 0);
  const methods = ['online', 'swish'].map(k => ({ key: k, label: k === 'online' ? 'Kort online (kort, Apple Pay, Google Pay)' : 'Swish', n: m[k].n, ...split(m[k].gross, m[k].tips) }));
  const fee = m.online.fee, feeEx = r2(fee / (1 + feeVat / 100));
  return {
    from: from, to: to, week: isoWeek_(to),
    label: from.slice(8) === '01' && to === addDays_(addDays_(to, 1).slice(0, 8) + '01', -1) && from.slice(0, 7) === to.slice(0, 7)
      ? MONTHS_SV[Number(from.slice(5, 7)) - 1] + ' ' + from.slice(0, 4) : 'vecka ' + isoWeek_(to),
    vatPct: vat, feeVatPct: feeVat, cancelled: cancelled, archive: data.archive,
    sales: sales, refunds: ref, orders: m.online.n + m.swish.n, methods: methods,
    fee: { n: m.online.n, total: r2(fee), ex: feeEx, vat: r2(fee - feeEx) },
    payout: { cards: r2(m.online.gross), refunded: r2(m.online.refunded), fee: r2(fee), total: r2(m.online.gross - m.online.refunded - fee) },
    swishDirect: r2(m.swish.gross - m.swish.refunded)
  };
}

function weeklyPdfHtml_(w) {
  const K = kr2_, neg = n => n ? '−' + K(n) : K(0);
  const th = cols => '<tr>' + cols.map((c, i) => '<th' + (i ? ' class="n"' : '') + '>' + c + '</th>').join('') + '</tr>';
  const tr = (cells, cls) => '<tr class="' + (cls || '') + '">' + cells.map((c, i) => '<td' + (i ? ' class="n"' : '') + '>' + c + '</td>').join('') + '</tr>';
  const s = w.sales, rf = w.refunds, logo = reportLogo_();
  const netEx = s.ex - rf.ex, netVat = s.goodsVat - rf.goodsVat, netTot = s.total - rf.total;
  return '<html><head><meta charset="utf-8"><style>' +
    '@page{size:A4;margin:16mm 14mm}body{font-family:Helvetica,Arial,sans-serif;color:#1B2A3A;font-size:10pt}' +
    '.head{width:100%;border-collapse:collapse;margin-bottom:6mm}.head td{vertical-align:top}' +
    'h1{font-size:20pt;font-weight:normal;margin:0 0 8pt}h2{font-size:13pt;font-weight:bold;margin:16pt 0 6pt}' +
    '.meta{line-height:1.8;color:#4B5261}.meta b{color:#1B2A3A}.right{text-align:right;line-height:1.8;color:#4B5261}' +
    'table.r{width:100%;border-collapse:collapse}table.r th{background:#ECEEF1;text-align:left;font-weight:bold;color:#4B5261;padding:6pt;font-size:9pt}' +
    'table.r th.n,table.r td.n{text-align:right;white-space:nowrap}table.r td{padding:6pt;border-bottom:1px solid #C9CDD3}' +
    'tr.sum td{font-weight:bold}tr.pay td{background:#ECEEF1;font-weight:bold;font-size:11pt}.note{font-size:8.5pt;color:#7A8794;margin-top:4pt}' +
    '</style></head><body>' +
    '<table class="head"><tr><td><h1>Avstämningsrapport</h1>' +
      '<div class="meta"><b>' + esc_(APP.NAME) + '</b><br>' + esc_(ORG.company) + ' · Org.nr: ' + ORG.orgnr + '<br><b>Period:</b> ' + w.from + ' till ' + w.to + ' (' + w.label + ')<br><b>Framtagen:</b> ' + now_('yyyy-MM-dd HH:mm') + '</div>' +
    '</td><td class="right">' + (logo ? '<img src="' + logo + '" width="64" height="64"><br>' : '') + esc_(ORG.street) + '<br>' + esc_(ORG.city) + '</td></tr></table>' +

    '<h2>Översikt</h2><table class="r">' + th(['', 'Ex. moms', 'Moms', 'Totalt inkl. moms']) +
      tr(['Försäljning', K(s.goodsEx), K(s.goodsVat), K(s.goods)]) +
      tr(['Dricks', K(s.tips), K(0), K(s.tips)]) +
      (rf.total ? tr(['Återbetalningar', neg(rf.goodsEx), neg(rf.goodsVat), neg(rf.total)]) : '') +
      tr(['Summa', K(netEx), K(netVat), K(netTot)], 'sum') + '</table>' +

    '<h2>Försäljning per momssats</h2><table class="r">' + th(['', 'Ex. moms', 'Moms', 'Totalt inkl. moms']) +
      tr(['0% Moms (dricks)', K(s.tips), K(0), K(s.tips)]) +
      tr([w.vatPct + '% Moms', K(s.goodsEx - rf.goodsEx), K(netVat), K(s.goods - rf.total)]) +
      tr(['Summa', K(netEx), K(netVat), K(netTot)], 'sum') + '</table>' +

    '<h2>Försäljning per betalmetod</h2><table class="r">' + th(['', 'Antal', 'Ex. moms', 'Totalt inkl. moms']) +
      w.methods.map(x => tr([x.label, x.n, K(x.ex), K(x.total)])).join('') +
      tr(['Summa', w.orders, K(s.ex), K(s.total)], 'sum') + '</table>' +

    '<h2>Avgifter per betalmetod</h2><table class="r">' + th(['', 'Antal', 'Ex. moms', 'Moms', 'Totalt inkl. moms']) +
      tr(['Kort online', w.fee.n, K(w.fee.ex), K(w.fee.vat), K(w.fee.total)]) +
      tr(['Swish', w.methods[1].n, K(0), K(0), K(0)]) +
      tr(['Summa', w.fee.n + w.methods[1].n, K(w.fee.ex), K(w.fee.vat), K(w.fee.total)], 'sum') + '</table>' +

    '<h2>Utbetalningssummering</h2><table class="r">' + th(['', 'Ex. moms', 'Moms', 'Totalt inkl. moms']) +
      tr(['Kortbetalningar online', '', '', K(w.payout.cards)]) +
      (w.payout.refunded ? tr(['Återbetalningar kort', '', '', neg(w.payout.refunded)]) : '') +
      tr(['Transaktionsavgift', neg(w.fee.ex), neg(w.fee.vat), neg(w.fee.total)]) +
      tr(['Totala avgifter', neg(w.fee.ex), neg(w.fee.vat), neg(w.fee.total)], 'sum') +
      tr(['Till ert bankkonto för perioden', '', '', K(w.payout.total)], 'pay') + '</table>' +
    '<p class="note">Kortbetalningarna betalas ut till ert bankkonto varje bankdag (de första veckorna med 7 dagars fördröjning), så beloppet kan komma i flera insättningar. ' +
      'Swish ' + K(w.swishDirect) + ' har betalats direkt till ert Swish-konto utan avgift. Transaktionsavgiften behålls vid återbetalning.' +
      (w.cancelled ? ' Avbokade beställningar (' + w.cancelled + ') ingår inte.' : '') + '</p>' +
    (w.archive === 'error' ? '<p style="color:#9B2C2C">Arkivet kunde inte läsas – siffrorna kan vara ofullständiga.</p>' : '') +
    '</body></html>';
}

function weeklyMail_(from, to) { return avstamningMail_(from, to); }

/** Skickar avstämningsrapporten för from–to (vecka eller månad) som PDF. */
function avstamningMail_(from, to) {
  const rcpt = reportRecipients_();
  if (!rcpt) throw new Error('REPORT_EMAIL/NOTIFY_EMAIL saknas');
  const w = weeklyData_(from, to);
  const pdf = Utilities.newBlob(weeklyPdfHtml_(w), 'text/html', 'v.html').getAs('application/pdf').setName(w.label.indexOf('vecka') === 0 ? 'Hanami_avstamning_v' + w.week + '_' + from + '.pdf' : 'Hanami_avstamning_' + from.slice(0, 7) + '.pdf');
  const html = '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;color:#161B26">' +
    '<p>Hej!</p><p>Här är avstämningsrapporten för <b>' + w.label + '</b> (' + from + ' – ' + to + ').</p>' +
    '<table style="border-collapse:collapse;font-size:15px">' +
    '<tr><td style="padding:4px 18px 4px 0;color:#4B5261">Försäljning totalt</td><td style="text-align:right">' + krR_(w.sales.total - w.refunds.total) + '</td></tr>' +
    '<tr><td style="padding:4px 18px 4px 0;color:#4B5261">Transaktionsavgift</td><td style="text-align:right">−' + krR_(w.fee.total) + '</td></tr>' +
    '<tr><td style="padding:4px 18px 4px 0"><b>Till ert bankkonto (kort)</b></td><td style="text-align:right"><b>' + krR_(w.payout.total) + '</b></td></tr>' +
    '<tr><td style="padding:4px 18px 4px 0;color:#4B5261">Swish (direkt till er)</td><td style="text-align:right">' + krR_(w.swishDirect) + '</td></tr></table>' +
    '<p style="color:#4B5261;font-size:13px">Hela rapporten finns i bifogad PDF.</p></div>';
  MailApp.sendEmail({ to: rcpt, subject: '🧾 Avstämningsrapport ' + w.label + ' · ' + from + '–' + to, htmlBody: html,
    body: 'Avstämningsrapport ' + w.label + ' (' + from + '–' + to + ')\nTill ert bankkonto (kort): ' + krR_(w.payout.total) + '\nSwish (direkt till er): ' + krR_(w.swishDirect), name: APP.NAME + ' rapport', attachments: [pdf] });
  log_('INFO', 'Avstämningsrapport', w.label + ' → ' + rcpt);
  return w;
}

/** Engångstrigger kl 00.03 efter lördag och/eller månadens sista dag. Var rapport skickas högst en gång. */
function sendPeriodReports() {
  const today = reportDay_(), props = PropertiesService.getScriptProperties();   // dygnet som just slutade 23.59.59
  if (new Date(today + 'T12:00:00Z').getUTCDay() === 6) {
    const from = addDays_(today, -6);                                           // söndag–lördag
    if (props.getProperty('WEEKLY_SENT') !== from) { avstamningMail_(from, today); props.setProperty('WEEKLY_SENT', from); }
  }
  if (addDays_(today, 1).slice(0, 7) !== today.slice(0, 7)) {
    const from = today.slice(0, 8) + '01';
    if (props.getProperty('MONTHLY_SENT') !== from) { avstamningMail_(from, today); props.setProperty('MONTHLY_SENT', from); }
  }
}
function monthlyReportTest() {
  const today = now_('yyyy-MM-dd'), w = avstamningMail_(today.slice(0, 8) + '01', today);
  say_('Månadsrapport för ' + w.label + ' (hittills) skickad till ' + reportRecipients_() + '.');
}
function weeklyReportTest() {
  const today = now_('yyyy-MM-dd'), dow = new Date(today + 'T12:00:00Z').getUTCDay();   // 0 = söndag
  const w = avstamningMail_(addDays_(today, -dow), today);                                 // från söndag denna vecka
  say_('Veckorapport för ' + w.label + ' (hittills) skickad till ' + reportRecipients_() + '.\nDen riktiga kommer natten efter lördag, kl 00.03.');
}
