import { act, renderHook } from "@testing-library/react-native";
import { api, sessionStorage } from "@/api/client";
import { useFamilySync } from "@/hooks/use-family-sync";

const mockInvalidateQueries = jest.fn().mockResolvedValue(undefined);

jest.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}));

jest.mock("@/api/client", () => ({
  api: {
    websocketUrl: jest.fn((path: string, params: Record<string, string>) =>
      `wss://guardian.example${path}?${new URLSearchParams(params)}`),
    realtimeToken: jest.fn(() => Promise.resolve("parent-token")),
  },
  sessionStorage: {
    getAccessToken: jest.fn(() => Promise.resolve("parent-token")),
    getDeviceToken: jest.fn(() => Promise.resolve(null)),
  },
}));

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  closed = false;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
    readonly options?: { headers?: Record<string, string> },
  ) {
    MockWebSocket.instances.push(this);
  }

  send = jest.fn();

  close() {
    this.closed = true;
    this.onclose?.({ code: 1000 });
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  MockWebSocket.instances = [];
  (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket;
  (sessionStorage.getAccessToken as jest.Mock).mockResolvedValue("parent-token");
  (sessionStorage.getDeviceToken as jest.Mock).mockResolvedValue(null);
});

afterEach(() => {
  jest.useRealTimers();
});

test("connects to the configured secure WebSocket and uses the parent bearer token", async () => {
  const hook = renderHook(() => useFamilySync("family-1", "parent", "child-1"));
  await act(async () => { await Promise.resolve(); });

  expect(MockWebSocket.instances).toHaveLength(1);
  expect(MockWebSocket.instances[0]).toMatchObject({
    url: "wss://guardian.example/v1/ws/parent?family_id=family-1&child_profile_id=child-1",
    options: { headers: { Authorization: "Bearer parent-token" } },
  });
  hook.unmount();
});

test("child connections use only the paired device credential", async () => {
  const realtimeToken = jest.spyOn(api, "realtimeToken");
  (sessionStorage.getDeviceToken as jest.Mock).mockResolvedValue("device-token");
  const hook = renderHook(() => useFamilySync("family-1", "child"));
  await act(async () => { await Promise.resolve(); });

  expect(MockWebSocket.instances[0]).toMatchObject({
    url: "wss://guardian.example/v1/ws/child?family_id=family-1",
    options: { headers: { Authorization: "Bearer device-token" } },
  });
  expect(realtimeToken).not.toHaveBeenCalled();
  hook.unmount();
});

test("ignores malformed WebSocket frames and still invalidates valid events", async () => {
  const hook = renderHook(() => useFamilySync("family-1", "parent"));
  await act(async () => { await Promise.resolve(); });
  const socket = MockWebSocket.instances[0];

  expect(() => socket.onmessage?.({ data: "not-json" })).not.toThrow();
  expect(mockInvalidateQueries).not.toHaveBeenCalled();
  act(() => socket.onmessage?.({ data: JSON.stringify({ type: "request-created" }) }));
  expect(mockInvalidateQueries).toHaveBeenCalled();
  expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["activity-usage", "family-1"] });

  hook.unmount();
});

test("falls back to polling and reconnects after a WebSocket failure", async () => {
  const hook = renderHook(() => useFamilySync("family-1", "parent"));
  await act(async () => { await Promise.resolve(); });
  const first = MockWebSocket.instances[0];

  act(() => first.onclose?.({ code: 1006 }));
  expect(mockInvalidateQueries).toHaveBeenCalled();
  const callsAfterDisconnect = mockInvalidateQueries.mock.calls.length;
  act(() => jest.advanceTimersByTime(1_000));
  await act(async () => { await Promise.resolve(); });
  expect(MockWebSocket.instances).toHaveLength(2);
  act(() => MockWebSocket.instances[1].onopen?.());
  const callsAfterReconnect = mockInvalidateQueries.mock.calls.length;

  act(() => jest.advanceTimersByTime(3_000));
  expect(mockInvalidateQueries.mock.calls.length).toBe(callsAfterReconnect);

  act(() => MockWebSocket.instances[1].onclose?.({ code: 1006 }));
  expect(mockInvalidateQueries.mock.calls.length).toBeGreaterThan(callsAfterDisconnect);
  act(() => jest.advanceTimersByTime(2_000));
  expect(mockInvalidateQueries.mock.calls.length).toBeGreaterThan(callsAfterReconnect);

  hook.unmount();
});

test("keeps polling after a policy rejection without retrying the rejected socket", async () => {
  const hook = renderHook(() => useFamilySync("family-1", "parent"));
  await act(async () => { await Promise.resolve(); });

  act(() => MockWebSocket.instances[0].onopen?.());
  act(() => MockWebSocket.instances[0].onclose?.({ code: 1008 }));
  const callsAfterRejection = mockInvalidateQueries.mock.calls.length;

  act(() => jest.advanceTimersByTime(2_000));
  expect(mockInvalidateQueries.mock.calls.length).toBeGreaterThan(callsAfterRejection);
  act(() => jest.advanceTimersByTime(30_000));
  expect(MockWebSocket.instances).toHaveLength(1);

  hook.unmount();
});

test("refreshes a parent token before reconnecting after expiry", async () => {
  const realtimeToken = jest.spyOn(api, "realtimeToken");
  realtimeToken.mockResolvedValueOnce("parent-token");
  realtimeToken.mockResolvedValueOnce("refreshed-parent-token");
  const hook = renderHook(() => useFamilySync("family-1", "parent"));
  await act(async () => { await Promise.resolve(); });

  act(() => MockWebSocket.instances[0].onclose?.({ code: 1006 }));
  act(() => jest.advanceTimersByTime(1_000));
  await act(async () => { await Promise.resolve(); });

  expect(realtimeToken).toHaveBeenCalledTimes(2);
  expect(MockWebSocket.instances[1].options).toEqual({
    headers: { Authorization: "Bearer refreshed-parent-token" },
  });
  hook.unmount();
});
