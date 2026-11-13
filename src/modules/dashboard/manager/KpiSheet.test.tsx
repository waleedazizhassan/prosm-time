// Owner 2026-10-27: each KPI card opens the people behind its number.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DashboardPersonFigures, ManagerDashboard } from "../../../core/repositories/DashboardRepository";
import KpiSheet from "./KpiSheet";

// the Buzz button needs the signed-in person; not part of these tests
vi.mock("../../../components/common/BuzzButton", () => ({ default: () => null }));

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
  lateTodayList: [{ userId: "c", name: "Camal", avatarUrl: null, siteName: "Main", lateMinutes: 12, firstIn: "2026-10-27T06:12:00Z" }],
} as unknown as ManagerDashboard;

const open = (kind: "hours" | "late" | "latePeriod" | "overtime", onOpenPage = vi.fn()) =>
  render(<KpiSheet kind={kind} data={data} time={() => "09:10"} onClose={() => {}} onOpenPage={onOpenPage} />);

describe("KpiSheet", () => {
  it("hours: everyone with hours", () => {
    open("hours");
    expect(screen.getByText("Alaa")).toBeTruthy();
    expect(screen.getByText("Basma")).toBeTruthy();
    expect(screen.getByText("10")).toBeTruthy(); // 600 minutes = 10 h
  });

  it("late today: today's late people only; the period's lateness is its own sheet (owner 2026-11-13)", () => {
    open("late");
    expect(screen.getByText("Camal")).toBeTruthy();
    expect(screen.queryByText("Alaa")).toBeNull();
  });

  it("the period's lateness: only the people concerned", () => {
    open("latePeriod");
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
