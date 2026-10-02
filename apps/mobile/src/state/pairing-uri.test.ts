import { parsePairingUri } from "@/state/pairing-uri";

test.each([
  "guardian://pair/session-123?child_id=child-456&code=123456",
  "guardian://pair/session-123?code=123456&child_id=child-456",
  "guardian://pair/session-123?source=camera&child_id=child-456&code=123456",
  "guardian://pair/session-123?code=123456&source=camera&child_id=child-456",
])("parses the backend pairing URI regardless of query ordering: %s", (uri) => {
  expect(parsePairingUri(uri)).toEqual({
    sessionId: "session-123",
    childId: "child-456",
    code: "123456",
  });
});

test("rejects non-Guardian and incomplete pairing URIs", () => {
  expect(parsePairingUri("https://pair/session-123?child_id=child-456&code=123456")).toBeNull();
  expect(parsePairingUri("guardian://pair/session-123?child_id=child-456")).toBeNull();
});
