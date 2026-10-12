import { Children, PropsWithChildren } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  colors,
  protectionStateColors,
  radii,
  spacing,
  touchTarget,
  typography,
} from "@guardian/design-tokens";

type Palette = typeof colors.light;

export function usePalette(): Palette {
  return colors.light;
}

export function ScreenScaffold({
  children,
  title,
}: PropsWithChildren<{ title?: string }>) {
  const insets = useSafeAreaInsets();
  const palette = usePalette();
  const { width } = useWindowDimensions();
  const isRegularWidth = width >= 600;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[
        styles.scaffold,
        { paddingTop: Math.max(insets.top, spacing.md), backgroundColor: palette.background },
      ]}
    >
      <View style={[styles.content, isRegularWidth && styles.contentRegular]}>
        {title ? (
          <Text accessibilityRole="header" style={[styles.title, { color: palette.text }]}>
            {title}
          </Text>
        ) : null}
        {children}
      </View>
    </ScrollView>
  );
}

export function ResponsiveColumns({ children }: PropsWithChildren) {
  const { width } = useWindowDimensions();
  const isRegularWidth = width >= 600;
  return (
    <View style={[styles.columns, isRegularWidth && styles.columnsRegular]}>
      {Children.map(children, (child) => (
        <View style={[styles.columnItem, isRegularWidth && styles.columnItemRegular]}>{child}</View>
      ))}
    </View>
  );
}

export function SectionSurface({ children }: PropsWithChildren) {
  const palette = usePalette();
  return (
    <View style={[styles.section, { backgroundColor: palette.surface, borderColor: palette.border }]}>
      {children}
    </View>
  );
}

export function CardSurface({ children }: PropsWithChildren) {
  const palette = usePalette();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: palette.elevatedSurface, borderColor: palette.border },
      ]}
    >
      {children}
    </View>
  );
}

export function ListRow({
  label,
  value,
  onPress,
}: {
  label: string;
  value?: string;
  onPress?: () => void;
}) {
  const palette = usePalette();
  const content = (
    <View style={styles.row}>
      <Text style={[styles.body, styles.rowLabel, { color: palette.text }]}>{label}</Text>
      {value ? <Text style={[styles.caption, styles.rowValue, { color: palette.secondaryText }]}>{value}</Text> : null}
    </View>
  );
  return onPress ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [pressed && styles.pressed]}
    >
      {content}
    </Pressable>
  ) : (
    content
  );
}

export function PrimaryButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: palette.primary },
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.buttonText, { color: palette.primaryText }]}>{label}</Text>
    </Pressable>
  );
}

export function SecondaryButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { borderColor: palette.border, backgroundColor: palette.surface },
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.buttonText, { color: palette.text }]}>{label}</Text>
    </Pressable>
  );
}

export function TextField({
  label,
  value,
  onChangeText,
  secureTextEntry,
  keyboardType,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  secureTextEntry?: boolean;
  keyboardType?: "default" | "email-address" | "numeric";
}) {
  const palette = usePalette();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: palette.text }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        autoCapitalize="none"
        keyboardType={keyboardType}
        onChangeText={onChangeText}
        secureTextEntry={secureTextEntry}
        style={[styles.input, { color: palette.text, borderColor: palette.border }]}
        value={value}
      />
    </View>
  );
}

const protectionTone: Record<string, keyof typeof protectionStateColors> = {
  HEALTHY: "PROTECTED",
  PROTECTED: "PROTECTED",
  DEGRADED: "DEGRADED",
  DISABLED: "DEGRADED",
  UNKNOWN: "UNKNOWN",
};

export function ProtectionStatePill({ state }: { state: string }) {
  const palette = usePalette();
  const color = protectionStateColors[protectionTone[state] ?? "UNKNOWN"].light;
  return (
    <View
      accessible
      accessibilityLabel={`Protection status: ${state}`}
      style={[styles.pill, { backgroundColor: `${color}22` }]}
    >
      <Text style={[styles.label, { color: palette.text }]}>{state}</Text>
    </View>
  );
}

export function DataState({
  state,
  onRetry,
  message: messageOverride,
  children,
}: PropsWithChildren<{
  state: "initial" | "loading" | "loaded" | "empty" | "offline" | "stale" | "permission-denied" | "platform-unavailable" | "error" | "revoked" | "pending-sync";
  onRetry?: () => void;
  message?: string;
}>) {
  const palette = usePalette();
  if (state === "loaded") return <>{children}</>;
  if (state === "loading" || state === "initial") return <ActivityIndicator accessibilityLabel="Loading" />;
  const message = messageOverride ?? {
    empty: "Nothing to show yet.",
    offline: "You're offline. Last-known data may be shown.",
    stale: "This data may be out of date.",
    "permission-denied": "Permission is required to continue.",
    "platform-unavailable": "This feature is unavailable on this platform.",
    error: "We couldn't load this data.",
    revoked: "Protection removed. This device is no longer linked to the family.",
    "pending-sync": "Changes are waiting to sync.",
  }[state];
  if (state === "stale") {
    return (
      <>
        <View accessibilityLiveRegion="polite" style={styles.state}>
          <Text style={[styles.body, { color: palette.text }]}>{message}</Text>
        </View>
        {children}
      </>
    );
  }
  return (
    <View accessibilityLiveRegion="polite" style={styles.state}>
      <Text style={[styles.body, { color: palette.text }]}>{message}</Text>
      {onRetry && state === "error" ? <SecondaryButton label="Retry" onPress={onRetry} /> : null}
    </View>
  );
}

export function ProtectionRemovedState({ onRecover }: { onRecover: () => void }) {
  const palette = usePalette();
  return (
    <View accessibilityLiveRegion="polite" style={styles.state}>
      <Text style={[styles.body, { color: palette.text }]}>Protection removed</Text>
      <Text style={[styles.body, { color: palette.text }]}>
        This device is no longer linked to the family.
      </Text>
      <Text style={[styles.caption, { color: palette.secondaryText }]}>
        Ask a parent to pair this device again.
      </Text>
      <SecondaryButton label="Return to setup" onPress={onRecover} />
    </View>
  );
}

export function DialogSurface({ children }: PropsWithChildren) {
  return <SectionSurface>{children}</SectionSurface>;
}

const styles = StyleSheet.create({
  scaffold: { flexGrow: 1, gap: spacing.lg, paddingHorizontal: spacing.md, paddingBottom: spacing.xxl },
  content: { width: "100%", gap: spacing.lg },
  contentRegular: { alignSelf: "center", maxWidth: 720 },
  columns: { gap: spacing.lg },
  columnsRegular: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start" },
  columnItem: { width: "100%" },
  columnItemRegular: { flexBasis: "47%", flexGrow: 1, width: "47%" },
  section: { gap: spacing.md, borderWidth: 1, borderRadius: radii.lg, padding: spacing.md },
  card: { gap: spacing.sm, borderWidth: 1, borderRadius: radii.md, padding: spacing.md },
  title: typography.title,
  body: typography.body,
  label: typography.label,
  caption: typography.caption,
  row: { minHeight: touchTarget.minimum, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  rowLabel: { flex: 1, flexShrink: 1 },
  rowValue: { flexShrink: 1 },
  button: { minHeight: touchTarget.minimum, alignItems: "center", justifyContent: "center", borderRadius: radii.md, borderWidth: 1, paddingHorizontal: spacing.md },
  buttonText: typography.bodyEmphasis,
  input: { minHeight: touchTarget.minimum, borderWidth: 1, borderRadius: radii.sm, paddingHorizontal: spacing.md, ...typography.body },
  field: { gap: spacing.xs },
  pill: { alignSelf: "flex-start", borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  state: { alignItems: "center", gap: spacing.md, paddingVertical: spacing.lg },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.45 },
});
