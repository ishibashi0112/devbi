"use client";
// A DevBI dashboard in this app's page: devbi-embed.js (public/devbi/) brings its own React and DuckDB, so the
// app's React and bundler do not matter. It reads the API at /devbi/api/ (app/devbi/[...path]/route.ts).
import { useEffect, useRef } from "react";

// A variable, with the ignore comments: the bundler leaves import() to the browser instead of looking for the file.
const DEVBI = "/devbi/devbi-embed.js";

type Devbi = { mount(target: Element, options: { dashboard?: string; theme?: "light" | "dark" | "auto" }): { unmount(): void } };

export function DevbiDashboard({ name, theme = "light" }: { name: string; theme?: "light" | "dark" | "auto" }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    let unmount = () => {};
    void import(/* webpackIgnore: true */ /* turbopackIgnore: true */ DEVBI).then((devbi: Devbi) => {
      if (alive && ref.current) unmount = devbi.mount(ref.current, { dashboard: name, theme }).unmount;
    });
    return () => {
      alive = false;
      unmount();
    };
  }, [name, theme]);
  return <div ref={ref} className="report" />;
}
