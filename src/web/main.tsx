import React from "react";
import ReactDOM from "react-dom/client";
import { Dashboard } from "./components/dashboard";
import { ThemeProvider } from "./components/theme-provider";
import "./styles.css";
import "@git-diff-view/react/styles/diff-view-pure.css";
import "@xterm/xterm/css/xterm.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <Dashboard />
    </ThemeProvider>
  </React.StrictMode>,
);
