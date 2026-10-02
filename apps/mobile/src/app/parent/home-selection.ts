export function resolveActiveChildId(
  storedChildId: string | null,
  routeChildId: string | undefined,
  fallbackChildId: string | undefined,
) {
  // A route can be stale after the parent switches children. The durable
  // explicit selection is the single source of truth once it exists.
  return storedChildId ?? routeChildId ?? fallbackChildId;
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
