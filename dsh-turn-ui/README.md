# dsh-turn-ui

长会话阅读优化：按轮把过程输出折叠成容器卡片，并给已展开的思考（Think）正文加高度限制，超出后在思考内部滚动查看。

## 组成

- **TurnFold**：把每个轮次的上下文注入 / 思考 / 工具 / 产物等过程行折叠成一张容器卡片；
  运行中的轮次保持原生展开，轮次结束后自动折叠，点击卡片可展开 / 收起。
- **思考高度限制**：只作用于已展开的 Think 正文（`data-variant="think"` + `data-open`），
  不改动原生展开 / 收起状态；超过 `thinkingMaxHeight`（默认 240px）时正文内部出滚动条。
- **设置**：设置 → 插件 →「轮次折叠容器」，可开关：
  - `turnFoldEnabled`：按轮折叠过程输出，默认开启；
  - `thinkingHeightEnabled`：展开思考时限制高度，默认开启；
  - `thinkingMaxHeight`：最大高度（px），默认 240，范围 120–2000。

## 部署

按普通 DSH profile 插件部署（`cordis.patch.yml` 已带 insert 行）。

## 测试

插件为纯 client UI，主要依赖浏览器会话快照与 DOM 锚点；构建后通过真实 DSH
页面验证轮次折叠、思考展开高度限制、内部滚动与设置开关。
