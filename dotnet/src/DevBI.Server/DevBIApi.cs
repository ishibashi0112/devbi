// DevBI's read-only API in C#: GET …/api/schema lists the SQL files, POST …/api/query runs one on SQL Server and
// answers with Arrow. The same contract as devbi-serve (docs/reference.md, "API の形"): the same paths, status codes,
// headers and Japanese messages, so a dashboard reads either one the same way. Hosts: DevBI.Server.AspNetCore
// (ASP.NET Core) and DevBI.Server.SystemWeb (ASP.NET on .NET Framework: WebForms, MVC 5, Web API 2).
using System;
using System.Collections.Generic;
using System.Data.Common;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace DevBI.Server
{
    public sealed class DevBIOptions
    {
        /// <summary>The folder that holds <c>api/*.sql</c>. Keep it where the web server does not send files (App_Data).</summary>
        public string Directory { get; set; } = "";

        /// <summary>
        /// A new, closed connection for a connection name: <c>DEVBI_DB</c>, or <c>DEVBI_DB_ERP</c> for a file with
        /// <c>-- connection: erp</c>. Null when there is none. Give it a user that may only SELECT.
        /// </summary>
        public Func<string, DbConnection?>? Connect { get; set; }

        /// <summary>Most rows one request may return (1 or more). Default 1,000,000.</summary>
        public int MaxRows { get; set; } = 1_000_000;

        /// <summary>
        /// How long one query may run, reading its rows included: up to 24 days. Default 60 seconds.
        /// <see cref="TimeSpan.Zero"/>: no limit.
        /// </summary>
        public TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(60);

        /// <summary>
        /// Send database errors to the browser as they are (they can name tables and columns). Off: the browser gets a
        /// short message and <see cref="Log"/> gets the details.
        /// </summary>
        public bool ExposeErrors { get; set; }

        /// <summary>Where one line per request and the details of errors go. Default: nowhere.</summary>
        public Action<string>? Log { get; set; }
    }

    /// <summary>What a host passes on from the HTTP request.</summary>
    public sealed class ApiRequest
    {
        /// <summary><c>schema</c> or <c>query</c>: see <see cref="DevBIApi.ActionOf"/>.</summary>
        public string Action { get; set; } = "";
        public string Method { get; set; } = "GET";
        public string? ContentType { get; set; }
        public string? AcceptEncoding { get; set; }
        public Stream Body { get; set; } = Stream.Null;
    }

    /// <summary>What a host sends back: the status, the headers (Content-Type among them) and the body.</summary>
    public sealed class ApiResponse
    {
        public ApiResponse(int status, IDictionary<string, string> headers, byte[] body)
        {
            Status = status;
            Headers = headers;
            Body = body;
        }

        public int Status { get; }
        public IDictionary<string, string> Headers { get; }
        public byte[] Body { get; }
    }

    /// <summary>A problem with the request, with its HTTP status.</summary>
    public sealed class ApiException : Exception
    {
        public ApiException(int status, string message) : base(message)
        {
            Status = status;
        }

        public int Status { get; }
    }

    /// <summary>The Arrow IPC stream of one query, and its row count.</summary>
    public sealed class QueryResult
    {
        public QueryResult(byte[] bytes, int rows)
        {
            Bytes = bytes;
            Rows = rows;
        }

        public byte[] Bytes { get; }
        public int Rows { get; }
    }

    public sealed class DevBIApi
    {
        public const string ArrowStreamType = "application/vnd.apache.arrow.stream";
        private const int MaxBody = 64 * 1024;
        private const string TimeoutHint = "DevBIOptions.Timeout で延ばせます";

        private static readonly JsonWriterOptions JsonOptions = new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
        private static readonly Regex ApiPath = new Regex("/api/(schema|query)\\z", RegexOptions.CultureInvariant);
        private static readonly Regex Gzip = new Regex("\\bgzip\\b", RegexOptions.CultureInvariant);
        private static readonly Regex Json = new Regex("^application/json\\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        private readonly DevBIOptions options;

        public DevBIApi(DevBIOptions options)
        {
            if (string.IsNullOrEmpty(options.Directory)) throw new ArgumentException("DevBIOptions.Directory（api/*.sql のあるフォルダ）がありません", nameof(options));
            if (options.Connect == null) throw new ArgumentException("DevBIOptions.Connect（接続を作る関数）がありません", nameof(options));
            if (options.MaxRows < 1) throw new ArgumentOutOfRangeException(nameof(options), "DevBIOptions.MaxRows は 1 以上にしてください");
            SqlServerQuery.CheckTimeout(options.Timeout);
            this.options = options;
        }

        /// <summary>
        /// <c>schema</c> or <c>query</c> when the path ends in <c>/api/schema</c> or <c>/api/query</c> (whatever comes
        /// before, so the API sits next to the dashboards under any path), otherwise null.
        /// </summary>
        public static string? ActionOf(string path)
        {
            var m = ApiPath.Match(path);
            return m.Success ? m.Groups[1].Value : null;
        }

        private void Log(string line) => options.Log?.Invoke(line);

        /// <summary>Answer one request: never throws for a problem with the request or the database (those are answers).</summary>
        public async Task<ApiResponse> HandleAsync(ApiRequest request, CancellationToken cancellationToken = default)
        {
            try
            {
                var method = request.Method.ToUpperInvariant();
                if (request.Action == "schema")
                {
                    if (method != "GET" && method != "HEAD") throw new ApiException(405, "GET で呼んでください");
                    return JsonResponse(200, SchemaJson());
                }
                if (request.Action == "query")
                {
                    if (method != "POST") throw new ApiException(405, "POST で呼んでください");
                    return await QueryAsync(request, cancellationToken).ConfigureAwait(false);
                }
                throw new ApiException(404, "ありません");
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception e)
            {
                var status = e is ApiException a ? a.Status : e is DatasetException d ? d.Status : 500;
                if (status >= 500) Log(e.Message);
                return JsonResponse(status, w => w.WriteString("error", e.Message));
            }
        }

        private static ApiResponse JsonResponse(int status, Action<Utf8JsonWriter> write)
        {
            using (var stream = new MemoryStream())
            {
                using (var w = new Utf8JsonWriter(stream, JsonOptions))
                {
                    w.WriteStartObject();
                    write(w);
                    w.WriteEndObject();
                }
                var headers = new Dictionary<string, string> { ["Content-Type"] = "application/json; charset=utf-8", ["Cache-Control"] = "no-store" };
                return new ApiResponse(status, headers, stream.ToArray());
            }
        }

        /// <summary>The names of the SQL files in <c>api/</c>, sorted.</summary>
        public IReadOnlyList<string> ListDatasets()
        {
            var dir = Path.Combine(options.Directory, "api");
            if (!System.IO.Directory.Exists(dir)) return new string[0];
            return System.IO.Directory.GetFiles(dir, "*.sql")
                .Select(Path.GetFileName)
                .Where(f => f != null && f.EndsWith(".sql", StringComparison.Ordinal) && !f.StartsWith(".", StringComparison.Ordinal))
                .Select(f => f!.Substring(0, f.Length - ".sql".Length))
                .OrderBy(n => n, StringComparer.Ordinal)
                .ToList();
        }

        /// <summary>The text of <c>api/&lt;name&gt;.sql</c>. Throws <see cref="DatasetException"/> (404 when there is no such file).</summary>
        public string ReadDatasetText(string name)
        {
            // Only names of files that are there: no paths from the request reach the file system.
            if (!ListDatasets().Contains(name, StringComparer.Ordinal)) throw new DatasetException($"API の SQL {name} はありません（api/{name}.sql）", 404);
            return File.ReadAllText(Path.Combine(options.Directory, "api", name + ".sql"), new UTF8Encoding(false));
        }

        /// <summary>
        /// <c>GET …/api/schema</c>'s datasets. Snapshots are not made here (devbi-snapshot makes them), so its
        /// <c>snapshots</c> list is empty.
        /// </summary>
        private Action<Utf8JsonWriter> SchemaJson()
        {
            var entries = new List<Action<Utf8JsonWriter>>();
            foreach (var name in ListDatasets())
            {
                try
                {
                    var d = Dataset.Parse(name, ReadDatasetText(name));
                    entries.Add(w =>
                    {
                        w.WriteString("name", name);
                        w.WriteString("description", d.Description);
                        w.WriteStartArray("params");
                        foreach (var p in d.Params) w.WriteStringValue(p);
                        w.WriteEndArray();
                        w.WriteString("connection", Dataset.ConnectionVariable(d.Connection));
                        if (d.Snapshot != null)
                        {
                            w.WriteStartArray("snapshot");
                            foreach (var t in d.Snapshot) w.WriteStringValue(t);
                            w.WriteEndArray();
                        }
                    });
                }
                catch (Exception e) when (e is DatasetException || e is IOException || e is UnauthorizedAccessException)
                {
                    var message = e.Message;
                    entries.Add(w =>
                    {
                        w.WriteString("name", name);
                        w.WriteString("error", message);
                    });
                }
            }
            return w =>
            {
                w.WriteStartArray("datasets");
                foreach (var entry in entries)
                {
                    w.WriteStartObject();
                    entry(w);
                    w.WriteEndObject();
                }
                w.WriteEndArray();
                w.WriteStartArray("snapshots");
                w.WriteEndArray();
            };
        }

        /// <summary>
        /// Run <c>api/&lt;name&gt;.sql</c> with the parameters (text, numbers, booleans or null): the Arrow IPC stream
        /// <c>POST …/api/query</c> answers, and its row count. Throws <see cref="ApiException"/> or <see cref="DatasetException"/>.
        /// </summary>
        public async Task<QueryResult> RunAsync(string name, IEnumerable<KeyValuePair<string, object?>>? parameters = null, CancellationToken cancellationToken = default)
        {
            var text = ReadDatasetText(name);
            var connectionName = Dataset.ConnectionVariable(Dataset.ConnectionOf(text));
            var connection = options.Connect!(connectionName);
            if (connection == null) throw new ApiException(500, $"接続先がありません。{connectionName} の接続を DevBIOptions.Connect で返してください");
            try
            {
                try
                {
                    await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
                }
                catch (Exception e) when (!(e is OperationCanceledException && cancellationToken.IsCancellationRequested))
                {
                    Log($"{connectionName}: {e.Message}");
                    throw new ApiException(500, options.ExposeErrors ? $"データベースにつなげません: {e.Message}" : "データベースにつなげません（くわしくはサーバーのログにあります）");
                }
                var dataset = Dataset.Parse(name, text);
                var bound = dataset.Bind((parameters ?? Enumerable.Empty<KeyValuePair<string, object?>>()).Select(p => new KeyValuePair<string, object?>(p.Key, Normalize(p.Value))));
                ResultSet result;
                try
                {
                    // One row past the limit tells whether there were more.
                    var read = options.MaxRows < int.MaxValue ? options.MaxRows + 1 : (int?)null;
                    result = await SqlServerQuery.RunAsync(connection, bound.Sql, bound.Values, read, options.Timeout, TimeoutHint, cancellationToken).ConfigureAwait(false);
                }
                catch (Exception e) when (!(e is OperationCanceledException && cancellationToken.IsCancellationRequested))
                {
                    Log($"api/{name}.sql: {e.Message}");
                    throw new ApiException(500, options.ExposeErrors ? $"api/{name}.sql: {e.Message}" : $"api/{name}.sql を実行できませんでした（くわしくはサーバーのログにあります）");
                }
                if (result.Rows.Count > options.MaxRows)
                {
                    throw new ApiException(422, $"api/{name}.sql の結果が {options.MaxRows.ToString("N0", CultureInfo.InvariantCulture)} 行を超えました。SQL の WHERE で絞ってください");
                }
                return new QueryResult(ArrowStream.Write(result), result.Rows.Count);
            }
            finally
            {
                connection.Dispose();
            }
        }

        /// <summary>Numbers as JSON gives them (<see cref="long"/> when whole, otherwise <see cref="double"/>); others as they are.</summary>
        private static object? Normalize(object? v)
        {
            switch (v)
            {
                case int i:
                    return (long)i;
                case short s:
                    return (long)s;
                case byte b:
                    return (long)b;
                case float f:
                    return Normalize((double)f);
                case decimal m:
                    return Normalize((double)m);
                // whole numbers as BIGINT up to its limit, as Node's mssql package sends them (2^63 is a double exactly)
                case double d when Math.Floor(d) == d && Math.Abs(d) < 9223372036854775808.0:
                    return (long)d;
                default:
                    return v;
            }
        }

        private async Task<ApiResponse> QueryAsync(ApiRequest request, CancellationToken cancellationToken)
        {
            if (!Json.IsMatch(request.ContentType ?? ""))
            {
                // JSON only: a page on another site cannot send it without the browser asking this server first (CORS).
                throw new ApiException(415, "Content-Type: application/json で送ってください");
            }
            var body = await ReadBody(request.Body, cancellationToken).ConfigureAwait(false);
            string? name = null;
            List<KeyValuePair<string, object?>> parameters;
            try
            {
                using (var doc = JsonDocument.Parse(body))
                {
                    parameters = ReadRequest(doc.RootElement, out name);
                }
            }
            // InvalidOperationException: text that is not UTF-16 (a lone surrogate, "\ud800")
            catch (Exception e) when (e is JsonException || e is InvalidOperationException)
            {
                throw new ApiException(400, "リクエストの JSON を読めません");
            }
            var started = Stopwatch.StartNew();
            var result = await RunAsync(name!, parameters, cancellationToken).ConfigureAwait(false);
            var bytes = result.Bytes;
            var headers = new Dictionary<string, string>
            {
                ["Content-Type"] = ArrowStreamType,
                ["Cache-Control"] = "no-store",
                ["X-DevBI-Rows"] = result.Rows.ToString(CultureInfo.InvariantCulture),
                ["Vary"] = "Accept-Encoding",
            };
            // Arrow keeps text as it is: gzip makes it several times smaller on the way.
            if (bytes.Length > 8192 && Gzip.IsMatch(request.AcceptEncoding ?? ""))
            {
                using (var zipped = new MemoryStream())
                {
                    using (var gzip = new GZipStream(zipped, CompressionLevel.Fastest, leaveOpen: true)) gzip.Write(bytes, 0, bytes.Length);
                    bytes = zipped.ToArray();
                }
                headers["Content-Encoding"] = "gzip";
            }
            Log($"api/{name}.sql: {result.Rows.ToString("N0", CultureInfo.InvariantCulture)} 行、{started.ElapsedMilliseconds} ms");
            return new ApiResponse(200, headers, bytes);
        }

        private static async Task<byte[]> ReadBody(Stream body, CancellationToken cancellationToken)
        {
            using (var buffer = new MemoryStream())
            {
                var chunk = new byte[8192];
                int n;
                while ((n = await body.ReadAsync(chunk, 0, chunk.Length, cancellationToken).ConfigureAwait(false)) > 0)
                {
                    if (buffer.Length + n > MaxBody) throw new ApiException(413, "リクエストが大きすぎます");
                    buffer.Write(chunk, 0, n);
                }
                return buffer.ToArray();
            }
        }

        /// <summary><c>{ "name": "orders", "params": { "from": "2024-04-01" } }</c>: the name, and the parameters in order.</summary>
        private static List<KeyValuePair<string, object?>> ReadRequest(JsonElement root, out string? name)
        {
            name = null;
            JsonElement? parameters = null;
            if (root.ValueKind == JsonValueKind.Object)
            {
                // the last one when a key comes twice, like JSON.parse
                foreach (var p in root.EnumerateObject())
                {
                    if (p.Name == "name") name = p.Value.ValueKind == JsonValueKind.String ? p.Value.GetString() : null;
                    else if (p.Name == "params") parameters = p.Value;
                }
            }
            if (string.IsNullOrEmpty(name)) throw new ApiException(400, "name（api/ の SQL ファイルの名前）がありません");
            var output = new List<KeyValuePair<string, object?>>();
            if (parameters == null) return output;
            if (parameters.Value.ValueKind != JsonValueKind.Object) throw new ApiException(400, "params はオブジェクトで送ってください");
            foreach (var p in parameters.Value.EnumerateObject())
            {
                var value = ValueOf(p.Value);
                var at = output.FindIndex(q => q.Key == p.Name);
                // a key that comes twice keeps its first place and its last value, like JSON.parse
                if (at >= 0) output[at] = new KeyValuePair<string, object?>(p.Name, value);
                else output.Add(new KeyValuePair<string, object?>(p.Name, value));
            }
            return output;
        }

        /// <summary>A JSON value as Bind takes it: text, a number, a boolean, null, or (an object or an array) the element, which Bind refuses.</summary>
        internal static object? ValueOf(JsonElement v)
        {
            switch (v.ValueKind)
            {
                case JsonValueKind.String:
                    return v.GetString();
                case JsonValueKind.Number:
                    return Normalize(v.GetDouble());
                case JsonValueKind.True:
                    return true;
                case JsonValueKind.False:
                    return false;
                case JsonValueKind.Null:
                    return null;
                default:
                    return v.Clone();
            }
        }
    }
}
