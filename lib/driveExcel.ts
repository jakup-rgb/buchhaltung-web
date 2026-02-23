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

function ensureHeader(ws: ExcelJS.Worksheet) {
  // Header in Row 1 setzen (falls leer/kaputt)
  const r1 = ws.getRow(1);

  const headers = [
    "Datum",
    "Lieferant",
    "Betrag",
    "Währung",
    "Kategorie",
    "PDF Name",
    "Drive Link",
    "Drive FileId",
    "Confidence",
  ];

  // Wenn Row 1 komplett leer ist oder nur teilweise, setzen wir ihn neu
  const hasAnyHeader = Array.from({ length: headers.length }).some((_, i) => {
    const v = r1.getCell(i + 1).value;
    return v !== null && v !== undefined && String(v).trim() !== "";
  });

  if (!hasAnyHeader) {
    headers.forEach((h, i) => {
      r1.getCell(i + 1).value = h;
    });
    r1.font = { bold: true };
    r1.commit?.();
  }

  // Optional: Spaltenbreiten (Google/Excel ignoriert das manchmal)
  const widths = [12, 24, 10, 8, 14, 40, 50, 24, 10];
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });
}

function findLastDataRow(ws: ExcelJS.Worksheet) {
  // Wir suchen die letzte Zeile, die in A..I irgendeinen Wert hat
  const max = Math.max(ws.actualRowCount || 0, ws.rowCount || 0, 1);

  for (let r = max; r >= 2; r--) {
    const row = ws.getRow(r);
    let has = false;
    for (let c = 1; c <= 9; c++) {
      const v = row.getCell(c).value;
      if (v !== null && v !== undefined && String(v).trim() !== "") {
        has = true;
        break;
      }
    }
    if (has) return r;
  }

  return 1; // nur Header
}

function normalizeTotal(total: RowData["total"]) {
  if (typeof total === "number" && Number.isFinite(total)) return total;
  return null;
}

function normalizeDate(d: RowData["date"]) {
  // falls "null" als String reinkommt
  if (!d) return "";
  if (d === "null") return "";
  return d;
}

export async function appendRowToDriveExcel(params: {
  drive: any;
  rootFolderId: string; // id vom "Belege" Ordner
  excelName?: string; // default: belege.xlsx
  row: RowData;
}) {
  const { drive, rootFolderId, row } = params;
  const excelName = params.excelName ?? "belege.xlsx";

  // 1) Excel-Datei finden oder neu erstellen
  const existing = await findFile(drive, excelName, rootFolderId);

  const wb = new ExcelJS.Workbook();
  let ws: ExcelJS.Worksheet;

  if (existing) {
    const dl = await drive.files.get(
      { fileId: existing.id, alt: "media" },
      { responseType: "arraybuffer" }
    );

    const arr = dl.data as ArrayBuffer;
    const buf = Buffer.from(arr);
    await wb.xlsx.load(buf as any);

    ws = wb.getWorksheet("Belege") ?? wb.worksheets[0] ?? wb.addWorksheet("Belege");
  } else {
    ws = wb.addWorksheet("Belege");
  }

  // 2) Header sicherstellen
  ensureHeader(ws);

  // 3) Zielzeile finden und ZELLEN direkt setzen (wichtig!)
  const lastDataRow = findLastDataRow(ws);
  const targetRowIndex = lastDataRow + 1;

  const r = ws.getRow(targetRowIndex);

  r.getCell(1).value = normalizeDate(row.date);
  r.getCell(2).value = row.vendor ?? "";
  r.getCell(3).value = normalizeTotal(row.total); // number|null
  r.getCell(4).value = row.currency ?? "";
  r.getCell(5).value = row.category ?? "";
  r.getCell(6).value = row.pdfName ?? "";
  r.getCell(7).value = row.pdfWebViewLink ?? "";
  r.getCell(8).value = row.pdfFileId ?? "";
  r.getCell(9).value = typeof row.confidence === "number" ? row.confidence : 0;

  r.commit?.();

  const rowCountAfter = Math.max(ws.actualRowCount || 0, ws.rowCount || 0);

  const appendedRow = {
    date: normalizeDate(row.date),
    vendor: row.vendor ?? "",
    total: normalizeTotal(row.total),
    currency: row.currency ?? "",
    category: row.category,
    pdfName: row.pdfName,
    pdfWebViewLink: row.pdfWebViewLink ?? "",
    pdfFileId: row.pdfFileId ?? "",
    confidence: typeof row.confidence === "number" ? row.confidence : 0,
    targetRowIndex,
    lastDataRow,
  };

  // 4) XLSX speichern -> Buffer
  const out = await wb.xlsx.writeBuffer();
  const outBuffer = Buffer.from(out as ArrayBuffer);

  // 5) Upload: create oder update
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

    return {
      id: created.data.id,
      webViewLink: created.data.webViewLink,
      rowCountAfter,
      appendedRow,
      createdNew: true,
    };
  } else {
    const updated = await drive.files.update({
      fileId: existing.id,
      media: {
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        body: Readable.from(outBuffer),
      },
      fields: "id, webViewLink",
    });

    return {
      id: existing.id,
      webViewLink: updated.data.webViewLink,
      rowCountAfter,
      appendedRow,
      createdNew: false,
    };
  }
}