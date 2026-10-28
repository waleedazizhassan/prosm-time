// v2.3.54 (owner 2026-10-26): the emails of a leave request - to the
// reviewer when it is asked for, to the requester (with a copy to whoever
// decided) when it is answered. Arabic for an Arabic reader, English
// otherwise; the same branded card as the other PROSM Time emails.
//
// v2.3.59 (owner 2026-10-28: "a real review of the workflow"): each email is
// written for its reader - the person who decided gets "you approved X's
// leave", not the employee's congratulations; the person a request was sent
// to hears when someone else decided it, or when the requester withdrew it
// before anyone answered; and each reader gets their own language.
// deno-lint-ignore-file no-explicit-any

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
  chosenReviewer?: Person | null;
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

const link = (email: string) => `<a href="mailto:${escape(email)}" style="color:#1e6fd9;font-weight:normal;">${escape(email)}</a>`;
const person = (who: { name: string; email: string | null }) => `${escape(who.name)}${who.email ? `<br>${link(who.email)}` : ""}`;

/** The words of one language, for one leave request. */
function wording(data: LeaveEmailData, language: string) {
  const ar = language === "ar";
  const L = (arText: string, enText: string) => (ar ? arText : enText);
  const typeLabel = TYPES[data.leave.type]?.[ar ? "ar" : "en"] ?? data.leave.typeName ?? data.leave.type;
  const typeLower = ar ? typeLabel : typeLabel.toLowerCase();
  const period = L(`من ${day(data.leave.startDate)} إلى ${day(data.leave.endDate)}`, `${day(data.leave.startDate)} to ${day(data.leave.endDate)}`);
  const rows: [string, string][] = [
    [L("الموظف", "Employee"), person(data.requester)],
    [L("نوع الإجازة", "Leave type"), escape(typeLabel) + (data.leave.isPaid === false ? escape(L(" (بدون أجر)", " (unpaid)")) : "")],
    [L("المدة", "Period"), escape(period)],
    [L("عدد الأيام", "Days"), escape(L(`${num(data.leave.days)} يوم`, `${num(data.leave.days)} day(s)`))],
  ];
  if (data.leave.reason) rows.push([L("السبب", "Reason"), escape(data.leave.reason)]);
  return {
    ar,
    L,
    dir: (ar ? "rtl" : "ltr") as "rtl" | "ltr",
    typeLabel,
    typeLower,
    period,
    rows,
    // v2.3.55 (owner 2026-10-27: "back and forth on the same thread"): every email
    // of one request has this same subject, so mail apps keep them together.
    subject: L(`طلب إجازة - ${data.requester.name} - ${period}`, `Leave request - ${data.requester.name} - ${period}`),
    footer: escape(L(`${data.organizationName} · PROSM Time - رسالة تلقائية من نظام الحضور.`, `${data.organizationName} · PROSM Time - an automatic message from the attendance system.`)),
    answerLine: (arLabel: string, enLabel: string, email: string | null) => (email ? `<br>${escape(L(arLabel, enLabel))} ${link(email)}` : ""),
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
        w.L("طلب إجازة بانتظار موافقتك", "A leave request awaits your review"),
        escape(w.L(`${requester.name} طلب ${w.typeLabel} ${w.period}. راجعه ووافق أو ارفض من البرنامج.`, `${requester.name} asked for ${w.typeLower}, ${w.period}. Review it in the app.`)),
        w.rows,
        { label: w.L("مراجعة الطلب", "Review the request"), href: `${APP_URL}/manager` },
        w.footer + w.answerLine("للرد على الموظف مباشرة:", "To answer the employee directly:", requester.email),
      ),
    );
    // the requester's own copy: sent, and to whom
    if (data.copyToRequester) {
      push(requester.email, requester.id, "time-leave-request-sent", (w) =>
        card(
          w.dir,
          w.L("تم إرسال طلب إجازتك", "Your leave request was sent"),
          escape(w.L(`أرسلنا طلبك (${w.typeLabel} ${w.period}) إلى ${recipient.name}. هيوصلك الرد على نفس الرسالة.`, `Your request (${w.typeLower}, ${w.period}) went to ${recipient.name}. The answer will come on this same thread.`)),
          [...w.rows, [w.L("أُرسل إلى", "Sent to"), person(recipient)]],
          { label: w.L("عرض إجازاتي", "View my leave"), href: `${APP_URL}/leave` },
          w.footer,
        ),
      );
    }
    return emails;
  }

  if (data.kind === "request_withdrawn") {
    // withdrawn before anyone answered: nothing is left to decide
    push(recipient.email, recipient.id, "time-leave-request-withdrawn", (w) =>
      card(
        w.dir,
        w.L("تم سحب طلب إجازة", "A leave request was withdrawn"),
        escape(w.L(`${requester.name} سحب طلب ${w.typeLabel} ${w.period} قبل الرد عليه. مش مطلوب منك أي إجراء.`, `${requester.name} withdrew the request for ${w.typeLower}, ${w.period}, before it was answered. Nothing is needed from you.`)),
        w.rows,
        null,
        w.footer,
      ),
    );
    if (data.copyToRequester) {
      push(requester.email, requester.id, "time-leave-request-withdrawn-copy", (w) =>
        card(
          w.dir,
          w.L("تم سحب طلب إجازتك", "Your leave request was withdrawn"),
          escape(w.L(`سحبت طلب ${w.typeLabel} ${w.period}، وبلّغنا ${recipient.name}.`, `You withdrew your request for ${w.typeLower}, ${w.period}; ${recipient.name} has been told.`)),
          w.rows,
          null,
          w.footer,
        ),
      );
    }
    return emails;
  }

  if (data.kind === "withdrawn") {
    // the requester took back an approved leave: whoever is told, and the requester's copy
    push(recipient.email, recipient.id, "time-leave-withdrawn", (w) =>
      card(
        w.dir,
        w.L("تم إلغاء إجازة معتمدة", "An approved leave was withdrawn"),
        escape(w.L(`${requester.name} ألغى ${w.typeLabel} ${w.period} بعد الموافقة عليها، ورجعت أيامها لرصيده. مش مطلوب منك أي إجراء.`, `${requester.name} withdrew their approved ${w.typeLower}, ${w.period}; its days are back in their balance. Nothing is needed from you.`)),
        w.rows,
        null,
        w.footer + w.answerLine("للرد على الموظف:", "To answer the employee:", requester.email),
      ),
    );
    if (data.copyToRequester) {
      push(requester.email, requester.id, "time-leave-withdrawn-copy", (w) =>
        card(w.dir, w.L("تم إلغاء إجازتك", "Your leave is cancelled"), escape(w.L(`ألغيت ${w.typeLabel} ${w.period}، ورجع رصيدها لك.`, `You withdrew your ${w.typeLower}, ${w.period}; its days are back in your balance.`)), w.rows, null, w.footer),
      );
    }
    return emails;
  }

  // a decision: approved, rejected, or cancelled after approval
  const kind = data.kind;
  const approved = kind === "approved";
  const cancelled = kind === "cancelled";
  const decider = data.reviewer;
  const decisionRows = (w: ReturnType<typeof wording>) => {
    const rows = [...w.rows];
    if (decider) rows.push([w.L(approved ? "وافق عليها" : cancelled ? "ألغاها" : "رفضها", approved ? "Approved by" : cancelled ? "Cancelled by" : "Declined by"), person(decider)]);
    if (data.leave.notes) rows.push([w.L("ملاحظة", "Note"), escape(data.leave.notes)]);
    if ((approved || cancelled) && data.remainingDays !== null) rows.push([w.L(`المتبقي من رصيد ${w.typeLabel}`, `Remaining ${w.typeLower} balance`), escape(w.L(`${num(data.remainingDays)} يوم`, `${num(data.remainingDays)} day(s)`))]);
    return rows;
  };
  const verb = (w: ReturnType<typeof wording>) => w.L(approved ? "وافق على" : cancelled ? "ألغى" : "رفض", approved ? "approved" : cancelled ? "cancelled" : "declined");

  // 1. the requester
  push(requester.email, requester.id, `time-leave-${kind}`, (w) => {
    const title = approved
      ? w.L("تمت الموافقة على إجازتك 🎉", "Your leave is approved 🎉")
      : cancelled
        ? w.L("تم إلغاء إجازتك", "Your leave is cancelled")
        : w.L("لم تتم الموافقة على طلب إجازتك", "Your leave request was not approved");
    const remaining = data.remainingDays !== null ? num(data.remainingDays) : null;
    const intro = approved
      ? w.L(`مبروك يا ${requester.name}! تمت الموافقة على ${w.typeLabel} ${w.period}${remaining !== null ? `، والمتبقي من رصيدك ${remaining} يوم` : ""}. إجازة سعيدة.`, `Congratulations, ${requester.name}! Your ${w.typeLower} is approved, ${w.period}${remaining !== null ? `; ${remaining} day(s) of your balance remain` : ""}. Enjoy your time off.`)
      : cancelled
        ? w.L(`تم إلغاء ${w.typeLabel} ${w.period} بعد الموافقة عليها، ورجعت أيامها لرصيدك.`, `Your approved ${w.typeLower}, ${w.period}, was cancelled; its days are back in your balance.`)
        : w.L(`للأسف لم تتم الموافقة على ${w.typeLabel} ${w.period}.`, `Your ${w.typeLower} request, ${w.period}, was not approved.`);
    return card(w.dir, title, escape(intro), decisionRows(w), { label: w.L("عرض إجازاتي", "View my leave"), href: `${APP_URL}/leave` }, w.footer + w.answerLine("للرد على صاحب القرار:", "To answer the person who decided:", decider?.email ?? null));
  });

  // 2. the person who decided: a record of their own decision, not the employee's email
  if (decider) {
    push(decider.email, decider.id, `time-leave-${kind}-copy`, (w) =>
      card(
        w.dir,
        approved ? w.L(`وافقت على إجازة ${requester.name}`, `You approved ${requester.name}'s leave`) : cancelled ? w.L(`ألغيت إجازة ${requester.name}`, `You cancelled ${requester.name}'s leave`) : w.L(`رفضت طلب إجازة ${requester.name}`, `You declined ${requester.name}'s leave request`),
        escape(w.L(`تم إبلاغ ${requester.name} بقرارك في البرنامج وعلى الإيميل.`, `${requester.name} has been told of your decision in the app and by email.`)),
        decisionRows(w),
        null,
        w.footer + w.answerLine("للرد على الموظف:", "To answer the employee:", requester.email),
      ),
    );
  }

  // 3. the person it was sent to, when someone else decided it
  const chosen = data.chosenReviewer;
  if (chosen && decider) {
    push(chosen.email, chosen.id, `time-leave-${kind}-info`, (w) =>
      card(
        w.dir,
        w.L(`تم الرد على طلب إجازة ${requester.name}`, `${requester.name}'s leave request was answered`),
        escape(w.L(`${decider.name} ${verb(w)} طلب ${w.typeLabel} ${w.period} اللي اتبعت لك. مش مطلوب منك أي إجراء.`, `${decider.name} ${verb(w)} the ${w.typeLower} request, ${w.period}, that was sent to you. Nothing is needed from you.`)),
        decisionRows(w),
        null,
        w.footer,
      ),
    );
  }
  return emails;
}
