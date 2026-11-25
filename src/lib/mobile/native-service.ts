interface CapacitorGlobal {
  isNativePlatform(): boolean;
}

export const isNative = (): boolean => {
  if (typeof window === 'undefined') return false;
  const cap = (window as unknown as Record<string, unknown>).Capacitor as CapacitorGlobal | undefined;
  return !!cap?.isNativePlatform();
};

interface SQLiteDB {
  execute(query: string): Promise<void>;
  close(): Promise<void>;
}

let dbInstance: SQLiteDB | null = null;
let sqliteConnection: unknown = null;

export const getSecureItem = async (key: string): Promise<string | null> => {
  if (!isNative()) return typeof window !== 'undefined' ? localStorage.getItem(key) : null;
  try {
    const { Preferences } = await import('@capacitor/preferences');
    const { value } = await Preferences.get({ key });
    return value;
  } catch (err) {
    console.error('Preferences get error:', err);
    return null;
  }
};

export const setSecureItem = async (key: string, value: string): Promise<void> => {
  if (!isNative()) {
    if (typeof window !== 'undefined') localStorage.setItem(key, value);
    return;
  }
  try {
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.set({ key, value });
  } catch (err) {
    console.error('Preferences set error:', err);
  }
};

export const removeSecureItem = async (key: string): Promise<void> => {
  if (!isNative()) {
    if (typeof window !== 'undefined') localStorage.removeItem(key);
    return;
  }
  try {
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.remove({ key });
  } catch (err) {
    console.error('Preferences remove error:', err);
  }
};

export const clearPreferences = async (): Promise<void> => {
  if (!isNative()) {
    if (typeof window !== 'undefined') localStorage.clear();
    return;
  }
  try {
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.clear();
  } catch (err) {
    console.error('Preferences clear error:', err);
  }
};

/** 256-bit random passphrase from the platform CSPRNG. */
const generatePassphrase = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

export const initDb = async (): Promise<SQLiteDB | null> => {
  if (!isNative()) return null;
  if (dbInstance) return dbInstance;

  try {
    const { SQLiteConnection, CapacitorSQLite } = await import('@capacitor-community/sqlite');
    sqliteConnection ??= new SQLiteConnection(CapacitorSQLite);
    const dbName = 'msns_offline_cache';
    const encrypted = true;
    const mode = 'secret';
    const version = 1;

    // The plugin keeps the passphrase in its own encrypted storage; we only need to
    // provide one the first time. Never store it in plain Preferences/localStorage.
    const secretConn = sqliteConnection as {
      isSecretStored(): Promise<{ result?: boolean }>;
      setEncryptionSecret(passphrase: string): Promise<void>;
    };
    const { result: secretStored } = await secretConn.isSecretStored();
    if (!secretStored) {
      await secretConn.setEncryptionSecret(generatePassphrase());
    }
    // Remove the plaintext key written by earlier app versions.
    await removeSecureItem('db_secret_key');

    const connectionObj = sqliteConnection as {
      createConnection(
        dbName: string,
        encrypted: boolean,
        mode: string,
        version: number,
        readonly: boolean
      ): Promise<{ open(): Promise<void>; execute(query: string): Promise<void>; close(): Promise<void> }>;
    };

    const conn = await connectionObj.createConnection(
      dbName,
      encrypted,
      mode,
      version,
      false
    );

    await conn.open();
    dbInstance = conn;
    await createOfflineTables(conn);
    return dbInstance;
  } catch (error) {
    console.error('Failed to initialize local SQLite database:', error);
    throw error;
  }
};

export const getDb = async () => {
  if (dbInstance) return dbInstance;
  return initDb();
};

export const clearDb = async () => {
  if (!isNative()) return;
  try {
    const { CapacitorSQLite } = await import('@capacitor-community/sqlite');
    if (dbInstance) {
      await dbInstance.close();
      dbInstance = null;
    }
    const dbName = 'msns_offline_cache';
    await CapacitorSQLite.deleteDatabase({ database: dbName });
  } catch (error) {
    console.error('Failed to clear local SQLite database:', error);
  }
};

const createOfflineTables = async (db: SQLiteDB) => {
  const query = `
    CREATE TABLE IF NOT EXISTS rosters (
      id TEXT PRIMARY KEY,
      studentId TEXT,
      rollNumber TEXT,
      name TEXT,
      classId TEXT,
      data TEXT
    );
    CREATE TABLE IF NOT EXISTS timetables (
      id TEXT PRIMARY KEY,
      classId TEXT,
      data TEXT
    );
    CREATE TABLE IF NOT EXISTS exams (
      id TEXT PRIMARY KEY,
      examId TEXT,
      data TEXT
    );
    CREATE TABLE IF NOT EXISTS diary (
      id TEXT PRIMARY KEY,
      classId TEXT,
      data TEXT
    );
    CREATE TABLE IF NOT EXISTS sync_queue (
      id TEXT PRIMARY KEY,
      action TEXT,
      payload TEXT,
      createdAt TEXT,
      status TEXT,
      attempts INTEGER DEFAULT 0
    );
  `;
  await db.execute(query);
  // Databases created by earlier versions lack the attempts column.
  try {
    await db.execute(`ALTER TABLE sync_queue ADD COLUMN attempts INTEGER DEFAULT 0;`);
  } catch {
    // column already exists
  }
};

export interface NetworkStatus {
  connected: boolean;
  connectionType: string;
}

export const getNetworkStatus = async (): Promise<NetworkStatus> => {
  if (!isNative()) return { connected: typeof navigator !== 'undefined' ? navigator.onLine : true, connectionType: 'wifi' };
  try {
    const { Network } = await import('@capacitor/network');
    const status = await Network.getStatus();
    return { connected: status.connected, connectionType: status.connectionType };
  } catch (err) {
    console.error('Network getStatus error:', err);
    return { connected: true, connectionType: 'wifi' };
  }
};

export const onNetworkStatusChange = async (callback: (status: NetworkStatus) => void) => {
  if (!isNative()) {
    if (typeof window !== 'undefined') {
      const onlineHandler = () => callback({ connected: true, connectionType: 'wifi' });
      const offlineHandler = () => callback({ connected: false, connectionType: 'none' });
      window.addEventListener('online', onlineHandler);
      window.addEventListener('offline', offlineHandler);
      return () => {
        window.removeEventListener('online', onlineHandler);
        window.removeEventListener('offline', offlineHandler);
      };
    }
    return () => undefined;
  }
  try {
    const { Network } = await import('@capacitor/network');
    const handler = await Network.addListener('networkStatusChange', (status) => {
      callback({ connected: status.connected, connectionType: status.connectionType });
    });
    return () => {
      void handler.remove();
    };
  } catch (err) {
    console.error('Network addListener error:', err);
    return () => undefined;
  }
};

export interface PushPayload {
  title?: string;
  body?: string;
  data?: Record<string, string>;
}

export interface PushRegistrationHandle {
  remove(): Promise<void>;
}

/**
 * Registers for push notifications and attaches listeners.
 * Listeners are attached BEFORE register() so the first token event is not missed.
 * Returns a handle whose remove() detaches every listener added here.
 */
export const registerPushNotifications = async (
  onToken: (token: string) => void,
  onNotification: (notification: PushPayload) => void
): Promise<PushRegistrationHandle | null> => {
  if (!isNative()) return null;
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    let permStatus = await PushNotifications.checkPermissions();
    if (permStatus.receive === 'prompt') {
      permStatus = await PushNotifications.requestPermissions();
    }
    if (permStatus.receive !== 'granted') {
      console.warn('Push notification permissions denied');
      return null;
    }

    const listeners = await Promise.all([
      PushNotifications.addListener('registration', (token) => {
        onToken(token.value);
      }),
      PushNotifications.addListener('registrationError', (err) => {
        console.error('Push notification registration error:', err.error);
      }),
      PushNotifications.addListener('pushNotificationReceived', (notification) => {
        onNotification({
          title: notification.title,
          body: notification.body,
          data: notification.data as Record<string, string> | undefined
        });
      }),
    ]);

    await PushNotifications.register();

    return {
      remove: async () => {
        await Promise.all(listeners.map((l) => l.remove()));
      },
    };
  } catch (error) {
    console.error('Push notifications init failed:', error);
    return null;
  }
};

/** Stops push delivery to this device (call on logout). */
export const unregisterPushNotifications = async (): Promise<void> => {
  if (!isNative()) return;
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    await PushNotifications.removeAllListeners();
    await PushNotifications.unregister();
  } catch (error) {
    console.error('Push notifications unregister failed:', error);
  }
};

export const capturePhoto = async (): Promise<string | null> => {
  if (!isNative()) {
    alert('Camera capture is only supported on mobile devices.');
    return null;
  }
  try {
    const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');
    const photo = await Camera.getPhoto({
      quality: 70,
      allowEditing: false,
      resultType: CameraResultType.Base64,
      source: CameraSource.Camera
    });
    return photo.base64String ?? null;
  } catch (error) {
    console.error('Camera capture failed:', error);
    return null;
  }
};

export const scanBarcode = async (): Promise<string | null> => {
  if (!isNative()) {
    alert('Barcode scanning is only supported on mobile devices.');
    return null;
  }
  try {
    const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning');
    const perm = await BarcodeScanner.requestPermissions();
    if (perm.camera !== 'granted') {
      console.warn('Camera permission for barcode scanning denied');
      return null;
    }
    const { barcodes } = await BarcodeScanner.scan({});
    if (barcodes.length > 0) {
      return barcodes[0]?.rawValue ?? null;
    }
    return null;
  } catch (error) {
    console.error('Barcode scanning failed:', error);
    return null;
  }
};

export const clearAllMobileState = async (): Promise<void> => {
  try {
    await clearDb();
    await clearPreferences();
    // Web-layer caches (offline cache mirrors, sync queue fallbacks) live in the
    // WebView's localStorage on native too; wipe them so the next user on a
    // shared device cannot read the previous user's data.
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.clear();
        window.sessionStorage.clear();
      } catch {
        // storage may be unavailable; nothing else to do
      }
    }
  } catch (error) {
    console.error('Failed to clear mobile state:', error);
  }
};
