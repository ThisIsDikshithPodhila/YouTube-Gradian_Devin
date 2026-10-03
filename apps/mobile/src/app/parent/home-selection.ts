export function resolveActiveChildId(
  storedChildId: string | null,
  routeChildId: string | undefined,
  fallbackChildId: string | undefined,
  availableChildIds?: string[],
) {
  const available = (childId: string | null | undefined) =>
    childId && (!availableChildIds || availableChildIds.includes(childId)) ? childId : null;
  return available(storedChildId) ?? available(routeChildId) ?? available(fallbackChildId) ?? undefined;
}

type ParentHomeRoute = {
  pathname: "/parent/home";
  params: { familyId: string; childId: string };
};

export async function selectParentHomeChild(
  familyId: string,
  childId: string,
  setChildId: (childId: string) => Promise<void>,
  replace: (route: ParentHomeRoute) => void,
) {
  await setChildId(childId);
  replace({ pathname: "/parent/home", params: { familyId, childId } });
}
