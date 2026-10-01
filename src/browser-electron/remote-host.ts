/**
 * Self-hosted browser host (parent side): an {@link ElectronBrowserViewHost}
 * implementation that spawns the plugin's own WebView2 host process
 * (dsh-browser-plus-host.exe) and drives it over line-delimited JSON-RPC on a
 * loopback TCP socket. This is what makes the plugin work on surfaces without a
 * desktop shell's electronViewHost (plain dsh web): installing the plugin is
 * enough — the browser window appears on first use.
 *
 * Protocol (one JSON object per line, both directions):
 *   -> { id, op: 'createView' } | { id, op: 'destroyView', viewId } |
 *      { id, op: 'showView', viewId } | { id, op: 'command', viewId, method, params } |
 *      { id, op: 'configure', chromeScript } | { id, op: 'eval', viewId, source }
 *   <- { id, ok: true, result? } | { id, ok: false, err }
 *
 * The child is the .NET WinForms host: it owns the shared window, the WebView2
 * controllers, and their CoreWebView2 CDP bridge. The page chrome itself stays
 * parent-owned: this side builds it and pushes it with 'configure', and the
 * host replays it on every committed navigation.
 * @module dsh-browser-plus/browser-electron/remote-host
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { ElectronBrowserViewHost, ElectronViewHandle } from './provider.ts'
import type { BrowserTaskInfo, BrowserTaskUpdate, ExportedCookie } from '../browser/types.ts'
import { PAGE_CHROME_SCRIPT } from './page-chrome.ts'

/** How long to wait for the child to signal readiness before failing. */
const READY_TIMEOUT_MS = 20_000

/** Safety cap on a single RPC reply line (base64 downloads are the big ones). */
const MAX_RPC_BUFFER_BYTES = 512 * 1024 * 1024
/** Bounded RPC budgets prevent a dead child from wedging model-facing tools. */
const RPC_QUERY_TIMEOUT_MS = 8_000
const RPC_COMMAND_TIMEOUT_MS = 35_000
const RPC_TRANSFER_TIMEOUT_MS = 120_000

/**
 * A recycled host can report document-ready before its compositor owns a
 * paintable surface. Delay only the first capture after self-healing.
 */
const RECOVERY_CAPTURE_SETTLE_MS = 3_000

/** The host executable's file name. WebView2 is Windows-only. */
const HOST_EXE_NAME = 'dsh-browser-plus-host.exe'

/**
 * Spawn options for the GUI host.
 *
 * `windowsHide` MUST be false. It sets STARTF_USESHOWWINDOW/SW_HIDE on the
 * child, and Windows applies that value to the FIRST ShowWindow call — which is
 * the one `Form.Show()` makes — so the WinForms host would create its window,
 * render the page, answer every CDP command, and never appear on screen. The
 * page would be invisible to the human sharing it.
 *
 * Exported so a regression test can lock the value down: it is the exact object
 * handed to `spawn`.
 */
export const HOST_SPAWN_OPTIONS: { stdio: ['ignore', 'pipe', 'pipe']; windowsHide: boolean } = {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: false,
}

/**
 * Locate the plugin's WebView2 host executable.
 *
 * Candidates, in order: an explicit 'DSH_BROWSER_PLUS_HOST' override, the
 * published 'host/' directory beside the package, and the .NET build output
 * used during development.
 *
 * The host is a Windows-only .NET binary, so a non-Windows platform fails here
 * with a message that names the requirement instead of a spawn ENOENT.
 */
export function resolveHostExecutable(): string {
  if (process.platform !== 'win32') {
    throw new Error(
      'dsh-browser-plus requires the WebView2 host, which is Windows-only; ' +
      'this platform (' + process.platform + ') has no WebView2 equivalent.',
    )
  }
  const override = process.env.DSH_BROWSER_PLUS_HOST
  if (typeof override === 'string' && override.length > 0 && existsSync(override)) return override

  const here = fileURLToPath(new URL('.', import.meta.url))
  const candidates = [
    // Published layout: host/ sits beside lib/ in the package.
    join(here, '..', '..', 'host', HOST_EXE_NAME),
    // Development: the framework-dependent build outputs.
    join(here, '..', '..', 'host', 'bin', 'Release', 'net8.0-windows', HOST_EXE_NAME),
    join(here, '..', '..', 'host', 'bin', 'Debug', 'net8.0-windows', HOST_EXE_NAME),
    // Self-contained publish output.
    join(here, '..', '..', 'host', 'publish', HOST_EXE_NAME),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    'dsh-browser-plus could not find its WebView2 host (' + HOST_EXE_NAME + '). ' +
    'Run "npm run build:host" in the plugin, or point DSH_BROWSER_PLUS_HOST at the executable.',
  )
}

/** One RPC round-trip with the child. */
interface Pending {
  resolve(result: unknown): void
  reject(err: Error): void
  readonly timer: ReturnType<typeof setTimeout>
}

/**
 * Line-delimited JSON-RPC client over a local TCP socket. The parent listens on
 * a loopback port and passes it to the child via '--rpc-port'; the child
 * connects back and speaks the same one-JSON-per-line protocol. A Windows GUI
 * child does not receive piped stdin, which is why the parent owns the listener.
 */
class BrowserHostClient {
  private readonly child: ChildProcessByStdio<null, import('node:stream').Readable, import('node:stream').Readable>
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private buffer = ''
  private socket: import('node:net').Socket | undefined
  private connected = false
  private outbox: string[] = []
  /** Set once the child has exited; further calls fail fast instead of queueing. */
  private dead = false

  /** Unsolicited host events (page actions) delivered to the host owner. */
  onEvent: ((event: { event: string; viewId?: string; payload?: string }) => void) | undefined

  constructor(
    private readonly hostPath: string,
    private readonly port: number,
    private readonly onExit?: () => void,
  ) {
    process.stderr.write('[dsh-browser-plus host] spawning webview2 host: ' + hostPath + '\n')
    // A GUI child must not inherit ELECTRON_RUN_AS_NODE or NODE_OPTIONS from a
    // parent that happens to be Electron/Node; neither is meaningful to .NET.
    const env: Record<string, string | undefined> = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    this.child = spawn(hostPath, ['--rpc-port', String(port)], { ...HOST_SPAWN_OPTIONS, env })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', chunk => {
      // Diagnostics only; never parse stderr as protocol.
      process.stderr.write('[dsh-browser-plus host] ' + String(chunk))
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', chunk => {
      process.stderr.write('[dsh-browser-plus host] ' + String(chunk))
    })
    // A failed spawn (missing/corrupt binary) emits 'error' — without a
    // listener that would crash the whole DSH process.
    this.child.on('error', error => {
      process.stderr.write('[dsh-browser-plus host] spawn error: ' + String(error) + '\n')
      this.fail(new Error('dsh-browser-plus: browser host failed to start: ' + String(error)))
    })
    this.child.on('exit', (code, signal) => {
      this.fail(new Error('dsh-browser-plus: browser host exited (code=' + String(code) + ' signal=' + String(signal) + ')'))
    })
  }

  /** Reject everything in flight, mark the client dead, and notify the host. */
  private fail(err: Error): void {
    if (this.dead) return
    this.dead = true
    this.connected = false
    for (const pending of this.pending.values()) pending.reject(err)
    this.pending.clear()
    this.outbox = []
    this.onExit?.()
  }

  /** Accept the child's connection (called by the server). */
  attach(socket: import('node:net').Socket): void {
    this.socket = socket
    this.connected = true
    socket.setEncoding('utf8')
    // Without an 'error' listener a remote reset (ECONNRESET/EPIPE) throws an
    // uncaught 'error' event and crashes the whole DSH process; 'close' below
    // does the cleanup.
    socket.on('error', error => {
      process.stderr.write('[dsh-browser-plus host] socket error: ' + String(error) + '\n')
    })
    socket.on('data', chunk => this.onData(chunk))
    socket.on('close', () => {
      this.connected = false
      if (!this.dead) {
        this.fail(new Error('dsh-browser-plus: browser host connection closed'))
      }
    })
    // Flush anything queued while disconnected.
    if (this.outbox.length > 0) {
      for (const line of this.outbox) socket.write(line + '\n')
      this.outbox = []
    }
  }

  private onData(chunk: string | Buffer): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    // Safety net: a pathological child (or a reply larger than expected) must
    // not grow the parent's memory without bound. The child caps downloads at
    // 256 MiB, so a healthy stream never approaches this.
    if (this.buffer.length > MAX_RPC_BUFFER_BYTES) {
      this.buffer = ''
      this.fail(new Error('dsh-browser-plus: RPC reply exceeded ' + MAX_RPC_BUFFER_BYTES + ' bytes'))
      return
    }
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (line === '') continue
      let msg: { id?: number; ok?: boolean; result?: unknown; err?: string }
      try {
        msg = JSON.parse(line) as typeof msg
      } catch {
        // Non-protocol line; ignore.
        continue
      }
      if (typeof msg.id !== 'number') {
        // An unsolicited event from the host (a page action, for example).
        if (typeof (msg as { event?: unknown }).event === 'string') {
          this.onEvent?.(msg as { event: string; viewId?: string; payload?: string })
        }
        continue
      }
      const pending = this.pending.get(msg.id)
      if (pending === undefined) continue
      this.pending.delete(msg.id)
      if (msg.ok === true) pending.resolve(msg.result)
      else pending.reject(new Error(msg.err ?? 'browser host command failed'))
    }
  }

  /** Send one bounded command and await the reply. */
  call<T = unknown>(op: string, payload: Record<string, unknown> = {}, timeoutMs = RPC_COMMAND_TIMEOUT_MS): Promise<T> {
    if (this.dead) {
      return Promise.reject(new Error('dsh-browser-plus: browser host is not running'))
    }
    const id = this.nextId++
    const line = JSON.stringify({ id, op, ...payload })
    return new Promise<T>((resolve, reject) => {
      const settle = <TValue>(callback: (value: TValue) => void, value: TValue): void => {
        clearTimeout(timer)
        callback(value)
      }
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (pending === undefined) return
        this.pending.delete(id)
        this.outbox = this.outbox.filter(queued => queued !== line)
        const error = new Error('dsh-browser-plus: RPC ' + op + ' timed out after ' + String(timeoutMs) + 'ms')
        pending.reject(error)
        // A child that stopped answering cannot safely serve later operations.
        // Tear it down so the next call follows the existing self-heal path.
        this.fail(error)
        try { this.child.kill() } catch { /* already exited */ }
      }, timeoutMs)
      this.pending.set(id, {
        timer,
        resolve: result => settle(resolve, result as T),
        reject: error => settle(reject, error),
      })
      if (this.connected && this.socket !== undefined) {
        this.socket.write(line + '\n')
      } else {
        // Not connected yet: queue; attach() flushes on the child's arrival.
        this.outbox.push(line)
      }
    })
  }

  /** Terminate the child and its loopback connection. */
  kill(): void {
    try { this.socket?.destroy() } catch { /* already closed */ }
    try { this.child.kill() } catch { /* already exited */ }
  }
}

/** One view in the child: its id, used for every command. */
class RemoteView implements ElectronViewHandle {
  constructor(readonly id: string, private readonly client: BrowserHostClient) {}

  sendCommand(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.call<Record<string, unknown>>('command', {
      viewId: this.id,
      method,
      params: params ?? {},
    }, RPC_COMMAND_TIMEOUT_MS)
  }

  /** Ask the child to download a URL to a local file (keeps cookies/login). */
  async download(url: string, savePath: string): Promise<void> {
    const result = await this.client.call<{ base64: string }>('download', { viewId: this.id, url, savePath }, RPC_TRANSFER_TIMEOUT_MS)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(savePath, Buffer.from(result.base64, 'base64'))
  }

  /** CDP screenshot of the view (PNG base64 + size). */
  capture(): Promise<{ base64: string; width: number; height: number }> {
    return this.client.call<{ base64: string; width: number; height: number }>('capture', { viewId: this.id }, RPC_TRANSFER_TIMEOUT_MS)
  }

  /** Export the session's cookies (login state). */
  flushAuth(): Promise<ExportedCookie[]> {
    return this.client.call<{ cookies: ExportedCookie[] }>('flushAuth', { viewId: this.id }, RPC_COMMAND_TIMEOUT_MS).then(r => r.cookies)
  }

  /** Import cookies into the session (restore login state). */
  restoreAuth(cookies: ExportedCookie[]): Promise<number> {
    return this.client.call<{ restored: number }>('restoreAuth', { viewId: this.id, cookies }, RPC_COMMAND_TIMEOUT_MS).then(r => r.restored)
  }

  /** Remove cookies matching a site scope (stale challenge generations, logout). */
  clearCookies(filter: { domain?: string; name?: string; all?: boolean }): Promise<{ removed: number; names: string[] }> {
    return this.client.call<{ removed: number; names: string[] }>('clearCookies', {
      viewId: this.id,
      ...filter.domain !== undefined ? { domain: filter.domain } : {},
      ...filter.name !== undefined ? { name: filter.name } : {},
      ...filter.all === true ? { all: true } : {},
    }, RPC_COMMAND_TIMEOUT_MS)
  }

  /** Read (and clear) the most recent auto-accepted JS dialog for the view. */
  async clearDialog(): Promise<unknown> {
    // client.call resolves the host's reply result directly (no wrapper), so
    // the dialog object arrives as-is; a null reply means nothing was raised.
    return this.client.call<unknown>('drainDialog', { viewId: this.id }, RPC_QUERY_TIMEOUT_MS)
  }

  /** Set this view's browser-task label; selected task controls the shared title. */
  async label(label: string): Promise<void> {
    await this.client.call('label', { viewId: this.id, label }, RPC_COMMAND_TIMEOUT_MS)
  }
}

/**
 * Self-hosted view host: spawns the plugin's WebView2 child on first use and
 * keeps it alive until dispose(). Fallback when no desktop shell provides
 * ctx.electronViewHost.
 */
export class RemoteElectronViewHost implements ElectronBrowserViewHost {
  private client: BrowserHostClient | undefined
  private server: Server | undefined
  private pendingSocket: Socket | undefined
  private readonly views = new Map<string, ElectronViewHandle>()
  private readyPromise: Promise<void> | undefined
  private disposed = false

  /**
   * Page-action handler: the injected chrome reports task switches, control
   * handoffs, and panel toggles from inside the page. The owner of workspace
   * state subscribes here.
   */
  onPageAction: ((viewId: string, payload: string) => void) | undefined

  constructor(private readonly hostPath: string) {}

  /** Ensure the child is up and ready (lazy on first use; restarts after a crash). */
  private ready(): Promise<void> {
    if (this.readyPromise !== undefined) return this.readyPromise
    const started = this.start()
    const wrapped = started.catch(error => {
      // A failed startup must not poison the host forever: tear down whatever
      // was half-created and let the next call retry from scratch.
      if (this.readyPromise === wrapped) {
        this.readyPromise = undefined
        this.client?.kill()
        this.client = undefined
        this.server?.close()
        this.server = undefined
        this.pendingSocket = undefined
      }
      throw error
    })
    this.readyPromise = wrapped
    return wrapped
  }

  private async start(): Promise<void> {
    // Listen on an ephemeral loopback port; the child connects back.
    const server = createServer(socket => {
      if (this.client !== undefined) this.client.attach(socket)
      else this.pendingSocket = socket
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    // A later server error (rare on a loopback ephemeral port) must not crash
    // the process; the client's fail path handles the actual recovery.
    server.on('error', error => {
      process.stderr.write('[dsh-browser-plus host] rpc server error: ' + String(error) + '\n')
    })
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    this.server = server
    this.client = new BrowserHostClient(this.hostPath, port, () => this.onChildExit())
    this.client.onEvent = event => {
      if (event.event === 'page-action' && event.viewId !== undefined && event.payload !== undefined) {
        this.onPageAction?.(event.viewId, event.payload)
      }
    }
    if (this.pendingSocket !== undefined) {
      this.client.attach(this.pendingSocket)
      this.pendingSocket = undefined
    }
    // Wait for the child's connection + readiness ping.
    await withTimeout(this.client.call('ping', {}, RPC_QUERY_TIMEOUT_MS), READY_TIMEOUT_MS, 'browser host did not become ready')
    // The parent owns the page chrome; hand the child the script to replay on
    // every committed navigation.
    await this.client.call('configure', { chromeScript: PAGE_CHROME_SCRIPT }, RPC_QUERY_TIMEOUT_MS)
  }

  /**
   * Whether the host's shared window is actually on screen.
   *
   * Diagnostic for the SW_HIDE trap: a window created with STARTF_USESHOWWINDOW
   * answers every RPC and renders the page while staying invisible, which no
   * CDP-level check can detect.
   */
  async windowState(): Promise<{ visible: boolean; handle: number; title: string }> {
    await this.ready()
    const client = this.client
    if (client === undefined) throw new Error('browser host unavailable')
    return client.call<{ visible: boolean; handle: number; title: string }>('windowState', {}, RPC_QUERY_TIMEOUT_MS)
  }

  /** The child died: tear down so the next use starts a fresh child. */
  private onChildExit(): void {
    if (this.disposed) return
    this.client = undefined
    this.server?.close()
    this.server = undefined
    this.pendingSocket = undefined
    this.readyPromise = undefined
    // Keep the views map: handles still resolve to ids; a fresh child simply
    // has no such views yet, and reset_session reopens clean sessions.
  }

  createView(key?: string, label?: string): ElectronViewHandle {
    // The seam is synchronous; the provider uses the handle immediately, so
    // commands are deferred until the child is up and the view materialized.
    const id = 'view:' + Math.random().toString(36).slice(2, 10)
    const view = new DeferredRemoteView(id, label, currentLabel => this.ensureView(id, key, currentLabel))
    this.views.set(id, view)
    return view
  }

  private async ensureView(id: string, key?: string, label?: string): Promise<RemoteView> {
    await this.ready()
    const client = this.client
    if (client === undefined) throw new Error('browser host unavailable')
    await client.call('createView', {
      viewId: id,
      ...key !== undefined ? { key } : {},
      ...label !== undefined ? { label } : {},
    })
    // If the view was destroyed while the createView RPC was in flight, do not
    // re-insert a stale entry that would resurrect a dead child view.
    if (this.views.get(id) === undefined) {
      throw new Error('browser: view destroyed while starting')
    }
    const view = new RemoteView(id, client)
    this.views.set(id, view)
    return view
  }

  showView(handle: ElectronViewHandle): void {
    // Fire-and-forget by design (visibility is best-effort), but a rejected
    // promise must not become an unhandled rejection (crash on Node >= 15).
    void this.ready()
      .then(() => this.client?.call('showView', { viewId: handle.id }))
      .catch(() => { /* host unavailable */ })
  }

  destroyView(handle: ElectronViewHandle): void {
    const view = this.views.get(handle.id)
    if (view === undefined) return
    this.views.delete(handle.id)
    void this.ready()
      .then(() => this.client?.call('destroyView', { viewId: handle.id }))
      .catch(() => { /* child already gone */ })
  }

  /** Append one operation to the child's per-view trail. */
  trace(viewId: string, entry: unknown): void {
    void this.ready()
      .then(() => this.client?.call('trace', { viewId, entry }))
      .catch(() => { /* child gone */ })
  }

  /** Run one parent-owned chrome patch inside a view. */
  eval(viewId: string, source: string): void {
    void this.ready()
      .then(() => this.client?.call('eval', { viewId, source }, RPC_QUERY_TIMEOUT_MS))
      .catch(() => { /* child gone */ })
  }

  /** List browser task keys with labels (legacy RPC name retained for compatibility). */
  async listWindows(): Promise<Array<{ key: string; label: string }>> {
    await this.ready()
    const client = this.client
    if (client === undefined) throw new Error('browser host unavailable')
    const r = await client.call<{ windows: Array<{ key: string; label: string }> }>('listWindows', {}, RPC_QUERY_TIMEOUT_MS)
    return r.windows
  }

  /** List task summaries from the self-hosted visible workspace. */
  async listTasks(): Promise<readonly BrowserTaskInfo[]> {
    await this.ready()
    const client = this.client
    if (client === undefined) throw new Error('browser host unavailable')
    const result = await client.call<{ tasks: BrowserTaskInfo[] }>('listTasks', {}, RPC_QUERY_TIMEOUT_MS)
    return result.tasks
  }

  /** Read one task summary from the self-hosted visible workspace. */
  async getTask(key: string): Promise<BrowserTaskInfo | undefined> {
    await this.ready()
    const client = this.client
    if (client === undefined) throw new Error('browser host unavailable')
    const result = await client.call<{ task: BrowserTaskInfo | null }>('getTask', { key }, RPC_QUERY_TIMEOUT_MS)
    return result.task ?? undefined
  }

  /** Update one task summary in the self-hosted visible workspace. */
  async updateTask(key: string, task: BrowserTaskUpdate): Promise<BrowserTaskInfo | undefined> {
    await this.ready()
    const client = this.client
    if (client === undefined) throw new Error('browser host unavailable')
    const result = await client.call<{ task: BrowserTaskInfo | null }>('updateTask', { key, task }, RPC_QUERY_TIMEOUT_MS)
    return result.task ?? undefined
  }

  /** Shut the child and the RPC server down. */
  dispose(): void {
    this.disposed = true
    this.client?.kill()
    this.client = undefined
    this.server?.close()
    this.server = undefined
    this.readyPromise = undefined
    this.views.clear()
  }
}

/** @internal Deferred view recovery handle; exported for focused behavior tests. */
export class DeferredRemoteView implements ElectronViewHandle {
  private materialized: Promise<RemoteView> | undefined
  private recoveryCompositorSettle: Promise<void> | undefined
  private taskLabel: string | undefined
  private labelRevision = 0

  constructor(
    readonly id: string,
    label: string | undefined,
    private readonly materialize: (label: string | undefined) => Promise<RemoteView>,
  ) {
    this.taskLabel = label
  }

  /**
   * Materialize once and cache: every sendCommand on the same handle must
   * target the SAME child view (re-materializing would re-run createView and
   * duplicate the view). A FAILED materialization is reset so a later call
   * (e.g. after the host restarted) can retry instead of being poisoned.
   */
  private materializeOnce(): Promise<RemoteView> {
    if (this.materialized === undefined) {
      const pending = this.materialize(this.taskLabel)
      this.materialized = pending.catch(error => {
        if (this.materialized === pending) this.materialized = undefined
        throw error
      })
    }
    return this.materialized
  }

  private scheduleRecoveredCompositorSettle(): void {
    this.recoveryCompositorSettle = new Promise<void>(resolve => {
      setTimeout(resolve, RECOVERY_CAPTURE_SETTLE_MS)
    })
  }

  /** Wait for a recovered child to acquire a paintable compositor surface. */
  private async settleRecoveredCompositorForCapture(): Promise<void> {
    // A second recovery can happen while a prior settle delay is resolving.
    while (this.recoveryCompositorSettle !== undefined) {
      const settle = this.recoveryCompositorSettle
      await settle
      if (this.recoveryCompositorSettle === settle) {
        this.recoveryCompositorSettle = undefined
        return
      }
    }
  }

  /**
   * Run an operation against the materialized view, with ONE self-heal retry:
   * if the child died while this handle was cached (host restart or a recycle),
   * dropping the cached materialization and re-materializing creates a fresh
   * child view for the same session handle, so a session survives a host
   * crash/recycle without a manual reset.
   */
  private async withView<T>(
    run: (view: RemoteView) => Promise<T>,
    afterRecovery?: () => Promise<void>,
  ): Promise<T> {
    try {
      return await run(await this.materializeOnce())
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('browser host is not running')) throw error
      // Stale child: forget the cached view, then re-create a fresh pair.
      this.materialized = undefined
      const view = await this.materializeOnce()
      this.scheduleRecoveredCompositorSettle()
      await afterRecovery?.()
      return run(view)
    }
  }

  async sendCommand(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const settle = method === 'Page.captureScreenshot'
      ? () => this.settleRecoveredCompositorForCapture()
      : undefined
    await settle?.()
    return this.withView(view => view.sendCommand(method, params), settle)
  }

  async download(url: string, savePath: string): Promise<void> {
    return this.withView(view => view.download(url, savePath))
  }

  async capture(): Promise<{ base64: string; width: number; height: number }> {
    await this.settleRecoveredCompositorForCapture()
    return this.withView(view => view.capture(), () => this.settleRecoveredCompositorForCapture())
  }

  async flushAuth(): Promise<ExportedCookie[]> {
    return this.withView(view => view.flushAuth())
  }

  async restoreAuth(cookies: ExportedCookie[]): Promise<number> {
    return this.withView(view => view.restoreAuth(cookies))
  }

  async clearCookies(filter: { domain?: string; name?: string; all?: boolean }): Promise<{ removed: number; names: string[] }> {
    return this.withView(view => view.clearCookies(filter))
  }

  async clearDialog(): Promise<unknown> {
    return this.withView(view => view.clearDialog())
  }

  async label(label: string): Promise<void> {
    const previousLabel = this.taskLabel
    const revision = ++this.labelRevision
    this.taskLabel = label
    try {
      await this.withView(view => view.label(label))
    } catch (error) {
      if (this.labelRevision === revision) this.taskLabel = previousLabel
      throw error
    }
  }
}

/** Reject a promise if it does not settle within the budget. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message + ' (' + ms + 'ms)')), ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

/** Default WebView2 host executable path relative to this module's build output. */
export function defaultHostMainPath(): string {
  return resolveHostExecutable()
}

/** The plugin's declared WebView2 host requirement, for diagnostics and tests. */
export function hostRequirement(): { platform: string; executable: string } {
  return { platform: 'win32', executable: HOST_EXE_NAME }
}
