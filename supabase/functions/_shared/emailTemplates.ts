// PROSM Time - shared branded HTML wrapper so outbound email looks
// like it comes from the same product no matter which Edge Function
// sends it. Same visual language as PROSM Platform's own
// _shared/emailTemplates.ts (Arial, #f5f5f5 page background, white
// 600px card, #0f172a heading, #374151 body copy, #16a34a brand-green
// accent - the real audited brand-primary, not the logo's blue, which
// PROSM Platform reserves for --brand-ai only), independently copied
// per this repo's own no-cross-import convention (see _shared/http.ts).
// Owner 2026-11-03: in the reader's language, any of the app's nine.
import { emailLanguage, emailT, isRtl } from "./emailI18n.ts";

const escape = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

function codeCard(language: string, title: string, body: string, codeLabel: string, code: string, expires: string, ignore: string): string {
  const rtl = isRtl(language);
  return `
<div dir="${rtl ? "rtl" : "ltr"}" style="font-family:Arial,sans-serif;padding:24px;background:#f5f5f5;text-align:${rtl ? "right" : "left"};">
  <div style="max-width:600px;margin:auto;background:#ffffff;border-radius:8px;padding:32px;">
    <h2 style="margin-top:0;color:#0f172a;">${escape(title)}</h2>
    <p style="font-size:16px;color:#374151;">${escape(body)}</p>
    <p style="color:#6b7280;font-size:14px;margin-top:24px;">${escape(codeLabel)}</p>
    <div style="margin:12px 0;text-align:center;">
      <span dir="ltr" style="display:inline-block;font-size:28px;font-weight:bold;letter-spacing:6px;color:#16a34a;">${escape(code)}</span>
    </div>
    <p style="color:#6b7280;">${escape(expires)}</p>
    <p style="color:#6b7280;">${escape(ignore)}</p>
    <hr style="margin:30px 0;border:none;border-top:1px solid #e5e7eb;">
    <p style="font-size:12px;color:#9ca3af;">PROSM Time</p>
  </div>
</div>
`;
}

export function invitationSubject(language: string, organizationName: string | null): string {
  const lang = emailLanguage(language);
  return emailT(lang, "invite.subject", { org: organizationName ?? emailT(lang, "invite.yourOrganization") });
}

export function invitationRoleLabel(language: string, roleKey: string): string {
  const label = emailT(emailLanguage(language), `invite.roles.${roleKey}`);
  return label === `invite.roles.${roleKey}` ? roleKey : label;
}

export function renderInvitationEmail({
  language,
  organizationName,
  inviteeName,
  roleLabel,
  verificationCode,
  expiryDays,
}: {
  language: string;
  organizationName: string;
  inviteeName: string;
  roleLabel: string;
  verificationCode: string;
  expiryDays: number;
}): string {
  const lang = emailLanguage(language);
  const T = (path: string, vars: Record<string, unknown> = {}) => emailT(lang, path, vars);
  return codeCard(
    lang,
    T("invite.title", { org: organizationName }),
    T("invite.body", { name: inviteeName, org: organizationName, role: roleLabel }),
    T("invite.codeLabel"),
    verificationCode,
    T("invite.expires", { count: expiryDays }),
    T("invite.ignore"),
  );
}

export function passwordResetSubject(language: string): string {
  return emailT(emailLanguage(language), "reset.subject");
}

export function renderPasswordResetEmail({
  language,
  fullName,
  verificationCode,
  expiryMinutes,
}: {
  language: string;
  fullName: string | null;
  verificationCode: string;
  expiryMinutes: number;
}): string {
  const lang = emailLanguage(language);
  const T = (path: string, vars: Record<string, unknown> = {}) => emailT(lang, path, vars);
  return codeCard(
    lang,
    T("reset.title"),
    T("reset.body", { name: fullName ?? T("reset.there") }).replace(/\s+,/, ","),
    T("reset.codeLabel"),
    verificationCode,
    T("reset.expires", { count: expiryMinutes }),
    T("reset.ignore"),
  );
}
