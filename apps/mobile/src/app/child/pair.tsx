import { useState } from "react";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { Text } from "react-native";
import * as ed25519 from "@noble/ed25519";
import * as Crypto from "expo-crypto";
import { api, ApiError, sessionStorage } from "@/api/client";
import { PrimaryButton, ScreenScaffold, SectionSurface, TextField } from "@/design-system";
import { parsePairingUri } from "@/state/pairing-uri";
import { activateChildRePair } from "@/state/child-repair";
import { clearRequestOutbox } from "@/state/request-outbox";
import { GuardianProtection } from "../../../modules/guardian-protection/src";

function toBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    output += alphabet[first >> 2];
    output += alphabet[((first & 3) << 4) | (second >> 4)];
    output += index + 1 < bytes.length ? alphabet[((second & 15) << 2) | (third >> 6)] : "=";
    output += index + 2 < bytes.length ? alphabet[third & 63] : "=";
  }
  return output;
}

ed25519.hashes.sha512Async = async (message) =>
  new Uint8Array(
    await Crypto.digest(
      Crypto.CryptoDigestAlgorithm.SHA512,
      new Uint8Array(message),
    ),
  );

export default function ChildPairRoute() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [code, setCode] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [childId, setChildId] = useState("");
  const [message, setMessage] = useState("Scan the parent QR code or enter its six digits.");
  const [scanning, setScanning] = useState(false);
  const redeem = async () => {
    try {
      setMessage("Generating device credentials…");
      const privateKey = Crypto.getRandomBytes(32);
      const publicKey = await ed25519.getPublicKeyAsync(privateKey);
      setMessage("Registering child device…");
      const credentials = await api.redeemPairing({ session_id: sessionId, code, child_profile_id: childId, platform: "ANDROID", public_key: toBase64(publicKey) });
      setMessage("Resetting previous child identity…");
      await activateChildRePair(credentials, toBase64(privateKey), {
        stopProtection: () => GuardianProtection.stopProtection(),
        clearNativeIdentity: () => GuardianProtection.clearChildIdentity(),
        clearRequestOutbox,
        configureNativeDevice: (deviceId) => GuardianProtection.setContentDeviceId(deviceId),
        clearDeviceCredentials: sessionStorage.clearDeviceIdentity,
        saveDeviceCredentials: sessionStorage.saveDeviceCredentials,
      });
      router.replace("/child/home");
    } catch (error) { setMessage(error instanceof ApiError ? error.message : `Pairing failed: ${error instanceof Error ? error.message : "check the code and try again."}`); }
  };
  return <ScreenScaffold title="Set up child device"><SectionSurface><PrimaryButton label="Scan QR code" onPress={() => { if (!permission?.granted) void requestPermission().catch(() => setMessage("Camera permission is required to scan the parent code.")); setScanning(true); }} />{scanning && permission?.granted ? <CameraView style={{ height: 220 }} onBarcodeScanned={({ data }) => { setScanning(false); const parsed = parsePairingUri(data); if (parsed) { setSessionId(parsed.sessionId); setCode(parsed.code); setChildId(parsed.childId); } else { setMessage("That QR code is not a Guardian pairing code."); } }} /> : null}<TextField label="Session ID" value={sessionId} onChangeText={setSessionId} /><TextField label="Six-digit code" value={code} onChangeText={setCode} keyboardType="numeric" /><TextField label="Child profile ID" value={childId} onChangeText={setChildId} /><Text accessibilityLiveRegion="polite">{message}</Text><PrimaryButton label="Pair device" onPress={redeem} disabled={!sessionId || code.length !== 6 || !childId} /></SectionSurface></ScreenScaffold>;
}
