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
import type { ElectronBrowserViewHost, ElectronViewHandle } from './provider.ts';
import type { BrowserTaskInfo, BrowserTaskUpdate, ExportedCookie } from '../browser/types.ts';
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
export declare const HOST_SPAWN_OPTIONS: {
    stdio: ['ignore', 'pipe', 'pipe'];
    windowsHide: boolean;
};
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
export declare function resolveHostExecutable(): string;
/**
 * Line-delimited JSON-RPC client over a local TCP socket. The parent listens on
 * a loopback port and passes it to the child via '--rpc-port'; the child
 * connects back and speaks the same one-JSON-per-line protocol. A Windows GUI
 * child does not receive piped stdin, which is why the parent owns the listener.
 */
declare class BrowserHostClient {
    private readonly hostPath;
    private readonly port;
    private readonly onExit?;
    private readonly child;
    private readonly pending;
    private nextId;
    private buffer;
    private socket;
    private connected;
    private outbox;
    /** Set once the child has exited; further calls fail fast instead of queueing. */
    private dead;
    /** Unsolicited host events (page actions) delivered to the host owner. */
    onEvent: ((event: {
        event: string;
        viewId?: string;
        payload?: string;
    }) => void) | undefined;
    constructor(hostPath: string, port: number, onExit?: (() => void) | undefined);
    /** Reject everything in flight, mark the client dead, and notify the host. */
    private fail;
    /** Accept the child's connection (called by the server). */
    attach(socket: import('node:net').Socket): void;
    private onData;
    /** Send one bounded command and await the reply. */
    call<T = unknown>(op: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
    /** Terminate the child and its loopback connection. */
    kill(): void;
}
/** One view in the child: its id, used for every command. */
declare class RemoteView implements ElectronViewHandle {
    readonly id: string;
    private readonly client;
    constructor(id: string, client: BrowserHostClient);
    sendCommand(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
    /** Ask the child to download a URL to a local file (keeps cookies/login). */
    download(url: string, savePath: string): Promise<void>;
    /** CDP screenshot of the view (PNG base64 + size). */
    capture(): Promise<{
        base64: string;
        width: number;
        height: number;
    }>;
    /** Export the session's cookies (login state). */
    flushAuth(): Promise<ExportedCookie[]>;
    /** Import cookies into the session (restore login state). */
    restoreAuth(cookies: ExportedCookie[]): Promise<number>;
    /** Remove cookies matching a site scope (stale challenge generations, logout). */
    clearCookies(filter: {
        domain?: string;
        name?: string;
        all?: boolean;
    }): Promise<{
        removed: number;
        names: string[];
    }>;
    /** Read (and clear) the most recent auto-accepted JS dialog for the view. */
    clearDialog(): Promise<unknown>;
    /** Set this view's browser-task label; selected task controls the shared title. */
    label(label: string): Promise<void>;
}
/**
 * Self-hosted view host: spawns the plugin's WebView2 child on first use and
 * keeps it alive until dispose(). Fallback when no desktop shell provides
 * ctx.electronViewHost.
 */
export declare class RemoteElectronViewHost implements ElectronBrowserViewHost {
    private readonly hostPath;
    private client;
    private server;
    private pendingSocket;
    private readonly views;
    private readyPromise;
    private disposed;
    /**
     * Page-action handler: the injected chrome reports task switches, control
     * handoffs, and panel toggles from inside the page. The owner of workspace
     * state subscribes here.
     */
    onPageAction: ((viewId: string, payload: string) => void) | undefined;
    constructor(hostPath: string);
    /** Ensure the child is up and ready (lazy on first use; restarts after a crash). */
    private ready;
    private start;
    /**
     * Whether the host's shared window is actually on screen.
     *
     * Diagnostic for the SW_HIDE trap: a window created with STARTF_USESHOWWINDOW
     * answers every RPC and renders the page while staying invisible, which no
     * CDP-level check can detect.
     */
    windowState(): Promise<{
        visible: boolean;
        handle: number;
        title: string;
    }>;
    /** The child died: tear down so the next use starts a fresh child. */
    private onChildExit;
    createView(key?: string, label?: string): ElectronViewHandle;
    private ensureView;
    showView(handle: ElectronViewHandle): void;
    destroyView(handle: ElectronViewHandle): void;
    /** Append one operation to the child's per-view trail. */
    trace(viewId: string, entry: unknown): void;
    /** Run one parent-owned chrome patch inside a view. */
    eval(viewId: string, source: string): void;
    /** List browser task keys with labels (legacy RPC name retained for compatibility). */
    listWindows(): Promise<Array<{
        key: string;
        label: string;
    }>>;
    /** List task summaries from the self-hosted visible workspace. */
    listTasks(): Promise<readonly BrowserTaskInfo[]>;
    /** Read one task summary from the self-hosted visible workspace. */
    getTask(key: string): Promise<BrowserTaskInfo | undefined>;
    /** Update one task summary in the self-hosted visible workspace. */
    updateTask(key: string, task: BrowserTaskUpdate): Promise<BrowserTaskInfo | undefined>;
    /** Shut the child and the RPC server down. */
    dispose(): void;
}
/** @internal Deferred view recovery handle; exported for focused behavior tests. */
export declare class DeferredRemoteView implements ElectronViewHandle {
    readonly id: string;
    private readonly materialize;
    private materialized;
    private recoveryCompositorSettle;
    private taskLabel;
    private labelRevision;
    constructor(id: string, label: string | undefined, materialize: (label: string | undefined) => Promise<RemoteView>);
    /**
     * Materialize once and cache: every sendCommand on the same handle must
     * target the SAME child view (re-materializing would re-run createView and
     * duplicate the view). A FAILED materialization is reset so a later call
     * (e.g. after the host restarted) can retry instead of being poisoned.
     */
    private materializeOnce;
    private scheduleRecoveredCompositorSettle;
    /** Wait for a recovered child to acquire a paintable compositor surface. */
    private settleRecoveredCompositorForCapture;
    /**
     * Run an operation against the materialized view, with ONE self-heal retry:
     * if the child died while this handle was cached (host restart or a recycle),
     * dropping the cached materialization and re-materializing creates a fresh
     * child view for the same session handle, so a session survives a host
     * crash/recycle without a manual reset.
     */
    private withView;
    sendCommand(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
    download(url: string, savePath: string): Promise<void>;
    capture(): Promise<{
        base64: string;
        width: number;
        height: number;
    }>;
    flushAuth(): Promise<ExportedCookie[]>;
    restoreAuth(cookies: ExportedCookie[]): Promise<number>;
    clearCookies(filter: {
        domain?: string;
        name?: string;
        all?: boolean;
    }): Promise<{
        removed: number;
        names: string[];
    }>;
    clearDialog(): Promise<unknown>;
    label(label: string): Promise<void>;
}
/** Default WebView2 host executable path relative to this module's build output. */
export declare function defaultHostMainPath(): string;
/** The plugin's declared WebView2 host requirement, for diagnostics and tests. */
export declare function hostRequirement(): {
    platform: string;
    executable: string;
};
export {};
