import ExcelJS from "exceljs";
import { Readable } from "stream";

type RowData = {
  date: string | null;
  vendor: string | null;
  total: number | null;
  currency: string | null;
  category: string;
  pdfName: string;
  pdfWebViewLink: string | null;
  pdfFileId: string | null;
  confidence: number;
};

async function findFile(drive: any, name: string, parentId?: string) {
  const safeName = name.replace(/'/g, "\\'");
  const qParts = [`name='${safeName}'`, `trashed=false`];
  if (parentId) qParts.push(`'${parentId}' in parents`);
  const q = qParts.join(" and ");

  const res = await drive.files.list({
    q,
    fields: "files(id,name)",
    spaces: "drive",
  });

  return res.data.files?.[0] ?? null;
}

export async function appendRowToDriveExcel(params: {
  drive: any;
  rootFolderId: string;      // id vom "Belege" Ordner
  excelName?: string;        // default: belege.xlsx
  row: RowData;
}) {
  const { drive, rootFolderId, row } = params;
  const excelName = params.excelName ?? "belege.xlsx";

  // 1) Excel-Datei finden oder neu erstellen
  const existing = await findFile(drive, excelName, rootFolderId);

  const wb = new ExcelJS.Workbook();
  let ws: ExcelJS.Worksheet;

  if (existing) {
    // Download existing xlsx
    const dl = await drive.files.get(
      { fileId: existing.id, alt: "media" },
      { responseType: "arraybuffer" }
    );
    const arr = dl.data as ArrayBuffer;
    const buf = Buffer.from(arr); // Node Buffer
    await wb.xlsx.load(buf as any);
    
    ws = wb.getWorksheet("Belege") ?? wb.worksheets[0] ?? wb.addWorksheet("Belege");
  } else {
    ws = wb.addWorksheet("Belege");
    ws.columns = [
      { header: "Datum", key: "date", width: 12 },
      { header: "Lieferant", key: "vendor", width: 24 },
      { header: "Betrag", key: "total", width: 10 },
      { header: "Währung", key: "currency", width: 8 },
      { header: "Kategorie", key: "category", width: 14 },
      { header: "PDF Name", key: "pdfName", width: 40 },
      { header: "Drive Link", key: "pdfWebViewLink", width: 50 },
      { header: "Drive FileId", key: "pdfFileId", width: 24 },
      { header: "Confidence", key: "confidence", width: 10 },
    ];
    ws.getRow(1).font = { bold: true };
  }

  // 2) Zeile anhängen
  ws.addRow({
    date: row.date ?? "",
    vendor: row.vendor ?? "",
    total: row.total ?? "",
    currency: row.currency ?? "",
    category: row.category,
    pdfName: row.pdfName,
    pdfWebViewLink: row.pdfWebViewLink ?? "",
    pdfFileId: row.pdfFileId ?? "",
    confidence: row.confidence,
  });

  // 3) XLSX wieder speichern -> Buffer
  const out = await wb.xlsx.writeBuffer();
  const outBuffer = Buffer.from(out as ArrayBuffer);

  // 4) Upload: create oder update
  if (!existing) {
    const created = await drive.files.create({
      requestBody: {
        name: excelName,
        parents: [rootFolderId],
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      media: {
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        body: Readable.from(outBuffer),
      },
      fields: "id, webViewLink",
    });
    return { id: created.data.id, webViewLink: created.data.webViewLink };
  } else {
    const updated = await drive.files.update({
      fileId: existing.id,
      media: {
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        body: Readable.from(outBuffer),
      },
      fields: "id, webViewLink",
    });
    return { id: updated.data.id, webViewLink: updated.data.webViewLink };
  }
}
