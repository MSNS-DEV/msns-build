import GalleryUploader from "~/components/blocks/gallery/GalleryUploader";
import { Toaster } from "sonner";

export const dynamic = "force-dynamic";

export default function ClerkGalleryPage() {
  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col space-y-4">
      <div className="shrink-0">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">
          School Gallery
        </h1>
        <p className="mt-1 text-muted-foreground">
          Upload photos for the school&apos;s website gallery
        </p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <GalleryUploader canDelete={false} />
      </div>
      <Toaster richColors closeButton position="bottom-right" />
    </div>
  );
}
