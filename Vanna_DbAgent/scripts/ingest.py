"""灌租户向量目录（DDL / 文档 / 黄金 SQL）。会调 embedding，不是契约 smoke。"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.catalog import ingest_tenant
from app.tenants import load_tenants


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tenant", default="p2604")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    tenants = load_tenants()
    t = tenants.get(args.tenant)
    if not t:
        raise SystemExit(f"unknown tenant: {args.tenant}")
    out = ingest_tenant(t, skip_if_ready=not args.force)
    print(out)


if __name__ == "__main__":
    main()
