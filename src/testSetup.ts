import "@testing-library/jest-dom/vitest";

import { i18nReady } from "./i18n";

// Translations load per language (2026-09-29); tests render once they are ready.
await i18nReady;
