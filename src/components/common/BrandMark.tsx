import prosmLogo from "../../assets/prosm-logo.png";

interface BrandMarkProps {
  size?: number;
  // § visual identity reference pass, user-directed - every supplied
  // reference image renders the mark with an ambient blue/green glow
  // against a dark ground. `glow` is opt-in, presentation-only (a CSS
  // drop-shadow around the untouched image, never a redrawn/recolored
  // asset - §33 "preserve supplied branding exactly" still holds) and
  // only ever passed by callers with a dark background behind them
  // (Sidebar, SplashScreen) - on the light surfaces this component
  // also renders on (Header, AuthLayout), a colored glow would read as
  // a rendering artifact rather than "premium enterprise tech", so
  // those callers keep the plain, unchanged mark.
  glow?: boolean;
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
export default function BrandMark({ size = 40, glow = false }: BrandMarkProps) {
  return (
    <img
      src={prosmLogo}
      alt="PROSM"
      width={size}
      height={size}
      style={{
        objectFit: "contain",
        filter: glow ? "drop-shadow(0 0 14px rgba(52, 211, 153, 0.45)) drop-shadow(0 0 26px rgba(59, 130, 246, 0.3))" : undefined,
      }}
    />
  );
}
