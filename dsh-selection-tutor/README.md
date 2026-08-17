# dsh-selection-tutor

选中对话里的任意文字，浮出「解释 / 翻译」两个按钮；点击后在当前会话上方打开一个可拖动、可缩放的学习小窗。小窗是当前主会话的一个**隐藏临时分支**：

- 不出现在会话列表；
- 不向主会话写入任何消息，不影响主会话上下文与缓存；
- 模型固定继承主会话（只读），只能切换思考强度；
- 关闭小窗即销毁该临时分支；
- 小窗历史不持久化，重启后不恢复。

## 配置

「设置 → 自定义模型配置 → 划词学习小窗」可设置新小窗的默认思考强度（默认 off）。该设置页签由 `dsh-custom-model-config` 提供。

## 构建

```bash
pnpm install
pnpm run build
pnpm test
```

## 安装

1. 将本插件与 `dsh-custom-model-config` 加入 profile 的 cordis patch 层；
2. 重启 `dsh web` 并刷新页面。
