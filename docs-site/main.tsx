import React from "react";
import ReactDOM from "react-dom/client";
import { DocsSite } from "./site";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <DocsSite />
  </React.StrictMode>,
);
