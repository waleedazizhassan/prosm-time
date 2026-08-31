import prosmLogo from "../../assets/prosm-logo.png";

interface BrandMarkProps {
  size?: number;
}

// PROSM Time visual identity (§29/§33) - the real, official PROSM logo
// supplied by the Product Owner (copied from PROSM Platform's own
// src/assets/logos/logo2.png, its canonical BRAND.logo asset - the
// SAME file, not a re-derived or reinterpreted copy, per §33: "Preserve
// supplied branding exactly - no reinterpretation. Not invent
// replacement assets when an appropriate supplied asset exists."). Used
// wherever a small brand mark is appropriate (activation, login,
// dashboard header) - the full Splash Screen (§31) and the complete
// shared Web/Mobile design-token system remain WP-21/WP-20's own scope.
export default function BrandMark({ size = 40 }: BrandMarkProps) {
  return <img src={prosmLogo} alt="PROSM" width={size} height={size} style={{ objectFit: "contain" }} />;
}
