// v2.3.43 step 21 (owner 2026-10-26): every error message carries a picture
// that fits it - decided from the server's own error code, remembered for
// the translated text, and "offline" when there is no connection.
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ErrorText from "../../components/common/ErrorText";
import EmptyState from "../../components/common/EmptyState";
import humanizeBackendError from "./humanizeBackendError";
import { classifyBackendError } from "./errorKind";

const t = ((key: string) => `translated:${key}`) as never;

afterEach(() => vi.restoreAllMocks());

describe("error kinds", () => {
  it("sorts the server's errors by what went wrong", () => {
    expect(classifyBackendError("DASHBOARD.VIEW AUTHORITY REQUIRED")).toBe("permission");
    expect(classifyBackendError("YOU DO NOT MANAGE THIS EMPLOYEES SITE")).toBe("permission");
    expect(classifyBackendError("CLOCK IN FAILED: YOU ARE OUTSIDE THE WORK AREA")).toBe("location");
    expect(classifyBackendError("A PHOTO IS REQUIRED AT THIS SITE")).toBe("camera");
    expect(classifyBackendError("SOS ALERT NOT FOUND")).toBe("notFound");
    expect(classifyBackendError("NO AUTHENTICATED SESSION")).toBe("session");
    expect(classifyBackendError("Failed to fetch")).toBe("offline");
    expect(classifyBackendError("THIS LEAVE HAS STARTED AND CAN NO LONGER BE CANCELLED")).toBe("error");
  });

  it("shows the picture of the server's error beside its translated text", () => {
    const text = humanizeBackendError("DASHBOARD.VIEW AUTHORITY REQUIRED", t)!;
    const { container } = render(<ErrorText>{text}</ErrorText>);
    expect(container.querySelector("[data-kind]")?.getAttribute("data-kind")).toBe("permission");
    expect(container.querySelector("img")).not.toBeNull();
  });

  it("uses the page's kind, the general picture otherwise, and offline without a connection", () => {
    const { container, rerender } = render(<ErrorText kind="camera">Could not take the photo</ErrorText>);
    expect(container.querySelector("[data-kind]")?.getAttribute("data-kind")).toBe("camera");
    rerender(<ErrorText>Something unexpected</ErrorText>);
    expect(container.querySelector("[data-kind]")?.getAttribute("data-kind")).toBe("error");
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    rerender(<ErrorText kind="camera">Could not take the photo</ErrorText>);
    expect(container.querySelector("[data-kind]")?.getAttribute("data-kind")).toBe("offline");
  });

  it("renders nothing for an empty message, and an empty state always has a picture", () => {
    const { container } = render(<ErrorText>{""}</ErrorText>);
    expect(container.innerHTML).toBe("");
    const empty = render(<EmptyState message="Nothing yet" />);
    expect(empty.container.querySelector("img")).not.toBeNull();
  });
});
