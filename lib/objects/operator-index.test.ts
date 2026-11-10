import { describe, expect, it } from "vitest";

import {
  buildBrowserRows,
  containingPrefix,
  filterAndSortListing,
  isPreviewableKey,
  paginateRows,
  parentPrefix,
  prefixSegments,
  sortBrowserRows,
} from "@/lib/objects/operator-index";

describe("operator index helpers", () => {
  it("returns a parent prefix without escaping the bucket root", () => {
    expect(parentPrefix("reports/2026/august/")).toBe("reports/2026/");
    expect(parentPrefix("reports/")).toBe("");
    expect(parentPrefix("")).toBe("");
  });

  it("turns a prefix into breadcrumb segments", () => {
    expect(prefixSegments("reports/2026/august/")).toEqual(["reports", "2026", "august"]);
    expect(prefixSegments("")).toEqual([]);
  });

  it("recognises only PDF and raster-image preview filenames", () => {
    expect(isPreviewableKey("photos/Scan.JPEG")).toBe(true);
    expect(isPreviewableKey("reports/summary.pdf")).toBe(true);
    expect(isPreviewableKey("uploads/vector.svg")).toBe(false);
    expect(containingPrefix("reports/2026/summary.pdf")).toBe("reports/2026/");
    expect(containingPrefix("summary.pdf")).toBe("");
  });

  it("filters folders and objects by finder text without mutating the listing", () => {
    const listing = {
      prefixes: ["reports/Archive/", "reports/current/"],
      objects: [
        { key: "reports/annual-summary.pdf", size: 42 },
        { key: "reports/notes.txt", size: 7 },
      ],
    };

    expect(filterAndSortListing(listing, "archive")).toEqual({
      prefixes: ["reports/Archive/"],
      objects: [],
    });
    expect(filterAndSortListing(listing, "notes")).toEqual({
      prefixes: [],
      objects: [{ key: "reports/notes.txt", size: 7 }],
    });
    expect(listing.prefixes).toEqual(["reports/Archive/", "reports/current/"]);
  });

  it("sorts and paginates table rows by display name", () => {
    const rows = buildBrowserRows(
      { prefixes: ["b-folder/"], objects: [{ key: "a-file.txt", size: 1 }] },
      "",
      false
    );
    expect(sortBrowserRows(rows, "desc").map((row) => row.name)).toEqual(["b-folder/", "a-file.txt"]);
    expect(paginateRows(sortBrowserRows(rows, "asc"), 1, 1)).toMatchObject({ page: 1, total: 2, totalPages: 2, rows: [{ name: "a-file.txt" }] });
  });
});
