# dsh-file-launcher

双击 **Ctrl** 唤起全盘文件名搜索框（Everything 引擎），DSH 前台/后台最小化均可唤起。

## 功能

- 双击 Ctrl 唤起一个无边框、置顶的小搜索框（由 `dsh-launcher` 的 DshShell 承载）
- 输入文件名关键词 → 毫秒级全盘搜索（Everything + es.exe）
- 下拉展示候选：名称高亮、路径、大小、修改时间
- **收藏**（★）：收藏项始终排最前
- **常用打分**：打开过的文件累积使用次数 + 最近打开加权，输入前几个字时常用项自动上浮
- 键盘操作：`↑↓` 选择 · `Enter` 打开 · `Ctrl+Enter` 在文件夹中定位 · `Tab` 收藏 · `Esc` 关闭

## 架构

| 部件 | 说明 |
|------|------|
| `index.js` | DSH host 插件：es.exe 搜索 + 状态持久化 + webServer 路由 |
| `launcher.html` | 搜索框 UI（自包含 HTML/CSS/JS） |
| `everything/` | 捆绑的 es.exe / everything.exe（Everything 引擎） |

状态持久化在 `~/.dsh/file-launcher/state.json`。

## 部署（dsh profile bundle）

1. 复制到 profile：`~/.dsh/profiles/web/node_modules/@peanutsdou/dsh-file-launcher/`
2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 的 insert 列表加一行：

   ```yaml
   - id: file-launcher
     name: '@peanutsdou/dsh-file-launcher'
   ```

3. 重启 DSH。

## 配套（桌面壳）

双击 Ctrl 全局钩子与置顶覆盖窗在 `dsh-launcher/src/DshShell/Program.cs` 中实现，
构建出的 `DshWeb.exe` 需替换运行中的桌面壳。
