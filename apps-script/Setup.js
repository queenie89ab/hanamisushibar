/** Installation och meny i kalkylarket. */

/** Dialogrutor fungerar bara när skriptet körs från kalkylarket. Körs det från editorn loggar vi i stället. */
function ui_() {
  try { return SpreadsheetApp.getUi(); } catch (e) { return null; }
}
function say_(message) {
  const ui = ui_();
  if (ui) ui.alert(message); else console.log(message);
}

function onOpen() {
  const ui = ui_(); if (!ui) return;
  ui.createMenu('Hanami')
    .addItem('Publicera webbplatsen', 'publishSite')
    .addSeparator()
    .addItem('Nollställ "Slut idag"', 'resetSoldOut')
    .addItem('Onlinebeställning PÅ', 'orderingOn')
    .addItem('Onlinebeställning AV', 'orderingOff')
    .addItem('Visa API-nyckel för Vercel', 'showSecret')
    .addItem('Skicka testbeställning', 'testOrder')
    .addSeparator()
    .addSubMenu(ui.createMenu('Städning')
      .addItem('Provkör (räknar bara, ändrar inget)', 'cleanupDryRun')
      .addItem('Städa nu', 'cleanupNow')
      .addItem('Slå på nattlig städning', 'cleanupEnable')
      .addItem('Stäng av nattlig städning', 'cleanupDisable')
      .addItem('Öppna arkivarket', 'openArchive'))
    .addSubMenu(ui.createMenu('Rapporter per e-post')
      .addItem('Slå på (dygnet t.o.m. 23.59.59, skickas 00.01)', 'reportMailEnable')
      .addItem('Stäng av', 'reportMailDisable')
      .addItem('Skicka gårdagens dagsrapport nu', 'reportMailYesterday')
      .addItem('Kontrollera rapporterna', 'reportMailStatus')
      .addItem('Skicka dagsrapport nu (test, idag hittills)', 'reportMailTestDay')
      .addItem('Skicka månadsrapport nu (denna månad, test)', 'monthlyReportTest')
      .addItem('Skicka veckorapport nu (denna vecka, test)', 'weeklyReportTest'))
    .addSubMenu(ui.createMenu('Q89 plattformsrapport')
      .addItem('Slå på (varje morgon, gårdagen)', 'platformReportEnable')
      .addItem('Stäng av', 'platformReportDisable')
      .addItem('Skicka för idag (hittills)', 'platformReportTestToday')
      .addItem('Skicka för igår', 'platformReportTestYesterday'))
    .addSeparator()
    .addItem('Installera / reparera', 'setup')
    .addItem('Kontrollera installationen', 'setupCheck')
    .addItem('Formatera menyfliken (kryssrutor, färger)', 'formatMenuOnly')
    .addItem('Lägg om all formatering (långsamt)', 'setupRepair')
    .addToUi();
}

/**
 * setup(): det NÖDVÄNDIGA – flikar och rubriker, triggers, nycklar, menyns första innehåll. Tar några sekunder.
 *          Rör aldrig befintliga rader. Varje steg loggas med tid i Nhật ký thực thi / Logg så att ett
 *          långsamt steg syns direkt.
 * setupRepair(): dessutom all formatering (textformat, prisformat, statusfärger, kryssrutor) – flik för flik.
 *          Kan ta minuter på ett ark med många rader; kör den bara när formateringen verkligen behöver läggas om.
 */
function setup() { return setup_(false); }
function setupRepair() { return setup_(true); }

const FRESH_ = {};   // fliknamn -> true om fliken skapades i den här körningen

function setup_(force) {
  const t0 = Date.now(), steps = [];
  const step = (name, fn) => { const t = Date.now(); const r = fn(); steps.push(name + ' ' + (Date.now() - t) + ' ms'); console.log(steps[steps.length - 1]); return r; };
  const ss = SpreadsheetApp.getActive();
  step('tidszon', () => ss.setSpreadsheetTimeZone(APP.TZ));

  const orders = step('flik Beställningar', () => ensureSheet_(SHEET.ORDERS, HEADERS.ORDERS, { 'Beställning': 260, 'Kommentar': 220, 'Rader (data)': 80 }));
  const bookings = step('flik Bokningar', () => ensureSheet_(SHEET.BOOKINGS, HEADERS.BOOKINGS, { 'Meddelande': 260 }));
  const menu = step('flik Meny', () => ensureSheet_(SHEET.MENU, HEADERS.MENU, { 'Kategori': 170, 'Kategoritext': 220, 'Namn': 220, 'Beskrivning': 420 }));
  step('flik Logg', () => ensureSheet_(SHEET.LOG, HEADERS.LOG, { 'Detaljer': 500 }));
  step('flik Betalningar', () => ensureSheet_(SHEET.PAY, HEADERS.PAY, { 'Order (data)': 80, 'Rader (data)': 80, 'Stripe session': 160, 'Payment intent': 160 }));

  // Meny: fyll på första gången
  if (menu.getLastRow() < 2) step('menyn fylls', () => menu.getRange(2, 1, MENU_SEED.length, MENU_SEED[0].length).setValues(MENU_SEED));

  // Formatering: bara nya flikar, eller allt vid setupRepair
  if (force || FRESH_[SHEET.ORDERS]) step('format Beställningar', () => formatOrders_(orders));
  if (force || FRESH_[SHEET.BOOKINGS]) step('format Bokningar', () => formatBookings_(bookings));
  if (force || FRESH_[SHEET.MENU]) step('format Meny', () => formatMenu_(menu));

  // Ta bort tomt standardblad
  step('städa standardblad', () => ['Blad1', 'Sheet1', 'Trang tính1'].forEach(name => {
    const sh = ss.getSheetByName(name);
    if (sh && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  }));
  ss.setActiveSheet(orders);

  // Triggers
  step('triggers', () => {
    ScriptApp.getProjectTriggers().forEach(t => {
      if (['handleEdit', 'resetSoldOut', 'nightlyCleanup', 'scheduleReportMail', 'sendReportMail', 'weeklyReportTick', 'sendPeriodReports'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
    });
    ScriptApp.newTrigger('handleEdit').forSpreadsheet(ss).onEdit().create();
    ScriptApp.newTrigger('resetSoldOut').timeBased().atHour(4).everyDays(1).inTimezone(APP.TZ).create();
    // Städningen en halvtimme senare så att de två nattjobben inte krockar om låset
    ScriptApp.newTrigger('nightlyCleanup').timeBased().atHour(4).nearMinute(30).everyDays(1).inTimezone(APP.TZ).create();
    // Rapporter per e-post (ReportMail.js): kl ~12 läggs engångstriggers på 00.01 (dag) och 00.03 (vecka/månad) natten efter
    ScriptApp.newTrigger('scheduleReportMail').timeBased().atHour(12).everyDays(1).inTimezone(APP.TZ).create();
    scheduleReportMail();
  });

  // Hemlig nyckel och räknare
  const props = PropertiesService.getScriptProperties();
  step('egenskaper', () => {
    if (!props.getProperty('API_SECRET')) props.setProperty('API_SECRET', Utilities.getUuid() + Utilities.getUuid().slice(0, 8));
    if (!props.getProperty('SEQ_H')) props.setProperty('SEQ_H', '1000');
    if (!props.getProperty('SEQ_B')) props.setProperty('SEQ_B', '1000');
    if (!props.getProperty('CLEANUP_ENABLED')) props.setProperty('CLEANUP_ENABLED', 'off');   // städningen slås på medvetet från menyn
    clearMenuCache_();
  });
  step('logg', () => log_('INFO', force ? 'Setup (reparera)' : 'Setup', 'Klar på ' + Math.round((Date.now() - t0) / 1000) + ' s · ' + steps.join(' · ')));
  console.log('SETUP KLAR på ' + Math.round((Date.now() - t0) / 1000) + ' s');

  const missing = ['NOTIFY_EMAIL', 'SITE_URL', 'VERCEL_DEPLOY_HOOK'].filter(k => !props.getProperty(k));
  say_('Installationen är klar ✅ (' + Math.round((Date.now() - t0) / 1000) + ' s)\n\n' +
    'Nästa steg:\n1. Distribuera → Ny distribution → Webbapp (Kör som: Jag, Åtkomst: Alla)\n' +
    '2. Hanami → Visa API-nyckel för Vercel\n' +
    '3. Hanami → Städning → Provkör, och slå på nattlig städning när siffrorna ser rätt ut\n' +
    (missing.length ? '\nSaknade skriptegenskaper: ' + missing.join(', ') : ''));
}

/** Kontroll utan att ändra något: flikar, radantal, triggers och nycklar. Kör den när du undrar om setup gick igenom. */
function setupCheck() {
  const ss = SpreadsheetApp.getActive(), out = [];
  [SHEET.ORDERS, SHEET.BOOKINGS, SHEET.MENU, SHEET.LOG, SHEET.PAY].forEach(n => {
    const sh = ss.getSheetByName(n);
    out.push(n + ': ' + (sh ? (sh.getLastRow() - 1) + ' rader, ' + sh.getLastColumn() + ' kolumner (max ' + sh.getMaxRows() + ' rader i arket)' : 'SAKNAS'));
  });
  const want = { ORDERS: HEADERS.ORDERS, BOOKINGS: HEADERS.BOOKINGS };
  Object.keys(want).forEach(k => {
    const sh = ss.getSheetByName(SHEET[k]); if (!sh) return;
    const have = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
    const miss = want[k].filter(h => have.indexOf(h) < 0);
    if (miss.length) out.push('Saknade kolumner i ' + SHEET[k] + ': ' + miss.join(', '));
  });
  out.push('Triggers: ' + ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction()).join(', '));
  const p = PropertiesService.getScriptProperties();
  out.push('API_SECRET: ' + (p.getProperty('API_SECRET') ? 'finns' : 'SAKNAS') + ' · CLEANUP_ENABLED: ' + (p.getProperty('CLEANUP_ENABLED') || '–') +
           ' · PICKUP_LEAD: ' + (p.getProperty('PICKUP_LEAD') || '–') + ' · ARCHIVE_ID: ' + (p.getProperty('ARCHIVE_ID') ? 'finns' : '–'));
  out.push('Webbapp-URL: ' + (ScriptApp.getService().getUrl() || '(inte distribuerad)'));
  say_(out.join('\n'));
}

/* ---- formatering, flik för flik. Begränsas till befintliga rader + 500 så att tomma rader inte kostar tid. ---- */
function fmtRows_(sh) { return Math.max(1, Math.min(sh.getMaxRows(), sh.getLastRow() + 500) - 1); }

function formatOrders_(sh) {
  const n = fmtRows_(sh), c = colMap_(sh);
  textColumns_(sh, ['Mottagen', 'Ordernr', 'Bord', 'Hämtas datum', 'Hämtas tid', 'Telefon', 'Sms klar', 'Utskriven', 'Betald'], n);
  sh.getRange(2, c['Summa'], n).setNumberFormat('#,##0" kr"');
  sh.getRange(2, c['Beställning'], n).setWrap(true);
  sh.hideColumns(c['Rader (data)']);
  statusRules_(sh, ORDER_STATUS, STATUS_COLORS.ORDERS, n);
}
function formatBookings_(sh) {
  const n = fmtRows_(sh);
  textColumns_(sh, ['Mottagen', 'Boknr', 'Datum', 'Tid', 'Telefon', 'Sms bekräftad'], n);
  statusRules_(sh, BOOKING_STATUS, STATUS_COLORS.BOOKINGS, n);
}
function formatMenu_(menu) {
  const mc = colMap_(menu), n = Math.max(menu.getLastRow() - 1, 1), all = fmtRows_(menu);
  textColumns_(menu, ['Kategori-id', 'Id'], all);
  menu.getRange(2, mc['Pris'], all).setNumberFormat('0" kr"');
  menu.getRange(2, mc['Visas på webben'], n).insertCheckboxes();
  menu.getRange(2, mc['Slut idag'], n).insertCheckboxes();
  menu.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$A2<>""').setBackground('#EEF3F8').setBold(true)
      .setRanges([menu.getRange(2, 1, all, HEADERS.MENU.length)]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$I2=TRUE').setFontColor('#B6493E')
      .setRanges([menu.getRange(2, 1, all, HEADERS.MENU.length)]).build()
  ]);
  menu.getRange(2, mc['Pris'], all).setDataValidation(
    SpreadsheetApp.newDataValidation().requireNumberBetween(0, 10000).setAllowInvalid(false).setHelpText('Pris i hela kronor').build());
}

/** Bara formateringen för Meny (kryssrutor, färger) – när nya rätter lagts till i arket. */
function formatMenuOnly() { formatMenu_(sheet_(SHEET.MENU)); say_('Menyfliken är formaterad.'); }

function ensureSheet_(name, headers, widths) {
  const ss = SpreadsheetApp.getActive();
  const existed = !!ss.getSheetByName(name);
  const sh = existed ? ss.getSheetByName(name) : ss.insertSheet(name);
  FRESH_[name] = !existed;
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    // lägg till nya kolumner om koden fått fler rubriker
    const have = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
    headers.filter(h => have.indexOf(h) < 0).forEach(h => sh.getRange(1, sh.getLastColumn() + 1).setValue(h));
  }
  const width = sh.getLastColumn();
  sh.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#161B26').setFontColor('#FFFFFF').setVerticalAlignment('middle');
  sh.setFrozenRows(1);
  sh.setRowHeight(1, 32);
  if (!existed) { const map = colMap_(sh); headers.forEach(h => sh.setColumnWidth(map[h], (widths && widths[h]) || 120)); }
  return sh;
}

function textColumns_(sh, names, rows) {
  const map = colMap_(sh), n = rows || Math.max(1, sh.getMaxRows() - 1);
  names.filter(x => map[x]).forEach(x => sh.getRange(2, map[x], n).setNumberFormat('@'));
}

function statusRules_(sh, values, colors, rows) {
  const c = colMap_(sh)['Status'], n = rows || Math.max(1, sh.getMaxRows() - 1);
  const letter = sh.getRange(1, c).getA1Notation().replace(/\d/g, '');
  sh.getRange(2, c, n).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(false).build());
  const range = sh.getRange(2, 1, n, sh.getLastColumn());
  sh.setConditionalFormatRules(Object.keys(colors).map(v =>
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$' + letter + '2="' + v + '"')
      .setBackground(colors[v]).setRanges([range]).build()));
}

function showSecret() {
  const s = prop_('API_SECRET');
  const url = ScriptApp.getService().getUrl();
  say_(
    'Lägg in i Vercel → Settings → Environment Variables:\n\n' +
    'GAS_SECRET = ' + (s || '(kör setup först)') + '\n\n' +
    'GAS_URL = ' + (url || '(distribuera som webbapp först)') + '\n\n' +
    'Dela aldrig nyckeln med någon annan.');
}

/** Menyval i arket: slå på/av onlinebeställning (samma sak som knappen i köksvyn). */
function orderingOn() { setOrdering_(true); say_('Onlinebeställning är PÅ. Webben tar emot beställningar igen.'); }
function orderingOff() { setOrdering_(false); say_('Onlinebeställning är AV. Gäster kan se menyn men inte beställa. Slå på igen via Hanami → Onlinebeställning PÅ eller i köksvyn.'); }

/** Skapar en testbeställning och en testbokning (utan sms). */
function testOrder() {
  const first = readMenuRows_().filter(i => i.visible && i.price > 0 && i.categoryId !== 'lunch' && i.categoryId !== 'happy')[0];
  const today = now_('yyyy-MM-dd');
  // asap: tiden räknas som på webben (nu + förberedelsetid), så testet fungerar oavsett klockslag
  const r = withLock_(() => createOrder_({ internal: true, kind: 'pickup', name: 'TEST – radera', phone: '', asap: true, openFrom: 0, closeAt: 1440,
    defaultLead: 30, pickupDate: today, pickupTime: '00:00', whenText: 'idag', payment: 'swish', message: 'Testbeställning', items: [{ id: first.id, qty: 2 }] }));
  SpreadsheetApp.getActive().toast('Testbeställning ' + r.no + ' skapad (' + r.total + ' kr). Kolla din e-post.', 'Hanami', 8);
}
