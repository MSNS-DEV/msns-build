"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useSession } from "next-auth/react";
import {
  FileText,
  UploadCloud,
  Download,
  ExternalLink,
  Trash2,
  Search,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Filter,
  FileSpreadsheet,
  FileCode,
  FileCheck,
  ShieldCheck,
  RefreshCw,
  FolderOpen,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Badge } from "~/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";

export interface DocumentItem {
  key: string;
  filename: string;
  title: string;
  category: string;
  size: number;
  lastModified: string;
  uploadedBy: string;
  uploadedAt: string;
  url: string;
}

const UPLOAD_ROLES = ["ADMIN", "PRINCIPAL", "HEAD", "CLERK", "TEACHER"];
const DELETE_ROLES = ["ADMIN", "PRINCIPAL", "HEAD", "CLERK"];

const CATEGORIES = [
  "All",
  "Official",
  "Academic",
  "Examination",
  "Policy",
  "Admissions",
  "General",
] as const;

export function DocumentsManager() {
  const { data: session } = useSession();
  const userRole = (session?.user?.accountType ?? "").toUpperCase();

  const canUpload = UPLOAD_ROLES.includes(userRole);
  const canDelete = DELETE_ROLES.includes(userRole);

  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("All");

  // Upload state
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadCategory, setUploadCategory] = useState("Academic");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  // Deleting state
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const fetchDocuments = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/documents");
      if (!res.ok) throw new Error("Failed to fetch documents");
      const data = (await res.json()) as { documents: DocumentItem[] };
      setDocuments(data.documents || []);
    } catch (err: unknown) {
      console.error(err);
      toast.error("Failed to load documents from Cloudflare bucket");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchDocuments();
  }, [fetchDocuments]);

  // Filtered documents
  const filteredDocuments = useMemo(() => {
    return documents.filter((doc) => {
      // Category filter
      if (
        selectedCategory !== "All" &&
        doc.category.toLowerCase() !== selectedCategory.toLowerCase()
      ) {
        return false;
      }

      // Search query filter
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchTitle = doc.title.toLowerCase().includes(q);
        const matchName = doc.filename.toLowerCase().includes(q);
        const matchCategory = doc.category.toLowerCase().includes(q);
        return matchTitle || matchName || matchCategory;
      }

      return true;
    });
  }, [documents, selectedCategory, searchQuery]);

  // Handle File Upload
  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) {
      toast.error("Please select a file to upload");
      return;
    }

    try {
      setIsUploading(true);
      setUploadProgress(20);

      const formData = new FormData();
      formData.append("file", selectedFile);
      formData.append("title", uploadTitle || selectedFile.name);
      formData.append("category", uploadCategory);

      setUploadProgress(50);
      const res = await fetch("/api/documents", {
        method: "POST",
        body: formData,
      });

      setUploadProgress(85);
      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
        document?: DocumentItem;
      };

      if (!res.ok || data.error) {
        throw new Error(data.error ?? "Upload failed");
      }

      setUploadProgress(100);
      toast.success("Document uploaded successfully to Cloudflare R2!");

      // Reset upload form
      setSelectedFile(null);
      setUploadTitle("");
      setUploadCategory("Academic");

      // Refresh list
      await fetchDocuments();
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : "Error uploading document";
      toast.error(msg);
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
    }
  };

  // Handle Document Delete
  const handleDelete = async (key: string, title: string) => {
    if (
      !window.confirm(
        `Are you sure you want to delete "${title}"? This cannot be undone.`,
      )
    ) {
      return;
    }

    try {
      setDeletingKey(key);
      const res = await fetch(`/api/documents?key=${encodeURIComponent(key)}`, {
        method: "DELETE",
      });

      const data = (await res.json()) as { success?: boolean; error?: string };

      if (!res.ok || data.error) {
        throw new Error(data.error ?? "Delete failed");
      }

      toast.success("Document deleted successfully");
      setDocuments((prev) => prev.filter((d) => d.key !== key));
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : "Failed to delete document";
      toast.error(msg);
    } finally {
      setDeletingKey(null);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const getCategoryBadgeClass = (cat: string) => {
    switch (cat.toLowerCase()) {
      case "official":
        return "bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-950/50 dark:text-emerald-300";
      case "academic":
        return "bg-teal-100 text-teal-800 border-teal-300 dark:bg-teal-950/50 dark:text-teal-300";
      case "examination":
        return "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/50 dark:text-amber-300";
      case "policy":
        return "bg-purple-100 text-purple-800 border-purple-300 dark:bg-purple-950/50 dark:text-purple-300";
      case "admissions":
        return "bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-950/50 dark:text-blue-300";
      default:
        return "bg-slate-100 text-slate-800 border-slate-300 dark:bg-slate-800 dark:text-slate-300";
    }
  };

  const getDocumentIcon = (filename: string) => {
    const ext = filename.split(".").pop()?.toLowerCase();
    if (ext === "pdf") return FileText;
    if (ext === "xls" || ext === "xlsx" || ext === "csv")
      return FileSpreadsheet;
    if (ext === "doc" || ext === "docx") return FileCheck;
    if (ext === "html" || ext === "json") return FileCode;
    return FileText;
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="bg-linear-to-r flex flex-col justify-between gap-4 rounded-3xl border border-emerald-800/40 from-emerald-950 via-slate-900 to-teal-950 p-6 text-white shadow-xl md:flex-row md:items-center">
        <div>
          <div className="mb-1 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-emerald-400">
            <FolderOpen className="h-4 w-4" /> Cloudflare R2 Document Vault
          </div>
          <h1 className="text-2xl font-bold tracking-tight md:text-3xl">
            Institutional Documents &amp; Academic Repository
          </h1>
          <p className="mt-1 max-w-2xl text-xs text-slate-300 md:text-sm">
            Access official prospectuses, admission forms, academic calendars,
            syllabuses, policies, and matric textbooks hosted on Cloudflare R2
            storage.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchDocuments()}
            disabled={loading}
            className="gap-1.5 border-white/20 bg-white/10 text-xs text-white hover:bg-white/20"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>

          <Badge
            variant="outline"
            className="border-emerald-400/40 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-300"
          >
            Role: {userRole || "GUEST"}
          </Badge>
        </div>
      </div>

      {/* UPLOAD CARD: Rendered ONLY for Authorized Uploaders (ADMIN, PRINCIPAL, HEAD, CLERK, TEACHER) */}
      {canUpload ? (
        <Card className="border-emerald-500/30 bg-white/90 shadow-sm backdrop-blur-xl dark:bg-slate-950/80">
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="rounded-xl bg-emerald-50 p-2 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
                  <UploadCloud className="h-5 w-5" />
                </div>
                <div>
                  <CardTitle className="text-lg font-bold text-slate-900 dark:text-slate-100">
                    Upload Institutional Document
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Authorized for {UPLOAD_ROLES.join(", ")}. Files are uploaded
                    directly to the Cloudflare R2 bucket.
                  </CardDescription>
                </div>
              </div>
              <Badge
                variant="outline"
                className="border-emerald-500 text-[11px] text-emerald-700 dark:text-emerald-400"
              >
                <ShieldCheck className="mr-1 h-3 w-3" /> RBAC Authorized
              </Badge>
            </div>
          </CardHeader>

          <CardContent>
            <form onSubmit={handleUpload} className="space-y-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                {/* Document Title */}
                <div className="space-y-1.5 md:col-span-2">
                  <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    Document Title
                  </label>
                  <Input
                    placeholder="e.g., Annual Sports Gala Schedule 2026-2027"
                    value={uploadTitle}
                    onChange={(e) => setUploadTitle(e.target.value)}
                    disabled={isUploading}
                    className="border-slate-200 bg-slate-50 text-xs dark:border-slate-800 dark:bg-slate-900"
                  />
                </div>

                {/* Document Category */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    Category
                  </label>
                  <select
                    value={uploadCategory}
                    onChange={(e) => setUploadCategory(e.target.value)}
                    disabled={isUploading}
                    className="focus:outline-hidden h-9 w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-900 focus:ring-2 focus:ring-emerald-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
                  >
                    <option value="Official">Official</option>
                    <option value="Academic">Academic</option>
                    <option value="Examination">Examination</option>
                    <option value="Policy">Policy</option>
                    <option value="Admissions">Admissions</option>
                    <option value="General">General</option>
                  </select>
                </div>
              </div>

              {/* File Input & Drop Area */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Select File (PDF, DOCX, XLSX, PPTX, Images, etc. up to 50MB)
                </label>
                <div className="flex flex-col items-center gap-3 sm:flex-row">
                  <Input
                    type="file"
                    onChange={(e) => {
                      if (e.target.files?.[0]) {
                        setSelectedFile(e.target.files[0]);
                        if (!uploadTitle) {
                          setUploadTitle(
                            e.target.files[0].name
                              .replace(/\.[^/.]+$/, "")
                              .replace(/[-_]/g, " "),
                          );
                        }
                      }
                    }}
                    disabled={isUploading}
                    className="border-slate-200 bg-slate-50 text-xs file:mr-4 file:rounded-md file:border-0 file:bg-emerald-50 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-emerald-700 hover:file:bg-emerald-100 dark:border-slate-800 dark:bg-slate-900 dark:file:bg-emerald-950 dark:file:text-emerald-400"
                  />

                  <Button
                    type="submit"
                    disabled={!selectedFile || isUploading}
                    className="shadow-xs w-full shrink-0 bg-emerald-600 px-6 py-2 text-xs font-bold text-white hover:bg-emerald-700 sm:w-auto"
                  >
                    {isUploading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Uploading ({uploadProgress}%)...
                      </>
                    ) : (
                      <>
                        <UploadCloud className="mr-2 h-4 w-4" />
                        Upload Document
                      </>
                    )}
                  </Button>
                </div>
                {selectedFile && (
                  <p className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                    Ready to upload: {selectedFile.name} (
                    {formatFileSize(selectedFile.size)})
                  </p>
                )}
              </div>
            </form>
          </CardContent>
        </Card>
      ) : (
        /* Notice for Readers (Students, Parents, Workers) */
        <div className="flex items-center justify-between rounded-2xl border border-emerald-200/80 bg-emerald-50/50 p-4 dark:border-emerald-800/40 dark:bg-emerald-950/20">
          <div className="flex items-center gap-3 text-xs text-slate-700 dark:text-slate-300">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
            <span>
              <strong>Document Access:</strong> You can view and download all
              official school documents below. Document upload permissions are
              assigned to teaching and administrative staff.
            </span>
          </div>
        </div>
      )}

      {/* SEARCH & CATEGORY FILTER BAR */}
      <div className="shadow-xs space-y-4 rounded-3xl border border-slate-200/80 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/60 md:p-6">
        <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
          {/* Search Input */}
          <div className="relative w-full sm:w-80">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              type="text"
              placeholder="Search documents by title or filename..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="border-slate-200 bg-slate-50 pl-9 pr-4 text-xs dark:border-slate-800 dark:bg-slate-950"
            />
          </div>

          <div className="text-xs font-medium text-slate-500">
            Showing {filteredDocuments.length} of {documents.length} documents
          </div>
        </div>

        {/* Category Tabs */}
        <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-2 dark:border-slate-800">
          <span className="mr-2 flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-slate-400">
            <Filter className="h-3 w-3" /> Category:
          </span>
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={`rounded-xl px-3 py-1 text-xs font-medium transition-all ${
                selectedCategory === cat
                  ? "shadow-xs bg-emerald-600 font-bold text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* DOCUMENT LIST / GRID */}
      {loading ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-12 text-center dark:border-slate-800 dark:bg-slate-900">
          <Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin text-emerald-600" />
          <p className="text-xs text-slate-500">
            Connecting to Cloudflare R2 bucket and fetching documents...
          </p>
        </div>
      ) : filteredDocuments.length === 0 ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-12 text-center dark:border-slate-800 dark:bg-slate-900">
          <AlertCircle className="mx-auto mb-3 h-8 w-8 text-slate-400" />
          <h3 className="mb-1 text-sm font-bold text-slate-800 dark:text-slate-200">
            No documents found
          </h3>
          <p className="text-xs text-slate-500">
            {searchQuery
              ? "Try refining your search query or switching categories."
              : "No documents exist in this category yet."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredDocuments.map((doc) => {
            const DocIcon = getDocumentIcon(doc.filename);
            const isDeleting = deletingKey === doc.key;

            return (
              <div
                key={doc.key}
                className="shadow-2xs group flex flex-col justify-between rounded-3xl border border-slate-200/90 bg-white p-5 transition-all duration-200 hover:border-emerald-500/40 hover:shadow-md dark:border-slate-800 dark:bg-slate-900/80"
              >
                <div>
                  {/* Top Bar: Icon + Category Badge */}
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="rounded-2xl bg-emerald-50 p-2.5 text-emerald-700 transition-transform group-hover:scale-105 dark:bg-emerald-950 dark:text-emerald-400">
                      <DocIcon className="h-5 w-5" />
                    </div>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${getCategoryBadgeClass(doc.category)}`}
                    >
                      {doc.category}
                    </span>
                  </div>

                  {/* Title & Filename */}
                  <h3 className="mb-1 line-clamp-2 text-sm font-bold text-slate-900 transition-colors group-hover:text-emerald-600 dark:text-slate-100">
                    {doc.title}
                  </h3>
                  <p className="mb-3 truncate font-mono text-[11px] text-slate-400">
                    {doc.filename}
                  </p>

                  {/* Metadata Badges */}
                  <div className="mb-4 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                    <span className="font-semibold">
                      {formatFileSize(doc.size)}
                    </span>
                    <span>•</span>
                    <span>
                      {new Date(doc.lastModified).toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </span>
                    <span>•</span>
                    <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] dark:bg-slate-800">
                      {doc.uploadedBy}
                    </span>
                  </div>
                </div>

                {/* Actions Footer */}
                <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                  <div className="flex items-center gap-1.5">
                    <a
                      href={doc.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-emerald-600 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-emerald-400"
                      title="Preview in browser"
                    >
                      <ExternalLink className="h-3.5 w-3.5" /> Preview
                    </a>

                    <a
                      href={doc.url}
                      download={doc.filename}
                      className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-50 hover:text-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-950/40 dark:hover:text-emerald-300"
                      title="Download file"
                    >
                      <Download className="h-3.5 w-3.5" /> Download
                    </a>
                  </div>

                  {/* Delete Button (Only for ADMIN, PRINCIPAL, HEAD) */}
                  {canDelete && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => void handleDelete(doc.key, doc.title)}
                      disabled={isDeleting}
                      className="h-7 w-7 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/40"
                      title="Delete document"
                    >
                      {isDeleting ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
