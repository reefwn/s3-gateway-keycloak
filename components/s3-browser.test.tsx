import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { S3Browser } from "@/components/s3-browser";

describe("S3Browser", () => {
  it("shows only readonly actions to a readonly actor", () => {
    render(<S3Browser actor={{ sub: "user-1", username: "alex", email: null, role: "readonly" }} buckets={["reports"]} />);

    expect(screen.getByRole("button", { name: "Browse reports" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload file" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete object" })).not.toBeInTheDocument();
  });

  it("shows upload and folder controls to a readwrite actor", () => {
    render(<S3Browser actor={{ sub: "user-1", username: "alex", email: null, role: "readwrite" }} buckets={["reports"]} />);

    expect(screen.getByRole("button", { name: "Upload file" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create folder" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete object" })).not.toBeInTheDocument();
  });
});
