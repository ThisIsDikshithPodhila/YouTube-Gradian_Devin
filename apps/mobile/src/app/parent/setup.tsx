import { useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Text } from "react-native";
import { ApiError, api } from "@/api/client";
import { useSession } from "@/auth/session";
import { PrimaryButton, ScreenScaffold, SectionSurface, TextField } from "@/design-system";

export default function ParentSetupRoute() {
  const router = useRouter();
  const { familyId: storedFamilyId, setChildId, setFamilyId } = useSession();
  const { familyId: routeFamilyId } = useLocalSearchParams<{ familyId?: string }>();
  const existingFamilyId = routeFamilyId ?? storedFamilyId;
  const [family, setFamily] = useState("");
  const [child, setChild] = useState("");
  const [dob, setDob] = useState("");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [message, setMessage] = useState<string | null>(null);
  const submit = async () => {
    try {
      const targetFamilyId = existingFamilyId ?? (await api.createFamily(family)).id;
      const createdChild = await api.createChild(targetFamilyId, { name: child, date_of_birth: dob, timezone });
      await setFamilyId(targetFamilyId);
      await setChildId(createdChild.id);
      setMessage(`Age band: ${createdChild.age_band}`);
      router.replace({ pathname: "/parent/home", params: { familyId: targetFamilyId, childId: createdChild.id } });
    } catch (error) { setMessage(error instanceof ApiError ? error.message : "Setup failed."); }
  };
  return (
    <ScreenScaffold title={existingFamilyId ? "Add a child" : "Set up your family"}>
      <SectionSurface>
        {!existingFamilyId ? <TextField label="Family name" value={family} onChangeText={setFamily} /> : null}
        <TextField label="Child name" value={child} onChangeText={setChild} />
        <TextField label="Date of birth (YYYY-MM-DD)" value={dob} onChangeText={setDob} />
        <TextField label="Timezone" value={timezone} onChangeText={setTimezone} />
        {message ? <Text accessibilityLiveRegion="polite">{message}</Text> : null}
        <PrimaryButton label={existingFamilyId ? "Add child" : "Create family and child"} onPress={submit} disabled={(!existingFamilyId && !family) || !child || !dob || !timezone} />
      </SectionSurface>
    </ScreenScaffold>
  );
}
