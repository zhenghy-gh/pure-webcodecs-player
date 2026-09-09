
## 在线演示与发布（2026-09-09 上线）
- GitHub Pages 已开通并长期生效：**https://zhenghy-gh.github.io/pure-webcodecs-player/**（main 分支根目录直出；根 index.html 重定向演示站 + .nojekyll，见 9d37879）。推 main 即自动更新站点。
- 开通通道：OAuth device flow（curl 走本机 VPN 代理 127.0.0.1:7897，见用户级记忆）→ Pages API 201。gh token 未持久化，API 需求重跑 flow（约 2 分钟）。
- 真机 e2e 回归：`scripts/e2e/demo-smoke.mjs`（playwright 驱动真实 Chrome，遍历 16 模块 demo + hub，刷新 `docs/review/i3/*.png`），属本地工具不进 CI 必跑。
