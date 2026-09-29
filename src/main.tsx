import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { i18nReady } from "./i18n";
import App from "./App";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found.");
}

// The first screen appears once the reader's language is loaded (a few KB, not all five languages).
void i18nReady.finally(() => {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
});
