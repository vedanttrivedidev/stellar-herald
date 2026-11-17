// Shared helpers for the subscriber system. No dependencies (Node 18+).
import { setTimeout as sleepMs } from 'node:timers/promises';

export const wait = ms => (process.env.HERALD_FAST ? Promise.resolve() : sleepMs(ms));

// ── Supabase over plain HTTPS ────────────────────────────────────────────
// New-style keys (sb_publishable_ / sb_secret_) go in the "apikey" header ONLY.
// Old JWT-style keys (eyJ...) and signed-in readers' tokens also use Authorization.
export function supabase({ url, key, token }) {
  const base = String(url).replace(/\/+$/, '');
  const legacy = String(key).startsWith('eyJ');
  async function call(method, path, { body, headers } = {}) {
    const h = { apikey: key, ...(headers || {}) };
    if (token) h.authorization = 'Bearer ' + token;
    else if (legacy) h.authorization = 'Bearer ' + key;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, ok: res.ok, json, text };
  }
  return {
    call,
    rest: (method, path, opts) => call(method, '/rest/v1/' + path.replace(/^\//, ''), opts),
    auth: (method, path, opts) => call(method, '/auth/v1/' + path.replace(/^\//, ''), opts),
  };
}

// ── Edition cleaning (mirror of the page's own code in docs/index.html) ──
const ENT = { quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', amp: '&' };
const dec = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => { if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m } return ENT[e.toLowerCase()] ?? m });
export const clean = s => dec(dec(String(s || ''))).replace(/<\/?[a-z][^>]*>/gi, ' ').replace(/\s+/g, ' ').trim();
export const fixStory = x => { const h = clean(x.h), t = clean(x.t); return { ...x, h, t: t.toLowerCase().startsWith(h.toLowerCase().slice(0, 30)) ? '' : t } };
export const normEdition = d => ({ ...d, breaking: (d.breaking || []).map(fixStory), stories: (d.stories || []).map(fixStory) });

// ── Dates (the paper is published on India time) ─────────────────────────
export function todayIST(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export const longDate = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

// ── Email layout (plain black-and-white, like the site) ──────────────────
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const okUrl = u => /^https?:\/\//i.test(String(u || ''));
const links = x => (x.l || []).filter(l => Array.isArray(l) && okUrl(l[1]));

export function renderEmail(ed, { siteUrl, unsubscribeUrl }) {
  const date = longDate(ed.date);
  const stories = ed.stories || [], breaking = (ed.breaking || []).filter(b => links(b).length);
  const head = x => { const l = links(x)[0]; return l ? `<a href="${esc(l[1])}" style="color:#111111;text-decoration:none">${esc(x.h)}</a>` : esc(x.h) };
  const free = x => { const ls = links(x); return ls.length ? `<div style="font-size:13px;color:#555555;margin-top:6px">Free to read: ${ls.map(l => `<a href="${esc(l[1])}" style="color:#111111;text-decoration:underline">${esc(l[0] || 'Read')}</a>`).join(' &middot; ')}</div>` : '' };
  const body = x => x.t ? `<p style="margin:6px 0 0;font-size:15px;color:#222222">${esc(x.t)}</p>` : '';
  const brk = breaking.map(b => `<div style="border-top:1px solid #111111;border-bottom:1px solid #111111;padding:10px 0;margin:0 0 18px;font-size:15px;font-weight:700"><span style="color:#b00020;font-size:11px;letter-spacing:.08em;text-transform:uppercase;border:1px solid #b00020;padding:2px 6px;margin-right:8px">Breaking</span>${head(b)}</div>`).join('');
  const [lead, ...rest] = stories;
  const leadHtml = lead ? `<div style="margin:0 0 22px"><h2 style="margin:0;font-size:24px;line-height:1.25">${head(lead)}</h2>${body(lead)}${free(lead)}</div>` : '';
  const restHtml = rest.map(x => `<div style="border-top:1px solid #dddddd;padding:14px 0"><h3 style="margin:0;font-size:18px;line-height:1.3">${head(x)}</h3>${body(x)}${free(x)}</div>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stellar Herald</title></head>
<body style="margin:0;padding:0;background:#ffffff;color:#111111">
<div style="max-width:620px;margin:0 auto;padding:24px 20px;font-family:Georgia,'Times New Roman',serif;line-height:1.5">
<div style="border-bottom:3px solid #111111;padding-bottom:10px;margin-bottom:18px"><div style="font-size:30px;font-weight:700">Stellar Herald</div><div style="font-size:12px;color:#555555;text-transform:uppercase;letter-spacing:.08em">Morning Edition &middot; ${esc(date)}</div></div>
${brk}${leadHtml}${restHtml}
<div style="border-top:3px solid #111111;margin-top:22px;padding-top:12px;font-size:12px;color:#555555">You get this email because you signed up for the Stellar Herald morning edition. <a href="${esc(unsubscribeUrl)}" style="color:#555555;text-decoration:underline">Unsubscribe</a> &middot; <a href="${esc(siteUrl)}" style="color:#555555;text-decoration:underline">Read online</a> (login required). Stellar Herald is an independent project.</div>
</div></body></html>`;
  const t = [];
  t.push(`STELLAR HERALD · ${date}`, '');
  for (const b of breaking) t.push(`BREAKING: ${b.h}`, links(b)[0][1], '');
  stories.forEach((x, i) => {
    t.push(`${i + 1}. ${x.h}`); if (x.t) t.push(`   ${x.t}`);
    for (const l of links(x)) t.push(`   ${l[0] || 'Read'}: ${l[1]}`);
    t.push('');
  });
  t.push('--', `Unsubscribe: ${unsubscribeUrl}`, `Read online (login required): ${siteUrl}`);
  return { subject: `Stellar Herald · ${date}`, html, text: t.join('\n') };
}

// ── Brevo (free transactional email API) ─────────────────────────────────
export async function sendBrevo({ apiKey, base = 'https://api.brevo.com/v3', sender, to, subject, html, text, headers, tags }) {
  const body = { sender, to: [{ email: to }], subject, htmlContent: html, textContent: text };
  if (tags?.length) body.tags = tags;
  if (headers && Object.keys(headers).length) body.headers = headers;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(base.replace(/\/+$/, '') + '/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const txt = await res.text();
    let json = null; try { json = JSON.parse(txt) } catch { /* not JSON */ }
    const error = res.ok ? null : (json?.message || txt.slice(0, 200) || 'HTTP ' + res.status);
    if (res.status === 429 && attempt < 2) { await wait(Math.min(30, Number(res.headers.get('retry-after')) || 5) * 1000); continue; }
    if (res.status === 400 && body.headers && /header/i.test(error)) { delete body.headers; continue; }   // retry once without custom headers
    return { status: res.status, ok: res.ok, messageId: json?.messageId, error };
  }
}
