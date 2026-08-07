import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { S3Browser } from "@/components/s3-browser";

const { signOut } = vi.hoisted(() => ({ signOut: vi.fn() }));

vi.mock("next-auth/react", () => ({ signOut }));

describe("S3Browser", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("signs the actor out to the application sign-in page", () => {
    render(<S3Browser actor={{ sub: "user-1", username: "alex", email: null, role: "readonly" }} buckets={["reports"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(signOut).toHaveBeenCalledWith({ callbackUrl: "/sign-in" });
  });

  it("shows only readonly actions to a readonly actor", () => {
    render(<S3Browser actor={{ sub: "user-1", username: "alex", email: null, role: "readonly" }} buckets={["reports"]} />);

    expect(screen.getByRole("button", { name: "Browse reports" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload file" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete object" })).not.toBeInTheDocument();
  });

  it("shows upload and folder controls to a readwrite actor after selecting a bucket", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ objects: [], prefixes: [] }), {
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    render(<S3Browser actor={{ sub: "user-1", username: "alex", email: null, role: "readwrite" }} buckets={["reports"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Browse reports" }));

    expect(await screen.findByRole("button", { name: "Upload file" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create folder" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete object" })).not.toBeInTheDocument();
  });

  it("opens focused dialogs for upload and folder creation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ objects: [], prefixes: [] }), {
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    render(<S3Browser actor={{ sub: "user-1", username: "alex", email: null, role: "readwrite" }} buckets={["reports"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Browse reports" }));
    fireEvent.click(await screen.findByRole("button", { name: "Upload file" }));
    expect(screen.getByRole("heading", { name: "Upload object" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    expect(screen.getByRole("heading", { name: "Create folder" })).toBeInTheDocument();
  });

  it("loads the selected bucket into the operator index with a finder", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ objects: [], prefixes: [] }), {
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    render(<S3Browser actor={{ sub: "user-1", username: "alex", email: null, role: "readonly" }} buckets={["reports"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Browse reports" }));

    expect(await screen.findByRole("navigation", { name: "Current path" })).toBeInTheDocument();
    expect(screen.queryByText("Prefix:")).not.toBeInTheDocument();
    const operations = screen.getByRole("region", { name: "Object operations" });
    expect(operations).toContainElement(screen.getByRole("search", { name: "Find current prefix" }));
    expect(operations).toContainElement(screen.getByRole("textbox", { name: "Find objects" }));
  });

  it("shows a generic status message when listing fails in the browser", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    render(<S3Browser actor={{ sub: "user-1", username: "alex", email: null, role: "readonly" }} buckets={["reports"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Browse reports" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Could not load this bucket. Try again.");
  });
});
