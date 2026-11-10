export type OperatorObject = Readonly<{
  key: string;
  size: number;
  lastModified?: string;
}>;

export type OperatorListing = Readonly<{
  objects: readonly OperatorObject[];
  prefixes: readonly string[];
}>;

export type OperatorSearchResult = Readonly<{
  objects: readonly OperatorObject[];
  truncated: boolean;
  continuationToken?: string;
}>;

export type OperatorListingPage = OperatorListing & Readonly<{
  nextContinuationToken?: string;
}>;

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

export type NameSortDirection = "asc" | "desc";

export type BrowserRow =
  | Readonly<{ kind: "prefix"; key: string; name: string }>
  | Readonly<{ kind: "object"; key: string; name: string; object: OperatorObject }>;

const previewableSuffixes = [".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"];

export const isPreviewableKey = (key: string) => previewableSuffixes.some((suffix) => key.toLocaleLowerCase().endsWith(suffix));

export const containingPrefix = (key: string) => key.includes("/") ? `${key.split("/").slice(0, -1).join("/")}/` : "";

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

export function listingDisplayName(key: string, currentPrefix: string, fromSearch: boolean): string {
  if (key.endsWith("/")) return key.slice(currentPrefix.length) || key.replace(/\/$/, "");
  return fromSearch ? (key.split("/").filter(Boolean).at(-1) ?? key) : (key.slice(currentPrefix.length) || key);
}

export function buildBrowserRows(listing: OperatorListing, currentPrefix: string, fromSearch: boolean): BrowserRow[] {
  return [
  ...listing.prefixes.map((key) => ({ kind: "prefix" as const, key, name: listingDisplayName(key, currentPrefix, fromSearch) })),
  ...listing.objects.map((object) => ({
    kind: "object" as const,
    key: object.key,
    name: listingDisplayName(object.key, currentPrefix, fromSearch),
    object,
  })),
  ];
}

export function sortBrowserRows(rows: readonly BrowserRow[], direction: NameSortDirection): BrowserRow[] {
  const sorted = [...rows].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  return direction === "desc" ? [...sorted].reverse() : sorted;
}

export function paginateRows<T>(rows: readonly T[], page: number, pageSize: number): Readonly<{ page: number; rows: T[]; total: number; totalPages: number }> {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  return { page: safePage, rows: rows.slice(start, start + pageSize), total, totalPages };
}
