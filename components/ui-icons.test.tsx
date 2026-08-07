import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BucketIcon } from "@/components/ui-icons";

describe("workspace icons", () => {
  it("renders a decorative SVG that accepts a class name", () => {
    render(<BucketIcon className="size-4" />);

    expect(screen.getByTestId("bucket-icon")).toHaveClass("size-4");
    expect(screen.getByTestId("bucket-icon")).toHaveAttribute("aria-hidden", "true");
  });
});
