// Owner 2026-11-03 (his PROSM Allow app exports the sheet to Excel): the allowance sheet as
// rows for a spreadsheet - the organisation, the person and the period, a row per day with the
// same columns as on screen, the totals at the foot. Every heading in the app's language.
import type { AllowanceEntry } from "../../core/repositories/AllowanceRepository";
import type { Cell } from "../../core/utils/spreadsheet";
import { formatDateOnly, formatTimeOnly, appLocale } from "../../core/utils/formatDate";

type TFunc = (key: string, options?: Record<string, unknown>) => string;

const MONEY: { key: keyof AllowanceEntry; label: string }[] = [
  { key: "expatriationAllowance", label: "expatriation" },
  { key: "transportationAllowance", label: "transportation" },
  { key: "travelAllowance", label: "travel" },
  { key: "mealAllowance", label: "meal" },
  { key: "housingAllowance", label: "housing" },
  { key: "otherAllowance", label: "other" },
];

const round2 = (value: number) => Math.round(value * 100) / 100;

export const entryTotal = (entry: AllowanceEntry) =>
  entry.mealAllowance + entry.expatriationAllowance + entry.transportationAllowance + entry.housingAllowance + entry.travelAllowance + entry.otherAllowance + entry.overtimeAmount + entry.extraDaysAmount - entry.lateAmount;

const hoursMinutes = (minutes: number) => {
  const total = Math.round(minutes);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

export function allowanceSheetTable(
  entries: AllowanceEntry[],
  { t, language, organizationName, startDate, endDate }: { t: TFunc; language: string; organizationName: string; startDate: string; endDate: string },
): Cell[][] {
  const sorted = [...entries].sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.userFullName.localeCompare(b.userFullName));
  const people = [...new Set(sorted.map((entry) => entry.userFullName))];
  const severalPeople = people.length > 1;
  const weekday = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString(appLocale(language), { weekday: "long" });

  const header: Cell[] = [
    t("sheet.day"),
    t("sheet.date"),
    ...(severalPeople ? [t("columns.employee")] : []),
    t("columns.site"),
    t("sheet.in"),
    t("sheet.out"),
    ...MONEY.map((column) => t(`columns.${column.label}`)),
    t("columns.overtimeHours"),
    t("columns.overtimeDays"),
    t("columns.overtimeAmount"),
    t("columns.total"),
    t("columns.status"),
  ];

  const rows: Cell[][] = sorted.map((entry) => [
    weekday(entry.entryDate),
    formatDateOnly(entry.entryDate, language),
    ...(severalPeople ? [entry.userFullName] : []),
    entry.siteName ?? "",
    entry.clockInAt ? formatTimeOnly(entry.clockInAt, language) : "",
    entry.clockOutAt ? formatTimeOnly(entry.clockOutAt, language) : "",
    ...MONEY.map((column) => round2(Number(entry[column.key]) || 0)),
    entry.overtimeMinutes ? hoursMinutes(entry.overtimeMinutes) : "",
    entry.overtimeDays || 0,
    round2(entry.overtimeAmount + entry.extraDaysAmount - entry.lateAmount),
    round2(entryTotal(entry)),
    t(`status.${entry.status}`),
  ]);

  const sum = (pick: (entry: AllowanceEntry) => number) => round2(sorted.reduce((all, entry) => all + pick(entry), 0));
  const totals: Cell[] = [
    t("sheet.total"),
    "",
    ...(severalPeople ? [""] : []),
    "",
    "",
    "",
    ...MONEY.map((column) => sum((entry) => Number(entry[column.key]) || 0)),
    hoursMinutes(sorted.reduce((all, entry) => all + entry.overtimeMinutes, 0)),
    sum((entry) => entry.overtimeDays),
    sum((entry) => entry.overtimeAmount + entry.extraDaysAmount - entry.lateAmount),
    sum(entryTotal),
    "",
  ];

  return [
    [t("sheet.title")],
    ...(organizationName ? [[organizationName]] : []),
    [t("sheet.employeeName"), severalPeople ? t("sheet.employeesCount", { count: people.length }) : people[0] ?? ""],
    [t("sheet.periodFrom"), formatDateOnly(startDate, language), t("sheet.periodTo"), formatDateOnly(endDate, language)],
    [],
    header,
    ...rows,
    totals,
  ];
}
