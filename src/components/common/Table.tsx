import type { ReactNode } from "react";
import LoadingState from "./LoadingState";
import EmptyState from "./EmptyState";
import styles from "./Table.module.css";

export interface TableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
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
export default function Table<T>({ columns, data, getRowId, loading = false, emptyTitle, emptyMessage, emptyIllustrationSrc, onRowClick }: TableProps<T>) {
  return (
    <div className={styles.wrapper}>
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} scope="col" className={styles.headerCell}>
                  {column.header}
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
              data.map((row) => (
                <tr
                  key={getRowId(row)}
                  className={styles.row}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  style={onRowClick ? { cursor: "pointer" } : undefined}
                >
                  {columns.map((column) => (
                    <td key={column.key} className={styles.cell}>
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
