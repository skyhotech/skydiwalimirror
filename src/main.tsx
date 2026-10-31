import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { startMirrorSync, startUploadSync } from "./lib/backend";
import { preloadFrames } from "./lib/frameAssets";
import { useStudio } from "./lib/store";
import { subscribeTemplates, templates } from "./templates";
// Warm the other frames in the background, after the one on screen.
const warmFrames = () =>
  void preloadFrames([...templates], useStudio.getState().template);
warmFrames();
subscribeTemplates(warmFrames);
startMirrorSync();
startUploadSync();
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
