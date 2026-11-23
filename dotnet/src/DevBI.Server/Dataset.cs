// One api/<name>.sql file, and its :name parameters bound to SQL Server's @p1, @p2, …
// A port of packages/server/src/datasets.ts (the messages are the same, word for word).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;

namespace DevBI.Server
{
    /// <summary>A problem with an SQL file or with the parameters sent for it: 400, or 404 when there is no such file.</summary>
    public sealed class DatasetException : Exception
    {
        public DatasetException(string message, int status) : base(message)
        {
            Status = status;
        }

        public int Status { get; }
    }

    /// <summary>One <c>api/&lt;name&gt;.sql</c> file: a SELECT the API runs for <c>read_api('&lt;name&gt;')</c>.</summary>
    public sealed class Dataset
    {
        internal Dataset(string name, string description, string? connection, IReadOnlyList<string>? snapshot, string sql, IReadOnlyList<string> parameters, IReadOnlyList<DatasetParameter> definitions, IReadOnlyList<string>? key)
        {
            Name = name;
            Description = description;
            Connection = connection;
            Snapshot = snapshot;
            Sql = sql;
            Params = parameters;
            Parameters = definitions;
            Key = key;
        }

        public string Name { get; }

        /// <summary>The comment lines above the SELECT, without the <c>connection:</c> and <c>snapshot:</c> lines.</summary>
        public string Description { get; }

        /// <summary>The <c>-- connection: &lt;name&gt;</c> line: which DEVBI_DB_&lt;NAME&gt; to use. Null: DEVBI_DB.</summary>
        public string? Connection { get; }

        /// <summary>The <c>-- snapshot: 06:00, 12:00</c> line: the times of day (<c>HH:MM</c>) its snapshot is made.</summary>
        public IReadOnlyList<string>? Snapshot { get; }

        /// <summary>The statement, without the comments above it and without a final <c>;</c>.</summary>
        public string Sql { get; }

        /// <summary>Parameter names (<c>:from</c> → <c>from</c>), each once, in the order they first appear.</summary>
        public IReadOnlyList<string> Params { get; }

        /// <summary>
        /// One per parameter: those with a <c>-- param:</c> line first, in the order of the lines, then the others in the
        /// order they first appear (only <see cref="DatasetParameter.Name"/>).
        /// </summary>
        public IReadOnlyList<DatasetParameter> Parameters { get; }

        /// <summary>The <c>-- key: 受注番号, 行番号</c> line: the result columns that tell one row from another. Null: none.</summary>
        public IReadOnlyList<string>? Key { get; }

        /// <summary>The name a connection goes by: DEVBI_DB, or DEVBI_DB_&lt;NAME&gt; for a named one (<c>-- connection: erp</c>).</summary>
        public static string ConnectionVariable(string? connection) =>
            string.IsNullOrEmpty(connection) ? "DEVBI_DB" : "DEVBI_DB_" + Regex.Replace(connection!.ToUpperInvariant(), "[^A-Z0-9]", "_");

        private static readonly Regex ConnectionLine = new Regex($"^[{SqlText.Space}]*--[{SqlText.Space}]*connection[{SqlText.Space}]*:[{SqlText.Space}]*([^{SqlText.Space}]+)[{SqlText.Space}]*\\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        private static readonly Regex SnapshotLine = new Regex($"^[{SqlText.Space}]*--[{SqlText.Space}]*snapshot[{SqlText.Space}]*:([^\\n\\r\\u2028\\u2029]*)\\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        private static readonly Regex CommentLine = new Regex($"^[{SqlText.Space}]*--", RegexOptions.CultureInvariant);
        private static readonly Regex Time = new Regex("^([0-9]{1,2}):([0-9]{2})\\z", RegexOptions.CultureInvariant);
        private static readonly Regex TimeSeparators = new Regex($"[,、{SqlText.Space}]+", RegexOptions.CultureInvariant);
        private static readonly Regex HeaderLine = new Regex($"^(connection|snapshot|param|key)[{SqlText.Space}]*:", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        /// <summary>The lines of the file, the way JavaScript's <c>split(/\r?\n/)</c> cuts them.</summary>
        private static string[] Lines(string text) => Regex.Split(text.Length > 0 && text[0] == '\ufeff' ? text.Substring(1) : text, "\r?\n");

        /// <summary>
        /// The <c>-- connection: &lt;name&gt;</c> line among the comment lines at the top of the file (blank lines between
        /// them are fine), without checking the SQL.
        /// </summary>
        public static string? ConnectionOf(string text)
        {
            foreach (var line in Lines(text))
            {
                var m = ConnectionLine.Match(line);
                if (m.Success) return m.Groups[1].Value;
                if (SqlText.Trim(line).Length > 0 && !CommentLine.IsMatch(line)) return null;
            }
            return null;
        }

        /// <summary>
        /// The <c>-- snapshot: 06:00, 12:00</c> line among the comment lines at the top of the file: the times of day
        /// (sorted, <c>HH:MM</c>). Null: no snapshot.
        /// </summary>
        public static IReadOnlyList<string>? SnapshotOf(string text, string name = "?")
        {
            foreach (var line in Lines(text))
            {
                var m = SnapshotLine.Match(line);
                if (m.Success)
                {
                    var times = new List<string>();
                    foreach (var t in TimeSeparators.Split(m.Groups[1].Value).Where(t => t.Length > 0))
                    {
                        var hm = Time.Match(t);
                        if (!hm.Success || int.Parse(hm.Groups[1].Value) > 23 || int.Parse(hm.Groups[2].Value) > 59)
                        {
                            throw new DatasetException($"api/{name}.sql: snapshot の時刻は 06:00 のように書きます（{t}）", 400);
                        }
                        times.Add(hm.Groups[1].Value.PadLeft(2, '0') + ":" + hm.Groups[2].Value);
                    }
                    if (times.Count == 0) throw new DatasetException($"api/{name}.sql: snapshot に時刻を書いてください（例: -- snapshot: 06:00）", 400);
                    return times.Distinct().OrderBy(t => t, StringComparer.Ordinal).ToList();
                }
                if (SqlText.Trim(line).Length > 0 && !CommentLine.IsMatch(line)) return null;
            }
            return null;
        }

        /// <summary>Read and check the text of <c>api/&lt;name&gt;.sql</c>. Throws <see cref="DatasetException"/> (400).</summary>
        public static Dataset Parse(string name, string text)
        {
            var rel = $"api/{name}.sql";
            var statements = SqlText.SplitStatements(text);
            if (statements.Count == 0) throw new DatasetException($"{rel}: SELECT 文がありません", 400);
            if (statements.Count > 1) throw new DatasetException($"{rel}: 1 つのファイルに書ける SELECT 文は 1 つだけです（{statements.Count} 個あります）", 400);
            var st = statements[0];
            var problem = SqlText.ReadOnlyProblem(st.Sql);
            if (problem != null)
            {
                var why = problem.Code == "not-select"
                    ? $"SELECT か WITH で始まる文だけ使えます（{problem.Word ?? "この文"} で始まっています）"
                    : problem.Code == "several"
                        ? "文が 2 つ以上あるかもしれません。引用符の閉じ忘れがないか見てください"
                        : $"{problem.Word} は使えません。読み取るだけの SELECT にしてください（列名なら引用符で囲みます）";
                throw new DatasetException($"{rel}: {why}", 400);
            }
            var connection = ConnectionOf(text);
            var snapshot = SnapshotOf(text, name);
            var description = st.Title.Split('\n').Where(line => !HeaderLine.IsMatch(SqlText.Trim(line)));
            var places = SqlText.Parameters(st.Sql);
            var parameters = new List<string>();
            foreach (var p in places)
            {
                if (!parameters.Any(q => q.ToLowerInvariant() == p.Name.ToLowerInvariant())) parameters.Add(p.Name);
            }
            var (definitions, key) = ParamLines.HeaderDirectives(text, name, parameters);
            // A multiple-value parameter only in IN (:name): the server writes one placeholder per value there.
            foreach (var p in places)
            {
                var def = definitions.FirstOrDefault(d => d.Name.ToLowerInvariant() == p.Name.ToLowerInvariant());
                if (def == null || !def.Multiple || InList(st.Sql, p.Start, p.End)) continue;
                var line = st.Line + st.Sql.Substring(0, p.Start).Count(c => c == '\n');
                throw new DatasetException($"{rel}（{line} 行目）: :{p.Name} は複数の値（{def.Type}[]）なので、IN (:{p.Name}) の形でだけ使えます", 400);
            }
            var declared = new HashSet<string>(definitions.Select(d => d.Name.ToLowerInvariant()), StringComparer.Ordinal);
            var all = definitions.Concat(parameters.Where(p => !declared.Contains(p.ToLowerInvariant())).Select(p => new DatasetParameter(p))).ToList();
            return new Dataset(name, SqlText.Trim(string.Join("\n", description)), connection, snapshot, st.Sql, parameters, all, key);
        }

        /// <summary>Whether the parameter at sql[start, end) is all there is in <c>IN (…)</c> (NOT IN too), spaces aside.</summary>
        private static bool InList(string sql, int start, int end)
        {
            var j = end;
            while (j < sql.Length && SqlText.IsSpace(sql[j])) j++;
            if (j >= sql.Length || sql[j] != ')') return false;
            var i = start - 1;
            while (i >= 0 && SqlText.IsSpace(sql[i])) i--;
            if (i < 0 || sql[i] != '(') return false;
            i--;
            while (i >= 0 && SqlText.IsSpace(sql[i])) i--;
            return i >= 1 && (sql[i - 1] == 'I' || sql[i - 1] == 'i') && (sql[i] == 'N' || sql[i] == 'n') && !SqlText.IsNameChar(sql, i - 2);
        }

        /// <summary>
        /// The SQL with its <c>:name</c> parameters as <c>@p1</c>, <c>@p2</c>, … (one per name), and the values in that
        /// order. Every parameter needs a value, and no others may be given. Values are text, numbers (<see cref="long"/>
        /// or <see cref="double"/>), <see cref="bool"/> or null; anything else is refused. A parameter with a
        /// <c>-- param:</c> line is checked against its type (dates and times are read as <c>CAST(@p1 AS date)</c> /
        /// <c>datetime2</c>); a multiple-value one takes a list and becomes one placeholder per value in its <c>IN (…)</c>.
        /// Names starting with <c>user.</c> are refused: they are the signed-in user's values (row-level security).
        /// </summary>
        public BoundSql Bind(IEnumerable<KeyValuePair<string, object?>> values)
        {
            var rel = $"api/{Name}.sql";
            // Names match without regard to case, like SQL names (and DuckDB passes read_api's argument names in lower case).
            var given = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var pair in values)
            {
                var lower = pair.Key.ToLowerInvariant();
                if (ParamLines.Reserved.IsMatch(pair.Key)) throw new DatasetException($"{rel}: パラメーター {pair.Key} は渡せません（user. で始まる名前は、ログインした人の値のために取ってあります）", 400);
                if (given.ContainsKey(lower)) throw new DatasetException($"{rel}: パラメーター {pair.Key} が 2 回あります", 400);
                if (!Params.Any(p => p.ToLowerInvariant() == lower))
                {
                    var known = Params.Count > 0 ? $"（使えるのは {string.Join(", ", Params)}）" : "（この SQL にはパラメーターがありません）";
                    throw new DatasetException($"{rel}: パラメーター {pair.Key} はありません{known}", 400);
                }
                given[lower] = pair.Value;
            }
            var types = new Dictionary<string, string?>(StringComparer.Ordinal);
            var checkedValues = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var p in Params)
            {
                var lower = p.ToLowerInvariant();
                if (!given.TryGetValue(lower, out var v)) throw new DatasetException($"{rel}: パラメーター :{p} の値がありません。read_api('{Name}', {p} = ...) と書きます", 400);
                var def = Parameters.FirstOrDefault(d => d.Name.ToLowerInvariant() == lower);
                types[lower] = def?.Type;
                if (def?.Type != null)
                {
                    checkedValues[lower] = ParamLines.CheckValue(rel, def, v);
                    continue;
                }
                if (v != null && !(v is string) && !(v is long) && !(v is double) && !(v is bool))
                {
                    throw new DatasetException($"{rel}: パラメーター {p} の値は文字・数値・真偽・null のどれかにしてください", 400);
                }
                checkedValues[lower] = v;
            }
            // A name's placeholders, written again where the name comes again.
            var written = new Dictionary<string, string>(StringComparer.Ordinal);
            var bound = new List<object?>();
            var sql = new System.Text.StringBuilder();
            var last = 0;
            foreach (var p in SqlText.Parameters(Sql))
            {
                sql.Append(Sql, last, p.Start - last);
                var lower = p.Name.ToLowerInvariant();
                if (!written.TryGetValue(lower, out var place))
                {
                    var v = checkedValues[lower];
                    var type = types[lower];
                    var items = v is List<object?> list ? list : new List<object?> { v };
                    place = string.Join(", ", items.Select(x =>
                    {
                        bound.Add(x);
                        var ph = "@p" + bound.Count.ToString(CultureInfo.InvariantCulture);
                        return type == "date" ? $"CAST({ph} AS date)" : type == "datetime" ? $"CAST({ph} AS datetime2)" : ph;
                    }));
                    written[lower] = place;
                }
                sql.Append(place);
                last = p.End;
            }
            sql.Append(Sql, last, Sql.Length - last);
            if (bound.Count > ParamLines.MaxPlaceholders)
            {
                throw new DatasetException(
                    $"{rel}: パラメーターの値が全部で {bound.Count.ToString("N0", CultureInfo.InvariantCulture)} 個になります。1 つの SQL に渡せるのは {ParamLines.MaxPlaceholders.ToString("N0", CultureInfo.InvariantCulture)} 個までです。候補を絞るか、すべてのときはこのパラメーターを使わない SQL にしてください",
                    400);
            }
            return new BoundSql(sql.ToString(), bound);
        }
    }

    /// <summary>An SQL text with <c>@p1</c>, <c>@p2</c>, … and their values.</summary>
    public sealed class BoundSql
    {
        public BoundSql(string sql, IReadOnlyList<object?> values)
        {
            Sql = sql;
            Values = values;
        }

        public string Sql { get; }
        public IReadOnlyList<object?> Values { get; }
    }
}
