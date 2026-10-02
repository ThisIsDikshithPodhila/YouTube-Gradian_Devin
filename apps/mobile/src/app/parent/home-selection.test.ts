import { resolveActiveChildId, selectParentHomeChild } from "./home-selection";

test("switching after setup replaces a stale child route with the selected child", async () => {
  const selected: string[] = [];
  const replace = jest.fn();

  await selectParentHomeChild(
    "family-1",
    "child-a",
    (childId) => {
      selected.push(childId);
      return Promise.resolve();
    },
    replace,
  );

  expect(selected).toEqual(["child-a"]);
  expect(replace).toHaveBeenCalledWith({
    pathname: "/parent/home",
    params: { familyId: "family-1", childId: "child-a" },
  });
  expect(resolveActiveChildId("child-a", "child-b", "child-b")).toBe("child-a");
});
