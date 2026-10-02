import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateReleaseAdmission } from "./release-admission.mjs";
import {
  bundletoolDumpManifestArgs,
  verifyArtifactManifestTree,
  verifyArtifactManifestXml,
  fixtureMarkerErrors,
  verifyApkAbis,
} from "./verify-release-artifact.mjs";

const validPublicKey = Buffer.alloc(32, 7).toString("base64");

let validationEnvironment;

async function validEnvironment() {
  if (validationEnvironment) return validationEnvironment;
  const directory = await mkdtemp(
    join(tmpdir(), "guardian-release-admission-"),
  );
  const storeFile = join(directory, "guardian-release.p12");
  const password = "validation-store-password";
  assert.ok(process.env.JAVA_HOME, "JAVA_HOME is required for real-keystore tests");
  const keytool = join(process.env.JAVA_HOME, "bin", "keytool");
  execFileSync(keytool, [
    "-genkeypair", "-alias", "guardian-release", "-keystore", storeFile,
    "-storetype", "PKCS12", "-storepass", password, "-keypass", password,
    "-dname", "CN=Guardian Release Validation,O=Guardian", "-keyalg", "RSA",
    "-keysize", "2048", "-validity", "1", "-noprompt",
  ], { stdio: "pipe" });
  const certificate = execFileSync(keytool, [
    "-exportcert", "-rfc", "-keystore", storeFile, "-storetype", "PKCS12",
    "-storepass", password, "-alias", "guardian-release",
  ], { encoding: "utf8" });
  const expectedCertificateDigest = createHash("sha256")
    .update(new X509Certificate(certificate).raw)
    .digest("hex");
  validationEnvironment = {
    EXPO_PUBLIC_API_URL: "https://api.guardian.family",
    GUARDIAN_DOH_URL: "https://dns.guardian.family/dns-query",
    GUARDIAN_POLICY_TRUSTED_PUBLIC_KEYS: JSON.stringify({
      "guardian-prod-2026-01": validPublicKey,
    }),
    GUARDIAN_RELEASE_STORE_FILE: storeFile,
    GUARDIAN_RELEASE_STORE_PASSWORD: password,
    GUARDIAN_RELEASE_KEY_ALIAS: "guardian-release",
    GUARDIAN_RELEASE_KEY_PASSWORD: password,
    GUARDIAN_RELEASE_STORE_TYPE: "PKCS12",
    GUARDIAN_RELEASE_CERT_SHA256: expectedCertificateDigest,
    GUARDIAN_POLICY_KEY_ID: "guardian-prod-2026-01",
    GUARDIAN_RELEASE_VERSION_CODE: "42",
  };
  return validationEnvironment;
}

test.after(async () => {
  if (validationEnvironment) {
    await rm(join(validationEnvironment.GUARDIAN_RELEASE_STORE_FILE, ".."), {
      recursive: true,
      force: true,
    });
  }
});

test("release admission fails closed when the required configuration is absent", () => {
  const errors = validateReleaseAdmission({});
  assert.ok(errors.some((error) => error.includes("Release API URL")));
  assert.ok(
    errors.some((error) =>
      error.includes("GUARDIAN_POLICY_TRUSTED_PUBLIC_KEYS"),
    ),
  );
  assert.ok(
    errors.some((error) => error.includes("GUARDIAN_RELEASE_STORE_FILE")),
  );
  assert.ok(
    errors.some((error) => error.includes("GUARDIAN_RELEASE_VERSION_CODE")),
  );
});

test("release admission rejects debug signing and fixture mode", async () => {
  const environment = await validEnvironment();
  const errors = validateReleaseAdmission({
    ...environment,
    GUARDIAN_RELEASE_STORE_FILE: "android/app/debug.keystore",
    GUARDIAN_RELEASE_KEY_ALIAS: "androiddebugkey",
    GUARDIAN_ENABLE_TEST_FIXTURES: "true",
  });
  assert.ok(errors.some((error) => error.includes("debug signing")));
  assert.ok(errors.some((error) => error.includes("fixture")));
});

test("release admission requires an existing regular-file keystore and certificate digest", async () => {
  const environment = await validEnvironment();
  const missingStore = validateReleaseAdmission({
    ...environment,
    GUARDIAN_RELEASE_STORE_FILE: join(tmpdir(), "guardian-missing-release-store.p12"),
  });
  assert.ok(missingStore.some((error) => error.includes("existing regular keystore file")));
  const missingDigest = validateReleaseAdmission({
    ...environment,
    GUARDIAN_RELEASE_CERT_SHA256: "",
  });
  assert.ok(missingDigest.some((error) => error.includes("GUARDIAN_RELEASE_CERT_SHA256")));
});

test("release admission rejects empty trust anchors and placeholder endpoints", async () => {
  const environment = await validEnvironment();
  const errors = validateReleaseAdmission({
    ...environment,
    EXPO_PUBLIC_API_URL: "https://api.guardian.example",
    GUARDIAN_DOH_URL: "http://localhost:8053/dns-query",
    GUARDIAN_POLICY_TRUSTED_PUBLIC_KEYS: "{}",
  });
  assert.ok(errors.some((error) => error.includes("API URL")));
  assert.ok(errors.some((error) => error.includes("DoH URL")));
  assert.ok(errors.some((error) => error.includes("trust-anchor")));
});

test("release admission accepts a complete non-debug validation configuration", async () => {
  const errors = validateReleaseAdmission(await validEnvironment());
  assert.deepEqual(errors, []);
});

test("mobile admission does not receive backend-only secrets", async () => {
  const errors = validateReleaseAdmission({
    ...(await validEnvironment()),
    GUARDIAN_JWT_SECRET: "",
    GUARDIAN_POLICY_PRIVATE_KEY: "",
    GUARDIAN_ENVIRONMENT: "",
  });
  assert.deepEqual(errors, []);
});

test("release admission requires the active strict-base64 trust anchor", async () => {
  const environment = await validEnvironment();
  const missingActive = validateReleaseAdmission({
    ...environment,
    GUARDIAN_POLICY_KEY_ID: "guardian-prod-2026-02",
  });
  assert.ok(
    missingActive.some((error) => error.includes("active trust-anchor")),
  );
  const nonCanonicalBase64 = validateReleaseAdmission({
    ...environment,
    GUARDIAN_POLICY_TRUSTED_PUBLIC_KEYS: JSON.stringify({
      "guardian-prod-2026-01": `${validPublicKey}\n`,
    }),
  });
  assert.ok(nonCanonicalBase64.some((error) => error.includes("trust-anchor")));
});

test("release admission rejects every supported fixture truthy value", async () => {
  const environment = await validEnvironment();
  for (const truthyValue of ["true", "TRUE", "1", "yes", "on"]) {
    const errors = validateReleaseAdmission({
      ...environment,
      GUARDIAN_ENABLE_TEST_FIXTURES: truthyValue,
    });
    assert.ok(
      errors.some((error) => error.includes("fixture")),
      truthyValue,
    );
  }
});

test("Android release sources declare SDK 36, no debug signing, and fail-closed admission", async () => {
  const buildFile = await readFile(
    new URL("../android/app/build.gradle", import.meta.url),
    "utf8",
  );
  const moduleBuildFile = await readFile(
    new URL(
      "../modules/guardian-protection/android/build.gradle",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(buildFile, /compileSdk 36/);
  assert.match(buildFile, /targetSdkVersion 36/);
  assert.match(buildFile, /signingConfig signingConfigs\.release/);
  assert.match(buildFile, /verifyGuardianReleaseAdmission/);
  assert.match(buildFile, /verifyGuardianReleaseApkArtifact/);
  assert.match(buildFile, /verifyGuardianReleaseAabArtifact/);
  assert.match(buildFile, /"--artifact", artifacts\.first\(\)\.absolutePath, "--kind", kind/);
  assert.doesNotMatch(buildFile, /merged_manifest|merged_manifests|--merged-manifest/);
  assert.match(buildFile, /com\.android\.tools\.build:bundletool:1\.18\.1/);
  assert.doesNotMatch(buildFile, /apkanalyzer/);
  assert.match(buildFile, /GUARDIAN_RELEASE_VERSION_CODE/);
  assert.match(buildFile, /output\.versionCode\.set/);
  assert.match(buildFile, /java\.security\.KeyStore\.getInstance/);
  assert.match(buildFile, /MessageDigest\.getInstance\("SHA-256"\)/);
  const releaseValueBlock = buildFile.match(/def releaseValue = \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.doesNotMatch(releaseValueBlock, /findProperty/);
  assert.equal(
    buildFile.match(/environment releaseAdmissionEnvironment/g)?.length,
    2,
    "admission and artifact verification must receive the same environment-only release inputs",
  );
  assert.match(buildFile, /assemble\|bundle\|package\|sign/);
  assert.match(
    buildFile,
    /task\.name in \["assembleRelease", "packageRelease"\].*verifyGuardianReleaseApkArtifact/,
  );
  assert.doesNotMatch(
    buildFile,
    /GUARDIAN_(?:JWT_SECRET|POLICY_PRIVATE_KEY|ENVIRONMENT)/,
  );
  const admission = await readFile(
    new URL("./release-admission.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    admission,
    /GUARDIAN_(?:JWT_SECRET|POLICY_PRIVATE_KEY|ENVIRONMENT)/,
  );
  assert.match(moduleBuildFile, /GUARDIAN_NON_RELEASE_FIXTURES_ENABLED/);
  assert.match(moduleBuildFile, /System\.getenv\("GUARDIAN_POLICY_TRUSTED_PUBLIC_KEYS"\)/);
  assert.match(moduleBuildFile, /System\.getenv\("GUARDIAN_POLICY_KEY_ID"\)/);
  assert.match(moduleBuildFile, /System\.getenv\("GUARDIAN_DOH_URL"\)/);
  assert.match(moduleBuildFile, /GUARDIAN_POLICY_KEY_ID/);
  assert.doesNotMatch(moduleBuildFile, /project\.findProperty/);
});

test("release manifest is private by default and declares transparent monitoring only", async () => {
  const manifest = await readFile(
    new URL("../android/app/src/main/AndroidManifest.xml", import.meta.url),
    "utf8",
  );
  const networkSecurity = await readFile(
    new URL(
      "../android/app/src/main/res/xml/network_security_config.xml",
      import.meta.url,
    ),
    "utf8",
  );
  const accessibility = await readFile(
    new URL(
      "../modules/guardian-protection/android/src/main/res/xml/guardian_accessibility_service.xml",
      import.meta.url,
    ),
    "utf8",
  );
  const accessibilityStrings = await readFile(
    new URL(
      "../modules/guardian-protection/android/src/main/res/values/strings.xml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(manifest, /android:usesCleartextTraffic="false"/);
  assert.match(
    manifest,
    /android:networkSecurityConfig="@xml\/network_security_config"/,
  );
  assert.match(manifest, /com\.guardian\.family\.CHILD_MONITORING_DISCLOSURE/);
  assert.match(manifest, /com\.guardian\.family\.ACCESSIBILITY_DECLARATION/);
  assert.match(manifest, /com\.guardian\.family\.VPN_DECLARATION/);
  assert.match(
    manifest,
    /android:name="isMonitoringTool" android:value="child_monitoring"/,
  );
  assert.match(networkSecurity, /cleartextTrafficPermitted="false"/);
  assert.match(accessibility, /android:canRetrieveWindowContent="true"/);
  assert.match(accessibility, /@string\/guardian_accessibility_description/);
  assert.match(accessibilityStrings, /separate Content Safety disclosure/);
  assert.doesNotMatch(
    manifest,
    /android\.permission\.(?:ACCESS_FINE_LOCATION|ACCESS_COARSE_LOCATION|RECORD_AUDIO|READ_SMS|QUERY_ALL_PACKAGES)/,
  );
});

test("debug cleartext override is narrowly limited while release stays disabled", async () => {
  const debugManifest = await readFile(
    new URL("../android/app/src/debug/AndroidManifest.xml", import.meta.url),
    "utf8",
  );
  const debugNetworkSecurity = await readFile(
    new URL(
      "../android/app/src/debug/res/xml/network_security_config.xml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(debugManifest, /android:usesCleartextTraffic="true"/);
  assert.match(
    debugManifest,
    /android:networkSecurityConfig="@xml\/network_security_config"/,
  );
  for (const host of ["localhost", "127.0.0.1", "10.0.2.2"]) {
    assert.match(debugNetworkSecurity, new RegExp(`<domain>${host}</domain>`));
  }
  assert.doesNotMatch(
    debugNetworkSecurity,
    /<base-config cleartextTrafficPermitted="true"/,
  );
});

test("effective artifact manifest policy rejects prohibited release policy", () => {
  const invalidManifest = `
    <manifest xmlns:android="http://schemas.android.com/apk/res/android">
      <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
      <application android:allowBackup="true" android:usesCleartextTraffic="true" />
    </manifest>`;
  const errors = verifyArtifactManifestXml(invalidManifest, "artifact");
  assert.ok(errors.some((error) => error.includes("allowBackup")));
  assert.ok(errors.some((error) => error.includes("Cleartext")));
  assert.ok(errors.some((error) => error.includes("ACCESS_FINE_LOCATION")));
  assert.ok(errors.some((error) => error.includes("isMonitoringTool")));
});

test("APK manifest-tree policy verifier rejects changed shipping declarations", () => {
  const tree = `
    E: manifest
      E: uses-permission
        A: android:name(0x01010003)="android.permission.RECORD_AUDIO"
      E: application
        A: android:allowBackup(0x01010080)=(type 0x12)0xffffffff
        A: android:usesCleartextTraffic(0x010104ec)=(type 0x12)0xffffffff
        A: android:name(0x01010003)="fixture release marker"`;
  const errors = verifyArtifactManifestTree(tree);
  assert.ok(errors.some((error) => error.includes("allowBackup")));
  assert.ok(errors.some((error) => error.includes("usesCleartextTraffic")));
  assert.ok(errors.some((error) => error.includes("RECORD_AUDIO")));
  assert.ok(errors.some((error) => error.includes("isMonitoringTool")));
  assert.ok(errors.some((error) => error.includes("CHILD_MONITORING_DISCLOSURE")));
  assert.ok(errors.some((error) => error.includes("GuardianVpnService")));
  assert.ok(errors.some((error) => error.includes("fixture")));
});

test("APK manifest-tree policy binds monitoring values to their metadata nodes", () => {
  const tree = `
    E: manifest
      E: application
        A: android:label(0x01010001)="com.guardian.family.CHILD_MONITORING_DISCLOSURE"
        E: meta-data
          A: android:name(0x01010003)="isMonitoringTool"
          A: android:value(0x01010024)="not_child_monitoring"
        E: meta-data
          A: android:name(0x01010003)="unrelated"
          A: android:value(0x01010024)="child_monitoring"`;
  const errors = verifyArtifactManifestTree(tree);
  assert.ok(errors.some((error) => error.includes("isMonitoringTool=child_monitoring")));
  assert.ok(errors.some((error) => error.includes("CHILD_MONITORING_DISCLOSURE")));
});

test("APK manifest-tree policy rejects malformed nested metadata cross-association", () => {
  const tree = `
    E: manifest
      E: application
        E: meta-data
          A: android:name(0x01010003)="isMonitoringTool"
          E: meta-data
            A: android:value(0x01010024)="child_monitoring"`;
  const errors = verifyArtifactManifestTree(tree);
  assert.ok(errors.some((error) => error.includes("isMonitoringTool=child_monitoring")));
});

test("AAB effective-manifest policy verifier rejects changed release declarations", () => {
  const invalidAabManifest = `
    <manifest xmlns:android="http://schemas.android.com/apk/res/android">
      <uses-permission android:name="android.permission.RECORD_AUDIO" />
      <application android:allowBackup="true" android:usesCleartextTraffic="true">
        <service android:name="GuardianVpnService" />
        <meta-data android:name="isMonitoringTool" android:value="not_monitoring" />
      </application>
    </manifest>`;
  const errors = verifyArtifactManifestXml(invalidAabManifest, "AAB");
  assert.ok(errors.some((error) => error.includes("allowBackup")));
  assert.ok(errors.some((error) => error.includes("Cleartext")));
  assert.ok(errors.some((error) => error.includes("RECORD_AUDIO")));
  assert.ok(errors.some((error) => error.includes("isMonitoringTool")));
  assert.ok(errors.some((error) => error.includes("GuardianAccessibilityService")));
});

test("AAB manifest inspection uses bundletool's supported base-module command", () => {
  assert.deepEqual(
    bundletoolDumpManifestArgs(
      "/tmp/guardian-release.aab",
      "/tmp/bundletool.jar:/tmp/protobuf.jar",
    ),
    [
      "-cp", "/tmp/bundletool.jar:/tmp/protobuf.jar",
      "com.android.tools.build.bundletool.BundleToolMain",
      "dump", "manifest", "--bundle=/tmp/guardian-release.aab", "--module=base",
    ],
  );
});

test("artifact archive policy rejects fixtures but permits its required fail-closed guard symbol", () => {
  assert.ok(fixtureMarkerErrors(["assets/fixture-policy.json"], []).length > 0);
  assert.ok(fixtureMarkerErrors(["classes.dex"], [Buffer.from("fixture payload")]).length > 0);
  assert.deepEqual(
    fixtureMarkerErrors(["classes.dex"], [Buffer.from("GUARDIAN_NON_RELEASE_FIXTURES_ENABLED")]),
    [],
  );
  assert.ok(
    fixtureMarkerErrors(
      ["classes.dex"],
      [Buffer.from("GUARDIAN_NON_RELEASE_FIXTURES_ENABLED real fixture payload")],
    ).length > 0,
  );
  assert.deepEqual(fixtureMarkerErrors(["assets/policy.json"], [Buffer.from("production payload")]), []);
});

test("release APK policy requires every configured native ABI", () => {
  const entries = [
    "lib/armeabi-v7a/libguardian.so",
    "lib/arm64-v8a/libguardian.so",
    "lib/x86/libguardian.so",
    "lib/x86_64/libguardian.so",
  ];
  assert.deepEqual(verifyApkAbis(entries), []);
  assert.deepEqual(
    verifyApkAbis(entries.filter((entry) => !entry.startsWith("lib/x86/"))),
    ["Release APK is missing native libraries for ABI x86."],
  );
});

test("signed-release emulator smoke grants KVM access then requires hardware acceleration", async () => {
  const smokeWorkflow = await readFile(
    new URL("../../../.github/workflows/android-release-emulator-smoke.yml", import.meta.url),
    "utf8",
  );
  assert.match(smokeWorkflow, /sudo chmod 666 \/dev\/kvm \|\| true/);
  assert.match(smokeWorkflow, /emulator-acceleration\.txt/);
  assert.match(smokeWorkflow, /must be an existing readable\/writable device/);
  assert.doesNotMatch(smokeWorkflow, /-accel off/);
});

test("the mobile API client has no production placeholder endpoint", async () => {
  const client = await readFile(
    new URL("../src/api/client.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(client, /api\.guardian\.example/);
  assert.match(client, /require an explicitly configured HTTPS API URL/);
});

test("production APK workflow is manual, protected, universal, and secret-bound", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/android-release-apk.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /environment: guardian-production/);
  assert.match(workflow, /GUARDIAN_RELEASE_REQUIRED_ABIS: "armeabi-v7a,arm64-v8a,x86,x86_64"/);
  for (const secret of [
    "EXPO_PUBLIC_API_URL",
    "GUARDIAN_DOH_URL",
    "GUARDIAN_POLICY_TRUSTED_PUBLIC_KEYS",
    "GUARDIAN_POLICY_KEY_ID",
    "GUARDIAN_RELEASE_KEYSTORE_BASE64",
    "GUARDIAN_RELEASE_STORE_PASSWORD",
    "GUARDIAN_RELEASE_KEY_ALIAS",
    "GUARDIAN_RELEASE_KEY_PASSWORD",
    "GUARDIAN_RELEASE_CERT_SHA256",
  ]) {
    assert.match(workflow, new RegExp(`secrets\\.${secret}`));
  }
  assert.doesNotMatch(workflow, /GUARDIAN_(?:JWT_SECRET|POLICY_PRIVATE_KEY)/);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/);
});
