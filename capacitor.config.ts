import type { CapacitorConfig } from "@capacitor/cli";

// Debug-only WebView features are opt-in. Release builds (cap sync / android:build)
// never set CAP_ENV, so they ship with WebView debugging and cleartext disabled.
// For local debugging run: CAP_ENV=development npx cap sync android
const isDevBuild = process.env.CAP_ENV === "development";

const config: CapacitorConfig = {
  appId: "com.msns.lms",
  appName: "MSNS LMS",
  webDir: "public",
  server: {
    // Live LMS production server domain
    url: "https://lms.msns.edu.pk",
    cleartext: isDevBuild,
    androidScheme: "https",
  },
  android: {
    captureInput: true,
    webContentsDebuggingEnabled: isDevBuild,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 0,
      launchAutoHide: true,
      backgroundColor: "#020806",
      showSpinner: false,
    },
    StatusBar: {
      overlaysWebView: true,
      backgroundColor: "#00000000",
      style: "DARK",
    },
    CapacitorSQLite: {
      iosIsEncryption: true,
      iosBiometric: {
        biometricAuth: true,
        biometricTitle: "MSNS Secure Cache Unlock",
      },
      androidIsEncryption: true,
      androidBiometric: {
        biometricAuth: true,
        biometricTitle: "MSNS Secure Cache Unlock",
        biometricSubTitle:
          "Please verify biometrics to decrypt offline roster data",
      },
    },
  },
};

export default config;
