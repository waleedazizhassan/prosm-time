import { Fragment, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
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
  // owner 2026-11-13: on a phone every table becomes cards; a matrix (people by days) keeps its columns and scrolls sideways
  wideOnPhone?: boolean;
  // Rows per page; a grid defaults to 50. A long list stays quick on a phone.
  pageSize?: number;
  // Rows of the same group together, each group under its own heading.
  groupBy?: (row: T) => string;
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
export default function Table<T>({ columns, data, getRowId, loading = false, emptyTitle, emptyMessage, emptyIllustrationSrc, onRowClick, grid = false, wideOnPhone = false, pageSize, groupBy }: TableProps<T>) {
  const { t } = useTranslation("common");
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ key: string; direction: 1 | -1 } | null>(null);
  const sorted = useMemo(() => {
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
  const grouped = useMemo(() => {
    if (!groupBy) return sorted;
    const groups = new Map<string, T[]>();
    for (const row of sorted) groups.set(groupBy(row), [...(groups.get(groupBy(row)) ?? []), row]);
    return [...groups.values()].flat();
  }, [sorted, groupBy]);
  const perPage = pageSize ?? (grid ? 50 : grouped.length || 1);
  const pages = Math.max(1, Math.ceil(grouped.length / perPage));
  const current = Math.min(page, pages - 1);
  const rows = grouped.slice(current * perPage, (current + 1) * perPage);
  const toggleSort = (key: string) => setSort((current) => (current?.key === key ? { key, direction: current.direction === 1 ? -1 : 1 } : { key, direction: 1 }));

  // screens review 2026-11-13: an empty or loading table says so across the whole width - inside the table's
  // horizontal scroll (wider than a phone) the message sat cut off at one side
  if (loading || data.length === 0) {
    return (
      <div className={styles.wrapper}>
        <div className={styles.emptyCell}>
          {loading ? <LoadingState size="sm" /> : <EmptyState title={emptyTitle} message={emptyMessage} illustrationSrc={emptyIllustrationSrc} />}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      <div className={grid ? `${styles.tableScroll} ${styles.gridScroll}` : styles.tableScroll}>
        <table className={`${styles.table}${grid ? ` ${styles.grid}` : ""}${wideOnPhone ? ` ${styles.wide}` : ""}`}>
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
              rows.map((row, index) => (
                <Fragment key={getRowId(row)}>
                  {groupBy && (index === 0 || groupBy(rows[index - 1]) !== groupBy(row)) ? (
                    <tr>
                      <th scope="colgroup" colSpan={columns.length} className={styles.groupCell}>
                        {groupBy(row)}
                      </th>
                    </tr>
                  ) : null}
                <tr
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
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>
      {pages > 1 ? (
        <div className={styles.pager}>
          <button type="button" className={styles.pagerButton} disabled={current === 0} onClick={() => setPage(current - 1)}>
            {t("table.previous")}
          </button>
          <span>{t("table.page", { page: current + 1, pages })}</span>
          <button type="button" className={styles.pagerButton} disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
            {t("table.next")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
