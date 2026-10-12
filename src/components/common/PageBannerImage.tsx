import styles from "./PageBannerImage.module.css";

// Shared page illustration banner - one size rule for every screen
// instead of a per-page fixed height that cropped the picture's edges.
export default function PageBannerImage({ src }: { src: string }) {
  return <img src={src} alt="" className={styles.banner} />;
}
