using System.Collections.Concurrent;
using System.Drawing;
using System.Text.Json.Nodes;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DshBrowserPlusHost;

/// <summary>One task-scoped page view backed by a WebView2 controller.</summary>
internal sealed class ViewEntry
{
    internal required string TaskKey { get; init; }
    internal required WebView2 Control { get; init; }
    internal required CoreWebView2 Core { get; init; }
    /// <summary>Latest unread auto-accepted JS dialog (read once by drainDialog).</summary>
    internal JsonObject? DialogLog;
    /// <summary>
    /// Last committed page URL, cached on the UI thread. CoreWebView2 is
    /// thread-affine, so task summaries read this instead of Core.Source.
    /// </summary>
    internal string Url = "";
}

/// <summary>Task state owned by the host (the chrome itself lives in the parent).</summary>
internal sealed class TaskState
{
    internal string Status { get; set; } = "idle";
    internal string Control { get; set; } = "agent";
    internal string? LatestAction { get; set; }
    internal string? Error { get; set; }
    internal long UpdatedAt { get; set; } = Json.NowMs();
}

/// <summary>
/// The shared visible browser window: one WinForms Form holding one WebView2
/// per task view, with only the selected task's view visible. Mirrors the
/// Electron host's single-BrowserWindow / many-WebContentsView design.
/// </summary>
internal sealed class BrowserHost : IDisposable
{
    private const int DefaultWidth = 1400;
    private const int DefaultHeight = 900;
    private const long MaxDownloadBytes = 256L * 1024 * 1024;
    private const int MaxTraceEntries = 500;
    /** SW_SHOWNORMAL for the user32 ShowWindow call in StartAsync. */
    private const int SwShowNormal = 1;

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    private readonly Form _form;
    private readonly object _gate = new();
    private readonly Dictionary<string, ViewEntry> _views = new();
    private readonly Dictionary<string, List<JsonObject>> _traces = new();
    private readonly Dictionary<string, string> _taskLabels = new();
    private readonly Dictionary<string, string> _activeViewByTask = new();
    private readonly Dictionary<string, HashSet<string>> _taskViewIds = new();
    private readonly Dictionary<string, TaskState> _taskStates = new();
    private readonly ConcurrentQueue<Action> _uiQueue = new();
    private CoreWebView2Environment? _environment;
    private string? _visibleTaskKey;
    private bool _disposed;
    /// <summary>Page chrome source pushed by the parent (it owns chrome state).</summary>
    private string _chromeScript = "";

    internal BrowserHost()
    {
        _form = new Form
        {
            Text = "dsh-browser-plus",
            Width = DefaultWidth,
            Height = DefaultHeight,
            StartPosition = FormStartPosition.CenterScreen,
            Icon = LoadIcon(),
        };
        _form.Resize += (_, _) => LayoutViews();
        _form.FormClosed += (_, _) =>
        {
            // The human closed the window: drop every view so the next tool call
            // rebuilds a fresh window instead of talking to destroyed controls.
            lock (_gate)
            {
                _views.Clear();
                _traces.Clear();
                _taskLabels.Clear();
                _activeViewByTask.Clear();
                _taskViewIds.Clear();
                _taskStates.Clear();
                _visibleTaskKey = null;
            }
        };
    }

    /// <summary>Create the environment and show the window. Must run on the UI thread.</summary>
    internal async Task StartAsync()
    {
        var userData = UserDataFolder();
        _environment = await CoreWebView2Environment.CreateAsync(null, userData, null);
        Console.Error.WriteLine("[dsh-browser-plus host] webview2 runtime " + _environment.BrowserVersionString
            + " userData=" + userData);
        _form.Show();
        // Windows applies a spawner's STARTF_USESHOWWINDOW/SW_HIDE to the FIRST
        // ShowWindow call, which Form.Show() just made — so a parent that spawns
        // us hidden (Node's windowsHide) would leave the window created,
        // rendering, and invisible to the human. Force it on screen explicitly
        // so the host is robust to any spawner, and raise it once so the human
        // actually sees the browser they are sharing.
        try
        {
            ShowWindow(_form.Handle, SwShowNormal);
            SetForegroundWindow(_form.Handle);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[dsh-browser-plus host] show window failed: " + ex.Message);
        }
        Application.Idle += (_, _) => DrainUiQueue();
    }

    /// <summary>The dedicated profile directory, isolated from the DSH app's own.</summary>
    private static string UserDataFolder()
    {
        var home = Environment.GetEnvironmentVariable("DSH_HOME");
        var baseDir = string.IsNullOrEmpty(home)
            ? Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData)
            : home;
        return Path.Combine(baseDir, "dsh-browser-plus-host");
    }

    private static Icon? LoadIcon()
    {
        // assets/dsh-browser-plus.ico ships beside the host in the package.
        foreach (var candidate in IconCandidates())
        {
            try { if (File.Exists(candidate)) return new Icon(candidate); } catch { /* cosmetic */ }
        }
        return null;
    }

    private static IEnumerable<string> IconCandidates()
    {
        var root = AppContext.BaseDirectory;
        yield return Path.Combine(root, "assets", "dsh-browser-plus.ico");
        yield return Path.Combine(root, "..", "assets", "dsh-browser-plus.ico");
        yield return Path.Combine(root, "..", "..", "..", "assets", "dsh-browser-plus.ico");
    }

    private void DrainUiQueue()
    {
        while (_uiQueue.TryDequeue(out var action))
        {
            try { action(); } catch (Exception ex) { Console.Error.WriteLine("[dsh-browser-plus host] ui: " + ex); }
        }
    }

    /// <summary>
    /// Run work on the WinForms UI thread and await its completion.
    ///
    /// The async body must START on the UI thread: WebView2 controls are
    /// thread-affine, and WinForms' SynchronizationContext resumes the
    /// continuations here after each await. There is deliberately no
    /// Func&lt;Action&gt; overload — an async lambda would bind to it as
    /// async-void and the RPC would reply before the view existed.
    /// </summary>
    private Task<T> OnUi<T>(Func<Task<T>> work)
    {
        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        void Start() => _ = CompleteOnUiAsync(work, tcs);
        if (_form.IsHandleCreated) _form.BeginInvoke(Start);
        else _uiQueue.Enqueue(Start);
        return tcs.Task;
    }

    /// <summary>Await a UI-thread body and funnel its outcome into the caller.</summary>
    private static async Task CompleteOnUiAsync<T>(Func<Task<T>> work, TaskCompletionSource<T> tcs)
    {
        try { tcs.TrySetResult(await work()); }
        catch (Exception ex) { tcs.TrySetException(ex); }
    }

    /// <summary>Synchronous UI work, still started on the UI thread.</summary>
    private Task OnUi(Func<Task> work) => OnUi<object?>(async () => { await work(); return null; });

    // ---------------------------------------------------------------- views

    /// <summary>
    /// Whether the shared window is actually on screen.
    ///
    /// <c>Form.Visible</c> reports the WinForms flag, which stays true even when
    /// the OS window was created hidden, so the user32 check is authoritative.
    /// Exposed over RPC so a live test can assert the window is not invisible.
    /// </summary>
    internal Task<JsonObject> WindowStateAsync()
        => OnUi(() =>
        {
            var handle = _form.IsHandleCreated ? _form.Handle : IntPtr.Zero;
            return Task.FromResult(new JsonObject
            {
                ["visible"] = handle != IntPtr.Zero && IsWindowVisible(handle),
                ["handle"] = handle.ToInt64(),
                ["title"] = _form.Text,
            });
        });

    /// <summary>Create one task view; the first view for a task becomes its active tab.</summary>
    internal Task CreateViewAsync(string viewId, string taskKey, string? label)
        => OnUi(async () =>
        {
            if (_views.ContainsKey(viewId)) throw new InvalidOperationException("duplicate viewId " + viewId);
            if (_environment is null) throw new InvalidOperationException("host not started");
            if (label is not null) _taskLabels[taskKey] = label;

            var control = new WebView2 { Dock = DockStyle.None, Visible = false };
            _form.Controls.Add(control);
            await control.EnsureCoreWebView2Async(_environment);
            var core = control.CoreWebView2;

            // No default context menu / status bar: this is an agent surface, not
            // a browser chrome. Devtools stays available for debugging.
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDevToolsEnabled = true;
            core.Settings.IsWebMessageEnabled = true;
            core.Settings.AreBrowserAcceleratorKeysEnabled = true;

            var entry = new ViewEntry { TaskKey = taskKey, Control = control, Core = core };

            // JS dialogs would freeze the page until answered; auto-accept and
            // stash the detail for the provider to surface via drainDialog.
            core.ScriptDialogOpening += (_, e) =>
            {
                entry.DialogLog = new JsonObject
                {
                    ["type"] = DialogKind(e.Kind),
                    ["message"] = e.Message,
                };
                try { e.Accept(); } catch { /* closing */ }
            };
            // Keep window.open / target=_blank inside this shared view.
            core.NewWindowRequested += (_, e) =>
            {
                e.Handled = true;
                if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri)
                    && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
                {
                    try { core.Navigate(e.Uri); } catch { /* closing */ }
                }
            };
            // The page chrome calls window.__dshBrowserTaskAction(...); forward it
            // to the parent, which owns workspace state.
            core.WebMessageReceived += (_, e) =>
            {
                string? payload;
                try { payload = e.TryGetWebMessageAsString(); } catch { payload = null; }
                if (!string.IsNullOrEmpty(payload)) HostBridge.Publish(viewId, payload!);
            };
            await core.AddScriptToExecuteOnDocumentCreatedAsync(BindingScript());
            // The parent owns the page chrome (toolbar, task manager, trail); the
            // host only replays the script it was configured with on every
            // committed navigation, exactly as the Electron host did.
            core.NavigationCompleted += (_, _) =>
            {
                entry.Url = SafeUrl(core);
                InstallChrome(viewId);
            };

            _views[viewId] = entry;
            if (!_taskViewIds.TryGetValue(taskKey, out var ids))
            {
                ids = new HashSet<string>();
                _taskViewIds[taskKey] = ids;
            }
            ids.Add(viewId);
            _taskStates.TryAdd(taskKey, new TaskState());
            _activeViewByTask[taskKey] = viewId;
            _visibleTaskKey ??= taskKey;
            LayoutViews();
            SyncVisibility();
        });

    /// <summary>Store the parent-owned chrome source and apply it to live views.</summary>
    internal Task ConfigureAsync(string? chromeScript)
        => OnUi(async () =>
        {
            _chromeScript = chromeScript ?? "";
            foreach (var viewId in _views.Keys.ToArray()) await InstallChromeAsync(viewId);
        });

    /// <summary>Replay the configured chrome into one page (cosmetic; never throws).</summary>
    internal void InstallChrome(string viewId)
    {
        if (_chromeScript.Length == 0) return;
        _ = InstallChromeAsync(viewId);
    }

    private async Task InstallChromeAsync(string viewId)
    {
        if (_chromeScript.Length == 0) return;
        ViewEntry entry;
        lock (_gate)
        {
            if (!_views.TryGetValue(viewId, out entry!)) return;
        }
        var active = _visibleTaskKey is not null
            && _activeViewByTask.TryGetValue(entry.TaskKey, out var activeId)
            && activeId == viewId;
        var source = _chromeScript
            + ";window.__dshChromeActive = " + (active ? "true" : "false")
            + ";try { window.__dshChromeSetActive?.(" + (active ? "true" : "false") + ") } catch {}";
        try { await entry.Core.ExecuteScriptAsync(source); }
        catch (Exception ex) { Console.Error.WriteLine("[dsh-browser-plus host] chrome: " + ex.Message); }
    }

    /// <summary>Evaluate one parent-supplied script in a view (chrome patches).</summary>
    internal Task EvalAsync(string viewId, string source)
        => OnUi(async () =>
    {
        try { await Core(viewId).ExecuteScriptAsync(source); }
        catch (Exception ex) { Console.Error.WriteLine("[dsh-browser-plus host] eval: " + ex.Message); }
    });

    /// <summary>Destroy one view and repair the active/visible pointers.</summary>
    internal Task DestroyViewAsync(string viewId)
        => OnUi(async () =>
        {
            if (!_views.TryGetValue(viewId, out var entry)) return;
            var taskKey = entry.TaskKey;
            var wasActive = _activeViewByTask.TryGetValue(taskKey, out var active) && active == viewId;
            _views.Remove(viewId);
            _traces.Remove(viewId);
            if (_taskViewIds.TryGetValue(taskKey, out var ids))
            {
                ids.Remove(viewId);
                if (ids.Count == 0) _taskViewIds.Remove(taskKey);
            }
            try { entry.Control.Dispose(); } catch { /* already gone */ }
            var replacement = _views.FirstOrDefault(pair => pair.Value.TaskKey == taskKey).Key;
            if (wasActive)
            {
                if (replacement is not null) _activeViewByTask[taskKey] = replacement;
                else
                {
                    _activeViewByTask.Remove(taskKey);
                    _taskLabels.Remove(taskKey);
                    _taskStates.Remove(taskKey);
                }
            }
            if (_visibleTaskKey == taskKey)
            {
                if (_activeViewByTask.ContainsKey(taskKey)) { /* stays visible */ }
                else
                {
                    _visibleTaskKey = _activeViewByTask.Keys.FirstOrDefault();
                    _form.Text = _visibleTaskKey is null ? "dsh-browser-plus" : TaskTitle(_visibleTaskKey);
                }
            }
            SyncVisibility();
            await Task.CompletedTask;
        });

    /// <summary>Make one view the active tab of its task (and visible if selected).</summary>
    internal Task ShowViewAsync(string viewId)
        => OnUi(async () =>
        {
            if (!_views.TryGetValue(viewId, out var entry)) throw new InvalidOperationException("unknown view " + viewId);
            _activeViewByTask[entry.TaskKey] = viewId;
            _visibleTaskKey ??= entry.TaskKey;
            SyncVisibility();
            await Task.CompletedTask;
        });

    /// <summary>Set a task's display label; the visible task controls the title.</summary>
    internal Task LabelAsync(string viewId, string label)
        => OnUi(async () =>
        {
            if (!_views.TryGetValue(viewId, out var entry)) throw new InvalidOperationException("unknown view " + viewId);
            _taskLabels[entry.TaskKey] = label;
            if (_visibleTaskKey == entry.TaskKey) _form.Text = TaskTitle(entry.TaskKey);
            await Task.CompletedTask;
        });

    private string TaskTitle(string taskKey)
    {
        var label = _taskLabels.TryGetValue(taskKey, out var value) ? value : "";
        return label.Length == 0 ? "dsh-browser-plus" : "dsh-browser-plus — " + label;
    }

    /// <summary>Every task view fills the one shared content surface.</summary>
    private void LayoutViews()
    {
        if (_form.IsDisposed) return;
        var size = _form.ClientSize;
        foreach (var entry in _views.Values)
        {
            try { entry.Control.Bounds = new Rectangle(0, 0, size.Width, size.Height); }
            catch { /* destroyed */ }
        }
    }

    /// <summary>
    /// Only the active view of the visible task is shown; every other view stays
    /// hidden. Hiding a WinForms WebView2 control does not unload the page, so
    /// background tasks keep running.
    /// </summary>
    private void SyncVisibility()
    {
        var target = _visibleTaskKey is not null && _activeViewByTask.TryGetValue(_visibleTaskKey, out var id)
            ? id
            : null;
        foreach (var (viewId, entry) in _views)
        {
            var active = viewId == target;
            try
            {
                entry.Control.Visible = active;
                if (active) entry.Control.BringToFront();
            }
            catch { /* destroyed */ }
            // The chrome hides its own panels for a background view; tell it
            // rather than rebuilding the injected DOM.
            if (_chromeScript.Length > 0)
            {
                _ = entry.Core.ExecuteScriptAsync(
                    "window.__dshChromeActive = " + (active ? "true" : "false")
                    + ";try { window.__dshChromeSetActive?.(" + (active ? "true" : "false") + ") } catch {}")
                    .ContinueWith(task => _ = task.Exception, TaskScheduler.Default);
            }
        }
        if (target is not null) _form.Text = TaskTitle(_views[target].TaskKey);
    }

    // ------------------------------------------------------------- commands

    /// <summary>Run one CDP method on a view through the WebView2 bridge.</summary>
    internal Task<JsonNode?> CommandAsync(string viewId, string method, JsonObject parameters)
        => OnUi(async () =>
        {
            // CoreWebView2 is thread-affine: every CDP call starts on the UI thread.
            var core = Core(viewId);
            var json = parameters.ToJsonString();
            var raw = await core.CallDevToolsProtocolMethodAsync(method, json);
            return string.IsNullOrEmpty(raw) ? null : JsonNode.Parse(raw);
        });

    private CoreWebView2 Core(string viewId)
    {
        lock (_gate)
        {
            if (_views.TryGetValue(viewId, out var entry)) return entry.Core;
        }
        throw new InvalidOperationException("unknown view " + viewId);
    }

    private ViewEntry Entry(string viewId)
    {
        lock (_gate)
        {
            if (_views.TryGetValue(viewId, out var entry)) return entry;
        }
        throw new InvalidOperationException("unknown view " + viewId);
    }

    /// <summary>
    /// PNG capture through CDP. WebView2 has no native capturePage, so this is
    /// the only path; the parent keeps its own compositor-settle handling.
    /// </summary>
    internal Task<JsonObject> CaptureAsync(string viewId)
        => OnUi(async () =>
        {
            var core = Core(viewId);
            var raw = await core.CallDevToolsProtocolMethodAsync("Page.captureScreenshot", "{\"format\":\"png\"}");
            var parsed = JsonNode.Parse(raw) as JsonObject;
            var data = parsed is null ? null : Json.Str(parsed, "data");
            if (string.IsNullOrEmpty(data)) throw new InvalidOperationException("capture produced no image");
            return new JsonObject { ["base64"] = data, ["width"] = 0, ["height"] = 0 };
        });

    /// <summary>
    /// Fetch a URL inside the page context (keeps cookies/login) and return the
    /// body as base64. Mirrors the Electron host's download path.
    /// </summary>
    internal Task<JsonObject> DownloadAsync(string viewId, string url, string savePath)
        => OnUi(async () =>
    {
        var core = Core(viewId);
        var expression = "(async () => {"
            + "const r = await fetch(" + System.Text.Json.JsonSerializer.Serialize(url) + ", { credentials: 'include' });"
            + "if (!r.ok) throw new Error('HTTP ' + r.status);"
            + "const b = await r.arrayBuffer();"
            + "const bytes = new Uint8Array(b);"
            + "if (bytes.length > " + MaxDownloadBytes + ") throw new Error('download too large (limit " + MaxDownloadBytes + " bytes, got ' + bytes.length + ')');"
            + "let bin = '';"
            + "for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));"
            + "return btoa(bin);"
            + "})()";
        var parameters = new JsonObject
        {
            ["expression"] = expression,
            ["awaitPromise"] = true,
            ["returnByValue"] = true,
        };
        var raw = await core.CallDevToolsProtocolMethodAsync("Runtime.evaluate", parameters.ToJsonString());
        var parsed = JsonNode.Parse(raw) as JsonObject;
        var value = parsed is not null && parsed["result"] is JsonObject result ? Json.Str(result, "value") : null;
        if (string.IsNullOrEmpty(value))
        {
            var detail = parsed?["exceptionDetails"]?["exception"]?["description"]?.GetValue<string>();
            throw new InvalidOperationException("download failed: " + (detail ?? "no data"));
        }
        return new JsonObject { ["base64"] = value, ["savePath"] = savePath };
    });

    /// <summary>Read (and clear) the most recent auto-accepted dialog for a view.</summary>
    internal JsonNode? DrainDialog(string viewId)
    {
        var entry = Entry(viewId);
        var log = entry.DialogLog;
        entry.DialogLog = null;
        return log;
    }

    internal Task<JsonObject> FlushAuthAsync(string viewId)
        => OnUi(async () =>
    {
        var cookies = await Core(viewId).CookieManager.GetCookiesAsync(null);
        return new JsonObject { ["cookies"] = CookieAuth.Export(cookies) };
    });

    internal Task<JsonObject> RestoreAuthAsync(string viewId, JsonArray cookies)
        => OnUi(async () =>
    {
        var manager = Core(viewId).CookieManager;
        var restored = 0;
        foreach (var node in cookies)
        {
            if (CookieAuth.RestoreOne(manager, node)) restored++;
        }
        return new JsonObject { ["restored"] = restored };
    });

    internal Task<JsonObject> ClearCookiesAsync(string viewId, string? domain, string? name, bool all)
        => OnUi(async () =>
    {
        var manager = Core(viewId).CookieManager;
        var cookies = await manager.GetCookiesAsync(null);
        var targets = CookieAuth.SelectForClear(cookies, domain, name, all);
        // CoreWebView2CookieManager.DeleteCookie takes the live cookie object,
        // so resolve each selected target back to it by name + domain + path.
        var names = new JsonArray();
        foreach (var target in targets)
        {
            var match = cookies.FirstOrDefault(cookie =>
                cookie.Name == target.Name
                && cookie.Domain == target.Domain
                && (string.IsNullOrEmpty(cookie.Path) ? "/" : cookie.Path) == target.Path);
            if (match is null) continue;
            manager.DeleteCookie(match);
            names.Add(target.Name);
        }
        return new JsonObject { ["removed"] = names.Count, ["names"] = names };
    });

    // -------------------------------------------------------------- state

    internal void AppendTrace(string viewId, JsonObject entry)
    {
        lock (_gate)
        {
            if (!_traces.TryGetValue(viewId, out var list))
            {
                list = new List<JsonObject>();
                _traces[viewId] = list;
            }
            list.Add(entry);
            if (list.Count > MaxTraceEntries) list.RemoveRange(0, list.Count - MaxTraceEntries);
            if (_views.TryGetValue(viewId, out var view))
            {
                var action = Json.Str(entry, "action");
                if (action is not null)
                {
                    var state = EnsureState(view.TaskKey);
                    state.LatestAction = action.Length > 120 ? action[..120] : action;
                    state.UpdatedAt = Json.NowMs();
                }
            }
        }
    }

    private TaskState EnsureState(string taskKey)
    {
        if (!_taskStates.TryGetValue(taskKey, out var state))
        {
            state = new TaskState();
            _taskStates[taskKey] = state;
        }
        return state;
    }

    internal void UpdateTask(string taskKey, JsonObject update)
    {
        lock (_gate)
        {
            var state = EnsureState(taskKey);
            var status = Json.Str(update, "status");
            if (status is "idle" or "running" or "waiting-user" or "failed") state.Status = status;
            var control = Json.Str(update, "control");
            if (control is "agent" or "human") state.Control = control;
            var latestAction = Json.Str(update, "latestAction");
            if (latestAction is not null) state.LatestAction = latestAction.Length > 120 ? latestAction[..120] : latestAction;
            var error = Json.Str(update, "error");
            if (error is not null) state.Error = error.Length > 180 ? error[..180] : error;
            else if (state.Status != "failed") state.Error = null;
            state.UpdatedAt = Json.NowMs();
        }
    }

    internal JsonObject? GetTask(string taskKey)
    {
        lock (_gate) return Summarize(taskKey);
    }

    internal JsonArray ListTasks()
    {
        lock (_gate)
        {
            var array = new JsonArray();
            foreach (var taskKey in _activeViewByTask.Keys) 
            {
                var summary = Summarize(taskKey);
                if (summary is not null) array.Add(summary);
            }
            return array;
        }
    }

    internal JsonArray ListWindows()
    {
        lock (_gate)
        {
            var array = new JsonArray();
            foreach (var taskKey in _activeViewByTask.Keys)
            {
                array.Add(new JsonObject
                {
                    ["key"] = taskKey,
                    ["label"] = _taskLabels.TryGetValue(taskKey, out var label) ? label : "",
                });
            }
            return array;
        }
    }

    private JsonObject? Summarize(string taskKey)
    {
        if (!_activeViewByTask.TryGetValue(taskKey, out var viewId)) return null;
        if (!_views.TryGetValue(viewId, out var view)) return null;
        var state = EnsureState(taskKey);
        var latest = _traces.TryGetValue(viewId, out var list) && list.Count > 0 ? list[^1] : null;
        var summary = new JsonObject
        {
            ["key"] = taskKey,
            ["label"] = _taskLabels.TryGetValue(taskKey, out var label) ? label : "",
            ["active"] = taskKey == _visibleTaskKey,
            ["background"] = taskKey != _visibleTaskKey,
            ["url"] = TaskSummaryUrl(view.Url),
            ["tabs"] = _taskViewIds.TryGetValue(taskKey, out var ids) ? ids.Count : 0,
            ["status"] = state.Status,
            ["control"] = state.Control,
            ["updatedAt"] = state.UpdatedAt,
            ["thumbnailVersion"] = 0,
        };
        if (latest is not null)
        {
            var action = Json.Str(latest, "action");
            var at = Json.Num(latest, "at");
            if (action is not null && at is not null)
            {
                summary["latest"] = new JsonObject { ["action"] = action, ["at"] = at.Value };
            }
        }
        if (state.Error is not null) summary["error"] = state.Error;
        return summary;
    }

    private static string SafeUrl(CoreWebView2 core)
    {
        try { return core.Source; } catch { return ""; }
    }

    /// <summary>Strip path/query/hash so a task summary never leaks a full URL.</summary>
    internal static string TaskSummaryUrl(string url)
    {
        if (string.IsNullOrEmpty(url)) return "";
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return url;
        if (uri.Scheme is "http" or "https") return uri.GetLeftPart(UriPartial.Authority);
        return uri.Scheme + ":";
    }

    /// <summary>Install the page-side task-action binding on every document.</summary>
    private static string BindingScript() =>
        "(() => {\n"
        + "  if (window.__dshBrowserTaskActionInstalled) return;\n"
        + "  window.__dshBrowserTaskActionInstalled = true;\n"
        + "  window.__dshBrowserTaskAction = (payload) => {\n"
        + "    try {\n"
        + "      if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage(String(payload));\n"
        + "    } catch (error) { /* host gone */ }\n"
        + "  };\n"
        + "})();";

    private static string DialogKind(CoreWebView2ScriptDialogKind kind) => kind switch
    {
        CoreWebView2ScriptDialogKind.Alert => "alert",
        CoreWebView2ScriptDialogKind.Confirm => "confirm",
        CoreWebView2ScriptDialogKind.Prompt => "prompt",
        CoreWebView2ScriptDialogKind.Beforeunload => "beforeunload",
        _ => "alert",
    };

    /// <summary>Close the window; the process then exits via the form's closed event.</summary>
    internal void CloseWindow()
    {
        try { _form.BeginInvoke(() => _form.Close()); } catch { /* already closing */ }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try { _form.Dispose(); } catch { /* already disposed */ }
    }
}

/// <summary>Bridge from a page's postMessage to the RPC parent.</summary>
internal static class HostBridge
{
    internal static event Action<string, string>? Message;
    internal static void Publish(string viewId, string payload) => Message?.Invoke(viewId, payload);
}
