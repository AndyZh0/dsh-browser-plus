using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;

namespace DshBrowserPlusHost;

/// <summary>
/// Line-delimited JSON-RPC over a loopback TCP socket, the same wire protocol
/// the Electron host spoke. The parent listens on an ephemeral port and passes
/// it via --rpc-port; this side connects back, which keeps the parent in charge
/// of the child's lifetime: when the socket closes, the host exits.
/// </summary>
internal sealed class RpcServer : IAsyncDisposable
{
    private readonly BrowserHost _host;
    private readonly int _port;
    private readonly TaskCompletionSource _closed = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private TcpClient? _client;
    private StreamWriter? _writer;
    private readonly SemaphoreSlim _writeLock = new(1, 1);

    internal RpcServer(BrowserHost host, int port)
    {
        _host = host;
        _port = port;
        // Page-side actions (task switch, control handoff, panel toggles) are
        // unsolicited: they go to the parent as event lines, not as replies.
        HostBridge.Message += OnPageAction;
    }

    private void OnPageAction(string viewId, string payload)
    {
        var line = Json.Serialize(new JsonObject
        {
            ["event"] = "page-action",
            ["viewId"] = viewId,
            ["payload"] = payload,
        });
        _ = ReplyAsync(line);
    }

    /// <summary>Completes when the parent closes the connection or the socket fails.</summary>
    internal Task Closed => _closed.Task;

    internal async Task RunAsync()
    {
        _client = new TcpClient();
        await _client.ConnectAsync("127.0.0.1", _port);
        _client.NoDelay = true;
        var stream = _client.GetStream();
        _writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true };
        Console.Error.WriteLine("[dsh-browser-plus host] connected to parent on port " + _port);
        var reader = new StreamReader(stream, Encoding.UTF8);
        try
        {
            while (true)
            {
                var line = await reader.ReadLineAsync();
                if (line is null) break;
                line = line.Trim();
                if (line.Length == 0) continue;
                _ = DispatchAsync(line);
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[dsh-browser-plus host] socket error: " + ex.Message);
        }
        finally
        {
            Console.Error.WriteLine("[dsh-browser-plus host] parent connection closed, exiting");
            _closed.TrySetResult();
        }
    }

    private async Task DispatchAsync(string line)
    {
        JsonObject message;
        int id;
        try
        {
            message = Json.ParseObject(line);
            if (message["id"] is not JsonValue idValue || !idValue.TryGetValue<int>(out id)) return;
        }
        catch
        {
            return; // non-protocol noise
        }
        try
        {
            var result = await HandleAsync(message);
            await ReplyAsync(Json.Reply(id, result));
        }
        catch (Exception ex)
        {
            await ReplyAsync(Json.Reply(id, null, ex.Message));
        }
    }

    private async Task<JsonNode?> HandleAsync(JsonObject message)
    {
        var op = Json.Str(message, "op") ?? throw new InvalidOperationException("missing op");
        var viewId = Json.Str(message, "viewId");
        switch (op)
        {
            case "ping":
                return null;

            case "createView":
            {
                var id = viewId ?? throw new InvalidOperationException("createView missing viewId");
                var key = Json.Str(message, "key") ?? "default";
                await _host.CreateViewAsync(id, key, Json.Str(message, "label"));
                return null;
            }

            case "destroyView":
                await _host.DestroyViewAsync(viewId ?? throw new InvalidOperationException("destroyView missing viewId"));
                return null;

            case "showView":
                await _host.ShowViewAsync(viewId ?? throw new InvalidOperationException("showView missing viewId"));
                return null;

            case "label":
            {
                var id = viewId ?? throw new InvalidOperationException("label missing viewId");
                var label = Json.Str(message, "label") ?? throw new InvalidOperationException("label missing label");
                await _host.LabelAsync(id, label);
                return null;
            }

            case "trace":
            {
                var id = viewId ?? throw new InvalidOperationException("trace missing viewId");
                var entry = Json.Obj(message, "entry") ?? throw new InvalidOperationException("trace missing entry");
                _host.AppendTrace(id, entry);
                return null;
            }

            case "drainDialog":
                return _host.DrainDialog(viewId ?? throw new InvalidOperationException("drainDialog missing viewId"));

            case "configure":
                await _host.ConfigureAsync(Json.Str(message, "chromeScript"));
                return null;

            case "eval":
            {
                var id = viewId ?? throw new InvalidOperationException("eval missing viewId");
                var source = Json.Str(message, "source") ?? throw new InvalidOperationException("eval missing source");
                await _host.EvalAsync(id, source);
                return null;
            }

            case "command":
            {
                var id = viewId ?? throw new InvalidOperationException("command missing viewId");
                var method = Json.Str(message, "method") ?? throw new InvalidOperationException("command missing method");
                var parameters = Json.Obj(message, "params") ?? new JsonObject();
                return await _host.CommandAsync(id, method, parameters);
            }

            case "capture":
                return await _host.CaptureAsync(viewId ?? throw new InvalidOperationException("capture missing viewId"));

            case "download":
            {
                var id = viewId ?? throw new InvalidOperationException("download missing viewId");
                var url = Json.Str(message, "url") ?? throw new InvalidOperationException("download missing url");
                var savePath = Json.Str(message, "savePath") ?? throw new InvalidOperationException("download missing savePath");
                return await _host.DownloadAsync(id, url, savePath);
            }

            case "flushAuth":
                return await _host.FlushAuthAsync(viewId ?? throw new InvalidOperationException("flushAuth missing viewId"));

            case "restoreAuth":
            {
                var id = viewId ?? throw new InvalidOperationException("restoreAuth missing viewId");
                var cookies = Json.Arr(message, "cookies") ?? throw new InvalidOperationException("restoreAuth missing cookies");
                return await _host.RestoreAuthAsync(id, cookies);
            }

            case "clearCookies":
            {
                var id = viewId ?? throw new InvalidOperationException("clearCookies missing viewId");
                return await _host.ClearCookiesAsync(
                    id,
                    Json.Str(message, "domain"),
                    Json.Str(message, "name"),
                    Json.Bool(message, "all") ?? false);
            }

            case "listWindows":
                return new JsonObject { ["windows"] = _host.ListWindows() };

            case "listTasks":
                return new JsonObject { ["tasks"] = _host.ListTasks() };

            case "getTask":
                return new JsonObject { ["task"] = _host.GetTask(Json.Str(message, "key") ?? throw new InvalidOperationException("getTask missing key")) };

            case "updateTask":
            {
                var key = Json.Str(message, "key") ?? throw new InvalidOperationException("updateTask missing key");
                var task = Json.Obj(message, "task") ?? throw new InvalidOperationException("updateTask missing task");
                _host.UpdateTask(key, task);
                return new JsonObject { ["task"] = _host.GetTask(key) };
            }

            default:
                throw new InvalidOperationException("unknown op " + op);
        }
    }

    private async Task ReplyAsync(string line)
    {
        var writer = _writer;
        if (writer is null) return;
        await _writeLock.WaitAsync();
        try
        {
            await writer.WriteLineAsync(line);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[dsh-browser-plus host] reply failed: " + ex.Message);
            _closed.TrySetResult();
        }
        finally
        {
            _writeLock.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        try { _writer?.Dispose(); } catch { /* already closed */ }
        try { _client?.Dispose(); } catch { /* already closed */ }
        await Task.CompletedTask;
    }
}
