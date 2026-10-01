# Contributing

感谢对这个插件的兴趣!

## 开发环境

需要 Node.js ≥ 22.19、**.NET 8 SDK**(构建 WebView2 宿主)与 Windows。

```sh
npm install
npm run build          # 图标 + WebView2 宿主 + TypeScript
npm test
npm run smoke:webview2-host   # 打开真实 WebView2 窗口的端到端冒烟
```

## 约定

- TDD:先写失败测试(`test/provider-actions.test.mjs` 用 FakeHost 断言 CDP 调用序列;`host-composition.test.mjs` 为源码断言,保护 host 线序)。
- **铁律**:
  1. 永不重挂可见页面视图:切换任务只切 WebView2 控件的 `Visible`,不做 remove/add。
  2. 页面 chrome 留在页面内(closed Shadow DOM);不得变成第二个原生视图。
  3. 每个 `CoreWebView2` 调用都必须从 WinForms UI 线程发起(线程亲和性)。
  4. 快照/填充/内容脚本必须过滤 `closest('[data-dsh-browser-chrome]')`。
  5. 宿主 RPC 的每个 op 都要在 `RpcServer.cs` 与 `remote-host.ts` 两侧同时更新。
- 提交信息风格:`feat/fix|test(scoped): ...`,每个任务独立提交。

## 运行时验证

改动 `host/*.cs` 后需要 `npm run build:host` 并重启宿主进程;改动
`page-chrome.ts` 后宿主会在下次导航重放新脚本;改动 provider/remote/tool 层后需
重启 DSH(见 `docs/SOAK-CHECKLIST.md`)。

## 发布

`package.json` 声明 `dsh.bundle.patch`(已就绪);发布 = 打 tag + `npm pack` + `gh release create`。
