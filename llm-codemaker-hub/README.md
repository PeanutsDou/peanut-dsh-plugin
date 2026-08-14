# @deepseek-ai/dsh-llm-codemaker-hub

CodeMaker Hub 供应商路由插件：在 DeepSeek Harness 中注册独立的 `codemaker-hub` provider，
复用 DeepSeek chat-completions 适配器（`@deepseek-ai/dsh-llm-deepseek`）指向本地
CodeMaker Hub 代理（`http://127.0.0.1:15721/v1`），由代理用公司登录态转发到公司 AI 网关。

与官方 `deepseek-official` 路由并存：两边都可以用，互不影响，都支持 off/high/max 思考强度。

## 部署

```text
1. pnpm/npm 构建：npm install && npm run build          # 产出 lib/index.js
2. 物理复制（勿用 link）：
   lib/ + package.json → ~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-llm-codemaker-hub/
3. 挂载：~/.dsh/profiles/web/cordis.patch.yml 追加
   - insert:
       - id: llm-codemaker-hub
         name: '@deepseek-ai/dsh-llm-codemaker-hub'
4. 重启 DSH（关窗重开，插件只在启动时加载）
```

API key 默认引用 `CODEMAKER_HUB_API_KEY`（hub 忽略 key 内容，任意值即可）；
凭据可经 Models 页或 `~/.dsh/.credentials.yaml` 存储。

## 配置（可选，全部热生效）

`~/.dsh/settings.yaml` 的 `llm-codemaker-hub:` 分节覆盖默认值：

```yaml
llm-codemaker-hub:
  baseURL: http://127.0.0.1:15721/v1   # 默认即此值
  reasoningEffort: max                  # off | high | max；默认 high
  models:                               # 选择器展示的目录（默认含全部网关模型）
    - id: deepseek-v4-flash
      name: DeepSeek V4 Flash
      contextWindow: 1000000
    - id: gpt-5.6-luna
      name: GPT-5.6 Luna
  multimodalModels: [gpt-5.6-luna, glm-5v-turbo]   # 支持图片输入的模型 id
```

## 多模态

`multimodalModels` 里的模型声明 `[text, image]` 输入：对话中可以直接附带图片
（经 attachment 服务转 base64 内嵌发送）。不在列表中的模型保持纯文本，
harness 会在发出请求前自动拒绝图片——无需按供应商手动区分。

默认多模态模型：`gpt-5.6-luna`、`glm-5v-turbo`。

## 模型

默认目录（截至 2026-08-14 网关模型缓存）：`deepseek-v4-flash`、`deepseek-v4-pro`、
`gpt-5.6-luna`、`gpt-5.5-2026-04-24`、`gpt-5.4-2026-03-05`、`qwen3.7-plus`、
`qwen3.5-flash`、`kimi-k2.7-code`、`MiniMax-M3`、`glm-5v-turbo`、`claude-sonnet-4-6`、
`gemini-3.1-flash-lite-preview`。

- 模型 id 透传：**不要带 `[1m]` 等后缀**（网关会拒绝，`deepseek-v4-flash[1m]` → 400）。
- 未列入目录的 id 也可直接用（选择器里可能不显示，但请求会透传）；在 `models` 里
  追加即可让选择器显示。

## 注意

- hub 必须运行（托盘应用）；关闭后请求报连接失败。
- 非 DeepSeek 模型（gpt/claude 等）走 DeepSeek 方言适配器：`reasoning_effort`/`thinking`
  参数是否被网关接受按模型实测；deepseek 系模型已验证（max 正常）。
- 流式响应中的空白 `data:` 事件（网关/代理在大上下文 prefill 等静默期的 keepalive）
  会被 `parseSse` 跳过，不再触发 `MALFORMED_RESPONSE` 中断；`[DONE]` 语义不变。
