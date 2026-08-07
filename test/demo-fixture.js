/**
 * A demo worklist for eyeballing the Helper — NOT a test fixture.
 *
 * The harness fixtures predate `checkout` / `internal_id`, so booting the Helper with one of them
 * shows the new row exactly as the old row: no booking reference, no check-out. This one carries
 * both, plus every state the pane can draw, so the whole surface is on screen at once:
 *
 *   · overdue, due-today, inside-24h and postponed rows, so the priority ranking is visible
 *   · a row with no sheet yet (nosheet) and one already submitted (awaiting)
 *   · one villa WITH credentials, one WITHOUT — the two session-bar states you can reach
 *     without solving a captcha (the third, "session open", needs a real login)
 *
 * Dates are computed from today so the buckets stay correct whenever you run it.
 *
 * Usage:  node demo-fixture.js            → prints a tm30:// deep link
 */
'use strict';

const DAY = 86400000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

/** `{letter}{company}-{ddMMyyyy}-{index}` — the shape `contract.internal_id` really has. */
function ref(offsetDays, index) {
  const d = new Date(Date.now() + offsetDays * DAY);
  const p = (n) => String(n).padStart(2, '0');
  return `C100-${p(d.getDate())}${p(d.getMonth() + 1)}${d.getFullYear()}-${String(index).padStart(3, '0')}`;
}

const SURIYAN = { name: 'Suriyan 2 portal', login: 'suriyan2@tm30', pass: 's3cr3t-pass-101' };
const ANDA = { name: 'Anda portal', login: 'anda@tm30', pass: 's3cr3t-pass-104' };

const row = (o) => ({
  filing_id: o.id,
  villa: o.villa,
  checkin: iso(o.in),
  checkout: iso(o.out),
  internal_id: ref(o.in, o.id),
  status: o.status || 'sheet_ready',
  dot: o.dot,
  ...(o.noSheet ? {} : { sheet_download_url: `https://drive.google.com/uc?export=download&id=DEMO${o.id}` }),
  folder_url: `https://drive.google.com/drive/folders/DEMO${o.id}`,
  return_url: `https://example.invalid/reservation/reservations/${o.id}`,
  ...(o.account ? { account: o.account } : {}),
});

const worklist = [
  // Villa Suriyan 2 — has credentials, so its rows render LOCKED until you log in.
  row({ id: 101, villa: 'Villa Suriyan 2', in: -2, out: 3, dot: 'overdue', account: SURIYAN }),
  row({ id: 102, villa: 'Villa Suriyan 2', in: 0, out: 4, dot: 'due', account: SURIYAN }),
  row({ id: 103, villa: 'Villa Suriyan 2', in: 1, out: 6, dot: 'due', noSheet: true, account: SURIYAN }),
  // Villa Anda — also credentialled, and one of its filings is already submitted.
  row({ id: 104, villa: 'Villa Anda', in: 0, out: 5, dot: 'due', account: ANDA }),
  row({ id: 105, villa: 'Villa Anda', in: -1, out: 4, dot: 'due', status: 'submitted', account: ANDA }),
  // Villa Baan Ork — NO credentials. The daily case, not an error: manual login.
  row({ id: 106, villa: 'Villa Baan Ork', in: 1, out: 5, dot: 'due' }),
  // Postponed: beyond the 24h horizon, so these sink to the bottom instead of hiding in a group.
  row({ id: 107, villa: 'Villa Chai Talay', in: 3, out: 8, dot: 'due' }),
  row({ id: 108, villa: 'Villa Chai Talay', in: 5, out: 9, dot: 'due', noSheet: true }),
];

const b64url = Buffer.from(JSON.stringify({ v: 2, worklist }), 'utf8')
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');

module.exports = { worklist, b64url, link: `tm30://open?d=${b64url}` };

if (require.main === module) process.stdout.write(`tm30://open?d=${b64url}\n`);
