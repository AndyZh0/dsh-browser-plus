using System.Globalization;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;

namespace DshBrowserPlusHost;

/// <summary>
/// Cookie export / restore / scoped-clear, ported from auth-cookies.ts.
///
/// The clear path is the security-relevant one: an unscoped request must never
/// wipe every login in the profile, so it is refused unless the caller passes
/// an explicit <c>all: true</c>.
/// </summary>
internal static class CookieAuth
{
    /// <summary>One cookie selected for removal, with the URI CoreWebView2 needs.</summary>
    internal readonly record struct ClearTarget(string Name, string Domain, string Path, Uri Uri);

    /// <summary>Normalize a domain for comparison: drop one leading dot, lowercase.</summary>
    private static string NormalizeDomain(string domain)
    {
        var trimmed = domain.Trim().ToLowerInvariant();
        return trimmed.StartsWith('.') ? trimmed[1..] : trimmed;
    }

    /// <summary>Whether a cookie domain falls under a scope: itself or a subdomain.</summary>
    internal static bool MatchesDomain(string cookieDomain, string scope)
    {
        var cookie = NormalizeDomain(cookieDomain);
        var target = NormalizeDomain(scope);
        if (cookie.Length == 0 || target.Length == 0) return false;
        return cookie == target || cookie.EndsWith("." + target, StringComparison.Ordinal);
    }

    /// <summary>Build the URI required to address one cookie.</summary>
    private static Uri? RemovalUri(string domain, string path, bool secure)
    {
        if (domain.Length == 0) return null;
        var host = domain.StartsWith('.') ? domain[1..] : domain;
        if (host.Length == 0) return null;
        var hostPart = host.Contains(':') && !host.StartsWith('[') ? "[" + host + "]" : host;
        var pathPart = path.Length == 0 ? "/" : path;
        var text = (secure ? "https://" : "http://") + hostPart + pathPart;
        return Uri.TryCreate(text, UriKind.Absolute, out var uri) ? uri : null;
    }

    /// <summary>Portable auth record: cookies from any view can be moved between hosts.</summary>
    internal static JsonArray Export(IReadOnlyList<CoreWebView2Cookie> cookies)
    {
        var exported = new JsonArray();
        foreach (var cookie in cookies)
        {
            var domain = cookie.Domain;
            if (string.IsNullOrEmpty(domain)) continue;
            var uri = RemovalUri(domain, cookie.Path ?? "/", cookie.IsSecure);
            if (uri is null) continue;
            exported.Add(new JsonObject
            {
                ["url"] = uri.ToString(),
                ["name"] = cookie.Name,
                ["value"] = cookie.Value,
                ["domain"] = domain,
                ["path"] = string.IsNullOrEmpty(cookie.Path) ? "/" : cookie.Path,
                ["secure"] = cookie.IsSecure,
                ["httpOnly"] = cookie.IsHttpOnly,
                // CoreWebView2Cookie.Expires is a DateTime; the wire format is
                // Unix seconds, matching the Electron export. Session cookies
                // carry no expiry and stay null.
                ["expirationDate"] = ExpirySeconds(cookie.Expires),
            });
        }
        return exported;
    }

    /// <summary>Unix seconds for a cookie expiry, or null for a session cookie.</summary>
    private static double? ExpirySeconds(DateTime expires)
    {
        if (expires == default) return null;
        var utc = expires.Kind == DateTimeKind.Utc ? expires : expires.ToUniversalTime();
        return new DateTimeOffset(utc).ToUnixTimeMilliseconds() / 1000.0;
    }

    /// <summary>
    /// Which cookies a clear request targets. Refuses an unscoped request so a
    /// missing filter can never wipe every login.
    /// </summary>
    internal static List<ClearTarget> SelectForClear(
        IReadOnlyList<CoreWebView2Cookie> cookies,
        string? domainScope,
        string? nameScope,
        bool all)
    {
        var hasDomain = !string.IsNullOrWhiteSpace(domainScope);
        var hasName = !string.IsNullOrEmpty(nameScope);
        if (!hasDomain && !hasName && !all)
        {
            throw new InvalidOperationException(
                "cookie clear requires a domain or name filter; pass all: true to remove every cookie");
        }
        var targets = new List<ClearTarget>();
        foreach (var cookie in cookies)
        {
            var domain = cookie.Domain;
            if (string.IsNullOrEmpty(domain)) continue;
            if (hasDomain || hasName)
            {
                if (hasDomain && !MatchesDomain(domain, domainScope!)) continue;
                if (hasName && cookie.Name != nameScope) continue;
            }
            var uri = RemovalUri(domain, cookie.Path ?? "/", cookie.IsSecure);
            if (uri is null) continue;
            targets.Add(new ClearTarget(cookie.Name, domain, string.IsNullOrEmpty(cookie.Path) ? "/" : cookie.Path, uri));
        }
        return targets;
    }

    /// <summary>Apply one restore record to a cookie manager. Returns false for malformed input.</summary>
    internal static bool RestoreOne(CoreWebView2CookieManager manager, JsonNode? node)
    {
        if (node is not JsonObject record) return false;
        var url = Json.Str(record, "url");
        var name = Json.Str(record, "name");
        var value = Json.Str(record, "value");
        if (url is null || name is null || value is null) return false;
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return false;
        // CoreWebView2Cookie.Domain is read-only; the host in the URI is what
        // CoreWebView2 derives the cookie's domain from.
        var cookie = manager.CreateCookie(name, value, uri.Host, string.IsNullOrEmpty(Json.Str(record, "path")) ? "/" : Json.Str(record, "path")!);
        cookie.IsSecure = Json.Bool(record, "secure") ?? false;
        cookie.IsHttpOnly = Json.Bool(record, "httpOnly") ?? false;
        if (Json.Num(record, "expirationDate") is double seconds)
        {
            cookie.Expires = DateTimeOffset.FromUnixTimeMilliseconds((long)Math.Round(seconds * 1000)).UtcDateTime;
        }
        manager.AddOrUpdateCookie(cookie);
        return true;
    }
}
