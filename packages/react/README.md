# @devbi/react

[DevBI](https://github.com/ishibashi0112/devbi) を React で動かす部分: DuckDB-wasm のエンジン、クロスフィルタ、組み込みのタイル（KPI、棒・線・帯グラフ、表、クロス集計、期間、選択、Markdown）、`<DevbiApp>`・`<Dashboard>`、ほかのページへの埋め込み（`mountDashboard`、`startEmbed`）。

```tsx
import { DevbiApp } from "@devbi/react";
import project from "virtual:devbi"; // @devbi/vite が dashboards/ と models/ から作る

createRoot(document.getElementById("root")!).render(<DevbiApp project={project} />);
```

新しく始めるときは `npm create devbi@latest my-reports`。使い方は [リファレンス](https://github.com/ishibashi0112/devbi/blob/main/docs/reference.md)。

MIT
