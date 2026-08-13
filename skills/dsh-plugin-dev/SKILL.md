---
name: dsh-plugin-dev
description: 开发 DeepSeek Harness (DSH) 插件（Profile Bundle）的强制规范流程：服务名查证、cordis 导入、客户端打包、构建部署、验证。用于避免 httpServer/webServer 这类服务名错误、cordis 双实例崩溃、客户端多文件打包失败、旧产物未部署等高频致命坑。
whenToUse: >-
  编写或修改 DSH 插件、Profile Bundle、或用户要求"开发/移植一个 DSH 插件"时使用。在写任何插件代码前必须先读本 skill，并按"标准流程检查单"逐条执行，不得跳过服务名查证。
---

# DSH 插件开发规范

本 skill 来自一次真实踩坑复盘（quick-launcher 插件开发），把"为什么反复出错"固化下来。
核心教训：**DSH 是 rc 版本，API（尤其服务名）在快速变化，第三方插件普遍滞后。唯一可靠的真相来源是 DSH 自己安装目录里的源码。照抄第三方插件（尤其已知有 bug 的）必然出错。**

---

## 一、铁律（违反任何一条都可能导致 DSH 启动即崩）

### 铁律 1：服务名必须查证，禁止照抄第三方

DSH 的服务由各 `dsh-*` 包通过 `super(ctx, "真实服务名")` 注册。服务名错了，插件 inject 会永远 `pending (waiting for service: xxx)`，DSH 启动即失败。

**查证方法**（唯一可靠途径）：
1. 先确定"我要用哪个能力"，反推服务包名（在 DSH 依赖树里找 `dsh-*` 包）。
2. 读 `C:\Users\DELL\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-<包名>\lib\index.js`
3. 找 `super(ctx, "...")` 或 `ctx.provide("...")` 那一行，**引号里的字符串就是真实服务名**。
4. 用 `grep` 找不到就 `read` 整个文件，不要退而求其次去照抄第三方插件。

**已查证服务名速查表**（截至 DSH 0.1.0-rc.6，用前若遇 pending 需重新查证）：

| 能力 | 包名 | 真实服务名 |
|---|---|---|
| HTTP 路由注册 | `dsh-host-webserver` | `webServer`（⚠️ 不是 httpServer） |
| shell 执行 | `dsh-shell` | `shell` |
| 工具注册 | `dsh-tools` | `tools` |
| 技能注册 | `dsh-skill` | `skills` |

**反面教材**：turn-rewind 插件写的 `httpServer` 是错的（正确是 `webServer`），且它连 `import 'cordis'` 都错。已知有 bug 的插件只当反面教材，不当参考。

### 铁律 2：服务端 import 必须用 `@deepseek-ai/cordis`

```ts
import { Service, type Context } from '@deepseek-ai/cordis'   // ✅
import { Service, type Context } from 'cordis'                 // ❌ 挂（裸 cordis 是 Koishi 版）
```

DSH 用的是 DeepSeek fork 版 `@deepseek-ai/cordis`，依赖闭包里**没有**裸 `cordis`。

### 铁律 3：客户端 bundle 必须是单文件

DSH 客户端插件编译成 CommonJS 后被 `window.__ModuleLoader__.load` 包装，浏览器运行时**无法解析 `require('./其他文件')`**。所以：
- 客户端入口 `src/client/index.tsx` 里要把所有组件写进**同一个文件**（或显式打包成单文件）。
- 参考：`tsconfig.client.json`（module: CommonJS）+ `scripts/wrap-client.mjs` 打包进 `lib/client.js`。

### 铁律 4：部署用"物理复制"，不用 link:

```text
❌ dsh plugin --profile web add D:/path/to/plugin   # 会生成 link: 依赖，Node realpath 后解析不到 DSH 闭包
✅ 复制到 ~/.dsh/profiles/web/node_modules/@<scope>/<name>/   # Node 向上遍历能找到 profiles/node_modules 里的 @deepseek-ai/cordis
```

link 方式（turn-rewind 的坑）会让插件从 `D:\...` 真实路径解析依赖，找不到 DSH 的 `@deepseek-ai/cordis` → 挂。

### 铁律 5：原生模块依赖要连依赖一起复制

原生模块（如 uiohook-napi）复制到 profile 时，它的依赖（如 node-gyp-build）在 pnpm 的 `.pnpm` 里，**要一起复制**，否则 require 时报 `Cannot find module 'node-gyp-build'`。

### 铁律 6：改源码后必须重新 build + 重新部署

DSH 加载的是 `~/.dsh/profiles/web/node_modules/@插件名/lib/` 里的**编译产物**，不是源码。改完源码如果只 build 不部署（或只部署不 build），重启后加载的还是旧产物。

### 铁律 7：插件只在 DSH 进程启动时加载

DSH 运行期间不动态加载新插件。改完插件后必须**重启 DSH 服务进程**（当前 dsh-launcher 关窗即杀 DSH，重开即拉起 = 重启）。

---

## 二、标准开发流程检查单

按顺序执行，每步都打勾：

- [ ] **1. 列服务清单**：确定插件要用哪些 DSH 服务/能力
- [ ] **2. 逐个查证服务名**：读 `dsh-*` 源码找 `super(ctx, "...")`，记录真实服务名（见铁律 1）
- [ ] **3. 写 package.json**：`dsh.bundle.patch` + `dsh.client.inject`（客户端才有）+ peerDependencies 声明 `@deepseek-ai/cordis`
- [ ] **4. 写 cordis.patch.yml**：`- insert: - id: xxx, name: '@scope/xxx'`
- [ ] **5. 写服务端**：`import '@deepseek-ai/cordis'`，inject 用查证过的服务名
- [ ] **6. 写客户端**（如有）：单文件，`ctx.effect` 挂载，`inject` 用查证过的客户端服务名
- [ ] **7. build**：`pnpm run build`（服务端 tsc + 客户端 tsc + wrap-client）
- [ ] **8. 部署**：复制 lib（+ everything 等资源 + 原生依赖）到 `~/.dsh/profiles/web/node_modules/@scope/name/`
- [ ] **9. 挂载**：在 `~/.dsh/profiles/web/cordis.patch.yml` 加 insert 行
- [ ] **10. 验证组合**：`dsh --profile web --dump-config` 确认插件行出现
- [ ] **11. 验证依赖解析**：从 lib 目录 `require.resolve('@deepseek-ai/cordis')` 必须指向 DSH 主安装的同一实例
- [ ] **12. 冒烟测试**：单独 import 服务端模块测核心逻辑（不依赖 DSH 上下文）
- [ ] **13. 重启验证**：关窗重开 DshWeb（= 重启 DSH），看日志 + 实测功能

---

## 三、踩坑档案（历史案例，勿重蹈）

| 案例 | 错误 | 教训 |
|---|---|---|
| turn-rewind 装完即崩 | `import 'cordis'`（裸）+ 用 link 安装 | 铁律 2、4 |
| quick-launcher 启动 pending | 服务名写成 `httpServer`（应为 `webServer`） | 铁律 1：照抄了 turn-rewind 的错误参考 |
| quick-launcher 客户端空白 | 客户端拆成多个 .tsx，require 无法解析 | 铁律 3 |
| uiohook 热键被禁用 | 复制原生模块漏了 node-gyp-build | 铁律 5 |
| 改完不生效 | build 后没重新部署 lib 到 profile | 铁律 6 |

---

## 四、快速参考：关键路径

```text
DSH 安装目录    : C:\Users\DELL\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh
DSH 服务包源码  : <DSH 安装目录>\node_modules\@deepseek-ai\dsh-<包名>\lib\index.js
profile 目录    : C:\Users\DELL\.dsh\profiles\<profile>\
插件部署目录    : C:\Users\DELL\.dsh\profiles\<profile>\node_modules\@<scope>\<name>\
插件源码目录    : D:\douzhongjun\peanut-dsh-plugin\<插件名>\
DSH 日志        : C:\Users\DELL\.dsh-web.log（dsh-launcher 重定向）或 .dsh-web.err.log
```
