// Audit 4.6 - the site form leads straight to that site's own settings
// (presence monitoring, shift policy, ...).
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import SiteFormModal from "./SiteFormModal";
import type { Site } from "../../core/repositories/SiteRepository";

vi.mock("../../core/repositories/OrganizationRepository", () => ({
  default: { getCurrentOrganization: () => Promise.resolve({ success: false, message: null, data: null }) },
}));

describe("SiteFormModal", () => {
  it("links an edited site to its own page, where its rules are", async () => {
    const site = { id: "site-42", name: "Tower B", latitude: 30, longitude: 31 } as unknown as Site;
    render(
      <MemoryRouter>
        <SiteFormModal isOpen onClose={vi.fn()} onSaved={vi.fn()} site={site} />
      </MemoryRouter>,
    );
    const link = await screen.findByRole("link", { name: "Open the site's page" });
    expect(link).toHaveAttribute("href", "/sites/site-42");
    expect(screen.getByText(/ongoing presence monitoring/)).toBeInTheDocument();
  });
});
