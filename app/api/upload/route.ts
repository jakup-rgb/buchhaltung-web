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
    .replace(/[^\p{L}\p{N}\-_. ]/gu, "")
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

    const mimeType =
      file.type ||
      (file.name.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg");

    // 1) Extract
    const extracted = await extractFromReceiptImage({
      mimeType,
      base64: bytes.toString("base64"),
    });

    // overrides (vom Modal)
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

    const category = final.category ?? "SONSTIGES";

    // 2) Image -> PDF
    const pdfDoc = await PDFDocument.create();
    const isPng = mimeType.includes("png");
    const embedded = isPng ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);

    const page = pdfDoc.addPage([embedded.width, embedded.height]);
    page.drawImage(embedded, {
      x: 0,
      y: 0,
      width: embedded.width,
      height: embedded.height,
    });

    const pdfBytes = await pdfDoc.save();

    // 3) Drive client
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    const drive = google.drive({ version: "v3", auth });

    // 4) Root: entweder ENV-ID (bestehend), sonst Ordnername "Belege"
const rootFolderIdFromEnv = process.env.DRIVE_ROOT_FOLDER_ID?.trim();
const rootName = process.env.DRIVE_ROOT_FOLDER || "Belege";

const storageTarget = final.storageTarget === "private" ? "private" : "shared";

let rootId: string;

if (storageTarget === "private") {
  // Im eigenen Drive des eingeloggten Users
  rootId = await ensureFolder(drive, rootName);
} else {
  // Im freigegebenen Ordner
  rootId = rootFolderIdFromEnv
    ? rootFolderIdFromEnv
    : await ensureFolder(drive, rootName);
}

    // Datum vom Beleg verwenden
    const receiptDate =
      final.date && /^\d{4}-\d{2}-\d{2}$/.test(final.date)
        ? new Date(final.date)
        : new Date();

    const yyyy = String(receiptDate.getFullYear());
    const mm = String(receiptDate.getMonth() + 1).padStart(2, "0");
    const dd = String(receiptDate.getDate()).padStart(2, "0");

    // Unterordner: YYYY/MM/Kategorie
    const yearId = await ensureFolder(drive, yyyy, rootId);
    const monthId = await ensureFolder(drive, mm, yearId);
    const categoryId = await ensureFolder(drive, category, monthId);

    // Dateiname
    const dateStr = `${yyyy}-${mm}-${dd}`;
    const vendor = final.vendor ? safeForFileName(final.vendor) : "BELEG";
    const totalStr = final.total != null ? String(final.total).replace(".", ",") : "NA";
    const fileName = `${dateStr}_${category}_${vendor}_${totalStr}.pdf`;

    // 5) Upload PDF
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

    // 6) Excel
    let excel: any = null;
    try {
      excel = await appendRowToDriveExcel({
        drive,
        rootFolderId: rootId,
        row: {
          date: final?.date ?? new Date().toISOString().slice(0, 10),
          vendor: final?.vendor ?? "",
          total:
            typeof final?.total === "number"
              ? final.total
              : typeof final?.total === "string"
              ? Number(String(final.total).replace(",", "."))
              : null,
          currency: final?.currency ?? "EUR",
          category,
          pdfName: fileName,
          pdfWebViewLink: uploaded.data.webViewLink ?? null,
          comment: final?.comment ?? "",
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
      folder: { rootId, rootName, yyyy, mm, category, storageTarget },
      extracted,
      final,
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