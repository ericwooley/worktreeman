import React from "react";
import ReactDOM from "react-dom/client";
import { Dashboard } from "./components/dashboard";
import { ThemeProvider } from "./components/theme-provider";
import { DashboardStateProvider } from "./hooks/use-dashboard-state";
import "./styles.css";
import "@git-diff-view/react/styles/diff-view-pure.css";
import "@xterm/xterm/css/xterm.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <DashboardStateProvider>
        <Dashboard />
      </DashboardStateProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
