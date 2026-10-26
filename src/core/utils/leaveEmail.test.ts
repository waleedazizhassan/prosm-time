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

  it("an approval congratulates the requester with the dates and the balance, and copies whoever approved", () => {
    const emails = renderLeaveEmails({
      ...base,
      kind: "approved",
      recipient: base.requester,
      reviewer: { id: "m", name: "Mona", email: "mona@acme.example" },
      leave: { ...base.leave, notes: "Enjoy" },
      remainingDays: 18,
    });
    expect(emails.map((email) => email.to)).toEqual(["omar@acme.example", "mona@acme.example"]);
    expect(emails[0].subject).toContain("تمت الموافقة");
    expect(emails[0].html).toContain("من 02/11/2026 إلى 04/11/2026");
    expect(emails[0].html).toContain("18 يوم");
    expect(emails[0].html).toContain("mailto:mona@acme.example");
    expect(emails[1].subject.startsWith("نسخة")).toBe(true);
  });

  it("English for a reader in another language; nothing without an address", () => {
    const [email] = renderLeaveEmails({ ...base, language: "de" });
    expect(email.subject).toContain("Leave request from");
    expect(renderLeaveEmails({ ...base, recipient: { ...base.recipient, email: null } })).toEqual([]);
  });
});
