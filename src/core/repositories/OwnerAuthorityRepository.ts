import DatabaseManager from "../database/DatabaseManager";

// Owner 2026-11-04 / 2026-11-08: the owner delegates authority to a person - all of it or only
// chosen permissions, from a start until an end (or until withdrawn) - and takes it back
// (migrations 20261104150000, 20261108100000). Every grant and withdrawal has a reason and is in
// the action log; the server checks that only the owner does either, and never delegates what
// could close or take over the organisation.
export interface OwnerDelegation {
  id: string;
  userId: string;
  userName: string;
  reason: string;
  grantedAt: string;
  grantedByName: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  scope: "full" | "partial";
  permissionKeys: string[];
  startsAt: string;
  endsAt: string | null;
}

export interface DelegationOptions {
  scope: "full" | "partial";
  permissionKeys?: string[];
  /** ISO timestamps; start defaults to now on the server, no end = until withdrawn */
  startsAt?: string | null;
  endsAt?: string | null;
}

/** Granted by the owner only - the server refuses them in a partial delegation too. */
export const UNDELEGABLE_PERMISSIONS = ["permissions.assign", "administrators.manage"];

type Row = {
  id: string;
  user_id: string;
  reason: string;
  granted_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  scope: "full" | "partial";
  permission_keys: string[] | null;
  starts_at: string;
  ends_at: string | null;
  person: { full_name: string } | { full_name: string }[] | null;
  granter: { full_name: string } | { full_name: string }[] | null;
};

const one = <T,>(value: T | T[] | null): T | null => (Array.isArray(value) ? value[0] ?? null : value);

class OwnerAuthorityRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  /** Every grant of the organisation, newest first (active ones have no revokedAt). */
  async list(): Promise<OwnerDelegation[]> {
    const { data, error } = await this.client
      .from("owner_delegations")
      .select("id, user_id, reason, granted_at, revoked_at, revoke_reason, scope, permission_keys, starts_at, ends_at, person:users!owner_delegations_user_id_fkey(full_name), granter:users!owner_delegations_granted_by_fkey(full_name)")
      .order("granted_at", { ascending: false });
    if (error || !data) return [];
    return (data as unknown as Row[]).map((row) => ({
      id: row.id,
      userId: row.user_id,
      userName: one(row.person)?.full_name ?? "",
      reason: row.reason,
      grantedAt: row.granted_at,
      grantedByName: one(row.granter)?.full_name ?? null,
      revokedAt: row.revoked_at,
      revokeReason: row.revoke_reason,
      scope: row.scope,
      permissionKeys: row.permission_keys ?? [],
      startsAt: row.starts_at,
      endsAt: row.ends_at,
    }));
  }

  async grant(userId: string, reason: string, options: DelegationOptions = { scope: "full" }): Promise<string | null> {
    const { error } = await this.client.rpc("grant_prosm_time_owner_authority", {
      p_user_id: userId,
      p_reason: reason,
      p_starts_at: options.startsAt ?? null,
      p_ends_at: options.endsAt ?? null,
      p_scope: options.scope,
      p_permission_keys: options.scope === "partial" ? options.permissionKeys ?? [] : null,
    });
    return error ? error.message : null;
  }

  async revoke(userId: string, reason: string): Promise<string | null> {
    const { error } = await this.client.rpc("revoke_prosm_time_owner_authority", { p_user_id: userId, p_reason: reason });
    return error ? error.message : null;
  }
}

export default new OwnerAuthorityRepository();
