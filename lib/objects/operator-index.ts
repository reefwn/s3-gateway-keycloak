export type OperatorObject = Readonly<{
  key: string;
  size: number;
  lastModified?: string;
}>;

export type OperatorListing = Readonly<{
  objects: readonly OperatorObject[];
  prefixes: readonly string[];
}>;

export function parentPrefix(prefix: string): string {
  const segments = prefix.split("/").filter(Boolean);
  return segments.slice(0, -1).join("/") + (segments.length > 1 ? "/" : "");
}

export function prefixSegments(prefix: string): readonly string[] {
  return prefix.split("/").filter(Boolean);
}

export function filterAndSortListing(listing: OperatorListing, query: string): OperatorListing {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = (value: string) => value.toLocaleLowerCase().includes(normalizedQuery);

  return {
    prefixes: listing.prefixes.filter(matches).slice().sort((left, right) => left.localeCompare(right)),
    objects: listing.objects.filter((object) => matches(object.key)).slice().sort((left, right) => left.key.localeCompare(right.key)),
  };
}
