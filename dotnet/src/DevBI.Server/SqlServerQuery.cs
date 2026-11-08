// Running one SELECT on SQL Server through ADO.NET (Microsoft.Data.SqlClient or System.Data.SqlClient): read-only by
// a transaction that is always rolled back, stopped at the row limit and at the time limit, and its columns typed the
// way packages/server/src/mssql.ts types them.
using System;
using System.Collections.Generic;
using System.Data;
using System.Data.Common;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace DevBI.Server
{
    /// <summary>DevBI's column types: what DuckDB gets (BIGINT, DOUBLE, BOOLEAN, DATE, TIMESTAMP, VARCHAR).</summary>
    public enum ColumnType
    {
        Int,
        Float,
        Bool,
        Date,
        Timestamp,
        String,
    }

    public sealed class ResultColumn
    {
        public ResultColumn(string name, ColumnType type)
        {
            Name = name;
            Type = type;
        }

        public string Name { get; }
        public ColumnType Type { get; }
    }

    /// <summary>
    /// Rows of a query. Values by column type: Int <see cref="long"/>, Float <see cref="double"/>, Bool <see cref="bool"/>,
    /// Date <see cref="int"/> (days since 1970-01-01), Timestamp <see cref="long"/> (microseconds since 1970-01-01 of the
    /// wall-clock time, read as UTC), String <see cref="string"/>; or null.
    /// </summary>
    public sealed class ResultSet
    {
        public ResultSet(IReadOnlyList<ResultColumn> columns, IReadOnlyList<object?[]> rows)
        {
            Columns = columns;
            Rows = rows;
        }

        public IReadOnlyList<ResultColumn> Columns { get; }
        public IReadOnlyList<object?[]> Rows { get; }
    }

    public static class SqlServerQuery
    {
        private static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Unspecified);

        /// <summary>The longest time limit: what <see cref="CancellationTokenSource.CancelAfter(TimeSpan)"/> takes (about 24.8 days).</summary>
        public static readonly TimeSpan MaxTimeout = TimeSpan.FromMilliseconds(int.MaxValue);

        /// <summary>Throws <see cref="ArgumentOutOfRangeException"/> for a time limit below zero or past <see cref="MaxTimeout"/>.</summary>
        public static void CheckTimeout(TimeSpan timeout)
        {
            if (timeout < TimeSpan.Zero || timeout > MaxTimeout) throw new ArgumentOutOfRangeException(nameof(timeout), "DevBIOptions.Timeout は 0（上限なし）から 24 日までにしてください");
        }

        /// <summary>The message when a query takes too long (the same words as devbi-serve's, without its option name).</summary>
        public static string TimeoutMessage(TimeSpan timeout, string hint) =>
            // JavaScript's Math.round (halves up), as devbi-serve writes it
            $"{(Math.Floor(timeout.TotalMilliseconds / 100 + 0.5) / 10).ToString(CultureInfo.InvariantCulture)} 秒を過ぎたので止めました（{hint}）";

        /// <summary>
        /// Run <paramref name="sql"/> (with <c>@p1</c>, <c>@p2</c>, …) on an open connection: in a transaction that is
        /// always rolled back, reading at most <paramref name="maxRows"/> rows of the first result, and stopped after
        /// <paramref name="timeout"/> (<see cref="TimeSpan.Zero"/>: no limit) with a <see cref="TimeoutException"/>.
        /// </summary>
        public static async Task<ResultSet> RunAsync(DbConnection connection, string sql, IReadOnlyList<object?> values, int? maxRows, TimeSpan timeout, string timeoutHint, CancellationToken cancellationToken)
        {
            CheckTimeout(timeout);
            // SQL Server has no read-only transaction: the statement was checked to be a SELECT, the user should be
            // granted SELECT only, and it runs in a transaction that is always rolled back.
            var transaction = connection.BeginTransaction();
            try
            {
                using (var command = connection.CreateCommand())
                using (var limit = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken))
                {
                    command.Transaction = transaction;
                    command.CommandText = sql;
                    // DevBI stops the query itself at the time limit (below); the driver's own limit only in case that fails.
                    command.CommandTimeout = timeout > TimeSpan.Zero ? (int)Math.Ceiling(timeout.TotalSeconds) + 10 : 0;
                    for (int i = 0; i < values.Count; i++) command.Parameters.Add(Parameter(command, i, values[i]));
                    if (timeout > TimeSpan.Zero) limit.CancelAfter(timeout);
                    try
                    {
                        return await Read(command, maxRows, limit.Token).ConfigureAwait(false);
                    }
                    catch (Exception) when (limit.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
                    {
                        throw new TimeoutException(TimeoutMessage(timeout, timeoutHint));
                    }
                }
            }
            finally
            {
                // fails when the server already ended the transaction (a severe error): nothing is left to undo
                try
                {
                    transaction.Rollback();
                }
                catch (Exception)
                {
                }
                transaction.Dispose();
            }
        }

        /// <summary>The way the mssql package (Node) sends a JavaScript value: Int, BigInt, Float, Bit, NVarChar.</summary>
        private static DbParameter Parameter(DbCommand command, int index, object? value)
        {
            var p = command.CreateParameter();
            p.ParameterName = "@p" + (index + 1);
            switch (value)
            {
                case null:
                    p.DbType = DbType.String;
                    p.Value = DBNull.Value;
                    break;
                case string s:
                    p.DbType = DbType.String;
                    p.Value = s;
                    break;
                case bool b:
                    p.DbType = DbType.Boolean;
                    p.Value = b;
                    break;
                case long l when l >= int.MinValue && l <= int.MaxValue:
                    p.DbType = DbType.Int32;
                    p.Value = (int)l;
                    break;
                case long l:
                    p.DbType = DbType.Int64;
                    p.Value = l;
                    break;
                case double d:
                    p.DbType = DbType.Double;
                    p.Value = d;
                    break;
                default:
                    throw new ArgumentException($"パラメーターの値の型が使えません: {value.GetType().Name}");
            }
            return p;
        }

        private static async Task<ResultSet> Read(DbCommand command, int? maxRows, CancellationToken token)
        {
            var rows = new List<object?[]>();
            string[] names;
            Type[] fieldTypes;
            string[] typeNames;
            bool pieces;
            using (var reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false))
            {
                var count = reader.FieldCount;
                names = new string[count];
                fieldTypes = new Type[count];
                typeNames = new string[count];
                for (int i = 0; i < count; i++)
                {
                    names[i] = reader.GetName(i);
                    fieldTypes[i] = reader.GetFieldType(i);
                    typeNames[i] = reader.GetDataTypeName(i);
                }
                // FOR JSON and FOR XML come in pieces of about 2,000 characters, one per row: all of them make one value,
                // so the row limit does not count them.
                pieces = count == 1 && IsPieces(names[0]);
                if (count > 0)
                {
                    while ((maxRows == null || pieces || rows.Count < maxRows) && await reader.ReadAsync(token).ConfigureAwait(false))
                    {
                        var row = new object?[count];
                        for (int i = 0; i < count; i++) row[i] = await reader.IsDBNullAsync(i, token).ConfigureAwait(false) ? null : ValueAt(reader, i);
                        rows.Add(row);
                    }
                }
                // Closing a reader reads what is left; cancelling first stops the server instead (the row limit, a
                // second result of "SELECT 1 SELECT 2").
                try
                {
                    command.Cancel();
                }
                catch (Exception)
                {
                }
            }
            CheckColumnNames(names);
            // One value, as Node's driver gives it (an empty text when there were no rows).
            if (pieces) rows = new List<object?[]> { new object?[] { string.Concat(rows.Select(r => r[0] as string)) } };
            var columns = new ResultColumn[names.Length];
            for (int i = 0; i < names.Length; i++)
            {
                var k = i;
                columns[i] = new ResultColumn(names[i], TypeOf(fieldTypes[i], typeNames[i], rows.Select(r => r[k])));
            }
            foreach (var row in rows)
            {
                for (int i = 0; i < row.Length; i++) row[i] = ValueOf(row[i], columns[i].Type);
            }
            return new ResultSet(columns, rows);
        }

        /// <summary>A value as ADO.NET gives it; a DECIMAL past .NET's decimal (DECIMAL(38) holds up to 10^38) as a double.</summary>
        private static object ValueAt(DbDataReader reader, int i)
        {
            try
            {
                return reader.GetValue(i);
            }
            catch (OverflowException)
            {
                // SqlDecimal, written out in full
                return double.Parse(Convert.ToString(reader.GetProviderSpecificValue(i), CultureInfo.InvariantCulture) ?? "", NumberStyles.Float, CultureInfo.InvariantCulture);
            }
        }

        /// <summary>The one column of a FOR JSON or FOR XML result.</summary>
        private static bool IsPieces(string name) => name == "JSON_F52E2B61-18A1-11d1-B105-00805F49916B" || name == "XML_F52E2B61-18A1-11d1-B105-00805F49916B";

        /// <summary>Arrow and DuckDB need one name per column.</summary>
        internal static void CheckColumnNames(IReadOnlyList<string> names)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var n in names)
            {
                if (!seen.Add(n)) throw new InvalidOperationException($"列名が重なっています: {n}（AS で別の名前を付けてください）");
            }
        }

        private static ColumnType TypeOf(Type type, string typeName, IEnumerable<object?> values)
        {
            if (type == typeof(long) || type == typeof(int) || type == typeof(short) || type == typeof(byte)) return ColumnType.Int;
            if (type == typeof(bool)) return ColumnType.Bool;
            if (type == typeof(decimal) || type == typeof(double) || type == typeof(float)) return ColumnType.Float;
            if (type == typeof(DateTime)) return string.Equals(typeName, "date", StringComparison.OrdinalIgnoreCase) ? ColumnType.Date : ColumnType.Timestamp;
            // DATETIMEOFFSET is a moment: its UTC time
            if (type == typeof(DateTimeOffset)) return ColumnType.Timestamp;
            // sql_variant: whatever its values are
            if (type == typeof(object)) return TypeOfValues(values.Where(v => v != null).ToList());
            return ColumnType.String;
        }

        /// <summary>A sql_variant column's type from its values: dates and times, numbers, booleans, otherwise text.</summary>
        private static ColumnType TypeOfValues(List<object?> values)
        {
            if (values.Count == 0) return ColumnType.String;
            if (values.All(v => v is DateTime || v is DateTimeOffset)) return ColumnType.Timestamp;
            ColumnType? type = null;
            foreach (var v in values)
            {
                ColumnType t;
                switch (v)
                {
                    case long _:
                    case int _:
                    case short _:
                    case byte _:
                        t = ColumnType.Int;
                        break;
                    // whole numbers past BIGINT as doubles (devbi-serve's Arrow does the same)
                    case decimal m:
                        t = m == decimal.Truncate(m) && m >= long.MinValue && m <= long.MaxValue ? ColumnType.Int : ColumnType.Float;
                        break;
                    case double d:
                        t = Math.Floor(d) == d && Math.Abs(d) < 9.2e18 ? ColumnType.Int : ColumnType.Float;
                        break;
                    case float f:
                        t = Math.Floor(f) == f && Math.Abs(f) < 9.2e18 ? ColumnType.Int : ColumnType.Float;
                        break;
                    case bool _:
                        t = ColumnType.Bool;
                        break;
                    default:
                        return ColumnType.String;
                }
                if (type == null || type == t) type = t;
                else if ((type == ColumnType.Int && t == ColumnType.Float) || (type == ColumnType.Float && t == ColumnType.Int)) type = ColumnType.Float;
                else return ColumnType.String;
            }
            return type ?? ColumnType.String;
        }

        private static object? ValueOf(object? v, ColumnType type)
        {
            if (v == null) return null;
            switch (type)
            {
                case ColumnType.Int:
                    return Convert.ToInt64(v, CultureInfo.InvariantCulture);
                case ColumnType.Float:
                    return v is float f ? (double)f : Convert.ToDouble(v, CultureInfo.InvariantCulture);
                case ColumnType.Bool:
                    return (bool)v;
                case ColumnType.Date:
                    return (int)Math.Floor((((DateTime)v).Date - Epoch).TotalDays);
                case ColumnType.Timestamp:
                    return Micros(v is DateTimeOffset o ? o.UtcDateTime : (DateTime)v);
                default:
                    return Text(v);
            }
        }

        /// <summary>Microseconds since 1970 of the wall-clock time, to the millisecond (like devbi-serve).</summary>
        private static long Micros(DateTime d)
        {
            var ticks = d.Ticks - Epoch.Ticks;
            var ms = ticks >= 0 ? ticks / TimeSpan.TicksPerMillisecond : -((-ticks + TimeSpan.TicksPerMillisecond - 1) / TimeSpan.TicksPerMillisecond);
            return ms * 1000;
        }

        /// <summary><c>YYYY-MM-DD HH:MM:SS.fff</c> (without <c>.000</c>).</summary>
        private static string DateTimeText(DateTime d)
        {
            var text = d.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture);
            return text.EndsWith(".000", StringComparison.Ordinal) ? text.Substring(0, text.Length - 4) : text;
        }

        private static string Text(object v)
        {
            switch (v)
            {
                case string s:
                    return s;
                case byte[] bytes:
                    return Convert.ToBase64String(bytes);
                case TimeSpan t:
                    // TIME: HH:MM:SS.fff
                    var ms = t.Milliseconds;
                    return $"{t.Hours:00}:{t.Minutes:00}:{t.Seconds:00}" + (ms > 0 ? "." + ms.ToString("000", CultureInfo.InvariantCulture) : "");
                case Guid g:
                    return g.ToString().ToUpperInvariant();
                case DateTime d:
                    return DateTimeText(d);
                case DateTimeOffset o:
                    return DateTimeText(o.UtcDateTime);
                case bool b:
                    return b ? "true" : "false";
                case double d:
                    return d.ToString("R", CultureInfo.InvariantCulture);
                case float f:
                    return ((double)f).ToString("R", CultureInfo.InvariantCulture);
                case IFormattable f:
                    return f.ToString(null, CultureInfo.InvariantCulture);
                default:
                    return v.ToString() ?? "";
            }
        }
    }
}
