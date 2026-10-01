# dsh-browser-plus

> A visible browser runtime for DeepSeek Harness. Humans and agents operate the same real page, not a headless replay or screenshot proxy.

dsh-browser-plus is developed on top of the MIT-licensed `dsh-browser` codebase and independently maintained by ParticleLight.

[![GitHub stars](https://img.shields.io/github/stars/ParticleLight/dsh-browser-plus?style=flat&label=stars)](https://github.com/ParticleLight/dsh-browser-plus)

## Why it exists

Browser automation should not disappear into a process the user cannot inspect. dsh-browser-plus keeps the browser window visible while giving agents reliable CDP control.

- **Visible by default**: a real native Microsoft Edge **WebView2** window, not a headless relay.
- **Task isolation**: all DSH sessions share one visible window while keeping isolated task views, tabs, and history; the page task manager switches the visible view, and `browser_space` names browser tasks.
- **Human handoff**: page chrome, bookmarks, the task workspace, operation trail, and user activity detection live on the real page; a user can take control of the active task and explicitly return it to the agent.
- **Glass workspace**: task and operation trail are independent translucent glass panels that can stay open together. Each task exposes running, waiting-user, human-control, failed, or idle state. Thumbnails refresh on demand only while the task panel is open; background tasks retain their last image.

![dsh-browser-plus task workspace](assets/readme-glass-workspace.png)

- **Physical input**: keyboard, mouse, hover, double-click, and file selection use CDP instead of synthetic `element.click()` events.
- **Recovery-aware**: a recycled child re-materializes the same session view; the first recovered capture waits for compositor readiness.
- **Stable baseline**: the host is a standalone .NET 8 WebView2 process, decoupled from the DSH desktop app's Electron version; captures go through CDP rather than an Electron compositor.

## Install

Requires **DeepSeek Harness 0.2.0** (runtime line `@deepseek-ai/dsh-tools` 0.2.0-rc.2,
`@deepseek-ai/cordis` 4.0.4); 0.1.x is not supported.

The host embeds **Microsoft Edge WebView2**, so it is **Windows-only** (Evergreen
WebView2 Runtime plus the .NET 8 desktop runtime, or a self-contained build).

```sh
dsh plugin --profile web add github:ParticleLight/dsh-browser-plus
```

If another browser bundle is already installed, read the [migration guide](docs/MIGRATION.md), then restart DSH Web.

## Main capabilities

| Scenario | Tools |
| --- | --- |
| Open and inspect | `browser_open`, `browser_snapshot`, `browser_content`, `browser_screenshot` |
| Native navigation | `browser_back`, `browser_forward`, `browser_reload`, `browser_stop`, `browser_scroll` |
| Snapshot references | `browser_click_ref`, `browser_scroll_into_view` |
| Page interaction | `browser_click`, `browser_press_key`, `browser_double_click`, `browser_hover`, `browser_type` |
| Forms and files | `browser_fill`, `browser_upload_file`, `browser_wait_for` |
| Tasks and handoff | `browser_tasks`, `browser_handoff`, `browser_list_tabs`, `browser_switch_tab`, `browser_close_tab`, `browser_space` |
| Auth and recovery | `browser_auth`, `browser_reset_session`, `browser_history` |

Snapshots expose a short-lived `snapshotId` plus element references. Prefer reference tools and take a fresh snapshot after the page changes; page-level scripts automatically ignore the browser's own chrome.

## How it works

```text
browser_* tools
  -> BrowserRuntime (ctx.browser seam)
  -> ElectronBrowserProvider (CDP)
  -> RemoteElectronViewHost (loopback JSON-RPC)
  -> dsh-browser-plus-host.exe (WinForms + WebView2)
```

The chrome and task manager are injected through a closed Shadow DOM rather than a second native view. Versioned incremental workspace updates keep task and trail rendering light while background task updates stay isolated and do not steal the user's visible page. Each task's page lives in its own `WebView2` control; switching tasks only toggles visibility.

`alert`, `confirm`, and `prompt` are auto-accepted so pages do not block. The next page operation records the detail as a `dialog` item in `browser_history`.

## Reliability rules

1. Never reparent a visible page view: switching tasks toggles `Visible` and nothing else.
2. Every `CoreWebView2` call starts on the UI thread (WebView2 is thread-affine).
3. A recovered host waits once for compositor readiness before capturing.
4. Dialogs, captures, dynamic waits, and host recovery have regression tests and live smoke coverage.

See [SOAK-CHECKLIST](docs/SOAK-CHECKLIST.md) for the complete runtime verification list.

## Development

```sh
npm install
npm run build
npm test
npm run build:host          # build the C# / WebView2 host (needs the .NET 8 SDK)
npm run smoke:webview2-host # opens a real WebView2 window; validates navigation, CDP, capture, cookies
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution rules and [docs](docs/README.md) for the full documentation set.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE.md).
