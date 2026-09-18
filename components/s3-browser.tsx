"use client";

import { FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { signOut } from "next-auth/react";

import { Badge } from "@/components/ui/badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArchiveIcon, BucketIcon, ChevronLeftIcon, DownloadIcon, EyeIcon, FolderIcon, RefreshIcon, SearchIcon, SignOutIcon, TrashIcon, UploadIcon } from "@/components/ui-icons";
import type { Actor } from "@/lib/auth/session";
import { containingPrefix, filterAndSortListing, isPreviewableKey, parentPrefix, prefixSegments, type OperatorListing, type OperatorSearchResult } from "@/lib/objects/operator-index";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatDate(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(date);
}

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : fallback;
  } catch {
    return fallback;
  }
}

const roleStyles = {
  readonly: "border-[#c9e5f3] bg-[#e9f6fc] text-[#236486]",
  readwrite: "border-[#d3e5d0] bg-[#edf6eb] text-[#356535]",
  admin: "border-[#f0dfae] bg-[#fdf6df] text-[#8a6408]",
} as const;

export function S3Browser({ actor, buckets }: Readonly<{ actor: Actor; buckets: readonly string[] }>) {
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null);
  const [listing, setListing] = useState<OperatorListing | null>(null);
  const [status, setStatus] = useState("");
  const [prefix, setPrefix] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResult, setSearchResult] = useState<OperatorSearchResult | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<readonly string[]>([]);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [deleteKey, setDeleteKey] = useState<string | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const listingRequest = useRef<AbortController | null>(null);
  const previewButton = useRef<HTMLButtonElement | null>(null);
  const downloadFrameName = `selected-download-${useId()}`;

  const canWrite = actor.role === "readwrite" || actor.role === "admin";
  const hasSearch = searchQuery.trim().length > 0;
  const visibleListing = useMemo(() => {
    if (hasSearch) return searchResult && { objects: searchResult.objects, prefixes: [] };
    return listing && filterAndSortListing(listing, "");
  }, [listing, hasSearch, searchResult]);
  const visibleKeys = visibleListing
    ? [...visibleListing.prefixes, ...visibleListing.objects.map((object) => object.key)]
    : [];
  const allSelected = visibleKeys.length > 0 && visibleKeys.every((key) => selectedKeys.includes(key));
  const someSelected = visibleKeys.some((key) => selectedKeys.includes(key));
  const selectedObject = selectedKeys.length === 1 ? visibleListing?.objects.find((object) => object.key === selectedKeys[0]) : undefined;
  const crumbs = prefixSegments(prefix);
  const shownItemCount = visibleListing ? visibleListing.prefixes.length + visibleListing.objects.length : 0;
  const previewFilename = previewKey?.split("/").at(-1) ?? "";
  const previewUrl = selectedBucket && previewKey && isPreviewableKey(previewKey)
    ? `/api/object-preview/${encodeURIComponent(selectedBucket)}/${previewKey.split("/").map(encodeURIComponent).join("/")}`
    : null;

  useEffect(() => () => listingRequest.current?.abort(), []);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!selectedBucket || !query) return;
    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      try {
        const response = await fetch(`/api/objects/${encodeURIComponent(selectedBucket)}?search=${encodeURIComponent(query)}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          if (!controller.signal.aborted) setStatus("Could not search this bucket. Try again.");
          return;
        }
        const result = (await response.json()) as OperatorSearchResult;
        if (!controller.signal.aborted) setSearchResult(result);
      } catch {
        if (!controller.signal.aborted) setStatus("Could not search this bucket. Try again.");
      } finally {
        if (!controller.signal.aborted) setIsSearching(false);
      }
    }, 300);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [selectedBucket, searchQuery]);

  function changeSearchQuery(value: string) {
    setSearchQuery(value);
    setSearchResult(null);
    setSelectedKeys([]);
    setPreviewKey(null);
    setStatus("");
    setIsSearching(value.trim().length > 0);
  }

  async function browse(bucket: string, nextPrefix = "") {
    listingRequest.current?.abort();
    const controller = new AbortController();
    listingRequest.current = controller;
    setSelectedBucket(bucket);
    setPrefix(nextPrefix);
    changeSearchQuery("");
    setListing(null);
    setIsLoading(true);

    try {
      const response = await fetch(`/api/objects/${encodeURIComponent(bucket)}?prefix=${encodeURIComponent(nextPrefix)}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) {
        if (!controller.signal.aborted) setStatus("Not found or not permitted");
        return;
      }
      const result = (await response.json()) as OperatorListing;
      if (!controller.signal.aborted) setListing(result);
    } catch {
      if (!controller.signal.aborted) setStatus("Could not load this bucket. Try again.");
    } finally {
      if (!controller.signal.aborted) setIsLoading(false);
    }
  }

  function downloadSelected() {
    if (!selectedBucket || selectedKeys.length === 0) return;
    setStatus("");
    const form = document.createElement("form");
    form.method = "post";
    form.action = `/api/selected-download/${encodeURIComponent(selectedBucket)}`;
    form.target = downloadFrameName;
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "keys";
    input.value = JSON.stringify(selectedKeys);
    form.append(input);
    document.body.append(form);
    try {
      form.submit();
    } catch {
      setStatus("Download could not be completed. Try again.");
    } finally {
      form.remove();
    }
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedBucket) return;
    const form = new FormData(event.currentTarget);
    const file = form.get("file");
    if (!(file instanceof File)) return;
    if (file.size > 500 * 1024 * 1024) {
      setStatus("Files larger than 500 MiB cannot be uploaded.");
      return;
    }
    const requestedName = String(form.get("objectName") ?? "").trim();
    form.set("key", `${prefix}${requestedName || file.name}`);
    form.set("action", "upload");
    form.set("overwrite", form.get("overwrite") === "on" ? "true" : "false");

    try {
      const response = await fetch(`/api/objects/${encodeURIComponent(selectedBucket)}`, { body: form, method: "POST" });
      setStatus(response.ok ? "Upload completed." : await responseError(response, "Upload failed."));
      if (response.ok) {
        setUploadOpen(false);
        await browse(selectedBucket, prefix);
      }
    } catch {
      setStatus("Upload could not be completed. Try again.");
    }
  }

  async function createFolder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedBucket) return;
    const form = new FormData(event.currentTarget);
    form.set("action", "create-prefix");
    form.set("prefix", `${prefix}${String(form.get("folderName") ?? "")}`);

    try {
      const response = await fetch(`/api/objects/${encodeURIComponent(selectedBucket)}`, { body: form, method: "POST" });
      setStatus(response.ok ? "Folder created." : await responseError(response, "Folder creation failed."));
      if (response.ok) {
        setFolderOpen(false);
        await browse(selectedBucket, prefix);
      }
    } catch {
      setStatus("Folder could not be created. Try again.");
    }
  }

  async function deleteObject() {
    if (!selectedBucket || !deleteKey || deleteConfirmation !== deleteKey) return;
    try {
      const response = await fetch(`/api/objects/${encodeURIComponent(selectedBucket)}/${deleteKey.split("/").map(encodeURIComponent).join("/")}`, {
        headers: { "x-s3-confirm-key": deleteKey },
        method: "DELETE",
      });
      setStatus(response.ok ? "Object deleted." : await responseError(response, "Delete failed."));
      if (response.ok) await browse(selectedBucket, prefix);
    } catch {
      setStatus("Object could not be deleted. Try again.");
    } finally {
      setDeleteKey(null);
      setDeleteConfirmation("");
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-7xl px-4 py-6 md:px-8 md:py-10">
      <iframe
        hidden
        name={downloadFrameName}
        onLoad={(event) => {
          // Attachments leave the empty frame in place; an HTTP error loads a document.
          if (event.currentTarget.contentDocument?.URL !== "about:blank") {
            setStatus("Download could not be completed. Try again.");
          }
        }}
        title="Selected ZIP download"
      />
      <header className="flex flex-col gap-5 border-b border-[#eaeaea] pb-6 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="font-metadata text-xs uppercase tracking-[0.18em] text-muted-foreground">Internal storage</p>
          <h1 className="font-editorial mt-2 text-4xl leading-none tracking-tight sm:text-5xl">Operator index</h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-right text-xs text-muted-foreground">{actor.username}</span>
          <Badge className={roleStyles[actor.role]} variant="outline">{actor.role}</Badge>
          <Button onClick={() => signOut({ callbackUrl: "/sign-in" })} size="sm" variant="ghost"><SignOutIcon className="size-3.5" />Sign out</Button>
        </div>
      </header>

      <section className="mt-6 grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="border border-[#eaeaea] bg-white p-3" aria-label="Approved buckets">
          <div className="mb-3 px-2 pt-1">
            <p className="font-metadata text-xs uppercase tracking-[0.16em] text-muted-foreground">Buckets</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Approved for this deployment</p>
          </div>
          <nav className="flex gap-1 overflow-x-auto lg:flex-col" aria-label="Approved buckets">
            {buckets.map((bucket) => {
              const selected = selectedBucket === bucket;
              return (
                <Button
                  aria-current={selected ? "page" : undefined}
                  aria-label={`Browse ${bucket}`}
                  className="min-w-fit justify-start"
                  key={bucket}
                  onClick={() => browse(bucket)}
                  variant={selected ? "secondary" : "ghost"}
                >
                  <BucketIcon className="size-4" />
                  <span className="truncate">{bucket}</span>
                </Button>
              );
            })}
          </nav>
        </aside>

        <section className="min-w-0 border border-[#eaeaea] bg-white" aria-label="Object browser">
          {!selectedBucket ? (
            <div className="flex min-h-80 flex-col justify-end p-6 sm:p-8">
              <p className="font-metadata text-xs uppercase tracking-[0.18em] text-muted-foreground">Ready to browse</p>
              <h2 className="font-editorial mt-3 text-3xl tracking-tight">Select an approved bucket.</h2>
              <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">Choose a bucket from the index to inspect its folders and objects.</p>
            </div>
          ) : (
            <>
              <div className="border-b border-[#eaeaea] px-5 py-5 sm:px-6">
                <div className="min-w-0">
                  <p className="font-metadata text-xs uppercase tracking-[0.16em] text-muted-foreground">Current bucket</p>
                  <h2 className="mt-1 truncate text-xl font-semibold tracking-tight">{selectedBucket}</h2>
                  <nav aria-label="Current path" className="mt-3 flex min-w-0 items-center gap-1 overflow-x-auto font-metadata text-xs">
                      <button aria-current={crumbs.length === 0 ? "page" : undefined} className={`shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 ${crumbs.length === 0 ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`} onClick={() => browse(selectedBucket)} type="button">Root</button>
                      {crumbs.map((crumb, index) => {
                        const crumbPrefix = `${crumbs.slice(0, index + 1).join("/")}/`;
                        const isCurrent = index === crumbs.length - 1;
                        return (
                          <span className="flex min-w-0 shrink-0 items-center gap-1.5" key={crumbPrefix}>
                            <span aria-hidden="true" className="text-[#c4c3bf]">/</span>
                            <button aria-current={isCurrent ? "page" : undefined} className={`max-w-40 truncate transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 ${isCurrent ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`} onClick={() => browse(selectedBucket, crumbPrefix)} type="button">{crumb}</button>
                          </span>
                        );
                      })}
                  </nav>
                </div>
              </div>

              <div className="flex flex-col gap-5 p-5 sm:p-6">
                <section aria-label="Object operations" className="flex flex-col gap-3 border-b border-[#eaeaea] pb-5 lg:flex-row lg:items-center lg:justify-between">
                  <form aria-label="Search this bucket" className="w-full lg:max-w-xs" onSubmit={(event) => event.preventDefault()} role="search">
                    <label className="sr-only" htmlFor="object-finder">Search this bucket</label>
                    <div className="relative rounded-md border border-[#eaeaea] transition-colors focus-within:border-foreground">
                      <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input className="h-8 border-0 bg-transparent pl-9 pr-2 focus-visible:ring-0" id="object-finder" onChange={(event) => changeSearchQuery(event.target.value)} placeholder="Search this bucket" value={searchQuery} />
                    </div>
                  </form>
                  {canWrite && (
                    <div className="flex flex-wrap gap-2">
                      <Dialog onOpenChange={setUploadOpen} open={uploadOpen}>
                        <DialogTrigger asChild><Button><UploadIcon className="size-4" />Upload file</Button></DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>Upload object</DialogTitle>
                            <DialogDescription>Choose a file to place under <span className="font-metadata text-xs text-foreground">/{prefix}</span>.</DialogDescription>
                          </DialogHeader>
                          <form className="grid gap-4" onSubmit={upload}>
                            <div>
                              <label className="font-metadata mb-1.5 block text-xs uppercase tracking-[0.14em] text-muted-foreground" htmlFor="upload-file">File</label>
                              <Input id="upload-file" aria-label="Upload file" name="file" required type="file" />
                            </div>
                            <div>
                              <label className="font-metadata mb-1.5 block text-xs uppercase tracking-[0.14em] text-muted-foreground" htmlFor="object-name">Object name</label>
                              <Input id="object-name" aria-label="Object name" name="objectName" placeholder="Optional object name" />
                              <p className="mt-1.5 text-xs leading-5 text-muted-foreground">Leave blank to keep the selected file name. Maximum size: 500 MiB.</p>
                            </div>
                            <label className="text-xs leading-5 text-muted-foreground"><input className="mr-2" name="overwrite" type="checkbox" />I confirm replacement if this object already exists</label>
                            <DialogFooter>
                              <DialogClose asChild><Button type="button" variant="outline">Cancel</Button></DialogClose>
                              <Button type="submit"><UploadIcon className="size-4" />Upload file</Button>
                            </DialogFooter>
                          </form>
                        </DialogContent>
                      </Dialog>
                      <Dialog onOpenChange={setFolderOpen} open={folderOpen}>
                        <DialogTrigger asChild><Button variant="outline"><FolderIcon className="size-4" />Create folder</Button></DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>Create folder</DialogTitle>
                            <DialogDescription>Create a prefix marker under <span className="font-metadata text-xs text-foreground">/{prefix}</span>.</DialogDescription>
                          </DialogHeader>
                          <form className="grid gap-4" onSubmit={createFolder}>
                            <div>
                              <label className="font-metadata mb-1.5 block text-xs uppercase tracking-[0.14em] text-muted-foreground" htmlFor="folder-name">Folder name</label>
                              <Input id="folder-name" aria-label="Folder name" name="folderName" placeholder="For example, 2026-reports" required />
                            </div>
                            <DialogFooter>
                              <DialogClose asChild><Button type="button" variant="outline">Cancel</Button></DialogClose>
                              <Button type="submit" variant="default"><FolderIcon className="size-4" />Create folder</Button>
                            </DialogFooter>
                          </form>
                        </DialogContent>
                      </Dialog>
                    </div>
                  )}
                </section>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="font-metadata text-xs uppercase tracking-[0.14em] text-muted-foreground">
                    {hasSearch && isSearching ? "Searching bucket" : isLoading ? "Loading index" : `${shownItemCount} ${shownItemCount === 1 ? "item" : "items"}`}
                  </p>
                  <div className="flex items-center gap-2">
                    {prefix && <Button onClick={() => browse(selectedBucket, parentPrefix(prefix))} size="sm" variant="ghost"><ChevronLeftIcon className="size-3.5" />Parent</Button>}
                    <Button disabled={isLoading} onClick={() => browse(selectedBucket, prefix)} size="sm" variant="outline"><RefreshIcon className="size-3.5" />Refresh</Button>
                    <a className="inline-flex h-7 items-center gap-1 border border-[#eaeaea] px-2.5 text-[0.8rem] font-medium hover:bg-muted" href={`/api/prefix-download/${encodeURIComponent(selectedBucket)}?prefix=${encodeURIComponent(prefix)}`}><ArchiveIcon className="size-3.5" />Download ZIP</a>
                  </div>
                </div>

                {status && <p className="text-sm text-muted-foreground" role="status">{status}</p>}
                {hasSearch && searchResult?.truncated && <p className="text-sm text-muted-foreground" role="status">Results are partial. Refine your search.</p>}

                {visibleListing && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">
                          <input
                            aria-label="Select all visible items"
                            checked={allSelected}
                            className="size-4 cursor-pointer accent-foreground"
                            disabled={visibleKeys.length === 0}
                            onChange={() => setSelectedKeys(allSelected ? [] : visibleKeys)}
                            ref={(input) => { if (input) input.indeterminate = someSelected && !allSelected; }}
                            type="checkbox"
                          />
                        </TableHead>
                        <TableHead>Name</TableHead>
                        {hasSearch && <TableHead>Path</TableHead>}
                        <TableHead>Type</TableHead>
                        <TableHead>Size</TableHead>
                        <TableHead>Modified</TableHead>
                        {actor.role === "admin" && <TableHead>Actions</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleListing.prefixes.map((item) => (
                        <TableRow key={item}>
                          <TableCell>
                            <input
                              aria-label={`Select ${item}`}
                              checked={selectedKeys.includes(item)}
                              className="size-4 cursor-pointer accent-foreground"
                              onChange={(event) => setSelectedKeys((keys) => event.target.checked ? [...keys, item] : keys.filter((key) => key !== item))}
                              type="checkbox"
                            />
                          </TableCell>
                          <TableCell><Button className="h-auto p-0 font-normal" onClick={() => browse(selectedBucket, item)} variant="link"><FolderIcon className="size-3.5" />{item.slice(prefix.length)}</Button></TableCell>
                          <TableCell className="text-muted-foreground">Folder</TableCell>
                          <TableCell className="text-muted-foreground">—</TableCell>
                          <TableCell className="text-muted-foreground">—</TableCell>
                          {actor.role === "admin" && <TableCell>—</TableCell>}
                        </TableRow>
                      ))}
                      {visibleListing.objects.map((object) => {
                        const filename = object.key.split("/").at(-1) ?? object.key;
                        const objectPrefix = containingPrefix(object.key);
                        return (
                          <TableRow data-state={selectedKeys.includes(object.key) ? "selected" : undefined} key={object.key}>
                            <TableCell>
                              <input
                                aria-label={`Select ${filename}`}
                                checked={selectedKeys.includes(object.key)}
                                className="size-4 cursor-pointer accent-foreground"
                                onChange={(event) => setSelectedKeys((keys) => event.target.checked ? [...keys, object.key] : keys.filter((key) => key !== object.key))}
                                type="checkbox"
                              />
                            </TableCell>
                            <TableCell><a className="text-foreground underline-offset-4 hover:underline" href={`/api/objects/${encodeURIComponent(selectedBucket)}/${object.key.split("/").map(encodeURIComponent).join("/")}`}>{hasSearch ? filename : object.key.slice(prefix.length)}</a></TableCell>
                            {hasSearch && <TableCell><Button aria-label={`Open ${objectPrefix || "Root"}`} className="h-auto p-0 font-metadata text-xs font-normal" onClick={() => browse(selectedBucket, objectPrefix)} variant="link">{objectPrefix || "Root"}</Button></TableCell>}
                            <TableCell className="text-muted-foreground">Object</TableCell>
                            <TableCell className="font-metadata text-xs text-muted-foreground">{formatBytes(object.size)}</TableCell>
                            <TableCell className="font-metadata text-xs text-muted-foreground">{formatDate(object.lastModified)}</TableCell>
                            {actor.role === "admin" && <TableCell><Button aria-label={`Delete ${filename}`} onClick={() => { setDeleteConfirmation(""); setDeleteKey(object.key); }} size="sm" variant="destructive"><TrashIcon className="size-3.5" />Delete</Button></TableCell>}
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
                {selectedKeys.length > 0 && (
                  <aside aria-label="Selected items" className="flex flex-col gap-3 border border-[#eaeaea] bg-muted/40 p-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                    <p className="text-sm font-medium" aria-live="polite">{selectedKeys.length} selected</p>
                    <div className="flex flex-wrap gap-2">
                      <Button onClick={downloadSelected}><DownloadIcon className="size-4" />Download selected as ZIP</Button>
                      {selectedObject && isPreviewableKey(selectedObject.key) && <Button aria-haspopup="dialog" aria-label="Preview selected file" onClick={() => setPreviewKey(selectedObject.key)} ref={previewButton} variant="outline"><EyeIcon className="size-4" />Preview</Button>}
                      <Button onClick={() => setSelectedKeys([])} variant="ghost">Clear selection</Button>
                    </div>
                  </aside>
                )}
                {!isLoading && !isSearching && visibleListing && shownItemCount === 0 && <p className="py-8 text-center text-sm text-muted-foreground">No folders or objects match this view.</p>}
              </div>
            </>
          )}
        </section>
      </section>

      <Dialog open={previewKey !== null} onOpenChange={(open) => !open && setPreviewKey(null)}>
        <DialogContent className="sm:max-w-4xl" onCloseAutoFocus={(event) => { event.preventDefault(); previewButton.current?.focus(); }}>
          <DialogHeader>
            <DialogTitle>Preview {previewFilename}</DialogTitle>
            <DialogDescription>Preview of the selected object.</DialogDescription>
          </DialogHeader>
          {previewUrl && (previewKey?.toLocaleLowerCase().endsWith(".pdf") ? (
            <iframe className="h-[70vh] w-full" src={previewUrl} title={`Preview ${previewFilename}`} />
          ) : (
            // The authenticated preview route streams the original image without Next.js optimization.
            // eslint-disable-next-line @next/next/no-img-element
            <img alt={`Preview ${previewFilename}`} className="max-h-[70vh] w-full object-contain" src={previewUrl} />
          ))}
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteKey !== null} onOpenChange={(open) => !open && setDeleteKey(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete object</AlertDialogTitle>
            <AlertDialogDescription>Type the exact object key to permanently delete it: {deleteKey}</AlertDialogDescription>
          </AlertDialogHeader>
          <Input aria-label="Exact object key confirmation" onChange={(event) => setDeleteConfirmation(event.target.value)} value={deleteConfirmation} />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={deleteConfirmation !== deleteKey} onClick={deleteObject} variant="destructive">Delete object</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
