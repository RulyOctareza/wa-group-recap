"""Kirim txt rekap ke web summary, ambil teks summary-nya.

Bentuk request/response diatur lewat .env (lihat docs/WEB_API.md):
- RECAP_API_MODE=multipart → field file (txt) + field password
- RECAP_API_MODE=json      → {"<RECAP_API_TEXT_FIELD>": isi txt, "<password field>": password}
Respons JSON → ambil RECAP_API_RESULT_PATH (dot path). Respons text/plain → body apa adanya.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from common import log


class SummaryError(RuntimeError):
    pass


def enabled(env: dict[str, str]) -> bool:
    return bool(env.get('RECAP_API_URL'))


def _multipart(fields: dict[str, str], file_field: str, filename: str, content: bytes) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    body = bytearray()
    for name, value in fields.items():
        body += (f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n'
                 f'{value}\r\n').encode()
    body += (f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; '
             f'filename="{filename}"\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n').encode()
    body += content + f'\r\n--{boundary}--\r\n'.encode()
    return bytes(body), f'multipart/form-data; boundary={boundary}'


def _dig(data, path: str):
    for key in filter(None, path.split('.')):
        if isinstance(data, list) and key.isdigit() and int(key) < len(data):
            data = data[int(key)]
        elif isinstance(data, dict):
            data = data.get(key)
        else:
            return None
    return data


def _extract(raw: bytes, ctype: str, url: str, env: dict[str, str]) -> str:
    if 'text/html' in ctype:
        # Halaman login Vercel / halaman error, bukan hasil summary
        raise SummaryError(f'dapat halaman HTML dari {url} (kena Deployment Protection atau URL salah?)')
    text = raw.decode('utf-8', 'replace').strip()
    if 'json' in ctype or text.startswith(('{', '[')):
        path = env.get('RECAP_API_RESULT_PATH', 'summary')
        value = _dig(json.loads(text), path) if path else json.loads(text)
        if value is None:
            raise SummaryError(f'field "{path}" gak ada di respons: {text[:200]}')
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)
    if not text.strip():
        raise SummaryError('summary kosong')
    return text.strip()


def summarize(env: dict[str, str], path: Path) -> str:
    content = path.read_bytes()
    headers = {'Accept': 'application/json, text/plain;q=0.9', 'User-Agent': 'wa-group-recap/1.0'}
    if env.get('VERCEL_PROTECTION_BYPASS'):
        headers['x-vercel-protection-bypass'] = env['VERCEL_PROTECTION_BYPASS']
    if env.get('RECAP_API_TOKEN'):
        headers['Authorization'] = f"Bearer {env['RECAP_API_TOKEN']}"

    pw_field = env.get('RECAP_API_PASSWORD_FIELD', 'password')
    fields = {pw_field: env.get('RECAP_API_PASSWORD', '')} if pw_field else {}
    if env.get('RECAP_API_MODE', 'multipart') == 'json':
        payload = {env.get('RECAP_API_TEXT_FIELD', 'text'): content.decode('utf-8'), **fields}
        body = json.dumps(payload, ensure_ascii=False).encode()
        headers['Content-Type'] = 'application/json'
    else:
        body, headers['Content-Type'] = _multipart(
            fields, env.get('RECAP_API_FILE_FIELD', 'file'), path.name, content)

    url = env['RECAP_API_URL']
    timeout = int(env.get('RECAP_API_TIMEOUT', '180'))
    error: Exception | None = None
    for attempt in range(1, 4):
        req = urllib.request.Request(url, data=body, headers=headers, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return _extract(resp.read(), resp.headers.get('Content-Type', ''), resp.geturl(), env)
        except urllib.error.HTTPError as exc:
            detail = exc.read()[:300].decode('utf-8', 'replace')
            error = SummaryError(f'HTTP {exc.code}: {detail}')
            if exc.code < 500 and exc.code != 429:
                break  # salah request / ditolak: retry gak bakal nolong
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            error = exc
        except SummaryError as exc:
            error = exc
            break
        if attempt < 3:
            log(f'summary {path.name} gagal (percobaan {attempt}/3): {error}')
            time.sleep(15 * attempt)
    raise SummaryError(str(error))
