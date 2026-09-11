import { Analytics } from "@vercel/analytics/react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "../styles.css";

const root = document.querySelector("#root");
const convexUrl = import.meta.env.VITE_CONVEX_URL;
const isPaymentPage =
  window.location.pathname === "/sandbox" || window.location.pathname.startsWith("/sandbox/");

if (!root) {
  throw new Error("Root element not found.");
}

if (!convexUrl && !isPaymentPage) {
  throw new Error("Missing VITE_CONVEX_URL.");
}

if (isPaymentPage) {
  const PaymentSandbox = lazy(() => import("./PaymentSandbox"));
  createRoot(root).render(
    <Suspense fallback={<p>Loading payment sandbox...</p>}>
      <PaymentSandbox />
    </Suspense>,
  );
} else {
  const convex = new ConvexReactClient(convexUrl);
  createRoot(root).render(
    <ConvexProvider client={convex}>
      <App />
      <Analytics />
    </ConvexProvider>,
  );
}
