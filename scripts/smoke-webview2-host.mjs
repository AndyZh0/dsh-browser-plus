/**
 * Live WebView2 host smoke test.
 *
 * Spawns the real .NET host through the same RemoteElectronViewHost the plugin
 * uses, then exercises the full RPC contract against the machine's WebView2
 * Runtime: create a view, navigate, evaluate, run CDP, capture a screenshot,
 * and round-trip cookies. Run it after "npm run build":
 *
 *   npm run smoke:webview2-host
 *
 * It opens a real window, so it is a manual/CI-on-Windows check rather than
 * part of the unit suite.
 */

import assert from 'node:assert/strict'

import { RemoteElectronViewHost, defaultHostMainPath } from '../lib/browser-electron/remote-host.js'

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + ' timed out after ' + String(timeoutMs) + 'ms')), timeoutMs)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

const host = new RemoteElectronViewHost(defaultHostMainPath())
try {
  const view = host.createView('webview2-smoke', 'WebView2 Smoke')

  // The window must be VISIBLE, not merely created. A host spawned with
  // SW_HIDE answers every CDP command and renders the page while the human sees
  // nothing, so no page-level assertion can catch it — only the OS can.
  const windowState = await withTimeout(host.windowState(), 10_000, 'windowState')
  assert.equal(windowState.visible, true, 'the shared browser window is on screen')
  assert.ok(windowState.handle !== 0, 'the window has an OS handle')
  const url = 'data:text/html,<title>smoke</title><h1 id=h>hello webview2</h1><input id=i value=seed>'

  const navigation = await withTimeout(
    view.sendCommand('Page.navigate', { url }),
    20_000,
    'Page.navigate',
  )
  assert.ok(navigation !== undefined, 'Page.navigate resolves through the host CDP bridge')

  // Wait for the document to commit, then read it back.
  const title = await withTimeout(view.sendCommand('Runtime.evaluate', {
    expression: 'document.title',
    returnByValue: true,
  }), 10_000, 'Runtime.evaluate')
  assert.equal(title.result?.value, 'smoke', 'the page is live in the WebView2 control')

  const heading = await withTimeout(view.sendCommand('Runtime.evaluate', {
    expression: "document.getElementById('h').textContent",
    returnByValue: true,
  }), 10_000, 'Runtime.evaluate heading')
  assert.equal(heading.result?.value, 'hello webview2')

  // Real CDP domains through the CoreWebView2 bridge.
  const doc = await withTimeout(view.sendCommand('DOM.getDocument', {}), 10_000, 'DOM.getDocument')
  assert.ok(doc.root, 'DOM.getDocument returns a document root')

  const shot = await withTimeout(view.capture(), 20_000, 'capture')
  assert.ok(typeof shot.base64 === 'string' && shot.base64.length > 100, 'capture returns PNG data')

  const cookies = await withTimeout(view.flushAuth(), 10_000, 'flushAuth')
  assert.ok(Array.isArray(cookies), 'flushAuth returns an array')

  // The task label travels through the shared-window state.
  await withTimeout(view.label('WebView2 Smoke Renamed'), 10_000, 'label')
  const tasks = await withTimeout(host.listTasks(), 10_000, 'listTasks')
  assert.ok(tasks.some(task => task.key === 'webview2-smoke'), 'the task is listed')

  console.log(JSON.stringify({
    ok: true,
    url: title.result?.value,
    screenshotBytes: Math.round(shot.base64.length * 3 / 4),
    tasks: tasks.length,
  }))
} finally {
  host.dispose()
}
