# README 视觉源文件

- `characters.png`：使用本仓库 `SpineRenderer` 和三个角色默认待机动作渲染的透明图层，并非桌面实机截图。
- `hero-layout.svg`：1200 × 680 排版源文件，引用同目录的角色图层。
- `../hero.webp`：最终发布图。README 使用已合成的 WebP，避免 GitHub 中 SVG 外链图片失效。

配色沿用应用设置页：背景 `#3b2630`、正文 `#fff0f5`、强调 `#e995b6`。

编辑 SVG 后，在浏览器中以内联 SVG 加载，并以此目录为 base URL，按 1200 × 680 截图，再导出 WebP。未使用 AI 生成角色或重新绘制原素材。
