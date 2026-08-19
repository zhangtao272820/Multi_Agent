"""通用租户目录引导：连库 snapshot，或用已有 schema_snapshot.json 生成 docs/golden。"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.bootstrap import bootstrap_tenant


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tenant", default="p2604")
    parser.add_argument(
        "--from-snapshot",
        action="store_true",
        help="不连库，用 tenants/<id>/schema_snapshot.json",
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="连租户 MySQL 拉 information_schema 再写 snapshot",
    )
    args = parser.parse_args()
    if args.live and args.from_snapshot:
        raise SystemExit("use either --live or --from-snapshot")
    from_snapshot = not args.live
    out = bootstrap_tenant(args.tenant, from_snapshot=from_snapshot)
    print(out)


if __name__ == "__main__":
    main()
