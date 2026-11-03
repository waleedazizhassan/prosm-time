// v2.3.54 (owner 2026-10-26): the emails of a leave request, in the same
// branded card as the other PROSM Time emails.
//
// v2.3.61 (owner 2026-10-28, the workflow he set out):
//   - a request: to the person it is sent to ("awaiting your review"), with a
//     copy to the employee ("your request was sent");
//   - a decision - approved, declined, or cancelled after approval: to the
//     employee only (no copy to whoever decided);
//   - withdrawn by the employee: the person it was sent to (or who approved
//     it) is told, with the employee's copy.
// Each reader gets their own language, all on one thread.
// deno-lint-ignore-file no-explicit-any
import { emailLanguage, emailT, inSentence, isRtl } from "./emailI18n.ts";

type Person = { id: string; name: string; email: string | null };

export interface LeaveEmailData {
  kind: "request" | "approved" | "rejected" | "cancelled" | "withdrawn" | "request_withdrawn";
  requestId?: string;
  copyToRequester?: boolean;
  organizationName: string;
  organizationId: string;
  language: string;
  languages?: Record<string, string>;
  recipient: Person;
  requester: Person;
  reviewer: Person | null;
  leave: { type: string; typeName: string | null; isPaid: boolean | null; startDate: string; endDate: string; days: number; reason: string | null; notes: string | null };
  remainingDays: number | null;
}

const APP_URL = "https://time.prosm.net";

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

const link = (email: string) => `<a href="mailto:${escape(email)}" style="color:#1e6fd9;font-weight:normal;">${escape(email)}</a>`;
const person = (who: { name: string; email: string | null }) => `${escape(who.name)}${who.email ? `<br>${link(who.email)}` : ""}`;

/** The words of one language, for one leave request (owner 2026-11-03: any of the nine). */
function wording(data: LeaveEmailData, readerLanguage: string) {
  const language = emailLanguage(readerLanguage);
  const T = (path: string, vars: Record<string, unknown> = {}) => emailT(language, path, vars);
  const known = ["annual", "sick", "unpaid", "emergency", "other"].includes(data.leave.type);
  const typeLabel = known ? T(`leave.types.${data.leave.type}`) : data.leave.typeName ?? data.leave.type;
  const type = inSentence(language, typeLabel);
  const period = T("leave.period", { from: day(data.leave.startDate), to: day(data.leave.endDate) });
  const days = (value: number) => T("common.days", { count: Number(num(value)) });
  const rows: [string, string][] = [
    [T("leave.rows.employee"), person(data.requester)],
    [T("leave.rows.type"), escape(typeLabel) + (data.leave.isPaid === false ? escape(T("leave.unpaid")) : "")],
    [T("leave.rows.period"), escape(period)],
    [T("leave.rows.days"), escape(days(data.leave.days))],
  ];
  if (data.leave.reason) rows.push([T("leave.rows.reason"), escape(data.leave.reason)]);
  return {
    T,
    days,
    dir: (isRtl(language) ? "rtl" : "ltr") as "rtl" | "ltr",
    typeLabel,
    type,
    period,
    rows,
    // v2.3.55 (owner 2026-10-27: "back and forth on the same thread"): every email
    // of one request has this same subject, so mail apps keep them together.
    subject: T("leave.subject", { name: data.requester.name, period }),
    footer: escape(T("common.footer", { org: data.organizationName })),
    answerLine: (path: string, email: string | null) => (email ? `<br>${escape(T(path))} ${link(email)}` : ""),
  };
}

/** The emails for one leave notification, each in its reader's language. */
export function renderLeaveEmails(data: LeaveEmailData): RenderedEmail[] {
  const languageOf = (id: string | undefined) => (id && data.languages?.[id]) || data.language;
  const requester = data.requester;
  const recipient = data.recipient;
  const emails: RenderedEmail[] = [];
  // one thread for everyone: the subject is always in the requester's language
  const subject = wording(data, languageOf(requester.id)).subject;
  const push = (to: string | null, reader: string | undefined, purpose: string, build: (w: ReturnType<typeof wording>) => string) => {
    if (!to) return;
    if (emails.some((email) => email.to === to)) return;
    emails.push({ to, subject, purpose, html: build(wording(data, languageOf(reader))) });
  };

  if (data.kind === "request") {
    push(recipient.email, recipient.id, "time-leave-request", (w) =>
      card(
        w.dir,
        w.T("leave.request.title"),
        escape(w.T("leave.request.intro", { name: requester.name, type: w.type, period: w.period })),
        w.rows,
        { label: w.T("leave.request.action"), href: `${APP_URL}/manager` },
        w.footer + w.answerLine("leave.answerEmployee", requester.email),
      ),
    );
    // the requester's own copy: sent, and to whom
    if (data.copyToRequester) {
      push(requester.email, requester.id, "time-leave-request-sent", (w) =>
        card(
          w.dir,
          w.T("leave.sent.title"),
          escape(w.T("leave.sent.intro", { type: w.type, period: w.period, to: recipient.name })),
          [...w.rows, [w.T("leave.rows.sentTo"), person(recipient)]],
          { label: w.T("leave.viewMine"), href: `${APP_URL}/leave` },
          w.footer,
        ),
      );
    }
    return emails;
  }

  if (data.kind === "request_withdrawn") {
    // withdrawn before anyone answered: nothing is left to decide
    push(recipient.email, recipient.id, "time-leave-request-withdrawn", (w) =>
      card(w.dir, w.T("leave.requestWithdrawn.title"), escape(w.T("leave.requestWithdrawn.intro", { name: requester.name, type: w.type, period: w.period })), w.rows, null, w.footer),
    );
    if (data.copyToRequester) {
      push(requester.email, requester.id, "time-leave-request-withdrawn-copy", (w) =>
        card(w.dir, w.T("leave.requestWithdrawn.copyTitle"), escape(w.T("leave.requestWithdrawn.copyIntro", { type: w.type, period: w.period, to: recipient.name })), w.rows, null, w.footer),
      );
    }
    return emails;
  }

  if (data.kind === "withdrawn") {
    // the requester took back an approved leave: whoever is told, and the requester's copy
    push(recipient.email, recipient.id, "time-leave-withdrawn", (w) =>
      card(
        w.dir,
        w.T("leave.withdrawn.title"),
        escape(w.T("leave.withdrawn.intro", { name: requester.name, type: w.type, period: w.period })),
        w.rows,
        null,
        w.footer + w.answerLine("leave.answerEmployeeShort", requester.email),
      ),
    );
    if (data.copyToRequester) {
      push(requester.email, requester.id, "time-leave-withdrawn-copy", (w) =>
        card(w.dir, w.T("leave.withdrawn.copyTitle"), escape(w.T("leave.withdrawn.copyIntro", { type: w.type, period: w.period })), w.rows, null, w.footer),
      );
    }
    return emails;
  }

  // a decision: approved, rejected, or cancelled after approval.
  // v2.3.61 (owner 2026-10-28): it goes to the employee only - "the manager who
  // decided must not get it, only employee 1" - no copy to whoever decided,
  // nor to the person the request was sent to.
  const kind = data.kind;
  const approved = kind === "approved";
  const cancelled = kind === "cancelled";
  const decider = data.reviewer;
  const decisionRows = (w: ReturnType<typeof wording>) => {
    const rows = [...w.rows];
    if (decider) rows.push([w.T(approved ? "leave.rows.approvedBy" : cancelled ? "leave.rows.cancelledBy" : "leave.rows.declinedBy"), person(decider)]);
    if (data.leave.notes) rows.push([w.T("leave.rows.note"), escape(data.leave.notes)]);
    if ((approved || cancelled) && data.remainingDays !== null) rows.push([w.T("leave.rows.remaining", { type: w.type }), escape(w.days(data.remainingDays))]);
    return rows;
  };
  push(requester.email, requester.id, `time-leave-${kind}`, (w) => {
    const title = w.T(approved ? "leave.approved.title" : cancelled ? "leave.cancelled.title" : "leave.rejected.title");
    const vars = { name: requester.name, type: w.type, period: w.period, remaining: data.remainingDays !== null ? w.days(data.remainingDays) : "" };
    const intro = approved
      ? w.T(data.remainingDays !== null ? "leave.approved.introBalance" : "leave.approved.intro", vars)
      : w.T(cancelled ? "leave.cancelled.intro" : "leave.rejected.intro", vars);
    return card(w.dir, title, escape(intro), decisionRows(w), { label: w.T("leave.viewMine"), href: `${APP_URL}/leave` }, w.footer + w.answerLine("leave.answerDecider", decider?.email ?? null));
  });
  return emails;
}
