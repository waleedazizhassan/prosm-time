// Owner 2026-10-26: the app draws its own drop-down list (the browser's was
// unreadable in Firefox); it must still behave like a list.
import { useEffect, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import Dropdown from "./Dropdown";
import Select from "./Select";

const SITES = [
  { value: "", label: "All sites" },
  { value: "a", label: "Alexandria" },
  { value: "c", label: "Cairo" },
];

function Controlled({ onChange = () => {} }: { onChange?: (value: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <Dropdown
      ariaLabel="Site"
      value={value}
      options={SITES}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

describe("Dropdown", () => {
  it("shows the chosen label, opens, and picks an option", () => {
    const changed = vi.fn();
    render(<Controlled onChange={changed} />);
    const trigger = screen.getByRole("button", { name: "Site" });
    expect(trigger.textContent).toBe("All sites");
    fireEvent.click(trigger);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["All sites", "Alexandria", "Cairo"]);
    fireEvent.click(screen.getByRole("option", { name: "Cairo" }));
    expect(changed).toHaveBeenCalledWith("c");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger.textContent).toBe("Cairo");
  });

  it("works from the keyboard and closes with Escape", () => {
    const changed = vi.fn();
    render(<Controlled onChange={changed} />);
    const trigger = screen.getByRole("button", { name: "Site" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const list = screen.getByRole("listbox");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(changed).toHaveBeenCalledWith("a");
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes on a click outside, but a click in the list does not close the menu it sits in", () => {
    const menuClosed = vi.fn();
    function Menu() {
      useEffect(() => {
        const outside = () => menuClosed();
        document.addEventListener("mousedown", outside);
        return () => document.removeEventListener("mousedown", outside);
      }, []);
      return <Controlled />;
    }
    render(<Menu />);
    fireEvent.click(screen.getByRole("button", { name: "Site" }));
    fireEvent.mouseDown(screen.getByRole("option", { name: "Alexandria" }));
    expect(menuClosed).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("a long list gets a search box", () => {
    const people = Array.from({ length: 12 }, (_, index) => ({ value: String(index), label: `Person ${index}` }));
    render(<Dropdown ariaLabel="Person" value="0" options={[...people, { value: "w", label: "Waleed" }]} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Person" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "wal" } });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Waleed"]);
  });
});

describe("Select", () => {
  it("still hands its caller a change event with the value and the name", () => {
    const changed = vi.fn();
    render(<Select label="Site" name="site" value="" options={SITES} onChange={(event) => changed(event.target.value, event.target.name)} />);
    fireEvent.click(screen.getByRole("button", { name: "Site" }));
    fireEvent.click(screen.getByRole("option", { name: "Alexandria" }));
    expect(changed).toHaveBeenCalledWith("a", "site");
  });
});
