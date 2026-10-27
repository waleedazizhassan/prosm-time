// v2.3.54 (owner 2026-10-26): the emails of a leave request - to the
// reviewer when it is asked for, to the requester (with a copy to whoever
// decided) when it is answered. Arabic for an Arabic reader, English
// otherwise; the same branded card as the other PROSM Time emails.
// deno-lint-ignore-file no-explicit-any

export interface LeaveEmailData {
  kind: "request" | "approved" | "rejected" | "cancelled" | "withdrawn";
  requestId?: string;
  copyToRequester?: boolean;
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

  // v2.3.55 (owner 2026-10-27: "back and forth on the same thread"): every email
  // of one request has this same subject, so mail apps keep them together.
  const subject = L(`طلب إجازة - ${data.requester.name} - ${period}`, `Leave request - ${data.requester.name} - ${period}`);
  const link = (email: string) => `<a href="mailto:${escape(email)}" style="color:#1e6fd9;font-weight:normal;">${escape(email)}</a>`;
  const person = (who: { name: string; email: string | null }) => `${escape(who.name)}${who.email ? `<br>${link(who.email)}` : ""}`;
  const answerLine = (label: string, email: string) => (email ? `<br>${escape(label)} ${link(email)}` : "");
  const emails: RenderedEmail[] = [];

  if (data.kind === "request") {
    if (data.recipient.email) {
      emails.push({
        to: data.recipient.email,
        subject,
        purpose: "time-leave-request",
        html: card(
          dir,
          L("طلب إجازة بانتظار موافقتك", "A leave request awaits your review"),
          escape(L(`${data.requester.name} طلب ${typeLabel} ${period}. راجعه ووافق أو ارفض من البرنامج.`, `${data.requester.name} asked for ${typeLabel.toLowerCase()}, ${period}. Review it in the app.`)),
          baseRows,
          { label: L("مراجعة الطلب", "Review the request"), href: `${APP_URL}/manager` },
          footer + answerLine(L("للرد على الموظف مباشرة:", "To answer the employee directly:"), requesterEmail),
        ),
      });
    }
    // the requester's own copy: sent, and to whom
    if (data.copyToRequester && requesterEmail && requesterEmail !== data.recipient.email) {
      emails.push({
        to: requesterEmail,
        subject,
        purpose: "time-leave-request-sent",
        html: card(
          dir,
          L("تم إرسال طلب إجازتك", "Your leave request was sent"),
          escape(L(`أرسلنا طلبك (${typeLabel} ${period}) إلى ${data.recipient.name}. هيوصلك الرد على نفس الرسالة.`, `Your request (${typeLabel.toLowerCase()}, ${period}) went to ${data.recipient.name}. The answer will come on this same thread.`)),
          [...baseRows, [L("أُرسل إلى", "Sent to"), person(data.recipient)]],
          { label: L("عرض إجازاتي", "View my leave"), href: `${APP_URL}/leave` },
          footer,
        ),
      });
    }
    return emails;
  }

  if (data.kind === "withdrawn") {
    // the requester took back an approved leave: whoever is told, and the requester's copy
    const title = L("تم إلغاء إجازة معتمدة", "An approved leave was withdrawn");
    const intro = escape(L(`${data.requester.name} ألغى ${typeLabel} ${period} بعد الموافقة عليها.`, `${data.requester.name} withdrew their approved ${typeLabel.toLowerCase()}, ${period}.`));
    if (data.recipient.email) emails.push({ to: data.recipient.email, subject, purpose: "time-leave-withdrawn", html: card(dir, title, intro, baseRows, null, footer + answerLine(L("للرد على الموظف:", "To answer the employee:"), requesterEmail)) });
    if (data.copyToRequester && requesterEmail && requesterEmail !== data.recipient.email) {
      emails.push({ to: requesterEmail, subject, purpose: "time-leave-withdrawn-copy", html: card(dir, L("تم إلغاء إجازتك", "Your leave is cancelled"), escape(L(`ألغيت ${typeLabel} ${period}، ورجع رصيدها لك.`, `You withdrew your ${typeLabel.toLowerCase()}, ${period}; its days are back in your balance.`)), baseRows, null, footer) });
    }
    return emails;
  }

  const approved = data.kind === "approved";
  const cancelled = data.kind === "cancelled";
  const rows = [...baseRows];
  if (data.reviewer) rows.push([L(approved ? "وافق عليها" : cancelled ? "ألغاها" : "رفضها", approved ? "Approved by" : cancelled ? "Cancelled by" : "Declined by"), person(data.reviewer)]);
  if (data.leave.notes) rows.push([L("ملاحظة", "Note"), escape(data.leave.notes)]);
  if ((approved || cancelled) && data.remainingDays !== null) rows.push([L(`المتبقي من رصيد ${typeLabel}`, `Remaining ${typeLabel.toLowerCase()} balance`), escape(L(`${num(data.remainingDays)} يوم`, `${num(data.remainingDays)} day(s)`))]);

  const title = approved
    ? L("تمت الموافقة على إجازتك 🎉", "Your leave is approved 🎉")
    : cancelled
      ? L("تم إلغاء إجازتك", "Your leave is cancelled")
      : L("لم تتم الموافقة على طلب إجازتك", "Your leave request was not approved");
  const intro = approved
    ? escape(L(`مبروك يا ${data.requester.name}! تمت الموافقة على ${typeLabel} ${period}${data.remainingDays !== null ? `، والمتبقي من رصيدك ${num(data.remainingDays)} يوم` : ""}. إجازة سعيدة.`, `Congratulations, ${data.requester.name}! Your ${typeLabel.toLowerCase()} is approved, ${period}${data.remainingDays !== null ? `; ${num(data.remainingDays)} day(s) of your balance remain` : ""}. Enjoy your time off.`))
    : cancelled
      ? escape(L(`تم إلغاء ${typeLabel} ${period} بعد الموافقة عليها، ورجعت أيامها لرصيدك.`, `Your approved ${typeLabel.toLowerCase()}, ${period}, was cancelled; its days are back in your balance.`))
      : escape(L(`للأسف لم تتم الموافقة على ${typeLabel} ${period}.`, `Your ${typeLabel.toLowerCase()} request, ${period}, was not approved.`));

  if (requesterEmail) {
    emails.push({ to: requesterEmail, subject, purpose: `time-leave-${data.kind}`, html: card(dir, title, intro, rows, { label: L("عرض إجازاتي", "View my leave"), href: `${APP_URL}/leave` }, footer + answerLine(L("للرد على صاحب القرار:", "To answer the person who decided:"), reviewerEmail)) });
  }
  // the decider's copy, on the same thread
  if (reviewerEmail && reviewerEmail !== requesterEmail) {
    emails.push({ to: reviewerEmail, subject, purpose: `time-leave-${data.kind}-copy`, html: card(dir, title, intro, rows, null, footer + answerLine(L("للرد على الموظف:", "To answer the employee:"), requesterEmail)) });
  }
  return emails;
}
