# dsh-usage-monitor

DSH API 余额与 token 用量监控插件：前端底部状态栏 + 点击展开的悬浮详情窗，host 端负责余额轮询与按日/月聚合记账。

## 功能

- **底部状态栏**（`shell.overlay`，不占三栏布局）：余额、今日输入/输出、缓存命中率；默认停靠右下角，**可拖动到界面任意位置**，位置保存在浏览器 `localStorage`，重启后保留；
- **悬浮详情窗**：点击状态栏展开——余额明细、今日/本月/累计、最近 7 天、最近 12 个月、会话消耗 Top 5、手动刷新余额；
- **token 记账**：监听 durable session 事件的 `assistant/chunk usage` / `assistant/message usage`，同一步骤后到的 usage 替换先到的（不双计）；按本地日期写入 `$DSH_HOME/usage-monitor/state.json`；
- **缓存命中**：沿用 DSH token-meter 口径 `cacheRead / (uncachedInput + cacheRead + cacheWrite)`；
- **余额**：用 `ctx.credentials` 解析 `DEEPSEEK_API_KEY`，轮询 `{balanceUrl}/user/balance`，默认 10 分钟一次；API key 永不下发到前端。

## 安装

1. 复制到 `~/.dsh/profiles/web/node_modules/@peanutsdou/dsh-usage-monitor/`；
2. 在 profile 的 `cordis.patch.yml` 追加：

   ```yaml
   - id: dsh-usage-monitor
     name: '@peanutsdou/dsh-usage-monitor'
   ```

3. 重启 DSH。

## 配置

设置 → 插件 → 可配置 → 「API 用量监控」，或直接编辑 `settings.yaml`：

```yaml
dsh-usage-monitor:
  balanceUrl: https://api.deepseek.com
  credentialRef: DEEPSEEK_API_KEY
  balancePollMs: 600000
```

## 限制

- 余额接口仅官方 DeepSeek 语义（`balance_infos`）；自定义网关可能显示“余额查询失败”，token 统计不受影响；
- token 历史从插件安装后开始记录，不回填旧会话；
- 每日/每月归属以本机时间为准。

## 构建与测试

```bash
pnpm install
pnpm run build
node --test tests/*.test.mjs
```

host 半由 `tsc` 输出到 `lib/index.js`；client 半由 `tsdown` 打成单文件 `lib/client.js`。
