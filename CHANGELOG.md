# Changelog

## v0.6.1 (2026-10-01)

- **修复:浏览器窗口不可见(页面隐形)**。父进程用 `windowsHide: true` 启动宿主,
  该标志会给子进程设置 `STARTF_USESHOWWINDOW` + `SW_HIDE`;Windows 把它套用到
  **第一次 `ShowWindow`** 调用(即 `Form.Show()`),于是窗口被创建、页面正常渲染、
  CDP 全部可用,但人眼完全看不到——任何页面级断言都发现不了。
  - 父进程改为 `windowsHide: false`,并导出 `HOST_SPAWN_OPTIONS` 供测试锁定。
  - 宿主侧加固:`Form.Show()` 之后显式 `ShowWindow(SW_SHOWNORMAL)` +
    `SetForegroundWindow`,不依赖调用方传对标志。
  - 新增 `windowState` RPC(返回 `visible`/`handle`/`title`),由
    `npm run smoke:webview2-host` 断言窗口真的在屏幕上。
  - 新增回归测试:`the GUI host is spawned without SW_HIDE` 与宿主侧
    `ShowWindow` 顺序断言。

## v0.6.0 (2026-10-01)

- **Electron → WebView2**: 宿主从 Electron 子进程改为 **C# / .NET 8 WinForms
  WebView2 宿主**(\`host/\`)。共享窗口、任务视图隔离、页面 chrome、cookie、
  下载与 CDP 全部保留；父进程侧 \`ElectronBrowserViewHost\` 接缝不变,因此
  provider 与 35 个 \`browser_*\` 工具无需改动。
- **CDP 通道**: Electron 的 \`webContents.debugger\` 换成
  \`CoreWebView2.CallDevToolsProtocolMethodAsync\`;父进程仍通过同一套
  行分隔 JSON-RPC 驱动宿主。
- **截图路径**: WebView2 没有原生 \`capturePage\`,截图统一走 CDP
  \`Page.captureScreenshot\`(父进程保留恢复后的合成器等待)。
- **平台**: WebView2 为 Windows 独占,插件不再是跨平台;非 Windows 平台在
  解析宿主时给出明确错误而不是 spawn ENOENT。
- **移除 Electron**: 删除 \`host-main.ts\`、\`electron\` optional dependency 与
  electron 类型 shim;\`npm run build:host\` 构建宿主,发行包内含
  \`host/bin/Release/net8.0-windows\`。
- **新增实时冒烟测试**: \`npm run smoke:webview2-host\` 通过真实宿主验证
  导航、\`Runtime.evaluate\`、\`DOM.getDocument\`、截图与 cookie。

## v0.5.0 (2026-10-01)

- **DSH 0.2.0 运行时**: peer 依赖迁移到 DeepSeek Harness 0.2.0 运行时线
  (`@deepseek-ai/dsh-tools` / `dsh-llm` / `dsh-system-prompt` 0.2.0-rc.2、
  `@deepseek-ai/cordis` 4.0.4、`@deepseek-ai/schemastery` 3.18.4)；旧的
  0.1.x 运行时不再受支持。
- **真实组合回归测试**: 新增 `test/dsh-0.2.0-composition.test.mjs`，在真实
  cordis 上下文里加载 0.2.0 的 `ToolRuntime`/`SystemPrompt` 服务并挂载插件的
  三层，断言 35 个 `browser_*` 工具的注册顺序、模型可见 schema 与
  `tool:browser` 系统提示段。此前所有测试都伪造 `ctx`，框架 API 变化只在
  生产暴露。
- **无 API 变更**: 插件只使用 `ctx.browser` 自有 seam 与 `ctx.tools` /
  `ctx.systemPrompt` 注册面；0.2.0 的 `projectContent` 与 `ctx.ptcRuntime`
  是新增/框架内部变化，插件不受影响。

## v0.4.2 (2026-09-17)

- **按站点清理 Cookie**: `browser_auth action="clear"` 支持按 `domain`(含子域)与/或 `name` 精确删除 Cookie;未限定范围时必须显式 `all: true`,避免误清全部登录态。用于清理 WAF 轮换名称留下的旧代挑战 Cookie。

## v0.4.1 (2026-08-26)

- **多标签会话恢复**: keyed browser sessions are recovered when the tool-layer session cache is lost, so the first direct switch or close operation still targets the existing tabs.

## v0.4.0 (2026-08-26)

- **显式人机交接**: 任务卡显示运行、等待用户、用户接管、失败和空闲状态；用户可在页面中接管/交还任务，`browser_tasks` 与 `browser_handoff` 暴露同一状态。
- **语义浏览控制**: 新增后退、前进、刷新、停止、滚动，以及由 `snapshotId` 和元素 ref 驱动的精确点击/滚动到元素工具。
- **轻量工作区同步**: Host 改为 bootstrap + versioned patch；常规操作只更新一张任务卡和一条轨迹。
- **资源预算**: 任务缩略图仅在任务面板打开时按需单飞捕获，带 2 秒节流和 32 项缓存；后台页面停止地址栏和用户活动轮询。
- **低干扰工具栏**: 工具栏默认隐入页面上方，顶部中间悬停出现圆形下箭头；展开后最右侧上箭头可收起工具栏及其关联浮层。

## v0.3.1 (2026-08-23)

- **单窗口任务管理器**: 所有 DSH 任务共享一个可见浏览器窗口，同时保留隔离的任务视图、标签和历史；页面任务管理器切换可见任务，后台任务操作不会抢走当前页面。
- **任务标签**: `browser_space` 命名或列出浏览器任务，不再表示原生窗口；任务标签显示在任务管理器和活动窗口标题。
- **可视工作区**: 任务与操作轨迹可同时打开，切换任务同步轨迹，并显示可见页面的实时缩略图。
- **Browser Flow 图标**: 新增 SVG 主源、PNG/ICO 衍生资源及 Electron 窗口图标接入。

## v0.3.0 (2026-08-21)

Ego 级功能集:

- **JS 对话框**:宿主自动 accept(页面永不卡死),草案以 `drainDialog` 读回并写入 `browser_history`(`dialog` 记录)。
- **输入工具**:`browser_press_key`(CDP keyDown/keyUp,修饰键位掩码)、`browser_double_click`(clickCount 2)、`browser_hover`(mouseMoved)、`browser_upload_file`(DOM.setFileInputFiles 真实文件选择)。
- **等待与定位**:`browser_wait_for`(250ms 有界轮询,`BROWSER_WAIT_TIMEOUT`);快照每个元素输出 `loc=`(id/name/aria-label/text 定位链)。
- **每任务窗口**:每个 DSH 任务一个独立 `BrowserWindow`(createView key);`browser_space` 命名窗口标题并列出全部窗口。
- **稳定性**:Electron 锁定 42.9.3(43.4.1 组合器故障);capture CDP 回退仅 detach 同窗口视图;截断/挂起防护(per-poll 超时)。
- **质量**:32/32 测试(FakeHost 行为测试 12 条 + 源码断言/页面 chrome 断言);SDD 全流程评审(每任务 implement->review->fix 循环 + 整支 final review)。

## v0.2.0 (2026-08-21)

首版 `dsh-browser-plus`:共享可见浏览器、ego 风格页面内工具栏、操作轨迹(trail)面板、用户控制检测、稳定单视图合成。
