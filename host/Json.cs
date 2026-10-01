using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace DshBrowserPlusHost;

/// <summary>
/// Small typed accessors over <see cref="JsonNode"/> so the RPC handlers read
/// like the TypeScript they replaced. Missing or mistyped fields return null
/// instead of throwing, which is what the original host did.
/// </summary>
internal static class Json
{
    private static readonly JsonSerializerOptions Options = new()
    {
        // The parent and host exchange compact one-line JSON; escaping is only
        // needed for correctness, not readability.
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    internal static JsonObject ParseObject(string line) =>
        JsonNode.Parse(line) as JsonObject ?? throw new FormatException("not a JSON object");

    internal static string Serialize(JsonNode node) => node.ToJsonString(Options);

    internal static string? Str(JsonObject o, string key) =>
        o.TryGetPropertyValue(key, out var node) && node is JsonValue value && value.TryGetValue<string>(out var s) ? s : null;

    internal static bool? Bool(JsonObject o, string key) =>
        o.TryGetPropertyValue(key, out var node) && node is JsonValue value && value.TryGetValue<bool>(out var b) ? b : null;

    internal static double? Num(JsonObject o, string key) =>
        o.TryGetPropertyValue(key, out var node) && node is JsonValue value && value.TryGetValue<double>(out var n) ? n : null;

    internal static int? Int(JsonObject o, string key) =>
        o.TryGetPropertyValue(key, out var node) && node is JsonValue value && value.TryGetValue<int>(out var n) ? n : null;

    internal static JsonObject? Obj(JsonObject o, string key) =>
        o.TryGetPropertyValue(key, out var node) ? node as JsonObject : null;

    internal static JsonArray? Arr(JsonObject o, string key) =>
        o.TryGetPropertyValue(key, out var node) ? node as JsonArray : null;

    /// <summary>Serialize one RPC reply line (a trailing newline is added by the writer).</summary>
    internal static string Reply(int id, JsonNode? result = null, string? error = null)
    {
        var payload = new JsonObject { ["id"] = id };
        if (error is null)
        {
            payload["ok"] = true;
            if (result is not null) payload["result"] = result;
        }
        else
        {
            payload["ok"] = false;
            payload["err"] = error;
        }
        return Serialize(payload);
    }

    /// <summary>Unix milliseconds, matching JavaScript's Date.now().</summary>
    internal static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    internal static string Invariant(double value) => value.ToString(CultureInfo.InvariantCulture);
}
