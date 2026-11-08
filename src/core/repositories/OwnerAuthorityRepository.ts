import DatabaseManager from "../database/DatabaseManager";

// Owner 2026-11-04: "Grant all" - the owner gives a person the owner's whole authority, and
// takes it back (migration 20261104150000). Every grant and withdrawal has a reason and is in
// the action log; the server checks that only the owner does either.
export interface OwnerDelegation {
  id: string;
  userId: string;
  userName: string;
  reason: string;
  grantedAt: string;
  grantedByName: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
}

type Row = {
  id: string;
  user_id: string;
  reason: string;
  granted_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
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
      .select("id, user_id, reason, granted_at, revoked_at, revoke_reason, person:users!owner_delegations_user_id_fkey(full_name), granter:users!owner_delegations_granted_by_fkey(full_name)")
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
    }));
  }

  async grant(userId: string, reason: string): Promise<string | null> {
    const { error } = await this.client.rpc("grant_prosm_time_owner_authority", { p_user_id: userId, p_reason: reason });
    return error ? error.message : null;
  }

  async revoke(userId: string, reason: string): Promise<string | null> {
    const { error } = await this.client.rpc("revoke_prosm_time_owner_authority", { p_user_id: userId, p_reason: reason });
    return error ? error.message : null;
  }
}

export default new OwnerAuthorityRepository();
