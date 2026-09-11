import styles from "./PageBanner.module.css";

interface PageBannerProps {
  src: string;
  alt?: string;
}

// PROSM Time - § user-directed, 2026-09-11: real illustrations for a
// few real pages (Leave, Kiosk, People, Sites, Reports), each sent by
// the user and processed for this app specifically. These are full
// scene illustrations (already a complete composition, not a
// transparent character-on-flat-background one like
// EmptyState/AdminOverviewCard's greeting banner use) - shown as their
// own rounded, shadowed banner above the page's real content rather
// than blended into a gradient card.
export default function PageBanner({ src, alt = "" }: PageBannerProps) {
  return (
    <div className={styles.banner}>
      <img src={src} alt={alt} className={styles.image} />
    </div>
  );
}
