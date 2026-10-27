// Owner 2026-10-27: each KPI card opens the people behind its number.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DashboardPersonFigures, ManagerDashboard } from "../../../core/repositories/DashboardRepository";
import KpiSheet from "./KpiSheet";

const person = (over: Partial<DashboardPersonFigures>): DashboardPersonFigures => ({
  userId: "u",
  name: "Someone",
  avatarUrl: null,
  siteName: "Main",
  days: 1,
  workedMinutes: 0,
  overtimeMinutes: 0,
  overtimePendingMinutes: 0,
  lateDays: 0,
  lateMinutes: 0,
  lateTodayMinutes: null,
  firstInToday: null,
  pendingMinutes: 0,
  ...over,
});

const data = {
  presentNow: [],
  byPerson: [
    person({ userId: "a", name: "Alaa", workedMinutes: 600, overtimeMinutes: 120, lateDays: 2, lateMinutes: 25, lateTodayMinutes: 10, firstInToday: "2026-10-27T06:10:00Z" }),
    person({ userId: "b", name: "Basma", workedMinutes: 270 }),
  ],
} as unknown as ManagerDashboard;

const open = (kind: "hours" | "late" | "overtime", onOpenPage = vi.fn()) =>
  render(<KpiSheet kind={kind} data={data} time={() => "09:10"} onClose={() => {}} onOpenPage={onOpenPage} />);

describe("KpiSheet", () => {
  it("hours: everyone with hours", () => {
    open("hours");
    expect(screen.getByText("Alaa")).toBeTruthy();
    expect(screen.getByText("Basma")).toBeTruthy();
    expect(screen.getByText("10")).toBeTruthy(); // 600 minutes = 10 h
  });

  it("late and overtime: only the people concerned", () => {
    open("late");
    expect(screen.getByText("Alaa")).toBeTruthy();
    expect(screen.queryByText("Basma")).toBeNull();
  });

  it("its button opens the full page for that card", () => {
    const onOpenPage = vi.fn();
    open("overtime", onOpenPage);
    expect(screen.queryByText("Basma")).toBeNull();
    fireEvent.click(screen.getAllByRole("button").at(-1)!);
    expect(onOpenPage).toHaveBeenCalledWith("overtime");
  });
});
