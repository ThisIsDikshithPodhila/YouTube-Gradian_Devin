import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PLACEHOLDER_PATTERN =
  /(?:^|[._/-])(example|invalid|localhost|127\.0\.0\.1|0\.0\.0\.0|change[-_ ]?me|replace[-_ ]?me|placeholder|fixture|test)(?:$|[._/-])/i;
const DEBUG_SIGNING_PATTERN =
  /debug\.keystore|androiddebugkey|cn\s*=\s*android debug/i;
const TRUTHY_VALUES = new Set(["true", "1", "yes", "on"]);

function value(environment, name) {
  const configured = environment[name];
  return typeof configured === "string" ? configured.trim() : "";
}

function isPlaceholder(valueToCheck) {
  return !valueToCheck || PLACEHOLDER_PATTERN.test(valueToCheck);
}

function decodeCanonicalBase64(valueToCheck) {
  if (
    typeof valueToCheck !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      valueToCheck,
    )
  ) {
    return null;
  }
  const decoded = Buffer.from(valueToCheck, "base64");
  return decoded.toString("base64") === valueToCheck ? decoded : null;
}

function validateHttpsUrl(raw, label, errors) {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || isPlaceholder(parsed.hostname)) {
      errors.push(`${label} must be a non-placeholder HTTPS URL.`);
    }
  } catch {
    errors.push(`${label} must be a non-placeholder HTTPS URL.`);
  }
}

function validateTrustedKeys(raw, activeKeyId, errors) {
  if (!raw) {
    errors.push(
      "GUARDIAN_POLICY_TRUSTED_PUBLIC_KEYS must contain at least one trusted policy public key.",
    );
    return;
  }
  try {
    const keys = JSON.parse(raw);
    if (
      !keys ||
      Array.isArray(keys) ||
      typeof keys !== "object" ||
      Object.keys(keys).length === 0
    ) {
      throw new Error("empty object");
    }
    for (const [keyId, encodedKey] of Object.entries(keys)) {
      const decoded = decodeCanonicalBase64(encodedKey);
      if (
        isPlaceholder(keyId) ||
        typeof encodedKey !== "string" ||
        isPlaceholder(encodedKey) ||
        decoded === null ||
        decoded.length !== 32
      ) {
        throw new Error("invalid anchor");
      }
    }
  } catch {
    errors.push(
      "GUARDIAN_POLICY_TRUSTED_PUBLIC_KEYS must be a non-empty production Ed25519 trust-anchor JSON object.",
    );
  }
  const keyId = activeKeyId;
  if (isPlaceholder(keyId)) {
    errors.push(
      "GUARDIAN_POLICY_KEY_ID must identify the active trusted policy key.",
    );
    return;
  }
  try {
    const keys = JSON.parse(raw);
    if (!Object.hasOwn(keys, keyId)) {
      errors.push(
        "GUARDIAN_POLICY_KEY_ID must be present in the active trust-anchor map.",
      );
    }
  } catch {
    // The invalid JSON diagnostic above is sufficient.
  }
}

/**
 * Returns deterministic, non-secret diagnostics suitable for CI and Gradle.
 * Backend private secrets are deliberately outside this mobile boundary.
 */
export function validateReleaseAdmission(environment = process.env) {
  const errors = [];
  const storeFile = value(environment, "GUARDIAN_RELEASE_STORE_FILE");
  const storePassword = value(environment, "GUARDIAN_RELEASE_STORE_PASSWORD");
  const keyAlias = value(environment, "GUARDIAN_RELEASE_KEY_ALIAS");
  const keyPassword = value(environment, "GUARDIAN_RELEASE_KEY_PASSWORD");

  if (!storeFile) {
    errors.push(
      "GUARDIAN_RELEASE_STORE_FILE must name a non-debug signing keystore; Gradle validates the keystore and certificate.",
    );
  }
  if (storeFile) {
    try {
      if (!existsSync(storeFile) || !statSync(storeFile).isFile()) throw new Error();
    } catch {
      errors.push("GUARDIAN_RELEASE_STORE_FILE must be an existing regular keystore file.");
    }
  }
  if (
    DEBUG_SIGNING_PATTERN.test(storeFile) ||
    DEBUG_SIGNING_PATTERN.test(keyAlias)
  ) {
    errors.push("Release builds must not use debug signing material.");
  }
  for (const [name, configured] of Object.entries({
    GUARDIAN_RELEASE_STORE_PASSWORD: storePassword,
    GUARDIAN_RELEASE_KEY_ALIAS: keyAlias,
    GUARDIAN_RELEASE_KEY_PASSWORD: keyPassword,
  })) {
    if (!configured || isPlaceholder(configured))
      errors.push(`${name} must be explicitly configured for release signing.`);
  }
  const certificateDigest = value(environment, "GUARDIAN_RELEASE_CERT_SHA256");
  if (!/^[a-fA-F0-9]{64}$/.test(certificateDigest.replaceAll(":", ""))) {
    errors.push("GUARDIAN_RELEASE_CERT_SHA256 must be the configured release certificate SHA-256 digest.");
  }

  validateHttpsUrl(
    value(environment, "EXPO_PUBLIC_API_URL"),
    "Release API URL",
    errors,
  );
  validateHttpsUrl(
    value(environment, "GUARDIAN_DOH_URL"),
    "Release DoH URL",
    errors,
  );
  validateTrustedKeys(
    value(environment, "GUARDIAN_POLICY_TRUSTED_PUBLIC_KEYS"),
    value(environment, "GUARDIAN_POLICY_KEY_ID"),
    errors,
  );
  const releaseVersionCode = value(
    environment,
    "GUARDIAN_RELEASE_VERSION_CODE",
  );
  if (
    !/^[1-9]\d*$/.test(releaseVersionCode) ||
    BigInt(releaseVersionCode || "0") > 2147483647n
  ) {
    errors.push(
      "GUARDIAN_RELEASE_VERSION_CODE must be a positive 32-bit integer.",
    );
  }
  if (
    TRUTHY_VALUES.has(
      value(environment, "GUARDIAN_ENABLE_TEST_FIXTURES").toLowerCase(),
    )
  ) {
    errors.push("Release admission forbids fixture code.");
  }
  const limitedChild = value(environment, "GUARDIAN_RELEASE_LIMITED_CHILD");
  if (!["", "true", "false"].includes(limitedChild)) {
    errors.push("GUARDIAN_RELEASE_LIMITED_CHILD must be true or false.");
  }
  if (limitedChild === "true" && (
    value(environment, "EXPO_PUBLIC_GUARDIAN_ROLE") !== "child" ||
    value(environment, "EXPO_PUBLIC_GUARDIAN_LIMITED_CHILD") !== "true"
  )) {
    errors.push("Limited Child release requires matching Child role and app capability settings.");
  }
  return errors;
}

function main() {
  const errors = validateReleaseAdmission();
  if (errors.length === 0) {
    process.stdout.write("Guardian release admission passed.\n");
    return;
  }
  process.stderr.write(
    `Guardian release admission failed:\n${errors.map((error) => `- ${error}`).join("\n")}\n`,
  );
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main();
