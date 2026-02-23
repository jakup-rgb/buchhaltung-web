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

    const category = extracted.category ?? "SONSTIGES";

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

    // Ordner nach HEUTE (später können wir extracted.date verwenden)
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, "0");

    const rootId = await ensureFolder(drive, rootName);
    const yearId = await ensureFolder(drive, yyyy, rootId);
    const monthId = await ensureFolder(drive, mm, yearId);
    const categoryId = await ensureFolder(drive, category, monthId);

    // 5) Dateiname verbessern
    const dateStr =
      extracted.date && /^\d{4}-\d{2}-\d{2}$/.test(extracted.date)
        ? extracted.date
        : `${yyyy}-${mm}-${String(now.getDate()).padStart(2, "0")}`;

    const vendor = extracted.vendor ? safeForFileName(extracted.vendor) : "BELEG";
    const totalStr =
      extracted.total != null ? String(extracted.total).replace(".", ",") : "NA";

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

    // 7) Excel-Log (nicht den Upload killen, falls Excel mal crasht)
    let excel: any = null;
    try {
      excel = await appendRowToDriveExcel({
        drive,
        rootFolderId: rootId, // <- "Belege" Ordner
        row: {
          date: extracted?.date ?? new Date().toISOString(),
          vendor: extracted?.vendor ?? "",
          total:
            typeof extracted?.total === "number"
              ? extracted.total
              : typeof extracted?.total === "string"
              ?  Number(String(extracted.total).replace(",", "."))
              : null,
          currency: extracted?.currency ?? "",
          category,
          pdfName: fileName,
          pdfWebViewLink: uploaded.data.webViewLink ?? null,
          pdfFileId: uploaded.data.id ?? null,
          confidence: extracted?.confidence ?? 0,
        },
      });
    } catch (e: any) {
      console.error("EXCEL_ERROR", e);
      excel = {
        ok: false,
        error: e?.message ?? String(e),
      };
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