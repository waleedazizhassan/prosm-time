import { useMemo, useState, type ReactNode } from "react";
import LoadingState from "./LoadingState";
import EmptyState from "./EmptyState";
import styles from "./Table.module.css";

export interface TableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  // With it, the header sorts by this column.
  sortValue?: (row: T) => string | number | null;
}

interface TableProps<T> {
  columns: TableColumn<T>[];
  data: T[];
  getRowId: (row: T) => string;
  loading?: boolean;
  emptyTitle?: string;
  emptyMessage: string;
  // § user-directed, 2026-09-11 - same opt-in illustration this Table
  // already forwards to EmptyState under the hood; most tables across
  // this app stay plain, a few genuinely welcoming empty states (no
  // leave requests yet, no sites yet) get one.
  emptyIllustrationSrc?: string;
  onRowClick?: (row: T) => void;
  // Plan stage 4.2, the spreadsheet look for long lists: compact rows, the header
  // and the first column stay in view, and it scrolls sideways on a phone.
  grid?: boolean;
}

// PROSM Time - a lighter port of PROSM Platform's own Table component
// (§ visual consistency pass): same wrapper/tableScroll/table/
// headerCell/row/cell CSS classes and visual behavior, and the same
// LoadingState/EmptyState treatment for its loading/empty rows (a
// spinner rather than Platform's own per-column Skeleton rows - real
// parity in kind, not a 1:1 port of every primitive). Sorting/
// selection/density are PROSM Platform's own Table features this
// product doesn't need yet - the shape (columns + render) is what's
// shared, not every capability.
export default function Table<T>({ columns, data, getRowId, loading = false, emptyTitle, emptyMessage, emptyIllustrationSrc, onRowClick, grid = false }: TableProps<T>) {
  const [sort, setSort] = useState<{ key: string; direction: 1 | -1 } | null>(null);
  const rows = useMemo(() => {
    const column = sort && columns.find((candidate) => candidate.key === sort.key);
    if (!sort || !column?.sortValue) return data;
    const value = column.sortValue;
    return [...data].sort((a, b) => {
      const left = value(a);
      const right = value(b);
      if (left === right) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      return (left < right ? -1 : 1) * sort.direction;
    });
  }, [columns, data, sort]);
  const toggleSort = (key: string) => setSort((current) => (current?.key === key ? { key, direction: current.direction === 1 ? -1 : 1 } : { key, direction: 1 }));

  return (
    <div className={styles.wrapper}>
      <div className={grid ? `${styles.tableScroll} ${styles.gridScroll}` : styles.tableScroll}>
        <table className={grid ? `${styles.table} ${styles.grid}` : styles.table}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} scope="col" className={styles.headerCell} aria-sort={sort?.key === column.key ? (sort.direction === 1 ? "ascending" : "descending") : undefined}>
                  {column.sortValue ? (
                    <button type="button" className={styles.sortButton} onClick={() => toggleSort(column.key)}>
                      {column.header}
                      {sort?.key === column.key ? <span aria-hidden="true">{sort.direction === 1 ? " ▲" : " ▼"}</span> : null}
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className={styles.emptyCell} colSpan={columns.length}>
                  <LoadingState size="sm" />
                </td>
              </tr>
            ) : data.length === 0 ? (
              <tr>
                <td className={styles.emptyCell} colSpan={columns.length}>
                  <EmptyState title={emptyTitle} message={emptyMessage} illustrationSrc={emptyIllustrationSrc} />
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={getRowId(row)}
                  className={styles.row}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  style={onRowClick ? { cursor: "pointer" } : undefined}
                >
                  {columns.map((column) => (
                    <td key={column.key} className={styles.cell} data-label={typeof column.header === "string" ? column.header : undefined}>
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
