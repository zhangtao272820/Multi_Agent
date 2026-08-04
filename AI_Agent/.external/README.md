# 可选外部引擎（不提交 git）

```
.external/
├── FeatherTalk/      # git clone anliyuan/FeatherTalk — 口型训练/推理真源
└── LiveTalking/      # git clone lipku/LiveTalking — WebRTC 推流 / idle / 打断
```

安装：

```powershell
.\scripts\setup_avatar_stack.ps1
```

若 SSL 报错：`$env:GIT_SSL_NO_VERIFY='true'` 后再跑。

**已废弃作为主路径**：Wav2Lip、MuseTalk、旧 Ultralight 独立微服务。
