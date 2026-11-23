// DevBI's read-only API in C#: GET …/api/schema lists the SQL files, POST …/api/query runs one on SQL Server and
// answers with Arrow. The same contract as devbi-serve (docs/reference.md, "API の形"): the same paths, status codes,
// headers and Japanese messages, so a dashboard reads either one the same way. Hosts: DevBI.Server.AspNetCore
// (ASP.NET Core) and DevBI.Server.SystemWeb (ASP.NET on .NET Framework: WebForms, MVC 5, Web API 2). Row-level
// security (docs/design/row-level-security.md) as packages/server/src/handler.ts has it: the host hands over the
// signed-in user (ApiRequest.User), and api/*.sql filters by :user.<attribute>.
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

        /// <summary>
        /// Row-level mode whatever the files say (set it in production when the SQL filters by user): every request
        /// needs a signed-in user (401), and every <c>api/*.sql</c> must say who sees which rows (<c>:user.…</c> or
        /// <c>-- access: all</c>). Without it, the mode is on when the files use row-level security (<c>:user.</c>,
        /// <c>-- roles</c>, <c>-- access</c> in an <c>api/*.sql</c>, or an <c>access/</c> folder).
        /// </summary>
        public bool RequireUser { get; set; }

        /// <summary>How long what <c>access/user.sql</c> says of a user is kept. Default 60 seconds; <see cref="TimeSpan.Zero"/> reads it each time.</summary>
        public TimeSpan UserCache { get; set; } = TimeSpan.FromSeconds(60);
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

        /// <summary>The signed-in user (row-level security). Null: nobody signed in.</summary>
        public DevBIUser? User { get; set; }

        /// <summary>Added in parentheses to the message of a 401 (nobody signed in): how to sign in.</summary>
        public string? SignInHint { get; set; }
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
        /// <summary>Room for a multiple-value parameter: up to 1,000 values.</summary>
        private const int MaxBody = 256 * 1024;
        private const string TimeoutHint = "DevBIOptions.Timeout で延ばせます";

        private static readonly JsonWriterOptions JsonOptions = new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
        private static readonly Regex ApiPath = new Regex("/api/(schema|query)\\z", RegexOptions.CultureInvariant);
        private static readonly Regex Gzip = new Regex("\\bgzip\\b", RegexOptions.CultureInvariant);
        private static readonly Regex Json = new Regex("^application/json\\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        private const string NotSignedInMessage = "ログインしていません";
        private const string UserFile = "access/user.sql";
        /// <summary>Users kept from access/user.sql at most (the oldest go first).</summary>
        private const int MaxCachedUsers = 10_000;
        private static readonly Stopwatch Clock = Stopwatch.StartNew();

        private readonly DevBIOptions options;
        private int warnedNoMode;

        // What access/user.sql says of each user, kept options.UserCache (failures are not kept).
        private readonly object cacheLock = new object();
        private readonly Dictionary<string, CachedUser> userCache = new Dictionary<string, CachedUser>(StringComparer.Ordinal);
        private readonly LinkedList<string> cacheOrder = new LinkedList<string>();

        private sealed class CachedUser
        {
            public CachedUser(TimeSpan until, Task<TableUser?> value, LinkedListNode<string> node)
            {
                Until = until;
                Value = value;
                Node = node;
            }

            public TimeSpan Until { get; }
            public Task<TableUser?> Value { get; }
            public LinkedListNode<string> Node { get; }
        }

        /// <summary>Row-level mode, and why it is on (for the messages).</summary>
        private sealed class RowLevelMode
        {
            public RowLevelMode(bool on, string? why)
            {
                On = on;
                Why = why;
            }

            public bool On { get; }
            public string? Why { get; }
        }

        /// <summary>Who asks: the signed-in user the host handed over (none: not signed in), read with access/user.sql only when a check needs it.</summary>
        private sealed class Asker
        {
            private readonly DevBIApi api;
            private Task<Viewer>? full;

            public Asker(DevBIApi api, Viewer? viewer, string? hint)
            {
                this.api = api;
                Viewer = viewer;
                Hint = hint;
            }

            public Viewer? Viewer { get; }
            public string? Hint { get; }

            /// <summary>The user with what access/user.sql says (read once for the request).</summary>
            public Task<Viewer> Resolved()
            {
                if (Viewer == null) throw NotSignedIn(this);
                return full ??= Resolve(Viewer);
            }

            private async Task<Viewer> Resolve(Viewer viewer) => viewer.With(await api.TableUserAsync(viewer.Id).ConfigureAwait(false));
        }

        public DevBIApi(DevBIOptions options)
        {
            if (string.IsNullOrEmpty(options.Directory)) throw new ArgumentException("DevBIOptions.Directory（api/*.sql のあるフォルダ）がありません", nameof(options));
            if (options.Connect == null) throw new ArgumentException("DevBIOptions.Connect（接続を作る関数）がありません", nameof(options));
            if (options.MaxRows < 1) throw new ArgumentOutOfRangeException(nameof(options), "DevBIOptions.MaxRows は 1 以上にしてください");
            if (options.UserCache < TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(options), "DevBIOptions.UserCache は 0 以上にしてください");
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

        // One line each: a database's message, or a user's id, may hold line breaks.
        private void Log(string line) => options.Log?.Invoke(Access.LogSafe(line));

        /// <summary>The 401 for a request without a user, with the host's hint (how to sign in).</summary>
        private static ApiException NotSignedIn(Asker asker) =>
            new ApiException(401, asker.Hint != null ? $"{NotSignedInMessage}（{asker.Hint}）" : NotSignedInMessage);

        /// <summary>The asker of a request: the host's user, checked (an <see cref="ArgumentException"/> for a wrong attribute).</summary>
        private Asker AskerOf(DevBIUser? user, string? hint)
        {
            var h = hint == null ? "" : SqlText.Trim(hint);
            return new Asker(this, Viewer.Of(user), h.Length > 0 ? h : null);
        }

        /// <summary>
        /// Row-level mode: the host's <see cref="DevBIOptions.RequireUser"/>, or the project's files using row-level security
        /// (an <c>access/</c> folder, <c>:user.</c>, <c>-- roles</c> or <c>-- access</c> in the text of an <c>api/*.sql</c>).
        /// Read again for each request, like the SQL. A file that cannot be read now puts it on.
        /// </summary>
        private RowLevelMode Mode()
        {
            if (options.RequireUser) return new RowLevelMode(true, "ホストの設定 RequireUser");
            var access = Path.Combine(options.Directory, "access");
            if (System.IO.Directory.Exists(access) || File.Exists(access)) return new RowLevelMode(true, "access/ フォルダがあるため");
            foreach (var name in ListDatasets())
            {
                string text;
                try
                {
                    text = ReadText(name);
                }
                catch (Exception e) when (e is IOException || e is UnauthorizedAccessException)
                {
                    // a file that cannot be read now may be one that filters: on, rather than off
                    return new RowLevelMode(true, $"api/{name}.sql を読めないため");
                }
                var signal = Access.RowLevelSignal(text);
                if (signal != null) return new RowLevelMode(true, $"api/{name}.sql に {signal} があるため");
            }
            return new RowLevelMode(false, null);
        }

        private RowLevelMode ModeFor(Asker asker)
        {
            var mode = Mode();
            if (!mode.On && asker.Viewer != null && Interlocked.Exchange(ref warnedNoMode, 1) == 0)
            {
                Log("利用者を受け取っていますが、行レベルのモードになっていません（api/*.sql に :user. も -- access: もありません。本番では DevBIOptions.RequireUser を付けます）");
            }
            return mode;
        }

        /// <summary>What row-level mode refuses in a file (it does not say who sees which rows, or has a bare <c>:user</c>), or null.</summary>
        private static string? RowLevelProblem(Dataset dataset, RowLevelMode mode)
        {
            if (!mode.On) return null;
            var rel = $"api/{dataset.Name}.sql";
            var bare = dataset.Params.FirstOrDefault(Access.IsBareUser);
            if (bare != null) return $"{rel}: 行レベルのモードでは :{bare} は使えません。ログインした人の ID なら :user.id と書きます（行レベルのモード: {mode.Why}）";
            if ((dataset.User == null || dataset.User.Count == 0) && dataset.Access != "all")
            {
                return $"{rel} は、だれにどの行を見せるかが書いてありません。:user.… で絞るか、全員に全部の行を見せるなら -- access: all を書いてください（行レベルのモード: {mode.Why}）";
            }
            return null;
        }

        /// <summary>Row-level mode's rules for one file. Throws <see cref="DatasetException"/> (400).</summary>
        private static void CheckRowLevel(Dataset dataset, RowLevelMode mode)
        {
            var problem = RowLevelProblem(dataset, mode);
            if (problem != null) throw new DatasetException(problem, 400);
        }

        /// <summary>Whether the asker may read a file with these <c>-- roles:</c> (none: anyone the mode lets in).</summary>
        private static async Task<bool> MayReadAsync(IReadOnlyList<string>? roles, Asker asker)
        {
            if (roles == null) return true;
            if (asker.Viewer == null) return false;
            var v = await asker.Resolved().ConfigureAwait(false);
            return roles.Any(v.HasRole);
        }

        /// <summary>What access/user.sql says of a user, kept <see cref="DevBIOptions.UserCache"/>; null when there is no such file.</summary>
        private Task<TableUser?> TableUserAsync(string id)
        {
            lock (cacheLock)
            {
                var now = Clock.Elapsed;
                if (userCache.TryGetValue(id, out var kept))
                {
                    if (kept.Until > now) return kept.Value;
                    userCache.Remove(id);
                    cacheOrder.Remove(kept.Node);
                }
                // Not cancelled with one request: others may wait for the same answer (the time limit still holds).
                var value = Task.Run(() => LookUpAsync(id));
                if (options.UserCache > TimeSpan.Zero)
                {
                    // TimeSpan.MaxValue: kept as long as the server runs (rather than an overflow)
                    var until = options.UserCache >= TimeSpan.MaxValue - now ? TimeSpan.MaxValue : now + options.UserCache;
                    userCache[id] = new CachedUser(until, value, cacheOrder.AddLast(id));
                    if (userCache.Count > MaxCachedUsers)
                    {
                        var oldest = cacheOrder.First!;
                        cacheOrder.RemoveFirst();
                        userCache.Remove(oldest.Value);
                    }
                    value.ContinueWith(
                        _ =>
                        {
                            lock (cacheLock)
                            {
                                if (userCache.TryGetValue(id, out var entry) && entry.Value == value)
                                {
                                    userCache.Remove(id);
                                    cacheOrder.Remove(entry.Node);
                                }
                            }
                        },
                        CancellationToken.None,
                        TaskContinuationOptions.NotOnRanToCompletion | TaskContinuationOptions.ExecuteSynchronously,
                        TaskScheduler.Default);
                }
                return value;
            }
        }

        /// <summary>A new connection for a connection name, opened. Throws <see cref="ApiException"/> (500).</summary>
        private async Task<DbConnection> OpenAsync(string connectionName, CancellationToken cancellationToken)
        {
            var connection = options.Connect!(connectionName);
            if (connection == null) throw new ApiException(500, $"接続先がありません。{connectionName} の接続を DevBIOptions.Connect で返してください");
            try
            {
                await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
                return connection;
            }
            catch (Exception e) when (!(e is OperationCanceledException && cancellationToken.IsCancellationRequested))
            {
                connection.Dispose();
                Log($"{connectionName}: {e.Message}");
                throw new ApiException(500, options.ExposeErrors ? $"データベースにつなげません: {e.Message}" : "データベースにつなげません（くわしくはサーバーのログにあります）");
            }
            catch
            {
                connection.Dispose();
                throw;
            }
        }

        /// <summary>access/user.sql for one user: its attributes and roles. Throws <see cref="ApiException"/> (500).</summary>
        private async Task<TableUser?> LookUpAsync(string id)
        {
            string text;
            try
            {
                text = File.ReadAllText(Path.Combine(options.Directory, "access", "user.sql"), new UTF8Encoding(false));
            }
            catch (Exception e) when (e is FileNotFoundException || e is DirectoryNotFoundException)
            {
                return null;
            }
            var connectionName = Dataset.ConnectionVariable(Dataset.ConnectionOf(text));
            var connection = await OpenAsync(connectionName, CancellationToken.None).ConfigureAwait(false);
            try
            {
                Dataset d;
                try
                {
                    d = Dataset.Parse("user", text, UserFile);
                }
                catch (DatasetException e)
                {
                    throw new ApiException(500, e.Message);
                }
                var other = d.Params.Count > 0 ? d.Params[0] : (d.User ?? new string[0]).Where(a => a != "id").Select(a => "user." + a).FirstOrDefault();
                if (other != null) throw new ApiException(500, $"{UserFile}: 使えるパラメーターは :user.id だけです（:{other} があります）");
                if (d.User == null || !d.User.Contains("id")) throw new ApiException(500, $"{UserFile}: :user.id で、ログインした人の行を選んでください（WHERE u.login = :user.id）");
                if (d.Snapshot != null || d.Roles != null || d.Access != null || d.Key != null) throw new ApiException(500, $"{UserFile}: -- snapshot:・-- roles:・-- access:・-- key: は書けません");
                var bound = d.BindAs(new KeyValuePair<string, object?>[0], Viewer.IdOnly(id), false, UserFile);
                ResultSet result;
                try
                {
                    result = await SqlServerQuery.RunAsync(connection, bound.Sql, bound.Values, 2, options.Timeout, TimeoutHint, CancellationToken.None).ConfigureAwait(false);
                }
                catch (Exception e)
                {
                    Log($"{UserFile}: {e.Message}");
                    throw new ApiException(500, options.ExposeErrors ? $"{UserFile}: {e.Message}" : $"{UserFile} を実行できませんでした（くわしくはサーバーのログにあります）");
                }
                if (result.Rows.Count > 1) throw new ApiException(500, $"{UserFile} が利用者 {Access.LogSafe(id)} の行を 2 行以上返しました。1 人につき 1 行（いなければ 0 行）にしてください");
                try
                {
                    return Access.TableUserOf(result.Columns, result.Rows.Count > 0 ? result.Rows[0] : null);
                }
                catch (ArgumentException e)
                {
                    throw new ApiException(500, e.Message);
                }
            }
            finally
            {
                connection.Dispose();
            }
        }

        /// <summary>Answer one request: never throws for a problem with the request or the database (those are answers).</summary>
        public async Task<ApiResponse> HandleAsync(ApiRequest request, CancellationToken cancellationToken = default)
        {
            try
            {
                var method = request.Method.ToUpperInvariant();
                if (request.Action != "schema" && request.Action != "query") throw new ApiException(404, "ありません");
                var asker = AskerOf(request.User, request.SignInHint);
                var mode = ModeFor(asker);
                if (request.Action == "schema")
                {
                    if (method != "GET" && method != "HEAD") throw new ApiException(405, "GET で呼んでください");
                    return JsonResponse(200, await SchemaJsonAsync(asker, mode).ConfigureAwait(false));
                }
                if (method != "POST") throw new ApiException(405, "POST で呼んでください");
                return await QueryAsync(request, asker, mode, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception e)
            {
                var status = e is ApiException a ? a.Status : e is DatasetException d ? d.Status : 500;
                if (status >= 500) Log(e.Message);
                return JsonResponse(status, w =>
                {
                    w.WriteString("error", e.Message);
                    // A 401 of DevBI's own says it knows row-level security (devbi-check --url; a login in front has its own 401).
                    if (status == 401) w.WriteNumber("access", 1);
                });
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
            return ReadText(name);
        }

        /// <summary>The text of a file <see cref="ListDatasets"/> named.</summary>
        private string ReadText(string name) => File.ReadAllText(Path.Combine(options.Directory, "api", name + ".sql"), new UTF8Encoding(false));

        /// <summary>
        /// <c>GET …/api/schema</c>'s datasets: only those the asker may read (the others are not even named), then
        /// <c>"access": 1</c> (this server knows row-level security) and the signed-in user's id. Snapshots are not made
        /// here (devbi-snapshot makes them), so its <c>snapshots</c> list is empty.
        /// </summary>
        private async Task<Action<Utf8JsonWriter>> SchemaJsonAsync(Asker asker, RowLevelMode mode)
        {
            if (mode.On && asker.Viewer == null) throw NotSignedIn(asker);
            var entries = new List<Action<Utf8JsonWriter>>();
            foreach (var name in ListDatasets())
            {
                try
                {
                    var text = ReadText(name);
                    IReadOnlyList<string>? roles;
                    try
                    {
                        roles = Access.Read(text, $"api/{name}.sql").Roles;
                    }
                    catch (AccessLineException e)
                    {
                        throw new DatasetException(e.Message, 400);
                    }
                    if (!await MayReadAsync(roles, asker).ConfigureAwait(false)) continue;
                    var d = Dataset.Parse(name, text);
                    CheckRowLevel(d, mode);
                    entries.Add(w =>
                    {
                        w.WriteString("name", name);
                        w.WriteString("description", d.Description);
                        w.WriteStartArray("params");
                        foreach (var p in d.Params) w.WriteStringValue(p);
                        w.WriteEndArray();
                        w.WriteStartArray("parameters");
                        foreach (var p in d.Parameters) p.WriteJson(w);
                        w.WriteEndArray();
                        if (d.Key != null)
                        {
                            w.WriteStartArray("key");
                            foreach (var k in d.Key) w.WriteStringValue(k);
                            w.WriteEndArray();
                        }
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
                w.WriteNumber("access", 1);
                if (asker.Viewer != null)
                {
                    w.WriteStartObject("user");
                    w.WriteString("id", asker.Viewer.Id);
                    w.WriteEndObject();
                }
            };
        }

        /// <summary>
        /// Run <c>api/&lt;name&gt;.sql</c> with the parameters (text, numbers, booleans or null; a list such as <c>string[]</c> for
        /// a multiple-value parameter): the Arrow IPC stream <c>POST …/api/query</c> answers, and its row count. Without a
        /// user: as nobody signed in (row-level mode: 401). Throws <see cref="ApiException"/> or <see cref="DatasetException"/>.
        /// </summary>
        public Task<QueryResult> RunAsync(string name, IEnumerable<KeyValuePair<string, object?>>? parameters = null, CancellationToken cancellationToken = default) =>
            RunAsync(name, parameters, null, cancellationToken);

        /// <summary>
        /// <see cref="RunAsync(string, IEnumerable{KeyValuePair{string, object}}, CancellationToken)"/> as the signed-in
        /// user (row-level security): the same checks as <c>api/query</c>.
        /// </summary>
        public async Task<QueryResult> RunAsync(string name, IEnumerable<KeyValuePair<string, object?>>? parameters, DevBIUser? user, CancellationToken cancellationToken = default)
        {
            // async: a user of the wrong shape or a folder that cannot be read fails the task (is not thrown before it)
            var asker = AskerOf(user, null);
            return await RunAsAsync(name, parameters ?? Enumerable.Empty<KeyValuePair<string, object?>>(), asker, ModeFor(asker), cancellationToken).ConfigureAwait(false);
        }

        /// <summary>
        /// api/&lt;name&gt;.sql for this asker, in order: signed in (row-level mode), the file, its connection, the file's
        /// rules, its roles, the user with the attributes the SQL uses, the parameters; then the query.
        /// </summary>
        private async Task<QueryResult> RunAsAsync(string name, IEnumerable<KeyValuePair<string, object?>> parameters, Asker asker, RowLevelMode mode, CancellationToken cancellationToken)
        {
            if (mode.On && asker.Viewer == null) throw NotSignedIn(asker);
            var text = ReadDatasetText(name);
            var connection = await OpenAsync(Dataset.ConnectionVariable(Dataset.ConnectionOf(text)), cancellationToken).ConfigureAwait(false);
            try
            {
                var dataset = Dataset.Parse(name, text);
                CheckRowLevel(dataset, mode);
                Viewer? viewer = null;
                if (asker.Viewer == null)
                {
                    if (dataset.Roles != null) throw NotSignedIn(asker);
                }
                else
                {
                    // access/user.sql only when a check needs more than the id
                    var needsMore = dataset.Roles != null || (dataset.User ?? new string[0]).Any(a => a != "id");
                    viewer = needsMore ? await asker.Resolved().ConfigureAwait(false) : asker.Viewer;
                    if (dataset.Roles != null && !dataset.Roles.Any(viewer.HasRole)) throw new ApiException(403, $"api/{name}.sql を読む役割がありません（利用者 {viewer.Id}）");
                }
                var bound = dataset.BindAs(parameters.Select(p => new KeyValuePair<string, object?>(p.Key, Normalize(p.Value))), viewer, mode.On);
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
                // a list for a multiple-value parameter (string[], List<int>…): its values the same way
                case System.Collections.IList list:
                    return list.Cast<object?>().Select(Normalize).ToList();
                // whole numbers as BIGINT up to its limit, as Node's mssql package sends them (2^63 is a double exactly)
                case double d when Math.Floor(d) == d && Math.Abs(d) < 9223372036854775808.0:
                    return (long)d;
                default:
                    return v;
            }
        }

        private async Task<ApiResponse> QueryAsync(ApiRequest request, Asker asker, RowLevelMode mode, CancellationToken cancellationToken)
        {
            // Signed in before anything else is read (the body, the file's name).
            if (mode.On && asker.Viewer == null) throw NotSignedIn(asker);
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
            var result = await RunAsAsync(name!, parameters, asker, mode, cancellationToken).ConfigureAwait(false);
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
            // `CORP\yamada ` before the line, when someone signed in asked
            var by = asker.Viewer != null ? asker.Viewer.Id + " " : "";
            Log($"{by}api/{name}.sql: {result.Rows.ToString("N0", CultureInfo.InvariantCulture)} 行、{started.ElapsedMilliseconds} ms");
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

        /// <summary>
        /// A JSON value as Bind takes it: text, a number, a boolean, null, a list of those for an array (for a
        /// multiple-value parameter), or (an object, an array in an array) the element, which Bind refuses.
        /// </summary>
        internal static object? ValueOf(JsonElement v) => ValueOf(v, true);

        private static object? ValueOf(JsonElement v, bool top)
        {
            if (top && v.ValueKind == JsonValueKind.Array) return v.EnumerateArray().Select(x => ValueOf(x, false)).ToList();
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
