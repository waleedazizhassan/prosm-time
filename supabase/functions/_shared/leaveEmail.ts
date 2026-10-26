// v2.3.54 (owner 2026-10-26): the emails of a leave request - to the
// reviewer when it is asked for, to the requester (with a copy to whoever
// decided) when it is answered. Arabic for an Arabic reader, English
// otherwise; the same branded card as the other PROSM Time emails.
// deno-lint-ignore-file no-explicit-any

export interface LeaveEmailData {
  kind: "request" | "approved" | "rejected";
  organizationName: string;
  organizationId: string;
  language: string;
  recipient: { id: string; name: string; email: string | null };
  requester: { id: string; name: string; email: string | null };
  reviewer: { id: string; name: string; email: string | null } | null;
  leave: { type: string; typeName: string | null; isPaid: boolean | null; startDate: string; endDate: string; days: number; reason: string | null; notes: string | null };
  remainingDays: number | null;
}

const APP_URL = "https://time.prosm.net";

const TYPES: Record<string, { ar: string; en: string }> = {
  annual: { ar: "إجازة سنوية", en: "Annual leave" },
  sick: { ar: "إجازة مرضية", en: "Sick leave" },
  unpaid: { ar: "إجازة بدون أجر", en: "Unpaid leave" },
  emergency: { ar: "إجازة طارئة", en: "Emergency leave" },
  other: { ar: "إجازة أخرى", en: "Other leave" },
};

const escape = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const day = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
};
const num = (value: number) => String(Math.round(Number(value) * 10) / 10);

function card(dir: "rtl" | "ltr", title: string, intro: string, rows: [string, string][], action: { label: string; href: string } | null, footer: string) {
  const align = dir === "rtl" ? "right" : "left";
  const table = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:8px 0;color:#6b7280;font-size:14px;width:38%;vertical-align:top;">${escape(label)}</td><td style="padding:8px 0;color:#0f172a;font-size:15px;font-weight:bold;">${value}</td></tr>`,
    )
    .join("");
  const button = action
    ? `<p style="margin:24px 0 0;"><a href="${escape(action.href)}" style="display:inline-block;background:#1e6fd9;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;">${escape(action.label)}</a></p>`
    : "";
  return `
<div dir="${dir}" style="font-family:Arial,sans-serif;padding:24px;background:#f5f5f5;text-align:${align};">
  <div style="max-width:600px;margin:auto;background:#ffffff;border-radius:8px;padding:32px;">
    <h2 style="margin-top:0;color:#0f172a;">${escape(title)}</h2>
    <p style="font-size:16px;color:#374151;line-height:1.6;">${intro}</p>
    <table style="width:100%;border-collapse:collapse;margin-top:12px;border-top:1px solid #e5e7eb;">${table}</table>
    ${button}
    <p style="color:#9ca3af;font-size:12px;margin-top:28px;">${footer}</p>
  </div>
</div>`;
}

export interface RenderedEmail {
  to: string;
  subject: string;
  html: string;
  purpose: string;
}

/** The emails for one leave notification: the reviewer's, or the requester's plus the decider's copy. */
export function renderLeaveEmails(data: LeaveEmailData): RenderedEmail[] {
  const ar = data.language === "ar";
  const dir = ar ? "rtl" : "ltr";
  const L = (arText: string, enText: string) => (ar ? arText : enText);
  const typeLabel = TYPES[data.leave.type]?.[ar ? "ar" : "en"] ?? data.leave.typeName ?? data.leave.type;
  const period = L(`من ${day(data.leave.startDate)} إلى ${day(data.leave.endDate)}`, `${day(data.leave.startDate)} to ${day(data.leave.endDate)}`);
  const days = L(`${num(data.leave.days)} يوم`, `${num(data.leave.days)} day(s)`);
  const requesterEmail = data.requester.email ?? "";
  const reviewerEmail = data.reviewer?.email ?? "";
  const footer = escape(L(`${data.organizationName} · PROSM Time - رسالة تلقائية من نظام الحضور.`, `${data.organizationName} · PROSM Time - an automatic message from the attendance system.`));
  const baseRows: [string, string][] = [
    [L("الموظف", "Employee"), `${escape(data.requester.name)}${requesterEmail ? `<br><a href="mailto:${escape(requesterEmail)}" style="color:#1e6fd9;font-weight:normal;">${escape(requesterEmail)}</a>` : ""}`],
    [L("نوع الإجازة", "Leave type"), escape(typeLabel) + (data.leave.isPaid === false ? escape(L(" (بدون أجر)", " (unpaid)")) : "")],
    [L("المدة", "Period"), escape(period)],
    [L("عدد الأيام", "Days"), escape(days)],
  ];
  if (data.leave.reason) baseRows.push([L("السبب", "Reason"), escape(data.leave.reason)]);

  if (data.kind === "request") {
    if (!data.recipient.email) return [];
    const subject = L(`طلب إجازة من ${data.requester.name} - ${period}`, `Leave request from ${data.requester.name} - ${period}`);
    return [
      {
        to: data.recipient.email,
        subject,
        purpose: "time-leave-request",
        html: card(
          dir,
          L("طلب إجازة بانتظار موافقتك", "A leave request awaits your review"),
          escape(L(`${data.requester.name} طلب ${typeLabel} ${period}. راجعه ووافق أو ارفض من البرنامج.`, `${data.requester.name} asked for ${typeLabel.toLowerCase()}, ${period}. Review it in the app.`)),
          baseRows,
          { label: L("مراجعة الطلب", "Review the request"), href: `${APP_URL}/manager` },
          footer + (requesterEmail ? `<br>${escape(L("للرد على الموظف مباشرة:", "To answer the employee directly:"))} <a href="mailto:${escape(requesterEmail)}">${escape(requesterEmail)}</a>` : ""),
        ),
      },
    ];
  }

  const approved = data.kind === "approved";
  const rows = [...baseRows];
  if (data.reviewer) rows.push([L(approved ? "وافق عليها" : "رفضها", approved ? "Approved by" : "Declined by"), `${escape(data.reviewer.name)}${reviewerEmail ? `<br><a href="mailto:${escape(reviewerEmail)}" style="color:#1e6fd9;font-weight:normal;">${escape(reviewerEmail)}</a>` : ""}`]);
  if (data.leave.notes) rows.push([L("ملاحظة", "Note"), escape(data.leave.notes)]);
  if (approved && data.remainingDays !== null) rows.push([L(`المتبقي من رصيد ${typeLabel}`, `Remaining ${typeLabel.toLowerCase()} balance`), escape(L(`${num(data.remainingDays)} يوم`, `${num(data.remainingDays)} day(s)`))]);

  const title = approved ? L("تمت الموافقة على إجازتك 🎉", "Your leave is approved 🎉") : L("بخصوص طلب إجازتك", "About your leave request");
  const intro = approved
    ? escape(L(`مبروك يا ${data.requester.name}! تمت الموافقة على ${typeLabel} ${period}${data.remainingDays !== null ? `، والمتبقي من رصيدك ${num(data.remainingDays)} يوم` : ""}. إجازة سعيدة.`, `Congratulations, ${data.requester.name}! Your ${typeLabel.toLowerCase()} is approved, ${period}${data.remainingDays !== null ? `; ${num(data.remainingDays)} day(s) of your balance remain` : ""}. Enjoy your time off.`))
    : escape(L(`للأسف لم تتم الموافقة على ${typeLabel} ${period}.`, `Your ${typeLabel.toLowerCase()} request, ${period}, was not approved.`));
  const subject = approved ? L(`تمت الموافقة على إجازتك - ${period}`, `Leave approved - ${period}`) : L(`لم تتم الموافقة على طلب الإجازة - ${period}`, `Leave not approved - ${period}`);
  const replyLine = reviewerEmail ? `<br>${escape(L("للرد على صاحب القرار:", "To answer the person who decided:"))} <a href="mailto:${escape(reviewerEmail)}">${escape(reviewerEmail)}</a>` : "";

  const emails: RenderedEmail[] = [];
  if (data.requester.email) {
    emails.push({ to: data.requester.email, subject, purpose: `time-leave-${data.kind}`, html: card(dir, title, intro, rows, { label: L("عرض إجازاتي", "View my leave"), href: `${APP_URL}/leave` }, footer + replyLine) });
  }
  // the copy for whoever decided, on the same subject
  if (reviewerEmail && reviewerEmail !== data.requester.email) {
    emails.push({
      to: reviewerEmail,
      subject: `${L("نسخة", "Copy")}: ${subject} - ${data.requester.name}`,
      purpose: `time-leave-${data.kind}-copy`,
      html: card(dir, title, intro, rows, null, footer + (requesterEmail ? `<br>${escape(L("للرد على الموظف:", "To answer the employee:"))} <a href="mailto:${escape(requesterEmail)}">${escape(requesterEmail)}</a>` : "")),
    });
  }
  return emails;
}
