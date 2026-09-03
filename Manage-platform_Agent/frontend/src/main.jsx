import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "@brand/index.css";
import "./styles.css";
/* 节气主题已废：不再引入 platform-season.css */
import "./platform-theme.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
