import { DevbiApp } from "@devbi/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import project from "virtual:devbi";
import "./app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DevbiApp project={project} />
  </StrictMode>,
);
