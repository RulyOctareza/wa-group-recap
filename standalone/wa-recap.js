#!/usr/bin/env node
/*
 * wa-recap.js — rekap harian grup WhatsApp dalam satu skrip.
 *
 * WhatsApp Web asli (whatsapp-web.js + Chrome headless) dibuka cuma saat rekap:
 * ambil pesan grup kemarin → txt per grup → POST ke web summary → kirim hasilnya ke WA.
 *
 * Pasang (Node >= 18):  npm install            (pakai package.json di folder ini)
 * Pakai:
 *   node wa-recap.js login [--number 08xx]   tautkan HP sekali (QR / kode pairing)
 *   node wa-recap.js pilih                   pilih grup yang direkap (ketik nomor, disimpan ke groups.json)
 *   node wa-recap.js groups                  lihat daftar grup + yang sedang dipilih
 *   node wa-recap.js run [--date YYYY-MM-DD] [--dry-run] [--no-summary] [--to 08xx]
 * Cron:   0 5 * * * cd /folder/skrip && node wa-recap.js run >> wa-recap.log 2>&1
 *
 * Isi CONFIG di bawah. Rahasia bisa lewat env: VERCEL_PROTECTION_BYPASS, RECAP_API_TOKEN.
 */
'use strict';

const CONFIG = {
  // Grup target. Biasanya dibiarkan kosong: pilih lewat `node wa-recap.js pilih`, hasilnya
  // disimpan di groups.json (dan dipakai menggantikan isian ini). Format manual: 'jid': 'Nama'.
  groups: {
    // '120363000000000000@g.us': 'Contoh Grup',
  },
  // Nomor penerima rekap (08xx / 62xx)
  recipients: [],
  // Batas hari rekap 00:00-24:00 di zona ini
  timezone: 'Asia/Jakarta',
  // per_group = ringkasan + 1 pesan per grup, combined = semua digabung 1 pesan
  summaryMode: 'per_group',
  // true = file txt mentah ikut dikirim. Kalau summary gagal, txt selalu dikirim.
  sendTxt: false,
  outputDir: 'output',
  txtRetentionDays: 30,

  // Web summary. url kosong = lewati summary, txt langsung dikirim.
  api: {
    url: '',
    mode: 'multipart', // multipart = upload file txt, json = {"<textField>": isi, "<passwordField>": ...}
    fileField: 'file',
    textField: 'text',
    passwordField: 'password', // '' = gak kirim field password
    password: '',
    resultPath: 'summary', // letak teks summary di respons JSON (dot path, mis. data.result)
    timeoutSec: 180,
    vercelBypass: process.env.VERCEL_PROTECTION_BYPASS || '', // header x-vercel-protection-bypass
    token: process.env.RECAP_API_TOKEN || '', // Authorization: Bearer <token>
  },

  whatsapp: {
    sessionDir: 'wa-session', // sesi login WA Web: jangan dibagi / di-commit
    chromePath: '', // kosong = Chrome bawaan Puppeteer; server Linux: '/usr/bin/chromium'
    headless: true,
    syncQuietSec: 20, // setelah buka, tunggu pesan tertunda sampai sepi sekian detik
    syncMaxWaitSec: 300,
    maxRuntimeSec: 1200, // batas total satu perintah; lewat = Chrome ditutup paksa
  },
};

// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const BASE = __dirname;
const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const TZ_LABEL = { 'Asia/Jakarta': 'WIB', 'Asia/Makassar': 'WITA', 'Asia/Jayapura': 'WIT' };
// Pesan sistem (anggota masuk/keluar, enkripsi, panggilan, reaksi, dsb.), bukan obrolan
const SKIP_TYPES = new Set([
  'e2e_notification', 'notification', 'notification_template', 'gp2', 'group_notification',
  'broadcast_notification', 'call_log', 'protocol', 'reaction', 'debug',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`${new Date().toLocaleString('sv-SE')} ${msg}`);
const pad = (n) => String(n).padStart(2, '0');
const fatal = (msg) => Object.assign(new Error(msg), { fatal: true });

function phone(raw) {
  const digits = String(raw).replace(/\D/g, '');
  return digits.startsWith('0') ? `62${digits.slice(1)}` : digits;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-summary') args.noSummary = true;
    else if (['--date', '--to', '--number'].includes(a)) args[a.slice(2)] = argv[++i];
    else args._.push(a);
  }
  return args;
}

// ── Waktu (zona CONFIG.timezone) ─────────────────────────────────────────────

function tzParts(ms, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

// Epoch detik untuk jam 00:00 tanggal itu di zona tz (aman untuk DST)
function zonedMidnight(y, mo, d, tz) {
  const target = Date.UTC(y, mo - 1, d);
  let t = target;
  for (let i = 0; i < 2; i++) {
    const p = tzParts(t, tz);
    t = target - (Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - t);
  }
  return Math.floor(t / 1000);
}

// Rentang [start, end) satu hari. Tanpa dateStr = kemarin di zona tz.
function dayRange(dateStr, tz) {
  let y, mo, d;
  if (dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error(`--date harus YYYY-MM-DD: ${dateStr}`);
    [y, mo, d] = dateStr.split('-').map(Number);
  } else {
    const now = tzParts(Date.now(), tz);
    const prev = new Date(Date.UTC(now.y, now.mo - 1, now.d - 1));
    [y, mo, d] = [prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate()];
  }
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  return {
    date: `${y}-${pad(mo)}-${pad(d)}`,
    label: `${HARI[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]}, ${d} ${BULAN[mo - 1]} ${y}`,
    start: zonedMidnight(y, mo, d, tz),
    end: zonedMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), tz),
  };
}

function hhmm(ts, tz) {
  const p = tzParts(ts * 1000, tz);
  return `${pad(p.h)}:${pad(p.mi)}`;
}

// ── txt rekap ────────────────────────────────────────────────────────────────

// Sama dengan str.splitlines() Python (tanpa elemen kosong di ujung)
function splitlines(s) {
  if (!s) return [];
  const parts = s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function slugify(name) {
  const ascii = name.normalize('NFKD').replace(/[^\x00-\x7f]/g, '');
  return ascii.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'grup';
}

// rows: [{id, ts, sender, from_me, text, quoted}] → {txt, count, others}
function buildTxt(name, range, rows) {
  const tz = CONFIG.timezone;
  const lines = [];
  const seen = new Set();
  let others = 0;
  for (const r of [...rows].sort((a, b) => a.ts - b.ts)) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    if (!r.from_me) others++;
    const parts = splitlines(r.text || '');
    const [first, ...rest] = parts.length ? parts : [''];
    lines.push(`[${hhmm(r.ts, tz)}] ${r.sender}: ${first}`);
    for (const extra of rest) lines.push(`    ${extra}`);
    if (r.quoted) {
      let snippet = r.quoted.split(/\s+/).filter(Boolean).join(' ');
      if (Array.from(snippet).length > 80) snippet = `${Array.from(snippet).slice(0, 77).join('')}...`;
      lines.push(`    ↪ balas: "${snippet}"`);
    }
  }
  const header = [
    `Grup    : ${name}`,
    `Tanggal : ${range.label} (00:00-24:00 ${TZ_LABEL[tz] || tz})`,
    `Pesan   : ${seen.size}`,
    '-'.repeat(60),
  ];
  return { txt: `${[...header, ...lines].join('\n')}\n`, count: seen.size, others };
}

// Urutan pesan WA: [{text}] atau [{doc, caption}]
function buildMessages(range, results, others) {
  const tz = CONFIG.timezone;
  const total = results.reduce((n, r) => n + r.count, 0);
  const head = ['📋 *Rekap Grup WA*', `${range.label} (00:00-24:00 ${TZ_LABEL[tz] || tz})`, ''];
  for (const r of results) head.push(`• ${r.name}: ${r.count} pesan`);
  head.push('', `Total ${total} pesan.`);
  if (total === 0) head.push('⚠️ Semua grup 0 pesan, cek koneksi WA di server.');
  else if (others === 0) head.push('⚠️ Gak ada pesan dari anggota lain, server mungkin gak nerima chat grup.');
  const failed = results.filter((r) => r.tried && r.summary === null).map((r) => r.name);
  if (failed.length) head.push(`⚠️ Summary gagal: ${failed.join(', ')} (txt mentah dilampirkan).`);

  const sections = results.filter((r) => r.summary).map((r) => `*${r.name}* · ${r.count} pesan\n\n${r.summary}`);
  let messages;
  if (CONFIG.summaryMode === 'combined') {
    let body = head.join('\n');
    if (sections.length) body += `\n\n${sections.join('\n\n―――――\n\n')}`;
    messages = [{ text: body }];
  } else {
    messages = [{ text: head.join('\n') }, ...sections.map((text) => ({ text }))];
  }
  for (const r of results) {
    if (r.count && (CONFIG.sendTxt || r.summary === null)) {
      const note = r.tried && r.summary === null ? ' (summary gagal)' : '';
      messages.push({ doc: r.file, caption: `${r.name} - ${r.count} pesan${note}` });
    }
  }
  return messages;
}

function pruneTxt(dir = path.resolve(BASE, CONFIG.outputDir)) {
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - CONFIG.txtRetentionDays * 86400000;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, entry.name);
    if (entry.isDirectory()) pruneTxt(f);
    else if (f.endsWith('.txt') && fs.statSync(f).mtimeMs < cutoff) fs.unlinkSync(f);
  }
}

// ── Web summary ──────────────────────────────────────────────────────────────

function dig(data, keyPath) {
  for (const key of keyPath.split('.').filter(Boolean)) {
    if (Array.isArray(data) && /^\d+$/.test(key)) data = data[Number(key)];
    else if (data && typeof data === 'object') data = data[key];
    else return undefined;
  }
  return data;
}

function extractSummary(body, ctype, url) {
  // Halaman login Vercel / halaman error, bukan hasil summary
  if (ctype.includes('text/html')) throw fatal(`dapat halaman HTML dari ${url} (kena Deployment Protection atau URL salah?)`);
  let text = body.trim();
  if (ctype.includes('json') || text.startsWith('{') || text.startsWith('[')) {
    const keyPath = CONFIG.api.resultPath;
    const value = keyPath ? dig(JSON.parse(text), keyPath) : JSON.parse(text);
    if (value === undefined || value === null) throw fatal(`field "${keyPath}" gak ada di respons: ${text.slice(0, 200)}`);
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  }
  if (!text.trim()) throw fatal('summary kosong');
  return text.trim();
}

async function summarize(file) {
  const api = CONFIG.api;
  const content = fs.readFileSync(file);
  const headers = { Accept: 'application/json, text/plain;q=0.9', 'User-Agent': 'wa-recap/1.0' };
  if (api.vercelBypass) headers['x-vercel-protection-bypass'] = api.vercelBypass;
  if (api.token) headers.Authorization = `Bearer ${api.token}`;
  if (api.mode === 'json') headers['Content-Type'] = 'application/json';
  const body = () => {
    if (api.mode === 'json') {
      const payload = { [api.textField]: content.toString('utf8') };
      if (api.passwordField) payload[api.passwordField] = api.password;
      return JSON.stringify(payload);
    }
    const form = new FormData();
    if (api.passwordField) form.append(api.passwordField, api.password);
    form.append(api.fileField, new Blob([content], { type: 'text/plain; charset=utf-8' }), path.basename(file));
    return form;
  };

  let error;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(api.url, {
        method: 'POST', headers, body: body(), signal: AbortSignal.timeout(api.timeoutSec * 1000),
      });
      const text = await res.text();
      if (res.ok) return extractSummary(text, res.headers.get('content-type') || '', res.url);
      error = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      if (res.status < 500 && res.status !== 429) break; // ditolak: retry gak bakal nolong
    } catch (err) {
      if (err.fatal) throw err;
      error = err.cause ? new Error(`${err.message} (${err.cause.code || err.cause.message})`) : err;
    }
    if (attempt < 3) {
      log(`summary ${path.basename(file)} gagal (percobaan ${attempt}/3): ${error.message}`);
      await sleep(15000 * attempt);
    }
  }
  throw error;
}

// ── WhatsApp Web ─────────────────────────────────────────────────────────────

let activeClient = null;

function makeClient() {
  const { Client, LocalAuth } = require('whatsapp-web.js');
  const wa = CONFIG.whatsapp;
  const puppeteer = {
    headless: wa.headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    // Sinyal ditangani shutdown(): puppeteer cuma nutup Chrome tanpa mengakhiri proses
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  };
  if (wa.chromePath) puppeteer.executablePath = wa.chromePath;
  activeClient = new Client({ authStrategy: new LocalAuth({ dataPath: path.resolve(BASE, wa.sessionDir) }), puppeteer });
  return activeClient;
}

// Tutup Chrome (maks 10 detik) lalu keluar, supaya gak ada Chrome nyangkut yang
// mengunci profil dan memblokir rekap berikutnya.
async function shutdown(code, reason) {
  log(reason);
  const client = activeClient;
  activeClient = null;
  if (client) await Promise.race([client.destroy().catch(() => {}), sleep(10000)]);
  process.exit(code);
}

// WhatsApp Web 2.3000.104x+ me-minify MsgKey._serialized jadi $1; rilis whatsapp-web.js 1.34.7
// belum menanganinya: getChats/fetchMessages/sendMessage error "r: r" / "t: t". Commit main
// yang dipakai package.json menambal sisi Node; patch sisi halaman ini dilewati kalau sudah ada.
// Kembalikan lewat getter di prototype MsgKey (wwebjs/whatsapp-web.js PR #201871, issue #201862).
// Boleh dihapus setelah versi whatsapp-web.js yang memperbaiki ini dirilis.
async function patchWhatsAppWeb(client) {
  return client.pupPage.evaluate(() => {
    const proto = window.require('WAWebMsgKey')?.prototype;
    if (!proto || Object.getOwnPropertyDescriptor(proto, '_serialized')) return false;
    Object.defineProperty(proto, '_serialized', {
      get() { return this.$1 || (typeof this.toString === 'function' ? this.toString() : undefined); },
      set(value) {
        Object.defineProperty(this, '_serialized', { value, writable: true, enumerable: true, configurable: true });
      },
      configurable: true,
    });
    return true;
  });
}

// Resolve saat WA Web siap. Tanpa login=true, munculnya QR berarti sesi belum/gak lagi tertaut.
function start(client, { login = false, number = null } = {}) {
  return new Promise((resolve, reject) => {
    let codeRequested = false;
    let authedAt = null;
    let stallTimer = null;
    const opened = Date.now();
    const limit = login ? 600 : 120;
    const timer = setTimeout(() => reject(new Error(`WA Web gak siap dalam ${limit} detik (${authedAt
      ? `macet setelah login, ${Math.round((authedAt - opened) / 1000)} detik`
      : 'macet sebelum login/sinkron selesai'})`)), limit * 1000);
    const fail = (err) => { clearTimeout(timer); clearTimeout(stallTimer); reject(err); };

    client.on('qr', async (qr) => {
      if (!login) return fail(Object.assign(new Error('Sesi WA belum ditautkan atau sudah logout. Jalankan: node wa-recap.js login'), { noRetry: true }));
      if (!number) {
        require('qrcode-terminal').generate(qr, { small: true });
        console.log('Scan dari HP: WhatsApp → Perangkat tertaut → Tautkan perangkat (QR ganti tiap ~20 detik)');
        return;
      }
      if (codeRequested) return;
      codeRequested = true;
      try {
        const code = await client.requestPairingCode(phone(number));
        console.log(`\nKode pairing: ${code.slice(0, 4)}-${code.slice(4)}`);
        console.log('HP: WhatsApp → Perangkat tertaut → Tautkan perangkat → Tautkan dengan nomor telepon saja → masukkan kode.');
      } catch (err) {
        fail(err);
      }
    });
    // Patch sebelum whatsapp-web.js menyuntik kodenya: tanpa ini, kadang 'ready' gak pernah muncul
    client.on('authenticated', () => {
      authedAt = Date.now();
      patchWhatsAppWeb(client).catch(() => {});
      // whatsapp-web.js kadang nyangkut setelah login tanpa error (lebih sering kalau sering
      // reconnect berturut-turut); buka ulang aja
      if (!login) stallTimer = setTimeout(() => fail(new Error('WA Web macet setelah login (ready gak muncul 60 detik)')), 60000);
    });
    client.on('auth_failure', (msg) => fail(Object.assign(new Error(`Autentikasi gagal: ${msg}`), { noRetry: true })));
    client.on('ready', async () => {
      clearTimeout(timer);
      clearTimeout(stallTimer);
      try {
        if (await patchWhatsAppWeb(client)) log('patch MsgKey._serialized dipasang');
      } catch (err) {
        log(`patch MsgKey gagal (${err.message}), lanjut tanpa patch`);
      }
      resolve();
    });
    client.initialize().catch(fail);
  });
}

// WA Web kadang macet saat dibuka. Buka ulang Chrome (maks 3 percobaan) sebelum menyerah.
async function openClient() {
  for (let attempt = 1; ; attempt++) {
    const client = makeClient();
    try {
      await start(client);
      return client;
    } catch (err) {
      await client.destroy().catch(() => {});
      if (err.noRetry || attempt >= 3) throw err;
      log(`${err.message}, buka ulang WA Web (percobaan ${attempt + 1}/3)`);
      await sleep(5000);
    }
  }
}

// WhatsApp mengirim pesan yang tertunda selama offline begitu WA Web tersambung.
async function waitForSync(client) {
  const quietMs = CONFIG.whatsapp.syncQuietSec * 1000;
  const maxMs = CONFIG.whatsapp.syncMaxWaitSec * 1000;
  const started = Date.now();
  let last = started;
  let count = 0;
  const bump = () => { last = Date.now(); count++; };
  client.on('message', bump);
  while (Date.now() - last < quietMs && Date.now() - started < maxMs) await sleep(2000);
  client.removeListener('message', bump);
  log(`sinkron selesai: ${count} pesan masuk selama ${Math.round((Date.now() - started) / 1000)} detik`);
}

// Pesan chat di [start, end). Limit digandakan sampai pesan tertua melewati start.
async function fetchRange(chat, start, end) {
  let limit = 200;
  let msgs = [];
  for (;;) {
    msgs = await chat.fetchMessages({ limit });
    const oldest = msgs.length ? Math.min(...msgs.map((m) => m.timestamp)) : 0;
    if (msgs.length < limit || oldest < start || limit >= 6400) break;
    limit *= 2;
  }
  return msgs.filter((m) => m.timestamp >= start && m.timestamp < end);
}

const withCaption = (label, caption) => (caption ? `${label} ${caption}` : label);

function render(m) {
  const d = m._data || {};
  switch (m.type) {
    case 'chat': return m.body || '';
    case 'image': return withCaption('[gambar]', m.body);
    case 'video': return withCaption(d.isGif ? '[gif]' : '[video]', m.body);
    case 'ptv': return '[video bulat]';
    case 'ptt': return '[voice note]';
    case 'audio': return '[audio]';
    case 'document': {
      const name = d.filename || '';
      return withCaption(name ? `[dokumen: ${name}]` : '[dokumen]', m.body === name ? '' : m.body);
    }
    case 'sticker': return '[stiker]';
    case 'location': {
      const l = m.location || {};
      return `[lokasi] ${l.name || l.address || l.description || `${l.latitude},${l.longitude}`}`;
    }
    case 'vcard': return `[kontak] ${d.vcardFormattedName || ''}`.trim();
    case 'multi_vcard': return `[kontak] ${(m.vCards || []).length} kontak`;
    case 'poll_creation':
      return `[polling] ${m.pollName || ''} (${(m.pollOptions || []).map((o) => o.name).join(' / ')})`;
    case 'scheduled_event_creation': return `[acara] ${d.eventName || ''}`.trim();
    case 'groups_v4_invite': return `[undangan grup] ${d.inviteGrpName || ''}`.trim();
    case 'revoked': return '[pesan dihapus]';
    case 'ciphertext': return '[pesan gagal dibuka]';
    default: return m.body || `[${m.type}]`;
  }
}

// Message whatsapp-web.js → baris rekap {id, ts, sender, from_me, text, quoted}
async function normalize(msgs) {
  const names = new Map();
  const rows = [];
  for (const m of msgs) {
    if (SKIP_TYPES.has(m.type)) continue;
    const d = m._data || {};
    let sender = d.notifyName;
    if (!sender && m.fromMe) sender = 'Saya';
    if (!sender) {
      const author = m.author || m.from;
      if (!names.has(author)) {
        let name = null;
        try {
          const c = await m.getContact();
          name = c.pushname || c.name || c.verifiedName || null;
        } catch { /* kontak gak ada di store lokal */ }
        const [user, server] = String(author || '?').split('@');
        // @lid = ID internal WhatsApp, bukan nomor HP
        names.set(author, name || (server === 'lid' ? `~${user.slice(-4)}` : `+${user}`));
      }
      sender = names.get(author);
    }
    const q = d.quotedMsg;
    rows.push({
      id: m.id._serialized || m.id.$1 || `${m.id.remote}_${m.id.id}`,
      ts: m.timestamp,
      sender,
      from_me: Boolean(m.fromMe),
      text: render(m),
      quoted: q ? render({ type: q.type, body: q.body || q.caption || '', _data: q }) || '...' : null,
    });
  }
  return rows;
}

// Pecah teks panjang per baris jadi beberapa pesan (WA menerima ±65 ribu karakter, tapi
// pesan pendek lebih enak dibaca di HP)
function chunkText(text, max = 3500) {
  const chunks = [];
  let cur = '';
  for (let line of text.split('\n')) {
    while (line.length > max) {
      if (cur) chunks.push(cur);
      cur = '';
      chunks.push(line.slice(0, max));
      line = line.slice(max);
    }
    if (cur && cur.length + line.length + 1 > max) {
      chunks.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// Kirim txt sebagai dokumen; kalau gagal (mis. rilis 1.34.7 di WA Web terbaru: "Data passed to
// getter must include an id"), kirim isinya sebagai pesan teks supaya rekap tetap sampai.
async function sendDoc(client, to, file, caption) {
  const { MessageMedia } = require('whatsapp-web.js');
  try {
    await client.sendMessage(to, MessageMedia.fromFilePath(file),
      { sendMediaAsDocument: true, caption, waitUntilMsgSent: true });
  } catch (err) {
    log(`kirim file ${path.basename(file)} gagal (${String(err.message).split('\n')[0]}), dikirim sebagai teks`);
    const parts = chunkText(fs.readFileSync(file, 'utf8').trimEnd());
    for (const [i, part] of parts.entries()) {
      if (i) await sleep(2000);
      const head = `📄 *${caption}*${parts.length > 1 ? ` (${i + 1}/${parts.length})` : ''}`;
      await client.sendMessage(to, `${head}\n\n${part}`, { waitUntilMsgSent: true });
    }
  }
}

// ── Perintah ─────────────────────────────────────────────────────────────────

async function cmdLogin(args) {
  const client = makeClient();
  await start(client, { login: true, number: args.number });
  log(`tertaut sebagai ${client.info.pushname || ''} (+${client.info.wid.user})`);
  await sleep(5000); // biar sesi sempat tersimpan sebelum browser ditutup
}

const GROUPS_FILE = path.join(BASE, 'groups.json');

// Grup target: groups.json (hasil `pilih`) kalau ada, kalau gak CONFIG.groups
function loadGroups() {
  return fs.existsSync(GROUPS_FILE) ? JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8')) : CONFIG.groups;
}

// Semua grup yang diikuti, urut terakhir aktif. getChats membaca store lokal WA Web:
// gak ada request per grup ke WhatsApp.
async function listGroups() {
  const client = await openClient();
  const chats = (await client.getChats()).filter((c) => c.isGroup);
  chats.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return chats.map((c) => ({
    jid: c.id._serialized,
    name: c.name || c.id.user,
    size: c.participants ? c.participants.length : '?',
    last: c.timestamp ? new Date(c.timestamp * 1000).toLocaleDateString('sv-SE') : '-',
  }));
}

function printGroups(groups, selected) {
  groups.forEach((g, i) => {
    const mark = selected[g.jid] ? 'x' : ' ';
    console.log(`${String(i + 1).padStart(4)}. [${mark}] ${g.name}  (${g.size} anggota, terakhir aktif ${g.last})`);
  });
}

// "1,3,5-7" → [1, 3, 5, 6, 7]
function parsePicks(answer, max) {
  const picks = new Set();
  for (const part of answer.split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`"${part}" bukan nomor. Contoh: 1,3,5-7`);
    const [a, b] = [Number(m[1]), Number(m[2] || m[1])];
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
      if (i < 1 || i > max) throw new Error(`nomor ${i} gak ada di daftar (1-${max})`);
      picks.add(i);
    }
  }
  return [...picks].sort((x, y) => x - y);
}

function ask(question) {
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

async function cmdGroups() {
  const groups = await listGroups();
  printGroups(groups, loadGroups());
  console.log('\n[x] = sedang direkap. Ubah pilihan: node wa-recap.js pilih');
}

async function cmdPilih() {
  const groups = await listGroups();
  // Chrome gak perlu nunggu orang mengetik
  await activeClient.destroy().catch(() => {});
  activeClient = null;
  printGroups(groups, loadGroups());
  const answer = (await ask('\nKetik nomor grup yang mau direkap (mis. 1,3,5-7). Kosong = batal: ')).trim();
  if (!answer) {
    log('pilihan grup gak diubah');
    return;
  }
  const picks = parsePicks(answer, groups.length);
  const chosen = Object.fromEntries(picks.map((i) => [groups[i - 1].jid, groups[i - 1].name]));
  fs.writeFileSync(GROUPS_FILE, `${JSON.stringify(chosen, null, 2)}\n`);
  log(`${picks.length} grup disimpan ke groups.json:`);
  for (const name of Object.values(chosen)) console.log(`  - ${name}`);
}

async function cmdRun(args) {
  const groups = Object.entries(loadGroups());
  if (!groups.length) throw new Error('Belum ada grup yang dipilih. Jalankan: node wa-recap.js pilih');
  const range = dayRange(args.date, CONFIG.timezone);
  const useSummary = Boolean(CONFIG.api.url) && !args.noSummary;
  const client = await openClient();
  log(`WA Web siap, rekap ${range.date}`);
  await waitForSync(client);

  const results = [];
  let others = 0;
  for (const [jid, name] of groups) {
    let rows = [];
    try {
      const chat = await client.getChatById(jid);
      rows = await normalize(await fetchRange(chat, range.start, range.end));
    } catch (err) {
      log(`${name}: gagal baca grup (${err.message}), cek nomor masih anggota grup`);
    }
    const { txt, count, others: fromOthers } = buildTxt(name, range, rows);
    others += fromOthers;
    const slug = slugify(name);
    const file = path.resolve(BASE, CONFIG.outputDir, slug, `${slug}_${range.date}.txt`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, txt);
    log(`${name}: ${count} pesan -> ${path.relative(BASE, file)}`);

    let summary = null;
    const tried = useSummary && count > 0;
    if (tried) {
      try {
        summary = await summarize(file);
        log(`${name}: summary ${summary.length} karakter`);
      } catch (err) {
        log(`${name}: summary gagal: ${err.message}`);
      }
    }
    results.push({ name, count, file, summary, tried });
    await sleep(1000);
  }
  pruneTxt();
  const messages = buildMessages(range, results, others);

  if (args.dryRun) {
    for (const m of messages) {
      console.log('-'.repeat(60));
      console.log(m.text !== undefined ? m.text : `[file] ${path.basename(m.doc)} — ${m.caption}`);
    }
    return;
  }
  const recipients = (args.to ? args.to.split(',') : CONFIG.recipients).map(phone).filter(Boolean);
  if (!recipients.length) throw new Error('CONFIG.recipients kosong, txt tersimpan tapi gak dikirim');
  for (const number of recipients) {
    const wid = await client.getNumberId(number);
    if (!wid) {
      log(`${number} gak terdaftar di WhatsApp, dilewati`);
      continue;
    }
    for (const [i, m] of messages.entries()) {
      if (i) await sleep(3000);
      if (m.text !== undefined) {
        await client.sendMessage(wid._serialized, m.text, { waitUntilMsgSent: true });
      } else {
        await sendDoc(client, wid._serialized, m.doc, m.caption);
      }
    }
    log(`terkirim ke ${number}: ${messages.length} pesan`);
  }
  await sleep(5000); // kasih waktu pesan terakhir benar-benar keluar sebelum browser ditutup
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const commands = { login: cmdLogin, pilih: cmdPilih, groups: cmdGroups, run: cmdRun };
  const command = commands[args._[0]];
  if (!command) {
    const src = fs.readFileSync(__filename, 'utf8');
    console.log(src.slice(src.indexOf('/*') + 2, src.indexOf('*/')).replace(/^ \* ?/gm, '').trim());
    process.exit(args._[0] ? 1 : 0);
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(130, `dihentikan (${sig})`));
  const maxRuntime = CONFIG.whatsapp.maxRuntimeSec;
  setTimeout(() => shutdown(2, `ERROR: melewati maxRuntimeSec (${maxRuntime} detik), dihentikan`), maxRuntime * 1000);
  try {
    await command(args);
    await shutdown(0, 'selesai');
  } catch (err) {
    await shutdown(1, `ERROR: ${err.message}`);
  }
}

if (require.main === module) main();
module.exports = { CONFIG, buildTxt, buildMessages, dayRange, splitlines, slugify, summarize };
