// v2.3.43 step 14: the shared avatar - photo, initial, broken link.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import Avatar from "./Avatar";

describe("Avatar", () => {
  it("shows the initial without a photo", () => {
    const { container } = render(<Avatar name="mona elsayed" url={null} />);
    expect(container.textContent).toBe("M");
  });

  it("shows the photo, lazily, and falls back to the initial when the link is broken", () => {
    const { container } = render(<Avatar name="Omar" url="https://example.test/a.png" size="md" />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("loading")).toBe("lazy");
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("O")).toBeTruthy();
  });
});
