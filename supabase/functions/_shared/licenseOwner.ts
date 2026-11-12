// Owner 2026-11-12: "the owner's data is recorded in the licence and shows in Platform Manager, where I can
// change the owner - email, name and the full data". A licence check (sync-all-licenses, refresh-license-status)
// hands the licence's owner data here: a newer change number is applied to the owner's account - the sign-in
// email through the auth service first (so the account and the app never disagree), then the name, official
// name, national ID and mobile; a changed email gets a password-reset code so the new owner can sign in.
// deno-lint-ignore-file no-explicit-any

export interface LicenceOwner {
  version?: number;
  email?: string | null;
  fullName?: string | null;
  legalName?: string | null;
  nationalId?: string | null;
  phone?: string | null;
}

export async function applyLicenceOwner(serviceClient: any, organizationId: string, owner: LicenceOwner | null | undefined): Promise<string | null> {
  if (!owner || typeof owner.version !== "number") return null;
  const { data: identity, error: identityError } = await serviceClient.rpc("get_prosm_time_owner_identity", { p_organization_id: organizationId });
  if (identityError || !identity) return identityError?.message ?? "owner not found";
  if (owner.version <= Number(identity.ownerVersion ?? 0)) return null;

  const newEmail = owner.email ? String(owner.email).trim().toLowerCase() : null;
  const emailChanges = Boolean(newEmail && newEmail !== String(identity.email ?? "").toLowerCase());
  if (emailChanges) {
    const { error } = await serviceClient.auth.admin.updateUserById(identity.authUserId, { email: newEmail, email_confirm: true });
    if (error) return `owner email: ${error.message}`;
  }
  const { error: applyError } = await serviceClient.rpc("apply_prosm_time_license_owner", { p_organization_id: organizationId, p_owner: owner });
  if (applyError) {
    // keep the account and the app in step: put the sign-in email back
    if (emailChanges) await serviceClient.auth.admin.updateUserById(identity.authUserId, { email: identity.email, email_confirm: true }).catch(() => undefined);
    return applyError.message;
  }
  if (emailChanges) {
    // the new owner sets their own password (the usual reset code by email)
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/request-password-reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: newEmail }),
    }).catch(() => undefined);
  }
  return null;
}
