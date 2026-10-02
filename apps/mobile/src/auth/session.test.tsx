import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Pressable, Text } from "react-native";

jest.mock("@/api/client", () => {
  class MockApiError extends Error {
    constructor(message: string, mockStatus: number, mockCode?: string) {
      super(message);
      this.name = "ApiError";
      Object.assign(this, { status: mockStatus, code: mockCode });
    }
  }
  return {
    ApiError: MockApiError,
    api: { me: jest.fn(), families: jest.fn(), children: jest.fn(), logout: jest.fn() },
    sessionStorage: {
      getAccessToken: jest.fn(),
      getFamilyId: jest.fn(),
      getSelectedChildId: jest.fn(),
      clearParentSession: jest.fn(),
      setFamilyId: jest.fn(),
      setSelectedChildId: jest.fn(),
      setTokens: jest.fn(),
    },
    subscribeToParentSessionExpiry: jest.fn(() => () => undefined),
  };
});

import { ApiError, api, sessionStorage } from "@/api/client";
import { SessionProvider, useSession } from "@/auth/session";

function SessionState() {
  const { childId, familyId, loading, sessionError, signIn } = useSession();
  return <>
    <Text>{loading ? "loading" : sessionError ?? "clear"}</Text>
    <Text>{`${familyId ?? "no-family"}:${childId ?? "no-child"}`}</Text>
    <Pressable accessibilityLabel="Sign in for test" onPress={() => { void signIn({ access_token: "access", refresh_token: "refresh" }); }} />
  </>;
}

beforeEach(() => {
  jest.clearAllMocks();
  (sessionStorage.getAccessToken as jest.Mock).mockResolvedValue("expired-access");
  (sessionStorage.getFamilyId as jest.Mock).mockResolvedValue("family-1");
  (sessionStorage.getSelectedChildId as jest.Mock).mockResolvedValue("child-1");
  (sessionStorage.clearParentSession as jest.Mock).mockResolvedValue(undefined);
  (sessionStorage.setFamilyId as jest.Mock).mockResolvedValue(undefined);
  (sessionStorage.setSelectedChildId as jest.Mock).mockResolvedValue(undefined);
  (sessionStorage.setTokens as jest.Mock).mockResolvedValue(undefined);
});

test("bootstrap preserves SESSION_EXPIRED as an actionable signed-out state", async () => {
  (api.me as jest.Mock).mockRejectedValue(new ApiError("Session expired", 401, "SESSION_EXPIRED"));

  render(<SessionProvider><SessionState /></SessionProvider>);

  await waitFor(() => expect(screen.getByText("SESSION_EXPIRED")).toBeTruthy());
  expect(sessionStorage.clearParentSession).toHaveBeenCalledTimes(1);
});

test("parent sign-in discovers an existing family and selected child without creating another family", async () => {
  (sessionStorage.getAccessToken as jest.Mock).mockResolvedValue(null);
  (api.me as jest.Mock).mockResolvedValue({ id: "parent-1", email: "parent@example.com" });
  (api.families as jest.Mock).mockResolvedValue([{ id: "family-existing", name: "Existing family" }]);
  (api.children as jest.Mock).mockResolvedValue([{ id: "child-existing", name: "Alex" }]);
  (sessionStorage.getSelectedChildId as jest.Mock).mockResolvedValue(null);

  render(<SessionProvider><SessionState /></SessionProvider>);
  fireEvent.press(await screen.findByLabelText("Sign in for test"));

  await waitFor(() => expect(screen.getByText("family-existing:child-existing")).toBeTruthy());
  expect((api.families as jest.Mock).mock.calls).toHaveLength(1);
  expect((api.children as jest.Mock).mock.calls).toEqual([["family-existing"]]);
  expect(sessionStorage.setFamilyId).toHaveBeenCalledWith("family-existing");
  expect(sessionStorage.setSelectedChildId).toHaveBeenCalledWith("child-existing");
});
