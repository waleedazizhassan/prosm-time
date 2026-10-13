// Privacy Policy / Terms of Use (owner 2026-10-13): public pages, and a
// one-time acknowledgement per version that never blocks offline use.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import LegalRepository from "../../core/repositories/LegalRepository";
import LegalAcknowledgementGate from "./LegalAcknowledgementGate";
import LegalPage from "./LegalPage";
import { LEGAL_DOCUMENTS, LEGAL_VERSION } from "./legalContent";

let isOwner = false;
vi.mock("../../core/context/AuthContext", () => ({
  useAuth: () => ({ profile: { id: "user-1", isOwner }, signOut: vi.fn() }),
}));
vi.mock("../../core/repositories/LegalRepository", () => ({
  default: { hasAcknowledged: vi.fn(), acknowledge: vi.fn() },
}));

const renderGate = () =>
  render(
    <MemoryRouter>
      <LegalAcknowledgementGate>
        <p>app-content</p>
      </LegalAcknowledgementGate>
    </MemoryRouter>,
  );

describe("legal acknowledgement", () => {
  beforeEach(() => {
    localStorage.clear();
    isOwner = false;
    vi.mocked(LegalRepository.hasAcknowledged).mockReset();
    vi.mocked(LegalRepository.acknowledge).mockReset();
  });

  it("asks once, records the current version, then opens the app", async () => {
    vi.mocked(LegalRepository.hasAcknowledged).mockResolvedValue({ success: true, message: null, data: false });
    vi.mocked(LegalRepository.acknowledge).mockResolvedValue({ success: true, message: null, data: null });
    renderGate();
    expect(await screen.findByText("Before you continue")).toBeInTheDocument();
    expect(screen.queryByText("app-content")).toBeNull();
    const accept = screen.getByRole("button", { name: "Continue" });
    expect(accept).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(accept);
    expect(await screen.findByText("app-content")).toBeInTheDocument();
    expect(LegalRepository.acknowledge).toHaveBeenCalledWith(LEGAL_VERSION);
  });

  it("asks the Owner to accept for the organisation", async () => {
    isOwner = true;
    vi.mocked(LegalRepository.hasAcknowledged).mockResolvedValue({ success: true, message: null, data: false });
    renderGate();
    expect(await screen.findByText(/on behalf of my organisation/)).toBeInTheDocument();
  });

  it("opens the app straight away when already acknowledged, or when it cannot check (offline)", async () => {
    vi.mocked(LegalRepository.hasAcknowledged).mockResolvedValue({ success: true, message: null, data: true });
    renderGate();
    expect(await screen.findByText("app-content")).toBeInTheDocument();

    localStorage.clear();
    vi.mocked(LegalRepository.hasAcknowledged).mockResolvedValue({ success: false, message: "Failed to fetch", data: null, networkError: true });
    renderGate();
    await waitFor(() => expect(screen.getAllByText("app-content").length).toBeGreaterThan(0));
  });
});

describe("legal pages", () => {
  it("shows the full Privacy Policy and Terms of Use with every section", () => {
    for (const document of ["privacy", "terms"] as const) {
      const { unmount } = render(
        <MemoryRouter>
          <LegalPage document={document} />
        </MemoryRouter>,
      );
      const doc = LEGAL_DOCUMENTS[document].en;
      expect(screen.getByRole("heading", { level: 1, name: doc.title })).toBeInTheDocument();
      expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(doc.sections.length);
      unmount();
    }
  });

  it("has the same sections in Arabic and English", () => {
    for (const document of ["privacy", "terms"] as const) {
      expect(LEGAL_DOCUMENTS[document].ar.sections.length).toBe(LEGAL_DOCUMENTS[document].en.sections.length);
    }
  });
});
