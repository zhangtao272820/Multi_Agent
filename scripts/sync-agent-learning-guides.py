#!/usr/bin/env python3
"""DEPRECATED: 各仓 学习指南.md 已迁入 docs/面试备战/，勿再同步平行副本。

See: docs/面试备战/00-使用说明与防穿帮.md
"""
from __future__ import annotations

import sys

def main() -> int:
    print(
        "DEPRECATED: interview knowledge SSOT is docs/面试备战/ "
        "(00～08). Do not sync per-agent 学习指南.md.",
        file=sys.stderr,
    )
    return 1

if __name__ == "__main__":
    raise SystemExit(main())
