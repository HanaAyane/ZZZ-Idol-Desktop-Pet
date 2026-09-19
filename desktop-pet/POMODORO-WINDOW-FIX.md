# Windows 番茄钟窗口修复验证

日期：2026-09-19，Windows x64，源码基线 `4e91c08`。

## 修复

- 设置开关使用异步命令，设置与菜单入口统一通过 `spawn_blocking` 创建 WebView，避免阻塞 Windows GUI 回调。
- 独立窗口创建锁串行化重复打开请求，创建过程中不持有计时状态锁。
- 将五个共享状态提前注册到 Tauri Builder，修复实测日志中的 `state not managed` 启动竞态。
- 从原工作目录迁移相关修复，保留新仓库其他源码和资源。

## 自动验证

- `npm run validate:windows-prep`：通过，114 项测试。
- `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib --release`：29 项通过。
- `npm run tauri -- build --bundles nsis,msi -- --locked`：前端、Rust、NSIS、MSI 构建通过。
- 两项窗口线程/锁静态回归检查在原始提交源码上失败，在修复后通过；这些检查不代替原生 UI 验收。
- NSIS 安装退出码 0；安装后的可执行文件与最终构建一致，仅有预期的 NSIS bundle 标记差异。

## 安装版实测

- 番茄钟修复版：设置开关打开完整页面；启动倒计时并从 01:00 递减；暂停成功。
- 补齐启动状态修复后的最终版：设置打开番茄钟成功，关闭后重新打开成功；日志两次记录 `window ready` 和 `frontend initialized: window=pomodoro`。
- 最终版桌宠继续漫步，日志持续记录自动托举与释放；本次冷启动未再出现共享状态未注册错误。
- 测试倒计时已清理，原番茄钟会话已从安装前备份恢复；最终页面为“本组已结束”。
- 自动化实机检查未完成对人物右键菜单和系统托盘入口的独立验收；代码已统一走后台创建路径，并有静态回归保护。
- macOS 未实测。

最终 NSIS SHA-256：`839e8f59658895d4948be2b1da66f2677635c9917eccbe91ac68a0c83376caea`。

## 用户手动验收

2026-09-20，用户确认已手动验收，未发现问题，并授权提交、推送。用户未逐项列明测试入口；此结论单独记录，不扩大上述自动化检查范围。
