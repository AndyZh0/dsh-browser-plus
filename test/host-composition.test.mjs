import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// The host moved from Electron (lib/browser-electron/host-main.js) to a .NET
// WinForms WebView2 process (host/*.cs). The wire order and the shared-window
// invariants are the same; these assertions now read the C# sources.
const hostSources = {
  browser: new URL('../host/BrowserHost.cs', import.meta.url),
  rpc: new URL('../host/RpcServer.cs', import.meta.url),
  cookies: new URL('../host/CookieAuth.cs', import.meta.url),
  program: new URL('../host/Program.cs', import.meta.url),
}
const providerPath = new URL('../lib/browser-electron/provider.js', import.meta.url)
const providerSourcePath = new URL('../src/browser-electron/provider.ts', import.meta.url)
const remotePath = new URL('../lib/browser-electron/remote-host.js', import.meta.url)
const runtimePath = new URL('../lib/browser/runtime.js', import.meta.url)
const typesPath = new URL('../lib/browser/types.d.ts', import.meta.url)

const readHost = (key) => readFile(hostSources[key], 'utf8')

test('showView changes visibility without reparenting a page view', async () => {
  const source = await readHost('browser')
  const start = source.indexOf('internal Task ShowViewAsync')
  const end = source.indexOf('/// <summary>Set a task', start)
  assert.ok(start >= 0 && end > start, 'ShowViewAsync exists')
  const block = source.slice(start, end)
  assert.match(block, /SyncVisibility\(\)/)
  // Visibility is a property toggle on a persistent control; a view is never
  // re-added to a different parent.
  const sync = source.slice(source.indexOf('private void SyncVisibility'), source.indexOf('// ------------------------------------------------------------- commands'))
  assert.match(sync, /entry\.Control\.Visible = active/)
  assert.doesNotMatch(sync, /Controls\.Remove/)
})

test('host creates the page surface through the WebView2 controller', async () => {
  const source = await readHost('browser')
  assert.match(source, /EnsureCoreWebView2Async\(_environment\)/)
  assert.match(source, /new WebView2 \{ Dock = DockStyle\.None, Visible = false \}/)
  assert.match(source, /AddScriptToExecuteOnDocumentCreatedAsync\(BindingScript\(\)\)/)
})

test('snapshots expose user-control state', async () => {
  const source = await readFile(providerPath, 'utf8')
  assert.match(source, /userControlling/)
  assert.match(source, /data-dsh-user-active/)
})

test('host keeps popup navigation inside the shared view', async () => {
  const source = await readHost('browser')
  assert.match(source, /NewWindowRequested/)
  assert.match(source, /e\.Handled = true/)
  assert.match(source, /UriSchemeHttp/)
  assert.match(source, /UriSchemeHttps/)
})

test('host records trace ops', async () => {
  const source = await readHost('browser')
  assert.match(source, /internal void AppendTrace/)
  assert.match(source, /MaxTraceEntries = 500/)
  const rpc = await readHost('rpc')
  assert.match(rpc, /case "trace"/)
})

test('provider forwards each record as a host trace', async () => {
  const source = await readFile(providerPath, 'utf8')
  assert.match(source, /host\.trace/)
})

test('remote host forwards trace to the child', async () => {
  const source = await readFile(remotePath, 'utf8')
  assert.match(source, /call\('trace'/)
})

test('model-facing snapshots ignore injected chrome controls', async () => {
  const source = await readFile(providerPath, 'utf8')
  assert.match(source, /data-dsh-browser-chrome/)
  assert.match(source, /closest\(/)
})

test('provider re-injects chrome after every navigation', async () => {
  const source = await readFile(providerPath, 'utf8')
  assert.match(source, /PAGE_CHROME_SCRIPT/)
  assert.match(source, /reinstallPageChrome\(handle\)/)
})

test('provider retains document-ready waiting and SPA empty-snapshot retry', async () => {
  const source = await readFile(providerPath, 'utf8')
  assert.match(source, /waitForDocumentReady/)
  assert.match(source, /attempt < 5/)
  assert.match(source, /readiness wait exceeded/)
})

test('host auto-accepts JS dialogs and exposes drainDialog', async () => {
  const source = await readHost('browser')
  // WebView2 surfaces the dialog natively, so no CDP Page.enable is needed.
  assert.match(source, /ScriptDialogOpening/)
  assert.match(source, /e\.Accept\(\)/)
  assert.match(source, /entry\.DialogLog = new JsonObject/)
  assert.match(source, /internal JsonNode\? DrainDialog/)
  const rpc = await readHost('rpc')
  assert.match(rpc, /case "drainDialog"/)
})

test('provider drains auto-accepted dialogs into history', async () => {
  const source = await readFile(providerPath, 'utf8')
  assert.match(source, /clearDialog/)
  assert.match(source, /this\.record\(s, 'dialog'/)
})

test('snapshots emit a targeted locator per element', async () => {
  const source = await readFile(providerSourcePath, 'utf8')
  assert.match(source, /const locatorOf = /)
  assert.match(source, /CSS\.escape/)
  assert.match(source, /\[aria-label=|\(aria-label\)/)
  assert.match(source, /loc: locatorOf\(el\)/)
})

test('host uses one shared window with task-keyed views', async () => {
  const source = await readHost('browser')
  assert.match(source, /private readonly Form _form/)
  assert.match(source, /_views\[viewId\] = entry/)
  assert.match(source, /internal required string TaskKey/)
  assert.match(source, /_taskLabels/)
  assert.match(source, /_activeViewByTask/)
  assert.match(source, /_visibleTaskKey/)
  assert.doesNotMatch(source, /windowsByKey/, 'per-task native windows are gone')
})

test('switchVisibleTask changes visibility without reparenting views', async () => {
  const source = await readHost('browser')
  const start = source.indexOf('private void SyncVisibility')
  assert.ok(start >= 0, 'SyncVisibility exists')
  const block = source.slice(start, start + 1200)
  assert.match(block, /entry\.Control\.Visible = active/)
  assert.match(block, /entry\.Control\.BringToFront\(\)/)
  assert.doesNotMatch(block, /Controls\.Remove/)
  assert.doesNotMatch(block, /Controls\.Add/)
})

test('provider opens with a window key and label through the host seam', async () => {
  const source = await readFile(providerSourcePath, 'utf8')
  assert.match(source, /const taskKey = options\?\.key \?\? 'default'/)
  assert.match(source, /createView\(taskKey, taskLabel/)
})

test('capture goes through the CDP screenshot path', async () => {
  const source = await readHost('browser')
  const start = source.indexOf('internal Task<JsonObject> CaptureAsync')
  const end = source.indexOf('/// <summary>', start)
  assert.ok(start >= 0 && end > start, 'CaptureAsync exists')
  const block = source.slice(start, end)
  // WebView2 has no native capturePage, so CDP is the only path.
  assert.match(block, /CallDevToolsProtocolMethodAsync\("Page\.captureScreenshot"/)
  assert.match(block, /capture produced no image/)
})

test('hidden task showView keeps the user-selected task visible', async () => {
  const source = await readHost('browser')
  const start = source.indexOf('internal Task ShowViewAsync')
  const end = source.indexOf('/// <summary>Set a task', start)
  const block = source.slice(start, end)
  assert.match(block, /_activeViewByTask\[entry\.TaskKey\] = viewId/)
  assert.match(block, /_visibleTaskKey \?\?= entry\.TaskKey/)
})

test('remote host forwards createView key/label and window ops', async () => {
  const source = await readFile(remotePath, 'utf8')
  assert.match(source, /call\('createView'/)
  assert.match(source, /\.\.\.key !== undefined/)
  assert.match(source, /call\('label'/)
  assert.match(source, /call\('listWindows'/)
})

test('recovered remote views settle the compositor before capture operations', async () => {
  const source = await readFile(remotePath, 'utf8')
  assert.match(source, /RECOVERY_CAPTURE_SETTLE_MS = 3_000/)
  assert.match(source, /recoveryCompositorSettle/)
  assert.match(source, /settleRecoveredCompositorForCapture/)
  const captureStart = source.indexOf('async capture()')
  const captureEnd = source.indexOf('async flushAuth()', captureStart)
  assert.ok(captureStart >= 0 && captureEnd > captureStart, 'capture method exists')
  assert.match(source.slice(captureStart, captureEnd), /settleRecoveredCompositorForCapture/)
  const deferredStart = source.indexOf('class DeferredRemoteView')
  const commandStart = source.indexOf('async sendCommand(', deferredStart)
  const commandEnd = source.indexOf('async download(', commandStart)
  assert.ok(commandStart >= 0 && commandEnd > commandStart, 'sendCommand method exists')
  const commandBlock = source.slice(commandStart, commandEnd)
  assert.match(commandBlock, /method === 'Page\.captureScreenshot'/)
  assert.match(commandBlock, /settleRecoveredCompositorForCapture/)
})

test('host installs the page task binding before any document runs', async () => {
  const source = await readHost('browser')
  assert.match(source, /BindingScript\(\)/)
  assert.match(source, /__dshBrowserTaskAction/)
  assert.match(source, /chrome\.webview\.postMessage/)
  // The binding must be registered as a document-created script, not injected
  // after the fact, so it exists before page scripts run.
  assert.match(source, /AddScriptToExecuteOnDocumentCreatedAsync\(BindingScript\(\)\)/)
})

test('host pushes safe task state and redacts summary URLs', async () => {
  const source = await readHost('browser')
  assert.match(source, /private JsonObject\? Summarize/)
  assert.match(source, /TaskSummaryUrl/)
  const start = source.indexOf('private JsonObject? Summarize')
  const end = source.indexOf('private static string SafeUrl', start)
  assert.ok(start >= 0 && end > start, 'summary block exists')
  assert.match(source.slice(start, end), /\["url"\] = TaskSummaryUrl\(/)
  // Only origin is exposed; a full path/query never reaches the page.
  const urlStart = source.indexOf('internal static string TaskSummaryUrl')
  const urlBlock = source.slice(urlStart, urlStart + 500)
  assert.match(urlBlock, /GetLeftPart\(UriPartial\.Authority\)/)
})

test('host replays the parent-owned chrome on every committed navigation', async () => {
  const source = await readHost('browser')
  // The handler caches the committed URL and replays the chrome.
  assert.match(source, /core\.NavigationCompleted \+= \(_, _\) =>/)
  assert.match(source, /entry\.Url = SafeUrl\(core\)/)
  assert.match(source, /InstallChrome\(viewId\)/)
  assert.match(source, /internal Task ConfigureAsync/)
  assert.match(source, /window\.__dshChromeSetActive/)
  const rpc = await readHost('rpc')
  assert.match(rpc, /case "configure"/)
  assert.match(rpc, /case "eval"/)
})

test('host applies the configured chrome only when the parent supplied one', async () => {
  const source = await readHost('browser')
  const start = source.indexOf('private async Task InstallChromeAsync')
  assert.ok(start >= 0, 'InstallChromeAsync exists')
  const block = source.slice(start, start + 700)
  assert.match(block, /if \(_chromeScript\.Length == 0\) return/)
})

test('host clears view state when the shared window closes', async () => {
  const source = await readHost('browser')
  const start = source.indexOf('_form.FormClosed')
  assert.ok(start >= 0, 'FormClosed handler exists')
  const block = source.slice(start, start + 600)
  assert.match(block, /_views\.Clear\(\)/)
  assert.match(block, /_visibleTaskKey = null/)
})

test('browser_space is documented as a task label, not a separate window', async () => {
  const source = await readFile(new URL('../lib/tool-browser/index.js', import.meta.url), 'utf8')
  assert.match(source, /Name this browser task/)
  assert.doesNotMatch(source, /Each task gets its own window/)
})

test('legacy listWindows compatibility is documented as browser tasks', async () => {
  const [providerSource, remote, runtime, types] = await Promise.all([
    readFile(providerSourcePath, 'utf8'),
    readFile(remotePath, 'utf8'),
    readFile(runtimePath, 'utf8'),
    readFile(typesPath, 'utf8'),
  ])
  assert.match(providerSource, /List browser tasks/)
  assert.match(remote, /List browser task keys/)
  assert.match(runtime, /browser task label/)
  assert.match(types, /browser task label/)
  assert.doesNotMatch(providerSource, /List open windows/)
  assert.doesNotMatch(remote, /List all open window keys/)
})

test('deferred views retain the latest task label for child recovery', async () => {
  const source = await readFile(remotePath, 'utf8')
  assert.match(source, /taskLabel;/)
  assert.match(source, /this\.materialize\(this\.taskLabel\)/)
  assert.match(source, /this\.taskLabel = label/)
  assert.match(source, /this\.withView\(view => view\.label\(label\)\)/)
})

test('cookie clear refuses an unscoped wipe in the host', async () => {
  const source = await readHost('cookies')
  assert.match(source, /SelectForClear/)
  assert.match(source, /pass all: true to remove every cookie/)
  assert.match(source, /MatchesDomain/)
})

test('host exports and restores cookies through the WebView2 cookie manager', async () => {
  const source = await readHost('browser')
  assert.match(source, /CookieManager\.GetCookiesAsync/)
  assert.match(source, /CookieAuth\.Export/)
  assert.match(source, /CookieAuth\.RestoreOne/)
  const rpc = await readHost('rpc')
  assert.match(rpc, /case "flushAuth"/)
  assert.match(rpc, /case "restoreAuth"/)
  assert.match(rpc, /case "clearCookies"/)
})

test('host speaks the same line-delimited JSON-RPC contract', async () => {
  const source = await readHost('rpc')
  // Every op the parent's RemoteElectronViewHost sends must be handled.
  for (const op of ['ping', 'createView', 'destroyView', 'showView', 'label', 'trace',
    'drainDialog', 'command', 'capture', 'download', 'flushAuth', 'restoreAuth',
    'clearCookies', 'listWindows', 'listTasks', 'getTask', 'updateTask', 'configure', 'eval', 'windowState']) {
    assert.match(source, new RegExp('case "' + op + '"'), 'handles op ' + op)
  }
  assert.match(source, /ReadLineAsync/)
  assert.match(source, /WriteLineAsync/)
  // A closed socket must end the process so no window outlives the parent.
  assert.match(source, /parent connection closed, exiting/)
  const program = await readHost('program')
  assert.match(program, /--rpc-port/)
  assert.match(program, /host\.CloseWindow\(\)/)
})

test('host forces its window on screen after Form.Show()', async () => {
  const source = await readHost('browser')
  // Defence in depth for the SW_HIDE trap: the host must not depend on the
  // spawner getting windowsHide right. Form.Show()'s ShowWindow is the one the
  // spawner's SW_HIDE overrides, so an explicit ShowWindow must follow it.
  const showIndex = source.indexOf('_form.Show();')
  const forceIndex = source.indexOf('ShowWindow(_form.Handle, SwShowNormal)')
  assert.ok(showIndex >= 0, 'the form is shown')
  assert.ok(forceIndex > showIndex, 'the window is forced visible AFTER Show()')
  assert.match(source, /SetForegroundWindow\(_form\.Handle\)/)
  assert.match(source, /IsWindowVisible\(/)
})

test('host reports whether its window is actually on screen', async () => {
  const source = await readHost('browser')
  assert.match(source, /internal Task<JsonObject> WindowStateAsync\(\)/)
  assert.match(source, /\["visible"\] = handle != IntPtr\.Zero && IsWindowVisible\(handle\)/)
  const rpc = await readHost('rpc')
  assert.match(rpc, /case "windowState"/)
})

test('host isolates its profile from the DSH app data directory', async () => {
  const source = await readHost('browser')
  assert.match(source, /DSH_HOME/)
  assert.match(source, /dsh-browser-plus-host/)
})
