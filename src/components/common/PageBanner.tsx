import styles from "./PageBanner.module.css";

interface PageBannerProps {
  src: string;
  alt?: string;
}

// PROSM Time - § user-directed, 2026-09-11: real illustrations for a
// few real pages, each sent by the user and processed for this app
// specifically. These are full scene illustrations (already a
// complete composition, not a transparent character-on-flat-background
// one like EmptyState/AdminOverviewCard's greeting banner use).
// § correction, same day - "drop the card idea, let it float free": no
// box/shadow/border, a soft fade at the bottom instead of a hard edge
// so it blends into the page rather than sitting in a frame.
export default function PageBanner({ src, alt = "" }: PageBannerProps) {
  return (
    <div className={styles.banner}>
      <img src={src} alt={alt} className={styles.image} />
    </div>
  );
}
