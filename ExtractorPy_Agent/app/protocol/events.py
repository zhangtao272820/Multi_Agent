"""WS event helpers matching Extractor_Agent /_ws contract."""

from __future__ import annotations

import json
from typing import Any


def ws_msg(msg_type: str, payload: Any = None) -> str:
    return json.dumps({"type": msg_type, "payload": payload}, ensure_ascii=False)
