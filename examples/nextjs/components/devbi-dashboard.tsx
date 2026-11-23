"use client";
// A DevBI dashboard in this app's page: devbi-embed.js (public/devbi/) brings its own React and DuckDB, so the
// app's React and bundler do not matter. It reads the API next to the script: /devbi/api/ (app/devbi/[...path]/
// route.ts), or for 「担当の売上」 /devbi-rls/api/ (script /devbi-rls/devbi-embed.js).
import { useEffect, useRef } from "react";

// A variable, with the ignore comments: the bundler leaves import() to the browser instead of looking for the file.
const DEVBI = "/devbi/devbi-embed.js";

type Devbi = { mount(target: Element, options: { dashboard?: string; theme?: "light" | "dark" | "auto" }): { unmount(): void } };

export function DevbiDashboard({ name, theme = "light", script = DEVBI }: { name: string; theme?: "light" | "dark" | "auto"; script?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    let unmount = () => {};
    void import(/* webpackIgnore: true */ /* turbopackIgnore: true */ script).then((devbi: Devbi) => {
      if (alive && ref.current) unmount = devbi.mount(ref.current, { dashboard: name, theme }).unmount;
    });
    return () => {
      alive = false;
      unmount();
    };
  }, [name, theme, script]);
  return <div ref={ref} className="report" />;
}
