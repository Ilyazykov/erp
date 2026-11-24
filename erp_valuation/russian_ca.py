"""The Russian Trusted Root CA (the Ministry of Digital Development) for MOEX ISS.

Since 23.11.2026 iss.moex.com's certificate chains to this root, which is not
in the usual trust stores: every MOEX request failed with
CERTIFICATE_VERIFY_FAILED and the MOEX prices stopped. The root is trusted
only for MOEX requests (open_url below); every other request verifies against
the default roots only. The same root as supabase/functions/_shared/russian_root_ca.ts
(SHA-256 D2:6D:2D:...:CA:8E:CF:31, valid 2022-03-01 .. 2032-02-27).
"""
from __future__ import annotations

import ssl
import urllib.parse
import urllib.request
from pathlib import Path

_PEM = Path(__file__).with_name("russian_trusted_root_ca.pem")
_RU_HOSTS = {"iss.moex.com"}
_context: ssl.SSLContext | None = None


def _ru_context() -> ssl.SSLContext:
    global _context
    if _context is None:
        _context = ssl.create_default_context()   # the default roots ...
        _context.load_verify_locations(_PEM)     # ... plus the Russian one
    return _context


def open_url(req, timeout: float):
    """urllib.request.urlopen, with the Russian root trusted for MOEX only."""
    url = req.full_url if isinstance(req, urllib.request.Request) else req
    host = urllib.parse.urlsplit(url).hostname
    if host in _RU_HOSTS:
        return urllib.request.urlopen(req, timeout=timeout, context=_ru_context())
    return urllib.request.urlopen(req, timeout=timeout)
