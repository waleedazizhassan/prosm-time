import type { ReactNode } from "react";
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
  emptyMessage: string;
  onRowClick?: (row: T) => void;
}

// PROSM Time - a lighter port of PROSM Platform's own Table component
// (§ visual consistency pass): same wrapper/tableScroll/table/
// headerCell/row/cell CSS classes and visual behavior. Sorting/
// selection/density are PROSM Platform's own Table features this
// product doesn't need yet - the shape (columns + render) is what's
// shared, not every capability.
export default function Table<T>({ columns, data, getRowId, loading = false, emptyMessage, onRowClick }: TableProps<T>) {
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
                  …
                </td>
              </tr>
            ) : data.length === 0 ? (
              <tr>
                <td className={styles.emptyCell} colSpan={columns.length}>
                  {emptyMessage}
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
