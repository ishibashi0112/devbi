using System;
using System.IO;

namespace DevBI.Server.Tests
{
    /// <summary>Paths in the repository (the tests run from dotnet/test/DevBI.Server.Tests/bin/...).</summary>
    internal static class Repo
    {
        public static readonly string Root = Find();

        /// <summary>examples/sales: api/orders.sql, api/sales_daily.sql, db/sales.sqlite.</summary>
        public static string Sample => Path.Combine(Root, "examples", "sales");

        private static string Find()
        {
            for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null; dir = dir.Parent)
            {
                if (File.Exists(Path.Combine(dir.FullName, "pnpm-workspace.yaml"))) return dir.FullName;
            }
            throw new InvalidOperationException("リポジトリのフォルダが見つかりません");
        }
    }
}
