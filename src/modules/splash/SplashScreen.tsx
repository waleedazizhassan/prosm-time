import splashPhoto from "../../assets/splash-crowd-photo.png";
import styles from "./SplashScreen.module.css";

// PROSM Time WP-21/§31 - "Presentation/startup surface only - must
// not contain business logic." No props, no data fetching, no auth
// checks: it only ever renders the brand photo - AppRoutes' own
// RootRedirect decides WHEN to show it (while auth state is still
// resolving), never this component.
//
// § live UX review, user-directed - the splash is the crowd/worksite
// photo alone, with no logo or text over it (the previous overlay
// made it "look bad"); the browser's own native page-load indicator
// is the only "loading bar" this screen relies on.
export default function SplashScreen() {
  return <div className={styles.page} style={{ backgroundImage: `url(${splashPhoto})` }} />;
}
