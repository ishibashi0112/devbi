// One api/<name>.sql file, and its :name parameters bound to SQL Server's @p1, @p2, …
// A port of packages/server/src/datasets.ts (the messages are the same, word for word).
using System;
using System.Collections.Generic;
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
        internal Dataset(string name, string description, string? connection, IReadOnlyList<string>? snapshot, string sql, IReadOnlyList<string> parameters)
        {
            Name = name;
            Description = description;
            Connection = connection;
            Snapshot = snapshot;
            Sql = sql;
            Params = parameters;
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

        /// <summary>The name a connection goes by: DEVBI_DB, or DEVBI_DB_&lt;NAME&gt; for a named one (<c>-- connection: erp</c>).</summary>
        public static string ConnectionVariable(string? connection) =>
            string.IsNullOrEmpty(connection) ? "DEVBI_DB" : "DEVBI_DB_" + Regex.Replace(connection!.ToUpperInvariant(), "[^A-Z0-9]", "_");

        private static readonly Regex ConnectionLine = new Regex($"^[{SqlText.Space}]*--[{SqlText.Space}]*connection[{SqlText.Space}]*:[{SqlText.Space}]*([^{SqlText.Space}]+)[{SqlText.Space}]*\\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        private static readonly Regex SnapshotLine = new Regex($"^[{SqlText.Space}]*--[{SqlText.Space}]*snapshot[{SqlText.Space}]*:([^\\n\\r\\u2028\\u2029]*)\\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        private static readonly Regex CommentLine = new Regex($"^[{SqlText.Space}]*--", RegexOptions.CultureInvariant);
        private static readonly Regex Time = new Regex("^([0-9]{1,2}):([0-9]{2})\\z", RegexOptions.CultureInvariant);
        private static readonly Regex TimeSeparators = new Regex($"[,、{SqlText.Space}]+", RegexOptions.CultureInvariant);
        private static readonly Regex HeaderLine = new Regex($"^(connection|snapshot)[{SqlText.Space}]*:", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

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
            var parameters = new List<string>();
            foreach (var p in SqlText.Parameters(st.Sql))
            {
                if (!parameters.Any(q => q.ToLowerInvariant() == p.Name.ToLowerInvariant())) parameters.Add(p.Name);
            }
            return new Dataset(name, SqlText.Trim(string.Join("\n", description)), connection, snapshot, st.Sql, parameters);
        }

        /// <summary>
        /// The SQL with its <c>:name</c> parameters as <c>@p1</c>, <c>@p2</c>, … (one per name), and the values in that
        /// order. Every parameter needs a value, and no others may be given. Values are text, numbers (<see cref="long"/>
        /// or <see cref="double"/>), <see cref="bool"/> or null; anything else is refused.
        /// </summary>
        public BoundSql Bind(IEnumerable<KeyValuePair<string, object?>> values)
        {
            var rel = $"api/{Name}.sql";
            // Names match without regard to case, like SQL names (and DuckDB passes read_api's argument names in lower case).
            var given = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var pair in values)
            {
                var lower = pair.Key.ToLowerInvariant();
                if (given.ContainsKey(lower)) throw new DatasetException($"{rel}: パラメーター {pair.Key} が 2 回あります", 400);
                if (!Params.Any(p => p.ToLowerInvariant() == lower))
                {
                    var known = Params.Count > 0 ? $"（使えるのは {string.Join(", ", Params)}）" : "（この SQL にはパラメーターがありません）";
                    throw new DatasetException($"{rel}: パラメーター {pair.Key} はありません{known}", 400);
                }
                given[lower] = pair.Value;
            }
            foreach (var p in Params)
            {
                if (!given.TryGetValue(p.ToLowerInvariant(), out var v)) throw new DatasetException($"{rel}: パラメーター :{p} の値がありません。read_api('{Name}', {p} = ...) と書きます", 400);
                if (v != null && !(v is string) && !(v is long) && !(v is double) && !(v is bool))
                {
                    throw new DatasetException($"{rel}: パラメーター {p} の値は文字・数値・真偽・null のどれかにしてください", 400);
                }
            }
            var order = new List<string>();
            var sql = new System.Text.StringBuilder();
            var last = 0;
            foreach (var p in SqlText.Parameters(Sql))
            {
                sql.Append(Sql, last, p.Start - last);
                var k = order.FindIndex(q => q.ToLowerInvariant() == p.Name.ToLowerInvariant());
                if (k < 0)
                {
                    order.Add(p.Name);
                    k = order.Count - 1;
                }
                sql.Append("@p").Append(k + 1);
                last = p.End;
            }
            sql.Append(Sql, last, Sql.Length - last);
            return new BoundSql(sql.ToString(), order.Select(n => given[n.ToLowerInvariant()]).ToList());
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
