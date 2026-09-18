# ZZZ Idol Desktop Pet

爱芮、南宫、千夏的 macOS / Windows 桌宠，基于 Tauri 2、TypeScript、Rust 与 Spine Runtime。

包含透明窗口、拖拽与漫步、角色互动与联动、窗口托举，以及独立番茄钟。

## 开发与构建

需要 Node.js 22、Rust stable，以及目标平台的 Tauri 构建依赖；macOS 需要 Xcode Command Line Tools。

```bash
cd desktop-pet
npm ci
npm run tauri -- dev
```

验证与 macOS 打包：

```bash
npm run validate:windows-prep
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked --lib
npm run tauri -- build --bundles app -- --locked
```

Windows x64 安装包由 GitHub Actions 构建，提供 NSIS 与 MSI。

## 目录

- `desktop-pet/`：应用源码、必需素材、锁文件、测试和校验脚本。
- `.github/`：Windows 构建工作流及问题反馈模板。
- `WINDOWS-TESTING.md`：Windows 实机验收清单。
- [功能与开发说明](desktop-pet/README.md)。

此仓库为从 `HanaAyane/AngelofDelusion-deskpet` 提交 `6ebb062a8bad5a9760d39d4ef20a698a68c257fe` 精简出的独立源码仓库。保留现有应用与 Windows CI 所需文件，不携带原始网页、剧情、重复素材、独立动画播放器、旧 Git 历史、依赖缓存或安装包。

角色素材来源于绝区零相关活动。素材及第三方运行库保留各自权利与使用条件；私密仓库不改变这些条件。
