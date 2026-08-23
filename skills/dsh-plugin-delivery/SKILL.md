---
name: dsh-plugin-delivery
description: DSH 插件安装/卸载/更新的标准交付流程：源码进本地插件库、提交推送到 dsh-plugin-family 分支、staging 沙盒验证、promote 正式版、收尾核验。用于“装个插件/更新插件/卸载插件/走流程交付插件”等需求。
whenToUse: >-
  用户要求安装、卸载、更新或交付一个 DSH 插件，尤其是带“先入库、推分支、沙盒测试、再上正式版”的流程时使用。如果只是改插件源码，先读 dsh-plugin-dev。
---

# DSH 插件安装/交付流程

本 skill 固化自一条完整实操链路：重新安装插件、清理未安装插件、修复 selection-tutor / usage-monitor 前端后发布正式版。
核心目标：**任何插件变更都先落在本地插件库和分支，再经过 staging 影子环境验证，最后才交付到 prod。**

---

## 一、铁律

1. **只动 `dsh-plugin-family`，绝不碰 `main`**  
   提交、推送都留在 `dsh-plugin-family`；`main` 保持官方/基线不动。

2. **源码先进本地插件库，再安装**  
   本地插件库 = `D:\douzhongjun\peanut-dsh-plugin\<插件名>`。第三方插件先拉源码进来，不要直接改 prod 里的安装副本。

3. **staging 是唯一测试入口**  
   未在 staging 完整健康检查通过前，不得 promote 到 prod。

4. **改文件后要同步安装副本 + 重启**  
   `pnpm file:` 安装的插件在源码变化后不会自动刷新 `node_modules` 里的副本。改了 vendor/源码后，要么重新 install，要么把整个插件目录物理复制到 staging/prod 的 `node_modules`，然后重启 DSH。

5. **promote 自动处理依赖，patch 删除需人工同步**  
   `cordis.patch.yml` 的 insert 删除不会被 promote 自动带过去；如果 staging 移除了 patch 条目，必须同步手动编辑 prod 的同名文件，否则 promote 会 block。

---

## 二、安装新插件的标准流程

### Step 1：拉源码到本地插件库
```powershell
$tmp = "C:\Users\DELL\AppData\Local\Temp\<plugin>-src"
git clone --depth 1 --branch <tag> <upstream-url> $tmp
$dest = "D:\douzhongjun\peanut-dsh-plugin\<plugin>"
New-Item -ItemType Directory -Path $dest -Force | Out-Null
Get-ChildItem $tmp -Force | Where-Object { $_.Name -ne '.git' } |
  ForEach-Object { Copy-Item $_.FullName $dest -Recurse -Force }
```

- 如果只想要最新 tag，优先用 `--branch vX.Y.Z`。
- 复制时**不要带嵌套 `.git`**。

### Step 2：检查插件元数据
确认：
- `package.json` 有 `dsh.bundle.patch` / `dsh.client` 等 DSH 声明
- `cordis.patch.yml` / bundle 会自动挂载
- `lib/` 是否已带编译产物；没有就先 `pnpm run build`

### Step 3：更新本地插件库 README
在 `D:\douzhongjun\peanut-dsh-plugin\README.md` 的插件清单表里补一行，注明来源和版本。

### Step 4：提交并推送分支
```powershell
cd D:\douzhongjun\peanut-dsh-plugin
git add <plugin> README.md
git commit -m "feat(<plugin>): vendor upstream v<ver> into local plugin library"
git push origin dsh-plugin-family
```
- 当前分支必须确认是 `dsh-plugin-family`。
- 不要 push `main`。

### Step 5：安装到 staging 沙盒
```powershell
# 优先使用 staging 工具
staging_install spec="file:D:/douzhongjun/peanut-dsh-plugin/<plugin>"
```
或者 CLI：
```powershell
cd D:\douzhongjun\dsh-plugin-staging
node dist/cli.js install file:D:/douzhongjun/peanut-dsh-plugin/<plugin>
```

安装后 staging 会自动做完整健康检查：
- 进程存活、HTTP 200
- 前端资源可加载
- `--dump-config` 组合成功
- 插件 bundle 入口完整
- staging 工具注册正常
- 无日志硬错误

### Step 6：promote 到正式版
```powershell
# 先 dry-run 确认计划
node dist/cli.js promote --dry-run --json

# 确认后正式发布（prod 会守护重启）
staging_promote approve=true
```
或 CLI：
```powershell
node dist/cli.js promote --yes
```

### Step 7：正式版验收
```powershell
# 1. package.json 出现依赖和 bundle
Select-String -Path C:\Users\DELL\.dsh\profiles\web\package.json -Pattern "<插件名>"

# 2. dump-config 出现插件条目
dsh --profile web --dump-config | Select-String -Pattern "<插件名>"

# 3. node_modules 存在
Test-Path C:\Users\DELL\.dsh\profiles\web\node_modules\<插件名>

# 4. 服务可用
Invoke-WebRequest http://127.0.0.1:3080/ -UseBasicParsing
```

---

## 三、卸载插件的流程

1. **先在 staging 卸载**：`staging_uninstall pluginId="<包名>"`。
2. **如果是 patch insert 插件**：手动从 staging 和 prod 的 `cordis.patch.yml` 删除对应 `- insert` 条目。
3. **清理残留**：
   - `package.json` 的 dependencies / devDependencies / `dsh.profile.bundles`
   - `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` / `allowBuilds`
   - `pnpm-lock.yaml`、`node_modules` 目录
   - `vendor-map.json` 中的条目（staging/promote 用）
   - 本地源码目录和 README 清单
4. **同步到 prod 后重启**：为了 patch 删除能通过，需人工同步 prod 的 `cordis.patch.yml` / `pnpm-workspace.yaml`，再 promote 或直接重启。
5. **commit + push 到 `dsh-plugin-family`**。

---

## 四、修改已安装插件的流程

1. 在 `D:\douzhongjun\peanut-dsh-plugin\<plugin>` 改源码。
2. 如果项目需要 build，执行 `pnpm run build`。
3. **同步安装副本**（关键，容易漏）：
   - staging：`D:\douzhongjun\dsh-plugin-staging\staging-home\profiles\web\node_modules\@<scope>\<plugin>`
   - prod：`C:\Users\DELL\.dsh\profiles\web\node_modules\@<scope>\<plugin>`
   - 最简单是删掉目录后从源码目录整体 `Copy-Item -Recurse`。
4. 删除/更新 source map 等旧产物，避免残留旧字符串。
5. 重启 staging 验证，再重启 prod。
6. 提交推送分支。

---

## 五、常用路径速查

```text
本地插件库        : D:\douzhongjun\peanut-dsh-plugin
staging 项目      : D:\douzhongjun\dsh-plugin-staging
staging home      : D:\douzhongjun\dsh-plugin-staging\staging-home
prod home         : C:\Users\DELL\.dsh
prod profile      : C:\Users\DELL\.dsh\profiles\web
staging CLI       : D:\douzhongjun\dsh-plugin-staging\dist\cli.js
staging 端口      : 3081
prod 端口         : 3080
staging 日志      : D:\douzhongjun\dsh-plugin-staging\logs
promote 报告      : D:\douzhongjun\dsh-plugin-staging\logs\promotes
```

---

## 六、验收检查单

- [ ] 源码已加入 `peanut-dsh-plugin`，无嵌套 `.git`
- [ ] README 插件清单已更新
- [ ] 已 commit + push 到 `dsh-plugin-family`
- [ ] staging 完整健康检查通过
- [ ] promote dry-run 无 block
- [ ] prod 守护重启成功，HTTP 200
- [ ] `package.json` / `--dump-config` / `node_modules` 均已确认
- [ ] 卸载/清理场景下无残留引用
