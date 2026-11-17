// One-click health check for the REAL Supabase project and Brevo account.
// Run it from GitHub: Actions > "Live check" > Run workflow.
// It creates two throw-away test readers, tries to break in the way a stranger would,
// then deletes everything it made. Nothing is emailed except (optionally) one test email to you.
//
// CHECK=db (default) | mail | all
import { pathToFileURL } from 'node:url';
import { supabase, sendBrevo } from './lib/core.mjs';

export async function liveCheck({ env = process.env, log = console.log } = {}) {
  const results = [];
  const rec = (ok, name, detail = '') => { results.push({ ok, name, detail }); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '\n        → ' + detail : ''}`); return ok };
  const which = String(env.CHECK || 'db').toLowerCase();
  const short = r => `HTTP ${r.status} ${String(r.text || '').slice(0, 140)}`;

  if (which === 'db' || which === 'all') {
    const miss = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY'].filter(k => !env[k]);
    if (miss.length) rec(false, 'GitHub secrets are set', `missing: ${miss.join(', ')}`);
    else await dbChecks();
  }
  if (which === 'mail' || which === 'all') {
    const miss = ['BREVO_API_KEY', 'BREVO_SENDER_EMAIL', 'EMAIL_TO'].filter(k => !env[k]);
    if (miss.length) rec(false, 'Brevo secrets are set', `missing: ${miss.join(', ')}`);
    else await mailChecks();
  }

  async function dbChecks() {
    const svc = supabase({ url: env.SUPABASE_URL, key: env.SUPABASE_SECRET_KEY });
    const anon = supabase({ url: env.SUPABASE_URL, key: env.SUPABASE_PUBLISHABLE_KEY });
    const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const emailA = `herald-check-a-${stamp}@example.com`, emailB = `herald-check-b-${stamp}@example.com`;
    const DAY = '2000-01-01';
    const sub = async id => ((await svc.rest('GET', `subscribers?user_id=eq.${id}&select=*`)).json || [])[0] || null;
    const leaks = r => r.ok && Array.isArray(r.json) && r.json.length > 0;     // 401/403 or [] both mean "locked"
    let idA, idB;
    try {
      for (const t of ['subscribers', 'editions', 'send_log']) {
        const r = await svc.rest('GET', `${t}?select=*&limit=1`);
        rec(r.ok, `table "${t}" exists and the secret key can read it`, `${short(r)} — run supabase/schema.sql, and check SUPABASE_URL / SUPABASE_SECRET_KEY`);
      }
      if (results.some(r => !r.ok)) return;

      const pub = await svc.rest('POST', 'editions?on_conflict=edition_date', { body: { edition_date: DAY, data: { date: DAY, stories: [{ s: 'Technology', h: 'Live check', t: '', l: [] }] } }, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
      rec(pub.ok, 'the daily job can publish an edition', short(pub));

      const peek = await anon.rest('GET', `editions?edition_date=eq.${DAY}&select=edition_date`);
      rec(!leaks(peek), 'the paper is NOT readable without logging in', 'a logged-out request returned the edition');

      const a = await svc.auth('POST', 'admin/users', { body: { email: emailA, email_confirm: false, user_metadata: { email_updates: true } } });
      idA = a.json?.id;
      if (!rec(!!idA, 'can create a test reader (Auth admin API)', short(a))) return;
      rec((await sub(idA)) === null, 'an UNVERIFIED sign-up is not added to the mailing list (no spam to strangers)', 'the trigger added an unverified address');

      await svc.auth('PUT', `admin/users/${idA}`, { body: { email_confirm: true } });
      const rowA = await sub(idA);
      rec(!!rowA && rowA.subscribed === true && rowA.email === emailA, 'a VERIFIED sign-up joins the list, opted in by default', JSON.stringify(rowA));

      const b = await svc.auth('POST', 'admin/users', { body: { email: emailB, email_confirm: true, user_metadata: { email_updates: false } } });
      idB = b.json?.id;
      const rowB = idB ? await sub(idB) : null;
      rec(!!rowB && rowB.subscribed === false, 'the "do not email me" checkbox at sign-up is honoured', JSON.stringify(rowB));

      const snoop = await anon.rest('GET', 'subscribers?select=email');
      rec(!leaks(snoop), 'the email list is NOT readable without logging in', 'a logged-out request returned subscriber emails');

      const un = await anon.rest('POST', 'rpc/unsubscribe_by_token', { body: { p_token: rowA?.unsubscribe_token } });
      rec(un.ok && un.json === true, 'the unsubscribe link works without logging in', short(un));
      rec((await sub(idA))?.subscribed === false, 'after unsubscribing, emails are switched off', 'row is still subscribed');
      const bad = await anon.rest('POST', 'rpc/unsubscribe_by_token', { body: { p_token: '00000000-0000-4000-8000-000000000000' } });
      rec(bad.ok && bad.json === false, 'a made-up unsubscribe link is rejected harmlessly', short(bad));

      const link = await svc.auth('POST', 'admin/generate_link', { body: { type: 'magiclink', email: emailA } });
      const otp = link.json?.email_otp;
      rec(!!otp, 'can get a login code for the test reader', `${short(link)} — tell Claude; the secret key may not be allowed to use the admin API`);
      if (!otp) return;
      let ver = await anon.auth('POST', 'verify', { body: { type: 'email', email: emailA, token: otp } });
      if (!ver.json?.access_token) ver = await anon.auth('POST', 'verify', { body: { type: 'magiclink', email: emailA, token: otp } });
      const jwt = ver.json?.access_token;
      rec(!!jwt, 'passwordless login works (the emailed code is accepted)', short(ver));
      if (!jwt) return;
      const me = supabase({ url: env.SUPABASE_URL, key: env.SUPABASE_PUBLISHABLE_KEY, token: jwt });

      const ed = await me.rest('GET', `editions?edition_date=eq.${DAY}&select=edition_date`);
      rec(ed.ok && ed.json?.length === 1, 'a logged-in reader CAN read the paper', short(ed));
      const mine = await me.rest('GET', 'subscribers?select=email');
      rec(mine.ok && mine.json?.length === 1 && mine.json[0].email === emailA, 'a reader sees only their own subscription, never other people’s emails', short(mine));
      const lg = await me.rest('GET', 'send_log?select=*');
      rec(!leaks(lg), 'readers cannot read the send log', 'send_log rows were visible');
      const on = await me.rest('POST', 'rpc/set_my_email_updates', { body: { p_on: true } });
      rec(on.ok && (await sub(idA))?.subscribed === true, 'a reader can switch emails back on in Settings', short(on));
      await me.rest('PATCH', `subscribers?user_id=eq.${idB}`, { body: { subscribed: true } });
      rec((await sub(idB))?.subscribed === false, 'a reader cannot change someone else’s subscription', 'another reader’s row was changed');
    } catch (e) {
      rec(false, 'the check ran without crashing', e.message);
    } finally {
      for (const id of [idA, idB]) if (id) await svc.auth('DELETE', `admin/users/${id}`);
      const d = await svc.rest('DELETE', `editions?edition_date=eq.${DAY}`);
      const left = (idA ? await sub(idA) : null) || (idB ? await sub(idB) : null);
      rec(d.ok && !left, 'test data cleaned up', `${short(d)}; leftover rows: ${!!left}`);
    }
  }

  async function mailChecks() {
    const base = env.BREVO_API_BASE || 'https://api.brevo.com/v3';
    const h = { 'api-key': env.BREVO_API_KEY, accept: 'application/json' };
    const acct = await fetch(base + '/account', { headers: h });
    rec(acct.ok, 'Brevo accepts the API key', `HTTP ${acct.status} — make sure BREVO_API_KEY is an API key (starts with xkeysib-), not an SMTP key`);
    if (!acct.ok) return;
    const sr = await fetch(base + '/senders', { headers: h });
    const list = sr.ok ? ((await sr.json()).senders || []) : null;
    if (list) {
      const mine = list.find(s => String(s.email).toLowerCase() === env.BREVO_SENDER_EMAIL.toLowerCase());
      rec(!!mine && mine.active !== false, 'the sender address is a verified Brevo sender', `"${env.BREVO_SENDER_EMAIL}" not found/active. Brevo lists: ${list.map(s => s.email).join(', ') || 'none'}`);
    } else log('NOTE  could not list Brevo senders; skipping that check');
    const r = await sendBrevo({ apiKey: env.BREVO_API_KEY, base, sender: { name: env.BREVO_SENDER_NAME || 'Stellar Herald', email: env.BREVO_SENDER_EMAIL }, to: env.EMAIL_TO, subject: 'Stellar Herald · live check', html: '<p>This is the Stellar Herald live check. If you can read this, email sending works.</p>', text: 'Stellar Herald live check. If you can read this, email sending works.', headers: { 'List-Unsubscribe': '<https://example.com/unsubscribe>' }, tags: ['live-check'] });
    rec(r.status === 201, 'Brevo accepted a test email to you (check your inbox and spam folder)', `HTTP ${r.status}: ${r.error}`);
  }

  const failed = results.filter(r => !r.ok).length;
  log(failed ? `\n${failed} CHECK(S) FAILED` : `\nALL ${results.length} CHECKS PASSED`);
  return { failed, results, exitCode: failed ? 1 : 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  liveCheck().then(r => process.exit(r.exitCode)).catch(e => { console.log(`::error::${e.message}`); process.exit(1); });
}
