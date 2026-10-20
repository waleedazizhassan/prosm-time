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
    useLegacyBridge: true,
  },
  // Reminders and the update notice use the same notification bar icon as push (owner 2026-10-20).
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_prosm',
      iconColor: '#16A34A',
    },
  },
};

export default config;
