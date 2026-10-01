using System.Windows.Forms;

namespace DshBrowserPlusHost;

/// <summary>
/// dsh-browser-plus WebView2 host entry point.
///
/// Spawned by RemoteElectronViewHost with <c>--rpc-port &lt;port&gt;</c>; connects
/// back to the parent's loopback listener and serves line-delimited JSON-RPC
/// until the parent closes the socket (the parent owns this process's lifetime,
/// so no zombie window is left behind).
/// </summary>
internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        var port = ParsePort(args);
        if (port <= 0)
        {
            Console.Error.WriteLine("[dsh-browser-plus host] missing or invalid --rpc-port");
            return 1;
        }

        ApplicationConfiguration.Initialize();
        using var host = new BrowserHost();
        var server = new RpcServer(host, port);

        // The form is the main window; the RPC loop runs beside it. When either
        // side ends, the process must exit so no window outlives the parent.
        _ = Task.Run(async () =>
        {
            try
            {
                await server.RunAsync();
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("[dsh-browser-plus host] rpc failed: " + ex.Message);
            }
            finally
            {
                host.CloseWindow();
                await server.DisposeAsync();
            }
        });

        try
        {
            // Create the WebView2 environment before the window is shown so the
            // first createView can attach a controller immediately.
            host.StartAsync().GetAwaiter().GetResult();
            Application.Run();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[dsh-browser-plus host] fatal: " + ex);
            return 1;
        }
        return 0;
    }

    private static int ParsePort(string[] args)
    {
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "--rpc-port" && int.TryParse(args[i + 1], out var port)) return port;
        }
        return 0;
    }
}
