/**
 * Underlag för omsättningsrapporten i köksvyn (Rapport). Apps Script lämnar bara ut raderna – summeringen
 * görs av Vercel (lib/report.js) så att den kan testas och räkna Q89-avgiften med samma formel som Stripe.
 *
 * Läser BÅDE driftarket och arkivet: nattstädningen flyttar beställningar äldre än 30 dagar till arkivarket
 * (Cleanup.js, ARCHIVE_ID). Utan arkivet skulle äldre månader se tomma ut. Inga personuppgifter lämnas ut.
 * Datum = dagen beställningen togs emot (Mottagen), i restaurangens tidszon.
 */
function reportOrders_(from, to, withLines) {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(from || '') || !iso.test(to || '') || from > to) throw new ApiError(400, 'Ogiltigt datumintervall.');
  const pick = sh => rows_(sh)
    .filter(r => { const d = String(r['Mottagen'] || '').slice(0, 10); return d >= from && d <= to; })
    .map(r => ({
      d: String(r['Mottagen']).slice(0, 10), no: r['Ordernr'], kind: r['Typ'] === 'Bord' ? 'table' : 'pickup',
      payment: r['Betalning'], status: r['Status'], paid: !!r['Betald'],
      total: Number(String(r['Summa']).replace(/\D/g, '')) || 0,
      tip: Number(String(r['Dricks']).replace(/\D/g, '')) || 0,
      online: /^pi_/.test(r['Stripe'] || ''), refunded: refundedKr_(r['Återbetald']),
      pi: /^pi_/.test(r['Stripe'] || '') ? String(r['Stripe']) : '',   // kopplar ordern till Stripe-utbetalningen
      lines: withLines ? (safeJson_(r['Rader (data)']) || []) : undefined
    }));

  const orders = pick(sheet_(SHEET.ORDERS));
  let archive = 'none';
  const id = PropertiesService.getScriptProperties().getProperty('ARCHIVE_ID');
  if (id && from < now_('yyyy-MM-dd')) {
    try {
      const a = SpreadsheetApp.openById(id).getSheetByName(SHEET.ORDERS);
      if (a && a.getLastRow() > 1) { pick(a).forEach(o => orders.push(o)); archive = 'ok'; }
    } catch (e) { archive = 'error'; log_('WARN', 'Rapport', 'Arkivet gick inte att läsa: ' + e.message); }
  }
  // samma order kan finnas i båda om städningen avbröts mitt i en flytt – räkna den en gång
  const seen = {};
  return { orders: orders.filter(o => !o.no || (seen[o.no] ? false : (seen[o.no] = true))), archive: archive };
}
