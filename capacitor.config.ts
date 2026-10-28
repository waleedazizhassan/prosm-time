import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'net.prosm.time',
  appName: 'PROSM Time',
  webDir: 'dist',
  // § user-directed, 2026-09-13 - required by
  // @capacitor-community/background-geolocation on Android: without
  // this, location updates from the plugin stop after ~5 minutes in
  // the background (a documented Capacitor bridge limitation, not a
  // plugin bug - see the plugin's own README).
  android: {
    // Required by @capacitor-community/background-geolocation: without it,
    // location updates stop after 5 minutes in the background (the plugin's
    // README; issue #89) - presence tracking during a shift depends on it.
    // Kept on purpose (security review 2026-10-28, item 7).
    useLegacyBridge: true,
  },
  // Reminders and the update notice use the same notification bar icon as push (owner 2026-10-20).
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_prosm',
      iconColor: '#1E6FD9',
    },
  },
};

export default config;
