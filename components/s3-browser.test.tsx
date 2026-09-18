import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { S3Browser } from "@/components/s3-browser";
import type { Actor } from "@/lib/auth/session";
import type { OperatorListing } from "@/lib/objects/operator-index";

const { signOut } = vi.hoisted(() => ({ signOut: vi.fn() }));

vi.mock("next-auth/react", () => ({ signOut }));

const listing: OperatorListing = {
  objects: [{ key: "photo.png", size: 2048 }, { key: "notes.txt", size: 4 }],
  prefixes: ["archive/"],
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function renderBrowserWithListing(role: Actor["role"] = "readonly", initialListing = listing) {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse(initialListing));
  vi.stubGlobal("fetch", fetchMock);
  render(<S3Browser actor={{ sub: "user-1", username: "alex", email: null, role }} buckets={["reports", "images"]} />);
  fireEvent.click(screen.getByRole("button", { name: "Browse reports" }));
  await screen.findByRole("link", { name: initialListing.objects[0].key });
  return fetchMock;
}

describe("S3Browser", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
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
    expect(operations).toContainElement(screen.getByRole("search", { name: "Search this bucket" }));
    expect(operations).toContainElement(screen.getByRole("textbox", { name: "Search this bucket" }));
  });

  it("shows a generic status message when listing fails in the browser", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    render(<S3Browser actor={{ sub: "user-1", username: "alex", email: null, role: "readonly" }} buckets={["reports"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Browse reports" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Could not load this bucket. Try again.");
  });

  it("selects visible folders and files, while keeping preview file-only", async () => {
    await renderBrowserWithListing();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select archive/" }));

    expect(screen.getByRole("complementary", { name: "Selected items" })).toHaveTextContent("1 selected");
    expect(screen.queryByRole("button", { name: "Preview selected file" })).not.toBeInTheDocument();

    const selectAll = screen.getByRole("checkbox", { name: "Select all visible items" });
    expect(selectAll).toBePartiallyChecked();
    fireEvent.click(selectAll);
    expect(screen.getByRole("complementary", { name: "Selected items" })).toHaveTextContent("3 selected");
    expect(selectAll).toBeChecked();
    fireEvent.click(selectAll);
    expect(screen.queryByRole("complementary", { name: "Selected items" })).not.toBeInTheDocument();
  });

  it("clears the selected items with the selection panel action", async () => {
    await renderBrowserWithListing();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select photo.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.getByRole("checkbox", { name: "Select photo.png" })).not.toBeChecked();
    expect(screen.queryByRole("button", { name: "Download selected as ZIP" })).not.toBeInTheDocument();
  });

  it.each(["archive/", "Refresh", "Browse images"])("clears selection when navigating with %s", async (action) => {
    const fetchMock = await renderBrowserWithListing();
    fetchMock.mockImplementationOnce(async () => jsonResponse({ objects: [], prefixes: [] }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select photo.png" }));
    fireEvent.click(screen.getByRole("button", { name: action }));
    expect(screen.queryByRole("complementary", { name: "Selected items" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Loading index")).not.toBeInTheDocument());
    if (action === "archive/") {
      expect(fetchMock).toHaveBeenLastCalledWith("/api/objects/reports?prefix=archive%2F", expect.anything());
    }
    expect(screen.queryByRole("button", { name: "Preview selected file" })).not.toBeInTheDocument();
  });

  it("previews a single supported image in a labelled dialog without changing selection on close", async () => {
    await renderBrowserWithListing();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select photo.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview selected file" }));
    const dialog = screen.getByRole("dialog", { name: "Preview photo.png" });
    expect(within(dialog).getByRole("img", { name: "Preview photo.png" })).toHaveAttribute("src", "/api/object-preview/reports/photo.png");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select photo.png" })).toBeChecked();
  });

  it("uses an encoded same-origin URL without a sandbox that blocks the browser PDF renderer", async () => {
    await renderBrowserWithListing("readonly", { objects: [{ key: "archive/report #1?.PDF", size: 4 }], prefixes: [] });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select report #1?.PDF" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview selected file" }));
    const dialog = screen.getByRole("dialog", { name: "Preview report #1?.PDF" });
    const frame = within(dialog).getByTitle("Preview report #1?.PDF");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame).not.toHaveAttribute("sandbox");
    expect(frame).toHaveAttribute("src", "/api/object-preview/reports/archive/report%20%231%3F.PDF");
  });

  it("supports keyboard selection and restores focus after closing preview with Escape", async () => {
    await renderBrowserWithListing();
    const user = userEvent.setup();
    screen.getByRole("checkbox", { name: "Select photo.png" }).focus();
    await user.keyboard(" ");
    const preview = screen.getByRole("button", { name: "Preview selected file" });
    preview.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Preview photo.png" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(preview).toHaveFocus();
  });

  it("does not offer preview for unsupported objects or multiple selected objects", async () => {
    await renderBrowserWithListing("readonly", { objects: [{ key: "unsafe.svg", size: 4 }, { key: "photo.png", size: 4 }], prefixes: [] });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select unsafe.svg" }));
    expect(screen.queryByRole("button", { name: "Preview selected file" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select photo.png" }));
    expect(screen.queryByRole("button", { name: "Preview selected file" })).not.toBeInTheDocument();
  });

  it("submits selected keys with a native POST form without fetching or buffering the ZIP", async () => {
    const fetchMock = await renderBrowserWithListing();
    const blob = vi.spyOn(Response.prototype, "blob");
    let submission: unknown;
    let downloadTarget: HTMLIFrameElement | undefined;
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (this: HTMLFormElement) {
      downloadTarget = [...document.querySelectorAll("iframe")].find((frame) => frame.name === this.target);
      submission = {
        connected: this.isConnected,
        method: this.method,
        action: this.action,
        encoding: this.enctype,
        fields: [...new FormData(this).entries()],
        inputType: this.querySelector('[name="keys"]')?.getAttribute("type")
      };
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all visible items" }));
    fireEvent.click(screen.getByRole("button", { name: "Download selected as ZIP" }));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(downloadTarget).toBeInTheDocument();
    expect(downloadTarget).toHaveAttribute("hidden");
    expect(submission).toEqual({
      connected: true,
      method: "post",
      action: `${window.location.origin}/api/selected-download/reports`,
      encoding: "application/x-www-form-urlencoded",
      fields: [["keys", '["archive/","notes.txt","photo.png"]']],
      inputType: "hidden"
    });
    expect(submit.mock.contexts[0]).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(blob).not.toHaveBeenCalled();
    expect(screen.getByRole("complementary", { name: "Selected items" })).toHaveTextContent("3 selected");
  });

  it("keeps the workspace and reports a native download HTTP error document in-app", async () => {
    const fetchMock = await renderBrowserWithListing();
    let downloadTarget: HTMLIFrameElement | undefined;
    let downloadUrl = "";
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (this: HTMLFormElement) {
      downloadTarget = [...document.querySelectorAll("iframe")].find((candidate) => candidate.name === this.target);
      downloadUrl = this.action;
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select photo.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Download selected as ZIP" }));

    expect(submit).toHaveBeenCalledTimes(1);
    expect(downloadTarget).toBeInTheDocument();
    const responseDocument = downloadTarget!.contentDocument!;
    Object.defineProperty(responseDocument, "URL", { configurable: true, value: downloadUrl });
    responseDocument.body.textContent = JSON.stringify({ error: "Private transport detail" });
    fireEvent.load(downloadTarget!);
    expect(screen.getByRole("status")).toHaveTextContent("Download could not be completed. Try again.");
    expect(screen.getByRole("status")).not.toHaveTextContent("Private");
    expect(screen.getByRole("textbox", { name: "Search this bucket" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select photo.png" })).toBeChecked();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not report the initial empty download frame as a failure", async () => {
    await renderBrowserWithListing();
    const frame = screen.getByTitle("Selected ZIP download");
    fireEvent.load(frame);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps selection and removes the temporary form if native submission fails", async () => {
    await renderBrowserWithListing();
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {
      throw new Error("Submission failed");
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select photo.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Download selected as ZIP" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Download could not be completed. Try again.");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.contexts[0]).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select photo.png" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Download selected as ZIP" })).toBeEnabled();
  });

  it("debounces bucket search for 300 ms and immediately clears selection on query change", async () => {
    const fetchMock = await renderBrowserWithListing();
    fetchMock.mockResolvedValueOnce(jsonResponse({ objects: [], truncated: false }));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select photo.png" }));
    const search = screen.getByRole("textbox", { name: "Search this bucket" });
    fireEvent.change(search, { target: { value: "rep" } });
    expect(screen.queryByRole("complementary", { name: "Selected items" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "photo.png" })).not.toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(200); });
    fireEvent.change(search, { target: { value: " report " } });
    await act(async () => { vi.advanceTimersByTime(299); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/objects/reports?search=report", expect.anything());
    expect(screen.getByText("No folders or objects match this view.")).toBeInTheDocument();
  });

  it("searches the whole selected bucket and navigates to a result's containing path", async () => {
    const fetchMock = await renderBrowserWithListing();
    fetchMock.mockResolvedValueOnce(jsonResponse({ objects: [{ key: "archive/2026/report.pdf", size: 4 }], truncated: true }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search this bucket" }), { target: { value: "report" } });
    const openPath = await screen.findByRole("button", { name: "Open archive/2026/" });
    expect(screen.getByText("Results are partial. Refine your search.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "photo.png" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all visible items" }));
    expect(screen.getByRole("complementary", { name: "Selected items" })).toHaveTextContent("1 selected");
    fetchMock.mockResolvedValueOnce(jsonResponse({ objects: [{ key: "archive/2026/report.pdf", size: 4 }], prefixes: [] }));
    fireEvent.click(openPath);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/objects/reports?prefix=archive%2F2026%2F", expect.anything());
    expect(screen.getByRole("textbox", { name: "Search this bucket" })).toHaveValue("");
    expect(screen.queryByRole("complementary", { name: "Selected items" })).not.toBeInTheDocument();
    expect(screen.queryByText("Results are partial. Refine your search.")).not.toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "report.pdf" })).toBeInTheDocument();
  });

  it("restores the prefix listing without stale selection after clearing a search", async () => {
    const fetchMock = await renderBrowserWithListing();
    fetchMock.mockResolvedValueOnce(jsonResponse({ objects: [{ key: "archive/report.pdf", size: 4 }], truncated: false }));
    const search = screen.getByRole("textbox", { name: "Search this bucket" });
    fireEvent.change(search, { target: { value: "report" } });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select report.pdf" }));
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByRole("link", { name: "photo.png" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Selected items" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Preview selected file" })).not.toBeInTheDocument();
  });

  it("ignores a delayed search response after navigating to another bucket", async () => {
    const fetchMock = await renderBrowserWithListing();
    let resolveSearch!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveSearch = resolve; }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search this bucket" }), { target: { value: "report" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fetchMock.mockResolvedValueOnce(jsonResponse({ objects: [{ key: "new.png", size: 4 }], prefixes: [] }));
    fireEvent.click(screen.getByRole("button", { name: "Browse images" }));
    await screen.findByRole("link", { name: "new.png" });
    await act(async () => { resolveSearch(jsonResponse({ objects: [{ key: "old.pdf", size: 4 }], truncated: true })); });
    expect(screen.getByRole("link", { name: "new.png" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "old.pdf" })).not.toBeInTheDocument();
    expect(screen.queryByText("Results are partial. Refine your search.")).not.toBeInTheDocument();
  });

  it("shows search failure without displaying the normal listing as search results", async () => {
    const fetchMock = await renderBrowserWithListing();
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fireEvent.change(screen.getByRole("textbox", { name: "Search this bucket" }), { target: { value: "report" } });
    expect(await screen.findByRole("status")).toHaveTextContent("Could not search this bucket. Try again.");
    expect(screen.queryByRole("link", { name: "photo.png" })).not.toBeInTheDocument();
  });

  it.each(["readonly", "readwrite"] as const)("hides row deletion for %s actors", async (role) => {
    await renderBrowserWithListing(role);
    expect(screen.queryByRole("button", { name: /^Delete/ })).not.toBeInTheDocument();
  });

  it("confirms an admin row deletion with the exact key and has no global delete action", async () => {
    const fetchMock = await renderBrowserWithListing("admin", { objects: [{ key: "archive/photo.png", size: 4 }], prefixes: [] });
    const row = screen.getByRole("link", { name: "archive/photo.png" }).closest("tr")!;
    fireEvent.click(screen.getByRole("checkbox", { name: "Select photo.png" }));
    expect(within(screen.getByRole("complementary", { name: "Selected items" })).queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete object" })).not.toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Delete photo.png" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete object" });
    const confirm = within(dialog).getByRole("button", { name: "Delete object" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Exact object key confirmation" }), { target: { value: "photo.png" } });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Exact object key confirmation" }), { target: { value: "archive/photo.png" } });
    expect(confirm).toBeEnabled();
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ objects: [], prefixes: [] }));
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("link", { name: "archive/photo.png" })).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith("/api/objects/reports/archive/photo.png", { method: "DELETE", headers: { "x-s3-confirm-key": "archive/photo.png" } });
    expect(screen.queryByRole("complementary", { name: "Selected items" })).not.toBeInTheDocument();
  });
});
