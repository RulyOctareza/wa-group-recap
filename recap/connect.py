#!/usr/bin/env python3
"""Siapkan instance WhatsApp di Evolution: buat instance, set settings, tautkan HP.

  recap/connect.py                     # tampilkan QR (di terminal kalau ada `qrencode`)
  recap/connect.py --number 08xxxx     # kode pairing 8 huruf, tanpa scan kamera
  recap/connect.py --status            # cek status koneksi aja
  recap/connect.py --wait              # tunggu sampai HP selesai ditautkan

Di HP: WhatsApp → Perangkat tertaut → Tautkan perangkat
(→ "Tautkan dengan nomor telepon saja" kalau pakai kode pairing).
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import time

from common import api, connection_state, load_env, log, phone

# groupsIgnore=false: pesan grup ikut disimpan (inti alur rekap).
# alwaysOnline/readMessages=false: HP tetap dapat notifikasi & chat gak otomatis ke-read.
SETTINGS = {
    'rejectCall': False,
    'msgCall': '',
    'groupsIgnore': False,
    'alwaysOnline': False,
    'readMessages': False,
    'readStatus': False,
    'syncFullHistory': False,
}


def instance_exists(env: dict, name: str) -> bool:
    for item in api(env, 'GET', '/instance/fetchInstances') or []:
        if (item.get('name') or (item.get('instance') or {}).get('instanceName')) == name:
            return True
    return False


def show_qr(env: dict, res: dict) -> None:
    code = res.get('code')
    if code and shutil.which('qrencode'):
        subprocess.run(['qrencode', '-t', 'ansiutf8', code], check=False)
        print('Scan QR di atas dari HP (QR ganti tiap ~40 detik, jalankan ulang kalau kedaluwarsa).')
    port = env['EVOLUTION_URL'].rsplit(':', 1)[-1].strip('/')
    print('\nAtau buka Evolution Manager di laptop:')
    print(f'  ssh -L {port}:localhost:{port} <user>@<server>')
    print(f'  buka http://localhost:{port}/manager → login pakai EVOLUTION_API_KEY → instance → QR')
    print('Atau tanpa kamera: recap/connect.py --number 08xxxxxxxxxx')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--number', help='nomor WA yang ditautkan, buat kode pairing')
    parser.add_argument('--status', action='store_true', help='cek status aja')
    parser.add_argument('--wait', action='store_true', help='tunggu sampai connected (maks 3 menit)')
    args = parser.parse_args()

    env = load_env()
    inst = env['INSTANCE']
    if args.status:
        print(f'{inst}: {connection_state(env)}')
        return 0

    if not instance_exists(env, inst):
        api(env, 'POST', '/instance/create',
            {'instanceName': inst, 'integration': 'WHATSAPP-BAILEYS', 'qrcode': False})
        log(f'instance {inst} dibuat')
    api(env, 'POST', f'/settings/set/{inst}', SETTINGS)
    log('settings diset (groupsIgnore=false)')

    state = connection_state(env)
    if state == 'open':
        log(f'{inst} udah connected')
        return 0

    if args.number:
        res = api(env, 'GET', f'/instance/connect/{inst}?number={phone(args.number)}') or {}
        code = res.get('pairingCode')
        if not code:
            log(f'kode pairing gak keluar, respons: {res}')
            return 1
        print(f'\nKode pairing: {code[:4]}-{code[4:]}')
        print('HP: WhatsApp → Perangkat tertaut → Tautkan perangkat → '
              'Tautkan dengan nomor telepon saja → masukkan kode.')
    else:
        show_qr(env, api(env, 'GET', f'/instance/connect/{inst}') or {})

    if not args.wait:
        print('\nSetelah ditautkan, cek: recap/connect.py --status')
        return 0
    for _ in range(36):
        time.sleep(5)
        if connection_state(env) == 'open':
            log(f'{inst} connected')
            return 0
    log('belum connected setelah 3 menit, jalankan ulang recap/connect.py')
    return 1


if __name__ == '__main__':
    sys.exit(main())
