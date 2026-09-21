import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MONTH_MAP: Record<string, number> = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, june:6, jul:7, july:7, aug:8, sep:9, sept:9, oct:10, nov:11, dec:12 };

function normDate(raw: any): string | null {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s || s.toUpperCase() === 'NA' || s === '-' || s === '—') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\s\-\/]+([A-Za-z]+)[\s\-\/]+(\d{4})$/);
  if (m) {
    const mon = MONTH_MAP[m[2].toLowerCase()];
    if (mon) return `${m[3]}-${String(mon).padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime()) && /\d{4}/.test(s)) return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  return null;
}

function normStatusKey(raw: any): string {
  const s = String(raw || '').trim().toLowerCase();
  if (s.startsWith('complet')) return 'completed';
  if (s.includes('amc')) return 'amcpending';
  if (s.includes('cool')) return 'cooling';
  return 'cooling';
}

function findCol(headerRow: any[], candidates: string[]): number {
  const norm = (h: any) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const normalizedHeaders = headerRow.map(norm);
  for (const cand of candidates) {
    const nc = norm(cand);
    const idx = normalizedHeaders.findIndex(h => h.includes(nc) || nc.includes(h));
    if (idx !== -1) return idx;
  }
  return -1;
}

function parseRows(rows: any[][]) {
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
    if (!r || r.every((v: any) => v === undefined || v === '')) continue;
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

async function getAccessToken(): Promise<string> {
  const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID")!;
  const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET")!;
  const refreshToken = Deno.env.get("GOOGLE_OAUTH_REFRESH_TOKEN")!;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("Google token refresh failed: " + JSON.stringify(data));
  return data.access_token;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const SHEET_ID = Deno.env.get("SHEET_ID")!;
    const SHEET_TAB = Deno.env.get("SHEET_TAB") || null;
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const accessToken = await getAccessToken();

    let tabTitle = SHEET_TAB;
    if (!tabTitle) {
      const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const meta = await metaRes.json();
      if (!metaRes.ok) throw new Error("Sheet metadata fetch failed: " + JSON.stringify(meta));
      tabTitle = meta.sheets[0].properties.title;
    }

    const range = `'${tabTitle}'!A1:Z10000`;
    const valuesRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const valuesData = await valuesRes.json();
    if (!valuesRes.ok) throw new Error("Sheet values fetch failed: " + JSON.stringify(valuesData));

    const parsed = parseRows(valuesData.values || []);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    if (parsed.length === 0) {
      await supabase.from("sync_meta").update({
        last_synced_at: new Date().toISOString(),
        last_sync_status: "no_rows_found",
        last_sync_row_count: 0,
      }).eq("id", true);
      return new Response(JSON.stringify({ ok: false, message: "No recognizable rows found in the sheet" }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const { error: delErr } = await supabase.from("ledger_rows").delete().gte("id", 0);
    if (delErr) throw delErr;
    const { error: insErr } = await supabase.from("ledger_rows").insert(parsed);
    if (insErr) throw insErr;

    await supabase.from("sync_meta").update({
      last_synced_at: new Date().toISOString(),
      last_sync_status: "ok",
      last_sync_row_count: parsed.length,
    }).eq("id", true);

    return new Response(JSON.stringify({ ok: true, rows: parsed.length }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message || e) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
