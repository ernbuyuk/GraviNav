import React from "react";
import { createRoot } from "react-dom/client";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import TrackerApp from "./TrackerApp.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <TrackerApp />
  </React.StrictMode>
);
