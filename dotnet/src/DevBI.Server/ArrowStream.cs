// A result set as Arrow IPC stream bytes (application/vnd.apache.arrow.stream): what DuckDB-wasm in the browser reads.
// The same types as packages/server/src/arrow.ts: Int64, Float64, Bool, Date32 (days), Timestamp (microseconds, no
// time zone: the wall-clock time) and Utf8.
using System;
using System.Collections.Generic;
using System.IO;
using Apache.Arrow;
using Apache.Arrow.Ipc;
using Apache.Arrow.Types;

namespace DevBI.Server
{
    public static class ArrowStream
    {
        private static readonly DateTimeOffset Epoch = new DateTimeOffset(1970, 1, 1, 0, 0, 0, TimeSpan.Zero);

        public static byte[] Write(ResultSet result)
        {
            var fields = new List<Field>();
            var arrays = new List<IArrowArray>();
            for (int i = 0; i < result.Columns.Count; i++)
            {
                var column = result.Columns[i];
                var array = Array(column.Type, result.Rows, i);
                arrays.Add(array);
                fields.Add(new Field(column.Name, array.Data.DataType, true));
            }
            var schema = new Schema(fields, null);
            var batch = new RecordBatch(schema, arrays, result.Rows.Count);
            using (var stream = new MemoryStream())
            {
                using (var writer = new ArrowStreamWriter(stream, schema, leaveOpen: true))
                {
                    writer.WriteRecordBatch(batch);
                    writer.WriteEnd();
                }
                return stream.ToArray();
            }
        }

        private static IArrowArray Array(ColumnType type, IReadOnlyList<object?[]> rows, int i)
        {
            switch (type)
            {
                case ColumnType.Int:
                {
                    var b = new Int64Array.Builder();
                    foreach (var r in rows)
                    {
                        if (r[i] is long v) b.Append(v);
                        else b.AppendNull();
                    }
                    return b.Build();
                }
                case ColumnType.Float:
                {
                    var b = new DoubleArray.Builder();
                    foreach (var r in rows)
                    {
                        if (r[i] is double v) b.Append(v);
                        else b.AppendNull();
                    }
                    return b.Build();
                }
                case ColumnType.Bool:
                {
                    var b = new BooleanArray.Builder();
                    foreach (var r in rows)
                    {
                        if (r[i] is bool v) b.Append(v);
                        else b.AppendNull();
                    }
                    return b.Build();
                }
                case ColumnType.Date:
                {
                    var b = new Date32Array.Builder();
                    foreach (var r in rows)
                    {
                        if (r[i] is int days) b.Append(Epoch.AddDays(days));
                        else b.AppendNull();
                    }
                    return b.Build();
                }
                case ColumnType.Timestamp:
                {
                    var b = new TimestampArray.Builder(new TimestampType(TimeUnit.Microsecond, (string?)null));
                    foreach (var r in rows)
                    {
                        if (r[i] is long micros) b.Append(Epoch.AddTicks(micros * 10));
                        else b.AppendNull();
                    }
                    return b.Build();
                }
                default:
                {
                    var b = new StringArray.Builder();
                    foreach (var r in rows)
                    {
                        if (r[i] is string v) b.Append(v);
                        else b.AppendNull();
                    }
                    return b.Build();
                }
            }
        }
    }
}
