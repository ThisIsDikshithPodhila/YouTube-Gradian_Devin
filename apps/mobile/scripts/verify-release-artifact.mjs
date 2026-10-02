import { createHash, X509Certificate } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROHIBITED_PERMISSIONS = [
  "ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION", "RECORD_AUDIO", "READ_SMS", "QUERY_ALL_PACKAGES",
];
const REQUIRED_SERVICES = [
  "GuardianVpnService", "GuardianAccessibilityService", "GuardianNotificationListenerService",
];
const REQUIRED_METADATA = {
  isMonitoringTool: "child_monitoring",
  "com.guardian.family.CHILD_MONITORING_DISCLOSURE": undefined,
  "com.guardian.family.ACCESSIBILITY_DECLARATION": undefined,
  "com.guardian.family.VPN_DECLARATION": undefined,
};
const FIXTURE_MARKER = /fixture/i;
const REQUIRED_NON_RELEASE_FIXTURE_GUARD = "GUARDIAN_NON_RELEASE_FIXTURES_ENABLED";

function applicationTag(xml) { return xml.match(/<application\b[^>]*>/)?.[0] ?? ""; }
function metadataTag(xml, name) {
  return Array.from(xml.matchAll(/<meta-data\b[^>]*>/g)).find((tag) => tag[0].includes(`android:name="${name}"`))?.[0];
}

export function verifyArtifactManifestXml(xml, artifactLabel) {
  const errors = [];
  const prefix = `Release ${artifactLabel} manifest`;
  const application = applicationTag(xml);
  if (!/android:allowBackup="false"/.test(application)) errors.push(`${prefix} must set android:allowBackup=false.`);
  if (!/android:usesCleartextTraffic="false"/.test(application)) errors.push(`${prefix} must set android:usesCleartextTraffic=false.`);
  for (const [name, requiredValue] of Object.entries(REQUIRED_METADATA)) {
    const metadata = metadataTag(xml, name);
    if (!metadata || (requiredValue && !metadata.includes(`android:value="${requiredValue}"`))) {
      errors.push(name === "isMonitoringTool" ? `${prefix} must declare isMonitoringTool=child_monitoring.` : `${prefix} is missing required metadata ${name}.`);
    }
  }
  for (const service of REQUIRED_SERVICES) if (!xml.includes(service)) errors.push(`${prefix} is missing ${service}.`);
  for (const permission of PROHIBITED_PERMISSIONS) if (xml.includes(`android.permission.${permission}`)) errors.push(`${prefix} contains prohibited permission ${permission}.`);
  if (FIXTURE_MARKER.test(xml)) errors.push(`${prefix} must not contain fixture declarations.`);
  return errors;
}
function xmlTreeMetadataNodes(tree) {
  const lines = tree.split("\n");
  const nodes = [];
  for (let index = 0; index < lines.length; index += 1) {
    const start = lines[index].match(/^(\s*)E:\s+meta-data\b/);
    if (!start) continue;
    let end = index + 1;
    while (end < lines.length) {
      if (/^\s*E:/.test(lines[end])) break;
      end += 1;
    }
    nodes.push(lines.slice(index, end).join("\n"));
  }
  return nodes;
}

function xmlTreeNodeHasStringAttribute(node, attribute, value) {
  return node.split("\n").some((line) =>
    line.trimStart().startsWith(`A: android:${attribute}(`) && line.includes(`"${value}"`),
  );
}

export function verifyArtifactManifestTree(tree) {
  const errors = [];
  for (const attribute of ["allowBackup", "usesCleartextTraffic"]) {
    const line = tree.split("\n").find((candidate) => candidate.includes(`android:${attribute}(`));
    if (!line || !/(?:\bfalse\b|0x0+\b)/.test(line) || /0xffffffff/.test(line)) errors.push(`Release APK manifest tree must set android:${attribute}=false.`);
  }
  const metadataNodes = xmlTreeMetadataNodes(tree);
  const monitoringMetadata = metadataNodes.some((node) =>
    xmlTreeNodeHasStringAttribute(node, "name", "isMonitoringTool")
      && xmlTreeNodeHasStringAttribute(node, "value", "child_monitoring"),
  );
  if (!monitoringMetadata) errors.push("Release APK manifest tree must declare isMonitoringTool=child_monitoring.");
  for (const required of Object.keys(REQUIRED_METADATA).filter((name) => name !== "isMonitoringTool")) {
    if (!metadataNodes.some((node) => xmlTreeNodeHasStringAttribute(node, "name", required))) {
      errors.push(`Release APK manifest tree is missing metadata ${required}.`);
    }
  }
  for (const service of REQUIRED_SERVICES) if (!tree.includes(service)) errors.push(`Release APK manifest tree is missing ${service}.`);
  for (const permission of PROHIBITED_PERMISSIONS) if (tree.includes(`android.permission.${permission}`)) errors.push(`Release APK manifest tree contains prohibited permission ${permission}.`);
  if (FIXTURE_MARKER.test(tree)) errors.push("Release APK manifest tree contains fixture content.");
  return errors;
}

export function fixtureMarkerErrors(entries, contents) {
  const errors = [];
  for (const entry of entries) if (FIXTURE_MARKER.test(entry)) errors.push(`Release archive contains fixture entry ${entry}.`);
  for (const content of contents) {
    const inspected = Buffer.from(content)
      .toString("utf8")
      .replaceAll(REQUIRED_NON_RELEASE_FIXTURE_GUARD, "");
    if (FIXTURE_MARKER.test(inspected)) errors.push("Release archive contains fixture bytes.");
  }
  return errors;
}

function output(command, args) { return execFileSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); }
function archiveEntries(artifact) { return output("unzip", ["-Z1", artifact]).split("\n").filter(Boolean); }
const DEFAULT_REQUIRED_APK_ABIS = ["armeabi-v7a", "arm64-v8a", "x86", "x86_64"];
function requiredApkAbis() {
  const configured = (process.env.GUARDIAN_RELEASE_REQUIRED_ABIS ?? "")
    .split(",")
    .map((abi) => abi.trim())
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_REQUIRED_APK_ABIS;
}
export function verifyApkAbis(entries, required = requiredApkAbis()) {
  const present = new Set(
    entries
      .map((entry) => entry.match(/^lib\/([^/]+)\//)?.[1])
      .filter(Boolean),
  );
  return required
    .filter((abi) => !present.has(abi))
    .map((abi) => `Release APK is missing native libraries for ABI ${abi}.`);
}
function archiveFixtureErrors(artifact) {
  const entries = archiveEntries(artifact);
  const inspected = entries.filter((entry) => /(^|\/)(assets\/|.*\.dex$|.*\.(?:jsbundle|bundle|json)$)/i.test(entry));
  return fixtureMarkerErrors(entries, inspected.map((entry) => execFileSync("unzip", ["-p", artifact, entry], { maxBuffer: 64 * 1024 * 1024 })));
}
function normalizedDigest(value) { return value.replaceAll(":", "").toLowerCase(); }
function expectedDigest() {
  const value = normalizedDigest(process.env.GUARDIAN_RELEASE_CERT_SHA256 ?? "");
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("GUARDIAN_RELEASE_CERT_SHA256 is required for final artifact verification.");
  return value;
}
function verifyApkCertificate(apk, apksigner) {
  const details = output(apksigner, ["verify", "--verbose", "--print-certs", apk]);
  const digest = details.match(/certificate SHA-256 digest:\s*([0-9A-F:]+)/i)?.[1];
  const subject = details.match(/certificate DN:\s*(.+)/i)?.[1] ?? "";
  if (!digest || normalizedDigest(digest) !== expectedDigest()) return ["Release APK signer does not match GUARDIAN_RELEASE_CERT_SHA256."];
  if (/cn\s*=\s*android debug/i.test(subject)) return ["Release APK is signed with an Android debug certificate."];
  return [];
}
function verifyAabCertificate(aab, keytool, jarsigner) {
  output(jarsigner, ["-verify", "-certs", aab]);
  const pem = output(keytool, ["-printcert", "-jarfile", aab, "-rfc"]);
  const certificate = new X509Certificate(pem);
  const digest = createHash("sha256").update(certificate.raw).digest("hex");
  if (digest !== expectedDigest()) return ["Release AAB signer does not match GUARDIAN_RELEASE_CERT_SHA256."];
  if (/cn\s*=\s*android debug/i.test(certificate.subject)) return ["Release AAB is signed with an Android debug certificate."];
  return [];
}
function verifyApkVersion(apk, aapt, expected) {
  const version = output(aapt, ["dump", "badging", apk]).match(/versionCode='(\d+)'/)?.[1];
  return version === expected ? [] : [`Release APK versionCode ${version ?? "is absent"} does not equal requested ${expected}.`];
}
export function bundletoolDumpManifestArgs(aab, classpath) {
  return [
    "-cp", classpath,
    "com.android.tools.build.bundletool.BundleToolMain",
    "dump", "manifest", `--bundle=${aab}`, "--module=base",
  ];
}

function verifyAabVersion(manifest, expected) {
  const version = manifest.match(/(?:android:)?versionCode="(\d+)"/)?.[1];
  return version === expected ? [] : [`Release AAB versionCode ${version ?? "is absent"} does not equal requested ${expected}.`];
}
function argument(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function requiredFile(path, label) { if (!path || !existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} is required.`); return path; }
function requiredValue(value, label) { if (!value) throw new Error(`${label} is required.`); return value; }

function main() {
  const artifact = requiredFile(argument("--artifact"), "Release artifact");
  const kind = argument("--kind");
  const expectedVersion = process.env.GUARDIAN_RELEASE_VERSION_CODE;
  if (!/^[1-9]\d*$/.test(expectedVersion ?? "")) throw new Error("GUARDIAN_RELEASE_VERSION_CODE is required for final artifact verification.");
  if (statSync(artifact).size === 0) throw new Error(`Release ${kind} is empty.`);
  const errors = [...archiveFixtureErrors(artifact)];
  if (kind === "apk") {
    const aapt = requiredFile(argument("--aapt"), "Android aapt");
    const apksigner = requiredFile(argument("--apksigner"), "Android apksigner");
    errors.push(...verifyArtifactManifestTree(output(aapt, ["dump", "xmltree", artifact, "AndroidManifest.xml"])), ...verifyApkCertificate(artifact, apksigner), ...verifyApkVersion(artifact, aapt, expectedVersion), ...verifyApkAbis(archiveEntries(artifact)));
  } else if (kind === "aab") {
    const keytool = requiredFile(argument("--keytool"), "keytool");
    const jarsigner = requiredFile(argument("--jarsigner"), "jarsigner");
    const java = requiredFile(argument("--java"), "JDK Java executable");
    const bundletoolClasspath = requiredValue(
      argument("--bundletool-classpath"),
      "Bundletool classpath",
    );
    const manifest = output(
      java,
      bundletoolDumpManifestArgs(artifact, bundletoolClasspath),
    );
    errors.push(
      ...verifyAabCertificate(artifact, keytool, jarsigner),
      ...verifyArtifactManifestXml(manifest, "AAB"),
      ...verifyAabVersion(manifest, expectedVersion),
    );
  } else throw new Error("Release artifact kind must be apk or aab.");
  if (errors.length) throw new Error(`Release artifact policy failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  process.stdout.write(`Guardian release ${kind.toUpperCase()} artifact policy passed.\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
