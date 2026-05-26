import { ConvexProvider, ConvexReactClient } from "convex/react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "../styles.css";

const root = document.querySelector("#root");
const convexUrl = import.meta.env.VITE_CONVEX_URL;

if (!root) {
  throw new Error("Root element not found.");
}

if (!convexUrl) {
  throw new Error("Missing VITE_CONVEX_URL.");
}

const convex = new ConvexReactClient(convexUrl);

createRoot(root).render(
  <ConvexProvider client={convex}>
    <App />
  </ConvexProvider>,
);
