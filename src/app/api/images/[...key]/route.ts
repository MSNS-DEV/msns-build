import { type NextRequest, NextResponse } from "next/server";
import { getFromS3 } from "~/lib/s3";
import { Readable } from "stream";
import { auth } from "~/server/auth";
import { cacheControlFor, isPublicKey, isSafeKey } from "~/server/storage-access";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ key: string[] }> }
) {
  try {
    const p = await params;
    const key = p.key.join("/");

    if (!key || !isSafeKey(key)) {
      return new NextResponse("Invalid image key", { status: 400 });
    }

    // Only public prefixes (gallery, logos, ...) are served without a session.
    if (!isPublicKey(key)) {
      const session = await auth();
      if (!session?.user) {
        return new NextResponse("Unauthorized", { status: 401 });
      }
    }

    const response = await getFromS3(key);

    if (!response.Body) {
      return new NextResponse("Image not found", { status: 404 });
    }

    // Use Node.js Readable.toWeb to avoid AWS SDK transformToWebStream uncaught exceptions
    const stream = Readable.toWeb(response.Body as Readable) as ReadableStream;

    const headers = new Headers();
    if (response.ContentType) headers.set("Content-Type", response.ContentType);
    if (response.ContentLength)
      headers.set("Content-Length", response.ContentLength.toString());
    headers.set("Cache-Control", cacheControlFor(key));

    return new NextResponse(stream, { headers });
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null) {
      const err = error as { name?: string; Code?: string };
      if (err.name === "NoSuchKey" || err.Code === "NoSuchKey") {
        return new NextResponse("Image not found", { status: 404 });
      }
    }

    console.error("Error fetching image from S3:", error);
    return new NextResponse("Internal server error", { status: 500 });
  }
}
