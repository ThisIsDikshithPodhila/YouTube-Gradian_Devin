# Guardian

Guardian is a family-safety product that connects a parent account to one or
more child devices. The backend signs policy snapshots, the Android child
runtime enforces app/time/web rules locally, and the parent and child Expo
surfaces provide setup, requests, approvals, health, activity, and privacy
controls. Communication Safety is an opt-in Android capability with
privacy-preserving, rules-based signals; iOS capability limits are reported
explicitly.

This repository contains the backend, shared TypeScript contracts, the Expo
mobile application, and the Android Guardian Protection native module.

## Repository layout

```text
backend/                         FastAPI, SQLAlchemy, Alembic, PostgreSQL
apps/mobile/                     Expo Router app and generated Android project
apps/mobile/modules/              Guardian Protection Expo native module
packages/api-client/              Generated and shared API client
packages/contracts/               Shared API/event TypeScript contracts
packages/design-tokens/           Shared UI tokens
packages/policy-schema/           Policy schema and validation
docs/                             PRD, requirement matrix, evidence/checkpoint docs
scripts/                          OpenAPI generation and platform verification tools
```

## Prerequisites

The verified local toolchain is:

- Node `22.13.0` and pnpm `10.14.0` (the repository pins both in `.nvmrc` and
  `package.json`).
- Python managed by `uv` using `.python-version` and `.uv-version` (normally
  installed at `$HOME/.local/bin/uv`).
- Docker Engine and Docker Compose, for PostgreSQL 16.
- Java 17, Android SDK/platform tools, and Android build tools `36.0.0` for
  Android builds.
- Android emulators for connected tests and emulator acceptance. The local
  harness uses `emulator-5554` (parent), `emulator-5556` (child), and
  `emulator-5558` (tablet).
- macOS/Xcode is required for iOS compilation, entitlements, and iOS tests.

Do not commit secrets. In particular, keep
`GUARDIAN_POLICY_PRIVATE_KEY` in the ignored `backend/.env`.

## Install dependencies

From the repository root, use a clean shell with Node 22 on `PATH`:

```bash
export PATH="$HOME/.nvm/versions/node/v22.13.0/bin:$PATH"
node --version
pnpm --version
pnpm install --frozen-lockfile
uv sync --directory backend --locked --extra dev
```

If a local policy signing key is not present, create one without printing it
into source control:

```bash
python scripts/generate-policy-key.py
```

Place the generated value in `backend/.env`:

```text
GUARDIAN_POLICY_PRIVATE_KEY=<base64-encoded-32-byte-key>
```

## Run the backend

Start PostgreSQL and apply migrations:

```bash
docker compose -f backend/docker-compose.yml up -d postgres
uv run --directory backend alembic upgrade head
```

Start the API:

```bash
uv run --directory backend uvicorn app.main:app --host 127.0.0.1 --port 8000
```

In another shell, verify readiness:

```bash
curl -fsS http://127.0.0.1:8000/readiness
```

Expected response:

```json
{"status":"ready"}
```

The emulator reaches the host API at `http://10.0.2.2:8000`.

## Run the mobile app

The exact Expo SDK v57 documentation is at
<https://docs.expo.dev/versions/v57.0.0/>.

Start Metro from the mobile package:

```bash
export PATH="$HOME/.nvm/versions/node/v22.13.0/bin:$PATH"
pnpm --dir apps/mobile start
```

Verify Metro from another shell:

```bash
curl -fsS http://127.0.0.1:8081/status
```

For a native Android development client, build and install with:

```bash
cd apps/mobile/android
GUARDIAN_POLICY_TRUSTED_PUBLIC_KEYS='{"guardian-dev":"<public-key>"}' \
  ./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.guardian.family/.MainActivity
```

The trusted public key is obtained from the backend's
`GET /v1/policy/public-key` response. Never place the private signing key in
the APK or in this README.

For a release build:

```bash
cd apps/mobile/android
GUARDIAN_RELEASE_STORE_FILE=/secure/guardian-release.p12 \
GUARDIAN_RELEASE_STORE_PASSWORD=from-secret-storage \
GUARDIAN_RELEASE_KEY_ALIAS=guardian-release \
GUARDIAN_RELEASE_KEY_PASSWORD=from-secret-storage \
GUARDIAN_RELEASE_STORE_TYPE=PKCS12 \
GUARDIAN_RELEASE_CERT_SHA256=64-lowercase-hex-certificate-fingerprint \
GUARDIAN_POLICY_TRUSTED_PUBLIC_KEYS='{"guardian-prod-2026-01":"base64-public-key"}' \
GUARDIAN_POLICY_KEY_ID=guardian-prod-2026-01 \
EXPO_PUBLIC_API_URL=https://api.guardian.family \
GUARDIAN_DOH_URL=https://dns.guardian.family/dns-query \
GUARDIAN_RELEASE_VERSION_CODE=42 \
GUARDIAN_ENABLE_TEST_FIXTURES=false \
./gradlew :app:assembleRelease
```

All release controls above are process-environment inputs; `-P` properties are
not accepted for them. `GUARDIAN_RELEASE_CERT_SHA256` is the SHA-256 digest of
the configured public release certificate, without colons. The trusted-key map
must contain canonical base64 32-byte public Ed25519 keys and the active key
id. The release task rejects debug signing, fixture mode, placeholder
endpoints, missing public policy authority, and a missing/invalid release
version code. It then verifies signed APK/AAB artifacts, including their final
manifests. Backend-only secrets (including JWT and policy private keys) are
validated by the backend and are never passed to the Android build.

The Android production APK workflow builds two signed, universal APKs from the
same commit: `Guardian-parent-release.apk` (`com.guardian.family.parent`) and
`Guardian-child-release.apk` (`com.guardian.family.child`). They can be installed
on separate devices or side by side. The parent app opens parent sign-in and
uses the parent real-time API; the child app opens pairing and uses the child
real-time API after pairing. The production workflow requires the protected
`guardian-production` environment, a deployed HTTPS API, and the release
signing configuration above. For a local role build, set
`EXPO_PUBLIC_GUARDIAN_ROLE=parent` and pass `-PguardianRole=parent` to Gradle
(use `child` for the child app). The unqualified build retains the original
single-app role selection and `com.guardian.family` package for development.

For a temporary web-only Child APK, use the same release configuration and
Child role, and add `GUARDIAN_RELEASE_LIMITED_CHILD=true` and
`EXPO_PUBLIC_GUARDIAN_LIMITED_CHILD=true` to the build environment. The APK
keeps the Child package and signing identity so it can update an installed
Child release, but omits Accessibility and notification-listener services.
VPN website protection, pairing, and policy sync remain. App-limit enforcement,
Accessibility content inspection, and notification-based safety are unavailable;
the Child app reports this explicitly. This build is for testing and does not
guarantee acceptance by Google Play Protect on a physical phone.

## Emulator harness

Confirm connected devices:

```bash
adb devices
```

Run the native connected test suite:

```bash
cd apps/mobile/android
./gradlew :guardian-protection:connectedDebugAndroidTest --no-daemon
```

Use `agent-device` for authenticated route audits and evidence capture. Start
with the known package/app and continue from the printed accessibility
snapshot:

```bash
agent-device open com.guardian.family --foreground
```

The parent and child sessions use the deep links below after authentication:

```text
guardian://parent/home
guardian://parent/rules
guardian://parent/activity
guardian://parent/health
guardian://child/home
```

For a normal agent-device session, use semantic refs from the latest snapshot,
verify the expected text after each action, and close the session:

```bash
agent-device wait text "Guardian"
agent-device screenshot
agent-device close
```

The full screen inventory, three-interaction matrix, platform limitations, and
evidence status are maintained in
`docs/PRD_REQUIREMENT_MATRIX.md` and `docs/DEVIN_CHECKPOINT.md`.

## Verification commands

JavaScript quality:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm check:openapi
```

Mobile quality:

```bash
pnpm --filter guardian-mobile lint
pnpm --filter guardian-mobile typecheck
pnpm --filter guardian-mobile test
```

Backend quality:

```bash
uv run --directory backend ruff check app tests
uv run --directory backend mypy app
uv run --directory backend pytest
```

The repository intentionally does not claim iOS build, APNs/FCM delivery,
physical-device battery/accessibility, Play reviewer, or store-approval
evidence on a Linux emulator host.
