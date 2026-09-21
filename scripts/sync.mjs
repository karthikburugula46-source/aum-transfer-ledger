import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';

const SHEET_ID = process.env.SHEET_ID;
const SHEET_TAB = process.env.SHEET_TAB || null; // optional explicit tab name; defaults to first tab
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Google auth comes from Workload Identity Federation (google-github-actions/auth@v2
// sets GOOGLE_APPLICATION_CREDENTIALS before this script runs) — no key file involved.

if (!SHEET_ID || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing required env vars: SHEET_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const MONTH_MAP = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function normDate(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s || s.toUpperCase() === 'NA' || s === '-' || s === '—') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  let m = s.match(/^(\d{1,2})[\s\-\/]+([A-Za-z]+)[\s\-\/]+(\d{4})$/);
  if (m) {
    const mon = MONTH_MAP[m[2].toLowerCase()];
    if (mon) return `${m[3]}-${String(mon).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  const d = new Date(s);
  if (!isNaN(d) && /\d{4}/.test(s)) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return null;
}

function normStatusKey(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s.startsWith('complet')) return 'completed';
  if (s.includes('amc')) return 'amcpending';
  if (s.includes('cool')) return 'cooling';
  return 'cooling';
}

function findCol(headerRow, candidates) {
  const norm = h => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const normalizedHeaders = headerRow.map(norm);
  for (const cand of candidates) {
    const nc = norm(cand);
    const idx = normalizedHeaders.findIndex(h => h.includes(nc) || nc.includes(h));
    if (idx !== -1) return idx;
  }
  return -1;
}

function parseRows(rows) {
  if (!rows.length) return [];
  const header = rows[0];
  const cPartner = findCol(header, ['partner name', 'partner']);
  const cArn = findCol(header, ['aum transfered in arn no', 'arn no', 'arn']);
  const cRm = findCol(header, ['rm name', 'rm']);
  const cValue = findCol(header, ['value in crs', 'value cr', 'value']);
  const cDate = findCol(header, ['received date ap', 'received date', 'date']);
  const cSubmitted = findCol(header, ['submitted date', 'submitted']);
  const cCompleted = findCol(header, ['completed date', 'completed']);
  const cAmc = findCol(header, ['amc completed', 'amc progress', 'amc']);
  const cStatus = findCol(header, ['status']);
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every(v => v === undefined || v === '')) continue;
    const partner = cPartner !== -1 ? r[cPartner] : '';
    if (!partner) continue;
    out.push({
      partner: String(partner).trim(),
      arn: cArn !== -1 ? String(r[cArn] || '').trim() : '',
      rm: cRm !== -1 ? String(r[cRm] || '').trim() : '',
      value: cValue !== -1 ? (Number(r[cValue]) || 0) : 0,
      date: cDate !== -1 ? normDate(r[cDate]) : null,
      submitted_date: cSubmitted !== -1 ? normDate(r[cSubmitted]) : null,
      completed_date: cCompleted !== -1 ? normDate(r[cCompleted]) : null,
      amc: cAmc !== -1 ? String(r[cAmc] || '').trim() : '',
      status: cStatus !== -1 ? normStatusKey(r[cStatus]) : 'cooling',
    });
  }
  return out;
}

async function main() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  let tabTitle = SHEET_TAB;
  if (!tabTitle) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    tabTitle = meta.data.sheets[0].properties.title;
  }

  const valuesRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${tabTitle}'!A1:Z10000`,
  });
  const rawRows = valuesRes.data.values || [];
  const parsed = parseRows(rawRows);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  if (parsed.length === 0) {
    await supabase.from('sync_meta').update({
      last_synced_at: new Date().toISOString(),
      last_sync_status: 'no_rows_found',
      last_sync_row_count: 0,
    }).eq('id', true);
    console.error('No recognizable rows found in the sheet; leaving existing ledger_rows untouched.');
    process.exit(1);
  }

  const { error: delErr } = await supabase.from('ledger_rows').delete().gte('id', 0);
  if (delErr) throw delErr;

  const { error: insErr } = await supabase.from('ledger_rows').insert(parsed);
  if (insErr) throw insErr;

  await supabase.from('sync_meta').update({
    last_synced_at: new Date().toISOString(),
    last_sync_status: 'ok',
    last_sync_row_count: parsed.length,
  }).eq('id', true);

  console.log(`Synced ${parsed.length} row(s) from sheet tab "${tabTitle}".`);
}

main().catch(async (e) => {
  console.error('Sync failed:', e);
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from('sync_meta').update({
      last_synced_at: new Date().toISOString(),
      last_sync_status: `error: ${String(e.message || e).slice(0, 200)}`,
    }).eq('id', true);
  } catch {}
  process.exit(1);
});
