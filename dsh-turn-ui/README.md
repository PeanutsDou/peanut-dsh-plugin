# dsh-turn-ui

长会话阅读优化：把每一轮“过程输出 + 工具调用”收进可折叠容器，并提供聊天区左边缘的轮次导航条。

## 组成

- **TurnFold（核心补丁）**：`scripts/apply-core-patch.mjs` 会替换 DSH 安装闭包里
  `@deepseek-ai/dsh-client-ui-conversation/lib/client.js` 的 `ChatView`：
  - 运行中的轮次默认展开；
  - 轮次结束后自动收起为一行（过程数 / 工具数 / 用时），最终回复正文始终可见；
  - 点击摘要行可展开查看完整过程与原始工具卡片。
- **TurnRail（插件）**：`src/client/index.tsx` 注册到会话头部的 utilities 槽位，
  用 portal 在聊天区左边缘画一条 8px 悬浮细轨；每轮一个短横杠，悬停显示轮次，
  点击跳转到对应轮次锚点（未加载的历史轮次按比例滚动）。

## 使用

```powershell
# 应用/重放核心补丁（DSH 升级后重新执行）
node scripts/apply-core-patch.mjs
# 强制重放
node scripts/apply-core-patch.mjs --force
```

补丁会把原 bundle 备份为 `client.js.pre-turnfold.bak`。插件本体按普通 DSH profile
插件部署（`cordis.patch.yml` 已带 insert 行）。

## 测试

```bash
node --test tests/turn-fold-logic.test.mjs
```

覆盖：完成轮折叠、运行轮展开、最终正文判定、中断摘要、无过程轮不生成容器。
