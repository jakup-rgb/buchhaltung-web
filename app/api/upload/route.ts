import { NextResponse } from "next/server";
import { google } from "googleapis";
import { PDFDocument } from "pdf-lib";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { Readable } from "stream";
import { extractFromReceiptImage } from "@/lib/extract";
import { appendRowToDriveExcel } from "@/lib/driveExcel";

async function ensureFolder(drive: any, name: string, parentId?: string) {
  const safeName = name.replace(/'/g, "\\'");
  const qParts = [
    `mimeType='application/vnd.google-apps.folder'`,
    `name='${safeName}'`,
    `trashed=false`,
  ];
  if (parentId) qParts.push(`'${parentId}' in parents`);
  const q = qParts.join(" and ");

  const found = await drive.files.list({
    q,
    fields: "files(id,name)",
    spaces: "drive",
  });

  if (found.data.files?.length) return found.data.files[0].id;

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: parentId ? [parentId] : undefined,
    },
    fields: "id",
  });

  return created.data.id;
}

function safeForFileName(s: string) {
  return s
    .replace(/[^\p{L}\p{N}\-_. ]/gu, "") // nur Buchstaben/Zahlen/._- und Leerzeichen
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 40);
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    // @ts-expect-error
    const accessToken = session?.accessToken;

    if (!accessToken) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const form = await req.formData();
    const file = form.get("image") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No image uploaded" }, { status: 400 });
    }

    const bytes = Buffer.from(await file.arrayBuffer());

    // 1) Vision/OCR + Felder extrahieren
    const mimeType =
      file.type ||
      (file.name.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg");

    const extracted = await extractFromReceiptImage({
      mimeType,
      base64: bytes.toString("base64"),
    });

    const overridesRaw = form.get("overrides") as string | null;
let overrides: any = null;

if (overridesRaw) {
  try {
    overrides = JSON.parse(overridesRaw);
  } catch {}
}

const final = {
  ...extracted,
  ...(overrides ?? {}),
};

// ab jetzt überall `final` verwenden statt `extracted`

    const category = final.category ?? "SONSTIGES";

    // 2) Bild -> PDF
    const pdfDoc = await PDFDocument.create();
    const isPng = mimeType.includes("png");
    const embedded = isPng
      ? await pdfDoc.embedPng(bytes)
      : await pdfDoc.embedJpg(bytes);

    const page = pdfDoc.addPage([embedded.width, embedded.height]);
    page.drawImage(embedded, {
      x: 0,
      y: 0,
      width: embedded.width,
      height: embedded.height,
    });

    const pdfBytes = await pdfDoc.save();

    // 3) Drive Client (User OAuth)
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    const drive = google.drive({ version: "v3", auth });

    // 4) Ordnerstruktur
    const rootName = process.env.DRIVE_ROOT_FOLDER || "Belege";

// ===== Datum vom Beleg verwenden =====
const receiptDate =
  final.date && /^\d{4}-\d{2}-\d{2}$/.test(final.date)
    ? new Date(final.date)
    : new Date();

const yyyy = String(receiptDate.getFullYear());
const mm = String(receiptDate.getMonth() + 1).padStart(2, "0");
const dd = String(receiptDate.getDate()).padStart(2, "0");

// ===== Ordnerstruktur =====
const rootId = await ensureFolder(drive, rootName);
const yearId = await ensureFolder(drive, yyyy, rootId);
const monthId = await ensureFolder(drive, mm, yearId);
const categoryId = await ensureFolder(drive, category, monthId);

// ===== Dateiname =====
const dateStr = `${yyyy}-${mm}-${dd}`;

const vendor = final.vendor
  ? safeForFileName(final.vendor)
  : "BELEG";

const totalStr =
  final.total != null
    ? String(final.total).replace(".", ",")
    : "NA";

const fileName = `${dateStr}_${category}_${vendor}_${totalStr}.pdf`;
    // 6) Upload als Stream
    const uploaded = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [categoryId],
        mimeType: "application/pdf",
      },
      media: {
        mimeType: "application/pdf",
        body: Readable.from(Buffer.from(pdfBytes)),
      },
      fields: "id, webViewLink",
    });

let excel: any = null;
try {
  excel = await appendRowToDriveExcel({
    drive,
    rootFolderId: rootId,
    row: {
      date: final?.date ?? new Date().toISOString().slice(0, 10), // ✅ nur YYYY-MM-DD
      vendor: final?.vendor ?? "",
      total:
        typeof final?.total === "number"
          ? final.total
          : typeof final?.total === "string"
          ? Number(String(final.total).replace(",", "."))
          : null,
      currency: final?.currency ?? "EUR", // ✅ Default
      category,
      pdfName: fileName,
      pdfWebViewLink: uploaded.data.webViewLink ?? null,
      comment: final?.comment ?? "",
     // pdfFileId: uploaded.data.id ?? null,
     // confidence: typeof final?.confidence === "number" ? final.confidence : 0, // ✅ sauber
    },
  });
} catch (e: any) {
  console.error("EXCEL_ERROR", e);
  excel = { ok: false, error: e?.message ?? String(e) };
}

    return NextResponse.json({
      ok: true,
      pdf: {
        fileId: uploaded.data.id,
        webViewLink: uploaded.data.webViewLink,
        fileName,
      },
      folder: { rootName, yyyy, mm, category },
      extracted,
      excel,
    });
  } catch (e: any) {
    console.error("UPLOAD_ERROR", e);
    return NextResponse.json(
      {
        error: "Upload failed",
        message: e?.message ?? String(e),
        stack: e?.stack ?? null,
      },
      { status: 500 }
    );
  }
}