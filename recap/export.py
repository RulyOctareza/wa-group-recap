#!/usr/bin/env python3
"""Rekap harian grup WhatsApp: pesan DB → txt per grup → summary web → kirim ke WA.

Default: rekap kemarin (00:00-24:00 di TZ_NAME), lalu kirim ke RECIPIENTS.
  recap/export.py                       # kemarin, jalur penuh
  recap/export.py --date 2026-10-18     # tanggal tertentu
  recap/export.py --dry-run             # semua tahap jalan, pesan WA cuma dicetak
  recap/export.py --no-summary          # lewati web, txt langsung dikirim
  recap/export.py --to 628xxxxxxxxxx    # override penerima (tes), boleh pisah koma
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import re
import sys
import time
import unicodedata
from pathlib import Path

import summarize
from common import ROOT, api, connection_state, load_env, load_groups, log, phone, psql, timezone

HARI = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu']
BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']

# Pesan sistem/metadata, bukan obrolan
SKIP_TYPES = {
    'reactionMessage', 'encReactionMessage', 'protocolMessage',
    'senderKeyDistributionMessage', 'messageContextInfo', 'pollUpdateMessage',
    'keepInChatMessage', 'pinInChatMessage', 'secretEncryptedMessage', 'call', 'unknown',
}
WRAPPERS = (
    'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2',
    'viewOnceMessageV2Extension', 'documentWithCaptionMessage', 'editedMessage',
    'groupMentionedMessage', 'futureProofMessage',
)
MEDIA = {
    'imageMessage': '[gambar]',
    'videoMessage': '[video]',
    'ptvMessage': '[video bulat]',
    'audioMessage': '[audio]',
    'documentMessage': '[dokumen]',
    'stickerMessage': '[stiker]',
}


def tanggal(day: dt.date) -> str:
    return f'{HARI[day.weekday()]}, {day.day} {BULAN[day.month - 1]} {day.year}'


def slugify(name: str) -> str:
    ascii_name = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode()
    return re.sub(r'[^A-Za-z0-9]+', '-', ascii_name).strip('-') or 'grup'


def unwrap(msg: dict) -> dict:
    for _ in range(4):
        for wrapper in WRAPPERS:
            inner = msg.get(wrapper)
            if isinstance(inner, dict) and isinstance(inner.get('message'), dict):
                msg = inner['message']
                break
        else:
            return msg
    return msg


def render(msg: dict | None) -> str | None:
    """Isi pesan jadi teks. None = gak ada yang perlu ditulis."""
    msg = unwrap(msg or {})
    if msg.get('conversation'):
        return msg['conversation']
    if isinstance(msg.get('extendedTextMessage'), dict):
        return msg['extendedTextMessage'].get('text') or None
    for key, label in MEDIA.items():
        media = msg.get(key)
        if isinstance(media, dict):
            if key == 'audioMessage' and media.get('ptt'):
                label = '[voice note]'
            if key == 'documentMessage' and media.get('fileName'):
                label = f"[dokumen: {media['fileName']}]"
            return f"{label} {media.get('caption') or ''}".strip()
    for key in ('pollCreationMessage', 'pollCreationMessageV2', 'pollCreationMessageV3'):
        poll = msg.get(key)
        if isinstance(poll, dict):
            opts = ' / '.join(o.get('optionName', '') for o in poll.get('options') or [])
            return f"[polling] {poll.get('name', '')} ({opts})"
    if isinstance(msg.get('locationMessage'), dict):
        loc = msg['locationMessage']
        place = loc.get('name') or loc.get('address') or f"{loc.get('degreesLatitude')},{loc.get('degreesLongitude')}"
        return f'[lokasi] {place}'
    if isinstance(msg.get('liveLocationMessage'), dict):
        return '[lokasi live]'
    if isinstance(msg.get('contactMessage'), dict):
        return f"[kontak] {msg['contactMessage'].get('displayName', '')}".strip()
    if isinstance(msg.get('contactsArrayMessage'), dict):
        return f"[kontak] {len(msg['contactsArrayMessage'].get('contacts') or [])} kontak"
    if isinstance(msg.get('eventMessage'), dict):
        return f"[acara] {msg['eventMessage'].get('name', '')}".strip()
    if isinstance(msg.get('groupInviteMessage'), dict):
        return f"[undangan grup] {msg['groupInviteMessage'].get('groupName', '')}".strip()
    return None


def sender(row: dict) -> str:
    if row.get('name'):
        return row['name']
    if row.get('from_me') == 'true':
        return 'Saya'
    for jid in (row.get('participant_alt'), row.get('participant')):
        if jid and jid.endswith('@s.whatsapp.net'):
            return '+' + jid.split('@')[0]
    return (row.get('participant') or '?').split('@')[0]


def fetch(env: dict, jid: str, start: int, end: int) -> list[dict]:
    out = psql(f"""
select coalesce(json_agg(t order by t.ts), '[]') from (
  select key->>'id' as id, "messageTimestamp" as ts, key->>'fromMe' as from_me,
         key->>'participant' as participant, key->>'participantAlt' as participant_alt,
         "pushName" as name, "messageType" as type, message, "contextInfo" as ctx
  from "Message"
  where key->>'remoteJid' = '{jid}'
    and "messageTimestamp" >= {start} and "messageTimestamp" < {end}
) t;
""", env)
    return json.loads(out or '[]')


def build_txt(name: str, day: dt.date, tz_label: str, zone, rows: list[dict]) -> tuple[str, int, int]:
    """(isi txt, jumlah pesan, jumlah pesan dari anggota lain)."""
    lines, seen, others = [], set(), 0
    for row in rows:
        if row['id'] in seen or row['type'] in SKIP_TYPES:
            continue
        seen.add(row['id'])
        others += row.get('from_me') != 'true'
        text = render(row['message'])
        if text is None:
            text = f"[{row['type']}]"
        when = dt.datetime.fromtimestamp(row['ts'], zone)
        first, *rest = text.splitlines() or ['']
        lines.append(f'[{when:%H:%M}] {sender(row)}: {first}')
        lines.extend(f'    {extra}' for extra in rest)
        quoted = (row.get('ctx') or {}).get('quotedMessage')
        if quoted:
            snippet = ' '.join((render(quoted) or '...').split())
            if len(snippet) > 80:
                snippet = snippet[:77] + '...'
            lines.append(f'    ↪ balas: "{snippet}"')
    count = len(seen)
    header = [
        f'Grup    : {name}',
        f'Tanggal : {tanggal(day)} (00:00-24:00 {tz_label})',
        f'Pesan   : {count}',
        '-' * 60,
    ]
    return '\n'.join(header + lines) + '\n', count, others


def build_messages(env: dict, day: dt.date, tz_label: str, results: list[dict], others: int) -> list[dict]:
    """Urutan pesan WA. Item: {'text': str} atau {'doc': Path, 'caption': str}."""
    send_txt = env.get('SEND_TXT', 'false').lower() == 'true'
    total = sum(r['count'] for r in results)
    head = ['📋 *Rekap Grup WA*', f'{tanggal(day)} (00:00-24:00 {tz_label})', '']
    head += [f"• {r['name']}: {r['count']} pesan" for r in results]
    head += ['', f'Total {total} pesan.']
    if total == 0:
        head.append('⚠️ Semua grup 0 pesan, cek koneksi WA di server.')
    elif others == 0:
        head.append('⚠️ Gak ada pesan dari anggota lain, server mungkin gak nerima chat grup.')
    failed = [r['name'] for r in results if r['tried'] and r['summary'] is None]
    if failed:
        head.append(f"⚠️ Summary gagal: {', '.join(failed)} (txt mentah dilampirkan).")

    sections = [f"*{r['name']}* · {r['count']} pesan\n\n{r['summary']}" for r in results if r['summary']]
    if env.get('SUMMARY_MODE', 'per_group') == 'combined':
        body = '\n'.join(head)
        if sections:
            body += '\n\n' + '\n\n―――――\n\n'.join(sections)
        messages = [{'text': body}]
    else:
        messages = [{'text': '\n'.join(head)}] + [{'text': s} for s in sections]

    for r in results:
        if r['count'] and (send_txt or r['summary'] is None):
            note = ' (summary gagal)' if r['tried'] and r['summary'] is None else ''
            messages.append({'doc': r['path'], 'caption': f"{r['name']} - {r['count']} pesan{note}"})
    return messages


def send(env: dict, path: str, payload: dict) -> None:
    for attempt in range(1, 4):
        try:
            api(env, 'POST', path, payload, timeout=120)
            return
        except Exception as exc:
            log(f'kirim gagal (percobaan {attempt}/3): {exc}')
            if attempt == 3:
                raise
            time.sleep(30 * attempt)


def deliver(env: dict, to: str, messages: list[dict]) -> None:
    inst = env['INSTANCE']
    for i, msg in enumerate(messages):
        if i:
            time.sleep(3)
        if 'text' in msg:
            send(env, f'/message/sendText/{inst}', {'number': to, 'text': msg['text']})
        else:
            doc: Path = msg['doc']
            send(env, f'/message/sendMedia/{inst}', {
                'number': to,
                'mediatype': 'document',
                'mimetype': 'text/plain',
                'caption': msg['caption'],
                'media': base64.b64encode(doc.read_bytes()).decode('ascii'),
                'fileName': doc.name,
            })


def prune_txt(days: int) -> None:
    cutoff = time.time() - days * 86400
    for f in (ROOT / 'output').rglob('*.txt'):
        if f.stat().st_mtime < cutoff:
            f.unlink()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--date', help='YYYY-MM-DD (default: kemarin)')
    parser.add_argument('--dry-run', action='store_true', help='jangan kirim WA, cetak pesannya')
    parser.add_argument('--no-summary', action='store_true', help='lewati web summary')
    parser.add_argument('--to', help='nomor penerima, default RECIPIENTS di .env')
    args = parser.parse_args()

    env = load_env()
    _, zone, tz_label = timezone(env)
    day = (dt.date.fromisoformat(args.date) if args.date
           else dt.datetime.now(zone).date() - dt.timedelta(days=1))
    start = int(dt.datetime.combine(day, dt.time(), zone).timestamp())
    end = int(dt.datetime.combine(day + dt.timedelta(days=1), dt.time(), zone).timestamp())
    use_summary = summarize.enabled(env) and not args.no_summary

    results, others = [], 0
    for jid, name in load_groups():
        txt, count, from_others = build_txt(name, day, tz_label, zone, fetch(env, jid, start, end))
        others += from_others
        slug = slugify(name)
        path = ROOT / 'output' / slug / f'{slug}_{day:%Y-%m-%d}.txt'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(txt, encoding='utf-8')
        log(f'{name}: {count} pesan -> {path.relative_to(ROOT)}')

        summary, tried = None, False
        if use_summary and count:
            tried = True
            try:
                summary = summarize.summarize(env, path)
                log(f'{name}: summary {len(summary)} karakter')
            except Exception as exc:
                log(f'{name}: summary gagal: {exc}')
        results.append({'name': name, 'count': count, 'path': path, 'summary': summary, 'tried': tried})

    prune_txt(int(env.get('TXT_RETENTION_DAYS', '30')))
    messages = build_messages(env, day, tz_label, results, others)

    if args.dry_run:
        for msg in messages:
            print('-' * 60)
            print(msg['text'] if 'text' in msg else f"[file] {msg['doc'].name} — {msg['caption']}")
        return 0

    recipients = [phone(n) for n in (args.to or env.get('RECIPIENTS', '')).split(',') if n.strip()]
    if not recipients:
        log('RECIPIENTS kosong, txt tersimpan tapi gak dikirim')
        return 1
    state = connection_state(env)
    if state != 'open':
        log(f'WA gak connected (state={state}), txt tersimpan tapi gak dikirim')
        return 2
    for to in recipients:
        deliver(env, to, messages)
        log(f'terkirim ke {to}: {len(messages)} pesan')
    return 0


if __name__ == '__main__':
    sys.exit(main())
