# dsh-custom-model-config

DSH 设置聚合页签「自定义模型配置」。本插件本身不保存任何配置，只提供一个统一入口：其他插件通过窗口级契约注册模型相关设置卡片，全部集中到这一个页签里，避免设置侧栏被插件页签刷屏。

## 接入方式

```ts
// 任意 DSH client 插件内
declare global {
  interface Window {
    __DSH_MODEL_CONFIG_REGISTRY__?: ModelConfigRegistry
    __DSH_MODEL_CONFIG_PENDING__?: ModelConfigCard[]
  }
}

register({
  id: 'my-plugin-id',
  title: '我的模型设置',
  description: '可选说明',
  order: 100,
  render: () => <MySettingsCard />,
})
```

没有类型依赖：注册表挂在 `window.__DSH_MODEL_CONFIG_REGISTRY__`；如果本插件尚未加载，卡片会先进入 `window.__DSH_MODEL_CONFIG_PENDING__`，页签加载后自动收编。加载顺序无关。

## 构建

```bash
pnpm install
pnpm run build
```

## 安装

将本插件加入 profile 的 cordis patch 层，重启 `dsh web` 并刷新页面。
