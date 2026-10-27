import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { init } from "./store/app";
import "./styles.css";

init();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
