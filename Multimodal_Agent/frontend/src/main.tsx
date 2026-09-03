import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ClawhiveLoginGate from "./ClawhiveLoginGate";
import { installFetchAuth, isLoggedIn } from "./clawhiveAuth";
import "@brand/index.css";
import "./multimodal-season.css";
import "./styles.css";
import "./mm-theme.css";

installFetchAuth();

function Root() {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  useEffect(() => {
    setAuthed(isLoggedIn());
    setReady(true);
  }, []);
  if (!ready) return null;
  if (!authed) return <ClawhiveLoginGate onSuccess={() => setAuthed(true)} />;
  return <App onLogout={() => setAuthed(false)} />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
