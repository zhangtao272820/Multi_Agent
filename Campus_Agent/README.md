# Campus_Agent · 人工学园

高考前 100 天校园模拟。**设计与进度唯一文档**：[`doc/Campus总览与进度.md`](doc/Campus总览与进度.md) · **AA2 增量升级**：[doc/人工学院2风格增量升级计划.md](doc/人工学院2风格增量升级计划.md)

## 开发启动

```powershell
# 后端
cd Campus_Agent/backend
pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 13116

# 前端（另开终端）
cd Campus_Agent/frontend
npm install
npm run dev
```

- 前端：http://127.0.0.1:5176  
- 后端：http://127.0.0.1:13116  

可选 `.env`（对话 LLM）：`DASHSCOPE_API_KEY`、`CAMPUS_LLM_MODEL`、`CAMPUS_AUX_LLM_MODEL`  
桌面密钥：`%LOCALAPPDATA%\CampusAgent\.env`（可用 `python scripts/seed_env_from_companion.py` 从 Companion 种子）

BGM：`data/bgm/` + `data/bgm_catalog.json`（CC0）；前端按标题/地图/地点/对话切曲，HUD 可静音。

## 冒烟

```powershell
python scripts/smoke-campus-shell.py
python scripts/smoke-campus-world.py
```

## 桌面 exe

```powershell
powershell -File desktop/build_exe.ps1
# 产物：desktop_dist/CampusAgent/CampusAgent.exe
```

存档与密钥目录：`%LOCALAPPDATA%\CampusAgent\`
