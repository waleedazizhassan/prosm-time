import type { CSSProperties } from "react";
import AuthHeader from "../../components/common/AuthHeader";
import authPhoto from "../../assets/splash-photo.png";
import styles from "../../components/common/AuthLayout.module.css";

// PROSM Time - § live UX review, user-directed: "no need for a card
// here, the header alone is enough" - the header (AuthHeader) already
// carries the Sign in / Create organization entry points, so the Home
// destination is just the full-page photo behind it - no card, no
// duplicate CTAs.
export default function WelcomePage() {
  return (
    <div className={styles.page} style={{ "--auth-photo": `url(${authPhoto})` } as CSSProperties}>
      <AuthHeader />
    </div>
  );
}
