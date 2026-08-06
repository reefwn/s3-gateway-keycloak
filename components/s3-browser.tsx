"use client";

import { FolderPlusIcon, RefreshCwIcon, UploadIcon } from "lucide-react";
import { FormEvent, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Actor } from "@/lib/auth/session";

type Listing = Readonly<{
  objects: readonly { key: string; size: number; lastModified?: string }[];
  prefixes: readonly string[];
}>;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function S3Browser({ actor, buckets }: Readonly<{ actor: Actor; buckets: readonly string[] }>) {
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [status, setStatus] = useState<string>("");
  const [prefix, setPrefix] = useState("");
  const [deleteKey, setDeleteKey] = useState<string | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");

  const canWrite = actor.role === "readwrite" || actor.role === "admin";

  async function browse(bucket: string, nextPrefix = "") {
    setStatus("");
    const response = await fetch(`/api/objects/${encodeURIComponent(bucket)}?prefix=${encodeURIComponent(nextPrefix)}`, { cache: "no-store" });
    if (!response.ok) {
      setStatus("Not found or not permitted");
      return;
    }
    setSelectedBucket(bucket);
    setPrefix(nextPrefix);
    setListing(await response.json());
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
    const response = await fetch(`/api/objects/${encodeURIComponent(selectedBucket)}`, { method: "POST", body: form });
    setStatus(response.ok ? "Upload completed." : (await response.json()).error ?? "Upload failed.");
    if (response.ok) await browse(selectedBucket, prefix);
  }

  async function createFolder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedBucket) return;
    const form = new FormData(event.currentTarget);
    form.set("action", "create-prefix");
    form.set("prefix", `${prefix}${String(form.get("folderName") ?? "")}`);
    const response = await fetch(`/api/objects/${encodeURIComponent(selectedBucket)}`, { method: "POST", body: form });
    setStatus(response.ok ? "Folder created." : (await response.json()).error ?? "Folder creation failed.");
    if (response.ok) await browse(selectedBucket, prefix);
  }

  async function deleteObject() {
    if (!selectedBucket || !deleteKey || deleteConfirmation !== deleteKey) return;
    const response = await fetch(`/api/objects/${encodeURIComponent(selectedBucket)}/${deleteKey.split("/").map(encodeURIComponent).join("/")}`, {
      method: "DELETE",
      headers: { "x-s3-confirm-key": deleteKey }
    });
    setStatus(response.ok ? "Object deleted." : (await response.json()).error ?? "Delete failed.");
    setDeleteKey(null);
    setDeleteConfirmation("");
    if (response.ok) await browse(selectedBucket, prefix);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-6 md:p-10">
      <header className="flex flex-col gap-3 border-b pb-6 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">Internal storage operations</p>
          <h1 className="text-2xl font-semibold tracking-tight">S3 Browser</h1>
        </div>
        <Badge variant="secondary">{actor.role}</Badge>
      </header>

      <section className="grid gap-6 lg:grid-cols-[16rem_1fr]">
        <Card size="sm">
          <CardHeader>
            <CardTitle>Buckets</CardTitle>
            <CardDescription>Approved for this deployment</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {buckets.map((bucket) => (
              <Button key={bucket} aria-label={`Browse ${bucket}`} variant={selectedBucket === bucket ? "secondary" : "ghost"} className="justify-start" onClick={() => browse(bucket)}>
                <span className="truncate">{bucket}</span>
              </Button>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{selectedBucket ?? "Choose a bucket"}</CardTitle>
            <CardDescription>{selectedBucket ? `Prefix: /${prefix}` : "Select a bucket to list objects."}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {canWrite && (
              <div className="grid gap-4 md:grid-cols-2">
                <form className="flex flex-col gap-2" onSubmit={upload}>
                  <div className="flex flex-wrap items-end gap-2">
                    <Input aria-label="Upload file" name="file" type="file" required disabled={!selectedBucket} />
                    <Input aria-label="Object name" name="objectName" placeholder="Optional object name" disabled={!selectedBucket} />
                    <Button type="submit" disabled={!selectedBucket}><UploadIcon data-icon="inline-start" />Upload file</Button>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-muted-foreground"><input name="overwrite" type="checkbox" disabled={!selectedBucket} /> I confirm replacement if this object already exists</label>
                </form>
                <form className="flex items-end gap-2" onSubmit={createFolder}>
                  <Input aria-label="Folder name" name="folderName" placeholder="Folder name" required disabled={!selectedBucket} />
                  <Button type="submit" variant="outline" disabled={!selectedBucket}><FolderPlusIcon data-icon="inline-start" />Create folder</Button>
                </form>
              </div>
            )}
            {status && <p className="text-sm text-muted-foreground" role="status">{status}</p>}
            {listing && (
              <Table>
                <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Type</TableHead><TableHead>Size</TableHead>{actor.role === "admin" && <TableHead>Actions</TableHead>}</TableRow></TableHeader>
                <TableBody>
                  {listing.prefixes.map((item) => <TableRow key={item}><TableCell><Button variant="link" className="h-auto p-0" onClick={() => browse(selectedBucket!, item)}>{item.slice(prefix.length)}</Button></TableCell><TableCell>Folder</TableCell><TableCell>—</TableCell>{actor.role === "admin" && <TableCell>—</TableCell>}</TableRow>)}
                  {listing.objects.map((object) => <TableRow key={object.key}><TableCell><a className="text-primary underline-offset-4 hover:underline" href={`/api/objects/${encodeURIComponent(selectedBucket!)}/${object.key.split("/").map(encodeURIComponent).join("/")}`}>{object.key.slice(prefix.length)}</a></TableCell><TableCell>Object</TableCell><TableCell>{formatBytes(object.size)}</TableCell>{actor.role === "admin" && <TableCell><Button variant="destructive" size="sm" onClick={() => setDeleteKey(object.key)}>Delete object</Button></TableCell>}</TableRow>)}
                </TableBody>
              </Table>
            )}
            {selectedBucket && <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => browse(selectedBucket, prefix)}><RefreshCwIcon data-icon="inline-start" />Refresh list</Button><a className="inline-flex h-8 items-center rounded-lg border border-border px-2.5 text-sm font-medium hover:bg-muted" href={`/api/prefix-download/${encodeURIComponent(selectedBucket)}?prefix=${encodeURIComponent(prefix)}`}>Download this prefix as ZIP</a></div>}
          </CardContent>
        </Card>
      </section>
      <AlertDialog open={deleteKey !== null} onOpenChange={(open) => !open && setDeleteKey(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete object</AlertDialogTitle>
            <AlertDialogDescription>Type the exact object key to permanently delete it: {deleteKey}</AlertDialogDescription>
          </AlertDialogHeader>
          <Input aria-label="Exact object key confirmation" value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={deleteConfirmation !== deleteKey} onClick={deleteObject}>Delete object</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
