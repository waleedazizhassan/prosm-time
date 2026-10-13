// Page name card (owner 2026-10-13): the page's own name from the
// sidebar, a short line about it, and its flat illustration.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import PageBanner from "./PageBanner";

describe("PageBanner", () => {
  it("shows the page name, its line and the illustration", () => {
    const { container } = render(<PageBanner pageId="people" illustration="/people.svg" />);
    expect(screen.getByRole("heading", { level: 1, name: "People" })).toBeInTheDocument();
    expect(screen.getByText("Employees, roles and invitations")).toBeInTheDocument();
    expect(container.querySelector("img")).toHaveAttribute("src", "/people.svg");
  });
});
