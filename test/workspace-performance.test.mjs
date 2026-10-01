import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

// Workspace state and thumbnails moved with the page chrome: the parent owns
// the versioned bootstrap/patch vocabulary (chrome-state.ts) and the host only
// replays the script it was configured with.
const hostBrowserPath = new URL('../host/BrowserHost.cs', import.meta.url)
const chromeStatePath = new URL('../src/browser-electron/chrome-state.ts', import.meta.url)
const chromePath = new URL('../src/browser-electron/page-chrome.ts', import.meta.url)
const remotePath = new URL('../src/browser-electron/remote-host.ts', import.meta.url)

test('chrome state keeps the versioned bootstrap and patch vocabulary', async () => {
  const source = await readFile(chromeStatePath, 'utf8')
  assert.match(source, /export function createBootstrap/)
  assert.match(source, /export function createPatch/)
  assert.match(source, /epoch/)
  assert.match(source, /revision/)
  assert.match(source, /ChromePatchOperation/)
})

test('the host replays parent-owned chrome instead of rebuilding workspace state', async () => {
  const source = await readFile(hostBrowserPath, 'utf8')
  // The host holds only the script and a visibility flag; task/trail state is
  // parent-owned and arrives as replayed scripts.
  assert.match(source, /private string _chromeScript = ""/)
  assert.match(source, /internal Task ConfigureAsync/)
  assert.match(source, /internal Task EvalAsync/)
  assert.match(source, /core\.NavigationCompleted \+= \(_, _\) =>/)
  assert.match(source, /InstallChrome\(viewId\)/)
  assert.doesNotMatch(source, /taskThumbnails/, 'thumbnail capture is not host-owned')
})

test('thumbnail encoding stays bounded by the shared budget', async () => {
  const thumbnails = await import('../lib/browser-electron/task-thumbnail.js')
  assert.equal(thumbnails.TASK_THUMBNAIL_WIDTH, 288)
  assert.equal(thumbnails.TASK_THUMBNAIL_JPEG_QUALITY, 58)
  assert.equal(thumbnails.MAX_TASK_THUMBNAIL_BYTES, 180 * 1024)
})

test('remote child RPC has bounded queries and timeout-driven recovery', async () => {
  const source = await readFile(remotePath, 'utf8')
  assert.match(source, /RPC_QUERY_TIMEOUT_MS = 8_000/)
  assert.match(source, /RPC_COMMAND_TIMEOUT_MS = 35_000/)
  assert.match(source, /RPC_TRANSFER_TIMEOUT_MS = 120_000/)
  assert.match(source, /this\.pending\.delete\(id\)/)
  assert.match(source, /this\.fail\(error\)/)
  assert.match(source, /this\.child\.kill\(\)/)
  assert.match(source, /listTasks', {}, RPC_QUERY_TIMEOUT_MS/)
  assert.match(source, /getTask', { key }, RPC_QUERY_TIMEOUT_MS/)
})

test('page chrome applies patches without rebuilding all task and trail state', async () => {
  const source = await readFile(chromePath, 'utf8')
  assert.match(source, /window\.__dshChromeApply = applyChromeMessage/)
  assert.match(source, /patchTaskRow/)
  assert.match(source, /appendTrailEntry/)
  assert.match(source, /taskPatches/)
  assert.match(source, /trailAppends/)
  assert.match(source, /window\.__dshChromeSetActive/)
  assert.match(source, /stopChromeTimers/)
  assert.match(source, /startChromeTimers/)
})
