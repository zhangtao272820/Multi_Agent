"""兼容入口。请改用：python scripts/bootstrap_tenant.py --tenant p2604 --from-snapshot"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.bootstrap import bootstrap_tenant


def main() -> None:
    print(bootstrap_tenant("p2604", from_snapshot=True))


if __name__ == "__main__":
    main()
