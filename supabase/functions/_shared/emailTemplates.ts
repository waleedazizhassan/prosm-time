// PROSM Time - shared branded HTML wrapper so outbound email looks
// like it comes from the same product no matter which Edge Function
// sends it. Same visual language as PROSM Platform's own
// _shared/emailTemplates.ts (Arial, #f5f5f5 page background, white
// 600px card, #0f172a heading, #374151 body copy, #16a34a brand-green
// accent - the real audited brand-primary, not the logo's blue, which
// PROSM Platform reserves for --brand-ai only), independently copied
// per this repo's own no-cross-import convention (see _shared/http.ts).

export function renderInvitationEmail({
  organizationName,
  inviteeName,
  roleLabel,
  invitationUrl,
  verificationCode,
  expiryDays,
}: {
  organizationName: string;
  inviteeName: string;
  roleLabel: string;
  invitationUrl: string;
  verificationCode: string;
  expiryDays: number;
}): string {
  return `
<div style="font-family:Arial,sans-serif;padding:24px;background:#f5f5f5;">
  <div style="max-width:600px;margin:auto;background:#ffffff;border-radius:8px;padding:32px;">

    <h2 style="margin-top:0;color:#0f172a;">
      You're invited to ${organizationName} on PROSM Time
    </h2>

    <p style="font-size:16px;color:#374151;">
      Hi ${inviteeName}, you've been invited to join <strong>${organizationName}</strong> on PROSM Time as
      <strong>${roleLabel}</strong>. Use the button below to accept your invitation and set up your account.
    </p>

    <div style="margin:30px 0;text-align:center;">
      <a href="${invitationUrl}" style="
        display:inline-block;
        background:#16a34a;
        color:#ffffff;
        font-size:16px;
        font-weight:bold;
        text-decoration:none;
        padding:14px 32px;
        border-radius:8px;
      ">
        Accept invitation
      </a>
    </div>

    <p style="color:#6b7280;font-size:14px;">
      If the button doesn't work, copy and paste this link into your browser:
    </p>
    <p style="color:#374151;font-size:14px;word-break:break-all;">
      ${invitationUrl}
    </p>

    <p style="color:#6b7280;font-size:14px;margin-top:24px;">
      Your verification code (already filled in for you if you use the link above):
    </p>
    <div style="margin:12px 0;text-align:center;">
      <span style="
        display:inline-block;
        font-size:28px;
        font-weight:bold;
        letter-spacing:6px;
        color:#16a34a;
      ">
        ${verificationCode}
      </span>
    </div>

    <p style="color:#6b7280;">
      This invitation expires in <strong>${expiryDays} days</strong>.
    </p>

    <p style="color:#6b7280;">
      If you weren't expecting this invitation, you can safely ignore this email.
    </p>

    <hr style="margin:30px 0;border:none;border-top:1px solid #e5e7eb;">

    <p style="font-size:12px;color:#9ca3af;">
      PROSM Time
    </p>

  </div>
</div>
`;
}
