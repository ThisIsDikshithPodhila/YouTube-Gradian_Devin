import { Redirect, useRouter } from "expo-router";
import { Text } from "react-native";
import { PrimaryButton, ScreenScaffold, SecondaryButton, SectionSurface } from "@/design-system";
import { configuredRole, roleStorage } from "@/state/role";

export default function RoleSelectionRoute() {
  const router = useRouter();
  const choose = async (role: "parent" | "child") => {
    await roleStorage.set(role);
    router.replace(role === "parent" ? "/parent/login" : "/child/pair");
  };
  if (configuredRole) return <Redirect href={configuredRole === "parent" ? "/parent/login" : "/child/pair"} />;
  return (
    <ScreenScaffold title="Welcome to Guardian">
      <SectionSurface>
        <Text accessibilityRole="header">Choose how this device will be used.</Text>
        <PrimaryButton label="Parent device" onPress={() => choose("parent")} />
        <SecondaryButton label="Child device" onPress={() => choose("child")} />
      </SectionSurface>
    </ScreenScaffold>
  );
}
