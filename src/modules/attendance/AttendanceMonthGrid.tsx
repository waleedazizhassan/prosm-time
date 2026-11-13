import { useMemo } from "react";

import Table, { type TableColumn } from "../../components/common/Table";

interface GridSession {
  userFullName: string;
  clockInAt: string;
  clockOutAt: string | null;
}

interface PersonRow {
  name: string;
  days: Map<string, number>;
  open: Set<string>;
}

const hours = (session: GridSession) => (session.clockOutAt ? (new Date(session.clockOutAt).getTime() - new Date(session.clockInAt).getTime()) / 3_600_000 : 0);

function daysBetween(start: string, end: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last && days.length < 62) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

// Plan stage 4.2: the period at a glance, people by days: hours worked, green; a
// shift still open, amber; a day without a record stays empty.
export default function AttendanceMonthGrid({ sessions, startDate, endDate, employeeHeader, emptyMessage }: { sessions: GridSession[]; startDate: string; endDate: string; employeeHeader: string; emptyMessage: string }) {
  const days = useMemo(() => daysBetween(startDate, endDate), [startDate, endDate]);
  const people = useMemo(() => {
    const byName = new Map<string, PersonRow>();
    for (const session of sessions) {
      const day = session.clockInAt.slice(0, 10);
      const person = byName.get(session.userFullName) ?? { name: session.userFullName, days: new Map(), open: new Set() };
      person.days.set(day, (person.days.get(day) ?? 0) + hours(session));
      if (!session.clockOutAt) person.open.add(day);
      byName.set(session.userFullName, person);
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [sessions]);

  const columns: TableColumn<PersonRow>[] = [
    { key: "name", header: employeeHeader, sortValue: (row) => row.name, render: (row) => row.name },
    ...days.map((day) => ({
      key: day,
      header: day.slice(8),
      render: (row: PersonRow) => {
        if (!row.days.has(day)) return null;
        const open = row.open.has(day);
        return <span style={{ color: open ? "var(--status-warning-text)" : "var(--status-success-text)", fontWeight: "var(--font-weight-semibold)" }}>{open ? "•" : (row.days.get(day) ?? 0).toFixed(1)}</span>;
      },
    })),
  ];

  return <Table grid wideOnPhone columns={columns} data={people} getRowId={(row) => row.name} emptyMessage={emptyMessage} />;
}
