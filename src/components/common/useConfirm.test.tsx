// v2.3.43 step 21: the app's own confirmation dialog replaces window.confirm.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import useConfirm from "./useConfirm";

function Harness({ onAnswer }: { onAnswer: (value: boolean) => void }) {
  const [confirm, dialog] = useConfirm();
  return (
    <>
      <button type="button" onClick={async () => onAnswer(await confirm("Delete Ahmed?"))}>
        ask
      </button>
      {dialog}
    </>
  );
}

describe("useConfirm", () => {
  it("resolves true on confirm and false on cancel, then closes", async () => {
    const answers: boolean[] = [];
    render(<Harness onAnswer={(value) => answers.push(value)} />);
    fireEvent.click(screen.getByText("ask"));
    expect(screen.getByText("Delete Ahmed?")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button").find((button) => /confirm/i.test(button.textContent ?? ""))!);
    await Promise.resolve();
    fireEvent.click(screen.getByText("ask"));
    fireEvent.click(screen.getAllByRole("button").find((button) => /cancel/i.test(button.textContent ?? ""))!);
    await Promise.resolve();
    expect(answers).toEqual([true, false]);
    expect(screen.queryByText("Delete Ahmed?")).toBeNull();
  });
});
