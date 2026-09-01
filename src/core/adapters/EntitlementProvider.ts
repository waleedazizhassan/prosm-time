// WP-24/§36 - "Define adapter interfaces for... entitlement
// providers." See ./README.md. Shape matches LicenseRepository's own
// real LicenseState type.
//
// Today's real implementation: LicenseRepository
// (src/core/repositories/LicenseRepository.ts), sourced from PROSM
// Management's own integration contract (never duplicated as an
// independent licensing authority - §5/§41: "Licensing authority is
// never duplicated - PROSM Management is the sole issuer/validator of
// record"). A future native integration would still resolve
// entitlement state through that same contract, not a different one -
// this interface exists for UI-layer decoupling, not to imply a
// second source of licensing truth would ever be legitimate.

export interface EntitlementState {
  licenseNumber: string;
  status: string;
  maxUsers: number | null;
  maxDevices: number | null;
  expiresAt: string | null;
  lastVerifiedAt: string;
}

export interface EntitlementProvider {
  getCurrentEntitlement(): Promise<EntitlementState | null>;
  refreshEntitlementStatus(): Promise<EntitlementState | null>;
}
