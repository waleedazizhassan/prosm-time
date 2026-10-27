import type { jsPDF } from "jspdf";

import type { ManagerDashboard } from "../../../core/repositories/DashboardRepository";
import { escapeHtml, renderHtmlToPdf } from "../../../core/utils/htmlToPdf";
import prosmLogo from "../../../assets/prosm-logo-pdf.png";

type TFunc = (key: string, options?: Record<string, unknown>) => string;

const hours = (minutes: number) => Math.round((Number(minutes) / 60) * 10) / 10;

// Owner 2026-10-27 ("export the dashboard"): the dashboard's figures and the
// people behind them for the chosen period, in the same certified layout as
// the other exports - for the Owner to send on. Built from the data already
// on screen (already scoped by the reader's rights).
export function buildDashboardPdf(
  data: ManagerDashboard,
  from: string,
  to: string,
  languageCode: string,
  t: TFunc,
  time: (iso: string) => string,
  organizationLogoUrl?: string | null,
): Promise<jsPDF> {
  const isRtl = languageCode === "ar";
  const align = isRtl ? "right" : "left";
  const kpi = data.kpi;
  const th = (label: string) => `<th style="padding:6px 8px;text-align:${align};font-size:10.5px;">${escapeHtml(label)}</th>`;
  const td = (value: string | number) => `<td style="padding:5px 8px;border-top:1px solid #e2e8f0;font-size:10.5px;">${escapeHtml(String(value))}</td>`;
  const section = (title: string, head: string[], rows: (string | number)[][]) =>
    rows.length === 0
      ? ""
      : `<div style="margin-top:18px;">
          <div style="font-size:13px;font-weight:700;margin-bottom:6px;">${escapeHtml(title)}</div>
          <table style="width:100%;border-collapse:collapse;"><thead><tr style="background:#f1f5f9;">${head.map(th).join("")}</tr></thead>
          <tbody>${rows.map((row) => `<tr>${row.map(td).join("")}</tr>`).join("")}</tbody></table>
        </div>`;

  const tiles: [string, string | number, string][] = [
    [t("manager.kpi.present"), kpi.presentNow, kpi.hasSchedule ? t("manager.kpi.ofExpected", { expected: kpi.expectedToday }) : t("manager.kpi.ofTeam", { team: data.teamSize })],
    [t("manager.kpi.hours"), hours(kpi.workedMinutes), kpi.scheduledMinutes ? t("manager.kpi.scheduled", { hours: hours(kpi.scheduledMinutes) }) : ""],
    [t("manager.kpi.late"), kpi.lateToday, t("manager.kpi.lateInPeriod", { count: kpi.lateCount })],
    [t("manager.kpi.absent"), kpi.absentToday, t("manager.kpi.onLeave", { count: kpi.onLeaveToday })],
    [t("manager.kpi.overdue"), data.overdue?.length ?? 0, ""],
    [t("manager.kpi.overtime"), hours(kpi.overtimeMinutes), t("manager.hoursUnit")],
  ];
  if (data.canViewCost && kpi.estimatedCost !== null) tiles.push([t("manager.kpi.cost"), Math.round(kpi.estimatedCost).toLocaleString(languageCode), t("manager.kpi.costNote")]);
  const tileHtml = tiles
    .map(
      ([label, value, hint]) => `<div style="border:1px solid #e2e8f0;border-radius:8px;padding:10px;">
        <div style="font-size:10px;color:#64748b;">${escapeHtml(label)}</div>
        <div style="font-size:20px;font-weight:700;margin:2px 0;">${escapeHtml(String(value))}</div>
        <div style="font-size:9.5px;color:#64748b;">${escapeHtml(hint)}</div>
      </div>`,
    )
    .join("");

  const col = (key: string) => t(`manager.sheet.columns.${key}`);
  const sites = section(
    t("manager.sites.title"),
    [t("manager.sites.columns.name"), t("manager.sites.columns.present"), t("manager.sites.columns.late"), t("manager.sites.columns.absent"), t("manager.sites.columns.workedMinutes"), t("manager.sites.columns.overtimeMinutes")],
    data.sites.map((site) => [site.name, site.expected ? `${site.present} / ${site.expected}` : site.present, site.late, site.absent, hours(site.workedMinutes), hours(site.overtimeMinutes)]),
  );
  const people = section(
    t("manager.sheet.title.hours"),
    [col("name"), col("days"), col("worked"), col("overtime"), col("lateDays"), col("pending")],
    (data.byPerson ?? []).map((row) => [row.name, row.days, hours(row.workedMinutes), hours(row.overtimeMinutes), row.lateDays, Number(row.pendingMinutes) > 0 ? hours(row.pendingMinutes) : "—"]),
  );
  const absence = section(
    t("manager.absence.title", { absent: kpi.absentToday, leave: kpi.onLeaveToday }),
    [t("manager.absence.columns.name"), t("manager.absence.columns.site"), t("manager.absence.columns.status")],
    (data.absence ?? []).map((row) => [row.name, row.siteName ?? "—", row.state === "absent" ? t("manager.absence.absent") : t("manager.absence.leave")]),
  );
  const overdue = section(
    t("manager.sheet.title.overdue"),
    [col("name"), col("site"), col("shiftEnded"), col("overdueBy")],
    (data.overdue ?? []).map((row) => [row.name, row.siteName ?? "—", time(row.endedAt), t("manager.sheet.overdueFor", { hours: Math.floor(row.overdueMinutes / 60), minutes: Math.round(row.overdueMinutes % 60) })]),
  );

  const container = document.createElement("div");
  container.dir = isRtl ? "rtl" : "ltr";
  container.style.cssText = "width:780px;padding:36px;background:#ffffff;color:#0f172a;font-family:'Segoe UI',Tahoma,Arial,sans-serif;";
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:3px solid #16a34a;padding-bottom:16px;margin-bottom:16px;">
      <img src="${prosmLogo}" style="height:44px;width:44px;object-fit:contain;" />
      <div style="text-align:center;flex:1;">
        <div style="font-size:19px;font-weight:700;">${escapeHtml(t("manager.title"))}</div>
        <div style="font-size:12px;color:#64748b;margin-top:2px;">${escapeHtml(from)} — ${escapeHtml(to)} · ${escapeHtml(t("manager.export.asOf", { time: time(data.asOf) }))}</div>
      </div>
      ${organizationLogoUrl ? `<img src="${escapeHtml(organizationLogoUrl)}" style="height:44px;max-width:80px;object-fit:contain;" />` : `<div style="width:44px;"></div>`}
    </div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;">${tileHtml}</div>
    ${sites}${people}${absence}${overdue}
  `;
  return renderHtmlToPdf(container);
}
