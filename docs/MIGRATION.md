# 迁移到 dsh-browser-plus

> 如果你的 DSH profile 仍装着旧版浏览器插件（package name 为 `dsh-builtin-browser`），按本指南切换到 `dsh-browser-plus` 并迁移登录态。

## 步骤

### 1. 导出当前浏览器登录态(可选但推荐)

在旧包仍生效的 DSH 会话中:

```
browser_auth action="flush"      # 把返回的 cookies JSON 保存到文件
```

### 2. 安装新包(正式名 dsh-browser-plus)

```sh
# 从 GitHub 安装(推荐;或使用 release tarball 或源码目录)
dsh plugin --profile web add github:ParticleLight/dsh-browser-plus
```

### 3. 移除已替换的旧包(可选)

```sh
dsh plugin --profile web remove dsh-builtin-browser   # 如实际安装名如此
```

### 4. 恢复登录态

新包会话中:

```
browser_auth action="restore" cookies=<步骤1保存的JSON>
```

> 说明:宿主 userData 目录已从 `dsh-builtin-browser-host` 改为 `dsh-browser-plus-host`
> (host-main.ts `app.setPath('userData', ...)`),因此 cookie 不会自动迁移,必须走一遍 export/import。

## DSH 0.2.0 运行时要求

v0.5.0 起，插件面向 DeepSeek Harness 0.2.0 运行时线构建：

| 包 | 版本 |
| --- | --- |
| `@deepseek-ai/cordis` | 4.0.4 |
| `@deepseek-ai/dsh-tools` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-llm` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-system-prompt` | 0.2.0-rc.2 |
| `@deepseek-ai/schemastery` | 3.18.4 |

- 0.1.x 运行时不再受支持；请先升级 DSH 桌面端 / Web 到 0.2.0。
- 插件**不**依赖 0.2.0 新增的 `projectContent` 或 `ctx.ptcRuntime`；它只使用
  自有的 `ctx.browser` seam 以及 `ctx.tools`、`ctx.systemPrompt` 注册面，
  因此从 0.1.x 升级无需改动插件配置。
- 0.2.0 桌面 shell 未提供 `electronViewHost` 服务，`cordis.patch.yml` 中的
  `viewHost` 仍解析为 `undefined`，插件按设计自托管 Electron 子进程
  （`host-main.js` + 本地 RPC）。这与 0.1.x 行为一致。
- 回归保护：`test/dsh-0.2.0-composition.test.mjs` 在真实 cordis 上下文里加载
  0.2.0 服务并断言 35 个 `browser_*` 工具与系统提示段的注册结果。升级框架前
  先跑 `npm test`。

## 变更对使用者可见的部分

- 当前共 35 个 `browser_*` 工具；除输入、文件和任务工具外，新增语义导航、滚动、快照引用、任务状态与显式人机交接。
- **一个共享可见浏览器窗口**，每个 DSH 任务保持隔离视图、标签与历史；页面任务管理器切换任务，后台任务操作不会抢走当前页面。`browser_space label="..."` 命名浏览器任务，空参列出任务。
- JS 对话框自动 accept,记录见 `browser_history`(action `dialog`)。
- Electron 锁定 **42.9.3**(43.4.1 组合器故障,勿升)。

## 重启要求

迁移 profile bundle 后请**重启 DSH Web**，确保旧 loader entry 完整卸载、新包以 `dsh-browser-plus` 身份加载（见 `docs/SOAK-CHECKLIST.md`）。
