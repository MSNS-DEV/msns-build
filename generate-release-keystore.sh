#!/usr/bin/env bash
# Generates the Android release (upload) keystore for MSNS LMS.
# Passwords are never hardcoded: set MSNS_KEYSTORE_PASSWORD (and optionally
# MSNS_KEY_PASSWORD) in the environment, or you will be prompted.
# Afterwards, put the same values in android/keystore.properties (gitignored):
#   storeFile=msns-release-key.keystore
#   storePassword=...
#   keyAlias=msns-key-alias
#   keyPassword=...
set -euo pipefail

KEYSTORE_PATH="android/app/msns-release-key.keystore"
ALIAS_NAME="${MSNS_KEY_ALIAS:-msns-key-alias}"

if [ -f "$KEYSTORE_PATH" ]; then
  echo "🔑 Release keystore already exists at $KEYSTORE_PATH"
  exit 0
fi

STORE_PASS="${MSNS_KEYSTORE_PASSWORD:-}"
if [ -z "$STORE_PASS" ]; then
  read -r -s -p "Keystore password (min 6 chars): " STORE_PASS; echo
fi
KEY_PASS="${MSNS_KEY_PASSWORD:-$STORE_PASS}"
export STORE_PASS KEY_PASS  # read by keytool via -storepass:env / -keypass:env

if [ "${#STORE_PASS}" -lt 6 ]; then
  echo "❌ Keystore password must be at least 6 characters" >&2
  exit 1
fi

echo "🔐 Generating Android Release Keystore for MSNS LMS..."

keytool -genkeypair -v \
  -keystore "$KEYSTORE_PATH" \
  -alias "$ALIAS_NAME" \
  -storepass:env STORE_PASS \
  -keypass:env KEY_PASS \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -dname "CN=M.S. Naz High School, OU=LMS Division, O=MSNS, L=Lahore, ST=Punjab, C=PK"

echo "✅ Keystore created at $KEYSTORE_PATH with alias '$ALIAS_NAME'"
echo "   Now create android/keystore.properties (see comments at the top of this script)."
