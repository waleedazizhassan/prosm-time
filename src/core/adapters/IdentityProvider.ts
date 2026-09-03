// WP-24/§36 - "Define adapter interfaces for identity... providers."
// See ./README.md for what this file is (a contract) and is NOT (a
// second implementation). Shape matches UserRepository's own real
// CurrentUserProfile exactly - not invented, the actual identity data
// this app already resolves today via Supabase Auth + `users`.
//
// Today's real implementation: AuthContext (src/core/context/AuthContext.tsx),
// backed by Supabase Auth + UserRepository. A future PROSM Platform-
// native identity provider would resolve the same shape from PROSM
// Platform's own session/identity system instead.

export interface IdentityProfile {
  id: string;
  organizationId: string;
  email: string;
  fullName: string;
  status: string;
  isOwner: boolean;
  roleKey: string;
  roleName: string;
  avatarUrl: string | null;
}

export interface IdentityProvider {
  getCurrentProfile(): Promise<IdentityProfile | null>;
  hasPermission(permissionKey: string): boolean;
  signOut(): Promise<void>;
}
