// v2.3.54 (owner 2026-10-26): the leave emails (supabase/functions/_shared/leaveEmail.ts).
import { describe, expect, it } from "vitest";

import { renderLeaveEmails, type LeaveEmailData } from "../../../supabase/functions/_shared/leaveEmail";

const base: LeaveEmailData = {
  kind: "request",
  organizationName: "Ratomag",
  organizationId: "org",
  language: "ar",
  recipient: { id: "m", name: "Mona", email: "mona@acme.example" },
  requester: { id: "e", name: "Omar <b>", email: "omar@acme.example" },
  reviewer: null,
  leave: { type: "annual", typeName: "Annual", isPaid: true, startDate: "2026-11-02", endDate: "2026-11-04", days: 3, reason: "Family trip", notes: null },
  remainingDays: null,
};

describe("leave emails", () => {
  it("a request goes to the reviewer with every detail and the requester's email", () => {
    const [email, ...rest] = renderLeaveEmails(base);
    expect(rest).toHaveLength(0);
    expect(email.to).toBe("mona@acme.example");
    expect(email.subject).toContain("02/11/2026");
    expect(email.html).toContain("mailto:omar@acme.example");
    expect(email.html).toContain("إجازة سنوية");
    expect(email.html).toContain("Family trip");
    // names are text, never markup
    expect(email.html).toContain("Omar &lt;b&gt;");
    expect(email.html).not.toContain("Omar <b>");
  });

  it("an approval congratulates the requester with the dates and the balance", () => {
    const emails = renderLeaveEmails({
      ...base,
      kind: "approved",
      recipient: base.requester,
      reviewer: { id: "m", name: "Mona", email: "mona@acme.example" },
      leave: { ...base.leave, notes: "Enjoy" },
      remainingDays: 18,
    });
    expect(emails[0].to).toBe("omar@acme.example");
    expect(emails[0].html).toContain("تمت الموافقة");
    expect(emails[0].html).toContain("من 02/11/2026 إلى 04/11/2026");
    expect(emails[0].html).toContain("18 يوم");
    expect(emails[0].html).toContain("mailto:mona@acme.example");
    // one thread: the decision carries the request's own subject
    const [request] = renderLeaveEmails(base);
    expect(emails[0].subject).toBe(request.subject);
  });

  it("the requester gets a copy of a request sent to the person they chose", () => {
    const emails = renderLeaveEmails({ ...base, copyToRequester: true });
    expect(emails.map((email) => email.to)).toEqual(["mona@acme.example", "omar@acme.example"]);
    expect(emails[1].html).toContain("تم إرسال طلب إجازتك");
    expect(emails[1].subject).toBe(emails[0].subject);
  });

  it("a leave taken back after approval says cancelled, not declined", () => {
    const [email] = renderLeaveEmails({ ...base, kind: "cancelled", recipient: base.requester, reviewer: { id: "m", name: "Mona", email: "mona@acme.example" }, remainingDays: 21 });
    expect(email.to).toBe("omar@acme.example");
    expect(email.html).toContain("تم إلغاء إجازتك");
    expect(email.html).not.toContain("لم تتم الموافقة");
  });

  // v2.3.61 (owner 2026-10-28): "approved, cancelled or declined - the email goes to employee 1 only, not to manager 2"
  it("a decision - approved, declined or cancelled - is emailed to the employee only, never to whoever decided", () => {
    const mona = { id: "m", name: "Mona", email: "mona@acme.example" };
    for (const kind of ["approved", "rejected", "cancelled"] as const) {
      const emails = renderLeaveEmails({ ...base, kind, recipient: base.requester, reviewer: mona, remainingDays: 18 });
      expect(emails.map((email) => email.to)).toEqual(["omar@acme.example"]);
    }
  });

  it("a request withdrawn before an answer tells the reviewer, with the requester's copy", () => {
    const emails = renderLeaveEmails({ ...base, kind: "request_withdrawn", copyToRequester: true });
    expect(emails.map((email) => email.to)).toEqual(["mona@acme.example", "omar@acme.example"]);
    expect(emails[0].html).toContain("سحب طلب");
    expect(emails[1].html).toContain("تم سحب طلب إجازتك");
  });

  it("each reader in their own language, on one thread in the requester's language", () => {
    const emails = renderLeaveEmails({ ...base, copyToRequester: true, languages: { e: "ar", m: "en" } });
    expect(emails[0].to).toBe("mona@acme.example");
    expect(emails[0].html).toContain("A leave request awaits your review");
    expect(emails[1].html).toContain("تم إرسال طلب إجازتك");
    expect(emails[0].subject).toBe(emails[1].subject);
    expect(emails[0].subject).toContain("طلب إجازة");
  });

  it("English for a reader in another language; nothing without an address", () => {
    const [email] = renderLeaveEmails({ ...base, language: "de" });
    expect(email.subject).toContain("Leave request - ");
    expect(renderLeaveEmails({ ...base, recipient: { ...base.recipient, email: null } })).toEqual([]);
  });
});
