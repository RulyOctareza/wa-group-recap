"""Helper bersama: config .env, daftar grup, query Postgres Evolution, panggil Evolution API."""
from __future__ import annotations

import datetime as dt
import json
import re
import subprocess
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
JID_RE = re.compile(r'^[0-9-]+@g\.us$')
TZ_RE = re.compile(r'^[A-Za-z_]+(/[A-Za-z0-9_+-]+)*$')
TZ_LABEL = {'Asia/Jakarta': 'WIB', 'Asia/Makassar': 'WITA', 'Asia/Jayapura': 'WIT'}

# Tabel statistik grup non-target yang dibuang (dipakai cleanup.py & groups.py)
SCHEMA_SQL = """
set client_min_messages = warning;
create schema if not exists wa_export;
create table if not exists wa_export.group_activity (
  jid text not null,
  day date not null,
  msgs integer not null default 0,
  primary key (jid, day)
);
"""


def log(msg: str) -> None:
    print(f'{dt.datetime.now():%Y-%m-%d %H:%M:%S} {msg}', flush=True)


def load_env() -> dict[str, str]:
    env = {}
    for line in (ROOT / '.env').read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def timezone(env: dict[str, str]) -> tuple[str, ZoneInfo, str]:
    """(nama, ZoneInfo, label singkat). Nama divalidasi karena ikut masuk SQL."""
    name = env.get('TZ_NAME') or 'Asia/Jakarta'
    if not TZ_RE.match(name):
        raise ValueError(f'TZ_NAME gak valid: {name!r}')
    return name, ZoneInfo(name), TZ_LABEL.get(name, name)


def load_groups() -> list[tuple[str, str]]:
    """groups.txt: satu grup per baris, `jid|Nama Grup`. Komentar `  # ...` di ujung diabaikan."""
    groups = []
    for line in (ROOT / 'groups.txt').read_text(encoding='utf-8').splitlines():
        line = line.split('  #', 1)[0].strip()
        if not line or line.startswith('#'):
            continue
        jid, _, name = line.partition('|')
        jid = jid.strip()
        if not JID_RE.match(jid):
            raise ValueError(f'JID grup gak valid di groups.txt: {jid!r}')
        groups.append((jid, name.strip() or jid))
    return groups


def sql_list(groups: list[tuple[str, str]]) -> str:
    # JID udah divalidasi JID_RE (cuma angka, '-', '@g.us'), aman di-inline
    return ','.join(f"'{jid}'" for jid, _ in groups) or "''"


def phone(raw: str) -> str:
    """08xx / +62 xx / 62xx → 62xx (format nomor yang diterima Evolution)."""
    digits = re.sub(r'\D', '', raw)
    return '62' + digits[1:] if digits.startswith('0') else digits


def psql(sql: str, env: dict[str, str]) -> str:
    cmd = [
        'docker', 'exec', '-i', env['PG_CONTAINER'],
        'psql', '-U', env.get('PG_USER', 'evolution'), '-d', env.get('PG_DB', 'evolution'),
        '-At', '-q', '-v', 'ON_ERROR_STOP=1',
    ]
    res = subprocess.run(cmd, input=sql, capture_output=True, text=True, timeout=120)
    if res.returncode:
        raise RuntimeError(f'psql gagal: {res.stderr.strip()}')
    return res.stdout


def api(env: dict[str, str], method: str, path: str, payload=None, timeout: int = 60):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        env['EVOLUTION_URL'].rstrip('/') + path,
        data=data,
        method=method,
        headers={'apikey': env['EVOLUTION_API_KEY'], 'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
    return json.loads(body) if body else None


def connection_state(env: dict[str, str]) -> str | None:
    res = api(env, 'GET', f"/instance/connectionState/{env['INSTANCE']}") or {}
    return (res.get('instance') or {}).get('state')
