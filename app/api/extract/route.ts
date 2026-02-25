import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { extractFromReceiptImage } from "@/lib/extract";

export async function POST(req: Request) {
  try {
    // optional: nur eingeloggte dürfen extrahieren
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const form = await req.formData();
    const file = form.get("image") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No image uploaded" }, { status: 400 });
    }

    const bytes = Buffer.from(await file.arrayBuffer());

    const mimeType =
      file.type ||
      (file.name.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg");

    const extracted = await extractFromReceiptImage({
      mimeType,
      base64: bytes.toString("base64"),
    });

    return NextResponse.json({ ok: true, extracted });
  } catch (e: any) {
    console.error("EXTRACT_ERROR", e);
    return NextResponse.json(
      { error: "Extract failed", message: e?.message ?? String(e) },
      { status: 500 }
    );
  }
}