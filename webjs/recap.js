#!/usr/bin/env node
// Mode WhatsApp Web: tangkap pesan grup lewat whatsapp-web.js (WhatsApp Web asli di Chrome),
// pakai ulang recap/export.py untuk txt + summary, lalu kirim hasilnya lewat sesi yang sama.
// Chrome cuma hidup selama perintah jalan (beberapa menit sehari), gak online 24 jam.
//
//   node webjs/recap.js login [--number 08xx]     tautkan HP (QR / kode pairing), sekali saja
//   node webjs/recap.js groups                    daftar grup, format groups.txt
//   node webjs/recap.js run [--date YYYY-MM-DD] [--dry-run] [--no-summary] [--to 08xx]
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const ROOT = path.resolve(__dirname, '..');
const PYTHON = process.env.PYTHON || 'python3';
const JID_RE = /^[0-9-]+@g\.us$/;
// Pesan sistem (anggota masuk/keluar, enkripsi, panggilan, dsb.), bukan obrolan
const SKIP_TYPES = new Set([
  'e2e_notification', 'notification', 'notification_template', 'gp2', 'group_notification',
  'broadcast_notification', 'call_log', 'protocol', 'reaction', 'debug',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`${new Date().toLocaleString('sv-SE')} ${msg}`);

function loadEnv() {
  const env = {};
  for (let line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    line = line.trim();
    const i = line.indexOf('=');
    if (!line || line.startsWith('#') || i < 0) continue;
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

function loadGroups() {
  const groups = [];
  for (let line of fs.readFileSync(path.join(ROOT, 'groups.txt'), 'utf8').split('\n')) {
    line = line.split('  #')[0].trim();
    if (!line || line.startsWith('#')) continue;
    const [jid, ...rest] = line.split('|');
    if (!JID_RE.test(jid.trim())) throw new Error(`JID grup gak valid di groups.txt: ${jid}`);
    groups.push([jid.trim(), rest.join('|').trim() || jid.trim()]);
  }
  return groups;
}

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

let activeClient = null;

function makeClient(env) {
  const puppeteer = {
    headless: env.WEBJS_HEADLESS !== 'false',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    // Sinyal ditangani shutdown() di bawah: puppeteer cuma nutup Chrome tanpa mengakhiri proses
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  };
  if (env.WEBJS_CHROME_PATH) puppeteer.executablePath = env.WEBJS_CHROME_PATH;
  activeClient = new Client({
    authStrategy: new LocalAuth({
      dataPath: path.resolve(ROOT, env.WEBJS_SESSION_DIR || 'data/webjs-session'),
    }),
    puppeteer,
  });
  return activeClient;
}

// Tutup Chrome (maks 10 detik) lalu keluar. Dipakai untuk sinyal stop & watchdog, supaya
// proses gak nyangkut dan memblokir rekap berikutnya (profil Chrome terkunci).
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
      if (!login) return fail(Object.assign(new Error('Sesi WA belum ditautkan atau sudah logout. Jalankan: node webjs/recap.js login'), { noRetry: true }));
      if (!number) {
        qrcode.generate(qr, { small: true });
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
async function openClient(env) {
  for (let attempt = 1; ; attempt++) {
    const client = makeClient(env);
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

// Setelah buka, WA Web masih menerima pesan yang tertunda selama offline. Tunggu sampai
// gak ada pesan baru selama WEBJS_SYNC_QUIET detik (maks WEBJS_SYNC_MAX_WAIT detik).
async function waitForSync(client, env) {
  const quietMs = Number(env.WEBJS_SYNC_QUIET || 20) * 1000;
  const maxMs = Number(env.WEBJS_SYNC_MAX_WAIT || 300) * 1000;
  const started = Date.now();
  let last = started;
  let count = 0;
  const bump = () => { last = Date.now(); count++; };
  client.on('message', bump);
  while (Date.now() - last < quietMs && Date.now() - started < maxMs) await sleep(2000);
  client.removeListener('message', bump);
  log(`sinkron selesai: ${count} pesan masuk selama ${Math.round((Date.now() - started) / 1000)} detik`);
}

// Ambil pesan chat di [start, end). Limit digandakan sampai pesan tertua melewati start.
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

// Message whatsapp-web.js → baris rekap {id, ts, sender, from_me, text, quoted} (lihat export.py)
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

function python(args, opts = {}) {
  const res = spawnSync(PYTHON, [path.join(ROOT, 'recap', 'export.py'), ...args],
    { cwd: ROOT, encoding: 'utf8', ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`recap/export.py keluar dengan kode ${res.status}`);
  return res.stdout;
}

async function cmdLogin(env, args) {
  const client = makeClient(env);
  try {
    await start(client, { login: true, number: args.number });
    log(`tertaut sebagai ${client.info.pushname || ''} (+${client.info.wid.user})`);
    await sleep(5000); // biar sesi sempat tersimpan sebelum browser ditutup
  } finally {
    await client.destroy().catch(() => {});
  }
}

async function cmdGroups(env) {
  let targets = new Set();
  try { targets = new Set(loadGroups().map(([jid]) => jid)); } catch { /* groups.txt belum ada */ }
  const client = await openClient(env);
  try {
    // getChats membaca store lokal WA Web: gak ada request per grup ke WhatsApp
    const chats = (await client.getChats()).filter((c) => c.isGroup);
    chats.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    for (const c of chats) {
      const jid = c.id._serialized;
      const last = c.timestamp ? new Date(c.timestamp * 1000).toLocaleDateString('sv-SE') : '-';
      const size = c.participants ? c.participants.length : '?';
      console.log(`${jid}|${c.name}  # ${size} anggota, terakhir aktif ${last}${targets.has(jid) ? ', TARGET' : ''}`);
    }
  } finally {
    await client.destroy().catch(() => {});
  }
}

async function cmdRun(env, args) {
  const range = JSON.parse(python(['--print-range', ...(args.date ? ['--date', args.date] : [])]));
  const groups = loadGroups();
  const client = await openClient(env);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-recap-'));
  try {
    log(`WA Web siap, rekap ${range.date}`);
    await waitForSync(client, env);

    const raw = {};
    for (const [jid, name] of groups) {
      try {
        const chat = await client.getChatById(jid);
        raw[jid] = await normalize(await fetchRange(chat, range.start, range.end));
        log(`${name}: ${raw[jid].length} pesan ditangkap`);
      } catch (err) {
        log(`${name}: gagal baca grup (${err.message}), cek nomor masih anggota grup`);
        raw[jid] = [];
      }
      await sleep(1000);
    }

    const rawPath = path.join(tmp, 'raw.json');
    const emitPath = path.join(tmp, 'messages.json');
    fs.writeFileSync(rawPath, JSON.stringify(raw));
    const pyArgs = ['--date', range.date, '--raw', rawPath, '--emit', emitPath];
    if (args.noSummary) pyArgs.push('--no-summary');
    if (args.to) pyArgs.push('--to', args.to);
    python(pyArgs, { stdio: 'inherit' });
    const out = JSON.parse(fs.readFileSync(emitPath, 'utf8'));

    if (args.dryRun) {
      for (const m of out.messages) {
        console.log('-'.repeat(60));
        console.log(m.text !== undefined ? m.text : `[file] ${path.basename(m.doc)} — ${m.caption}`);
      }
      return;
    }
    if (!out.recipients.length) throw new Error('RECIPIENTS kosong, txt tersimpan tapi gak dikirim');
    for (const number of out.recipients) {
      const wid = await client.getNumberId(number);
      if (!wid) {
        log(`${number} gak terdaftar di WhatsApp, dilewati`);
        continue;
      }
      for (const [i, m] of out.messages.entries()) {
        if (i) await sleep(3000);
        if (m.text !== undefined) {
          await client.sendMessage(wid._serialized, m.text, { waitUntilMsgSent: true });
        } else {
          await sendDoc(client, wid._serialized, m.doc, m.caption);
        }
      }
      log(`terkirim ke ${number}: ${out.messages.length} pesan`);
    }
    await sleep(5000); // kasih waktu pesan terakhir benar-benar keluar sebelum browser ditutup
  } finally {
    await client.destroy().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const commands = { login: cmdLogin, groups: cmdGroups, run: cmdRun };
  if (!commands[cmd]) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 8).join('\n').replace(/^\/\/ ?/gm, ''));
    process.exit(cmd ? 1 : 0);
  }
  const env = loadEnv();
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => shutdown(130, `dihentikan (${sig})`));
  }
  const maxRuntime = Number(env.WEBJS_MAX_RUNTIME || 1200);
  setTimeout(() => shutdown(2, `ERROR: melewati WEBJS_MAX_RUNTIME (${maxRuntime} detik), dihentikan`),
    maxRuntime * 1000);
  await commands[cmd](env, args);
}

main().then(() => process.exit(0)).catch((err) => {
  log(`ERROR: ${err.message}`);
  process.exit(1);
});
