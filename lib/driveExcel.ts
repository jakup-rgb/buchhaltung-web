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

// ✅ Findet die letzte "echte" Datenzeile (nicht rowCount, weil der durch Formatierung aufblasen kann)
function findLastDataRow(ws: ExcelJS.Worksheet) {
  const max = ws.actualRowCount && ws.actualRowCount > 0 ? ws.actualRowCount : ws.rowCount;

  for (let r = max; r >= 1; r--) {
    const row = ws.getRow(r);

    // row.values[0] ist immer leer (1-based), daher ab index 1 prüfen
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];

    const hasAnyValue = values.some(
      (v) =>
        v !== null &&
        v !== undefined &&
        (typeof v === "number" ? true : String(v).trim() !== "")
    );

    // Zeile 1 ist Header – zählen wir als "Daten vorhanden"
    if (hasAnyValue) return r;
  }

  return 1;
}

// ✅ Stelle sicher, dass Betrag immer number|null ist
function normalizeTotal(total: RowData["total"]) {
  if (typeof total === "number") return Number.isFinite(total) ? total : null;
  return null;
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
    // Download existing xlsx
    const dl = await drive.files.get(
      { fileId: existing.id, alt: "media" },
      { responseType: "arraybuffer" }
    );

    const arr = dl.data as ArrayBuffer;
    const buf = Buffer.from(arr);
    await wb.xlsx.load(buf as any);

    ws =
      wb.getWorksheet("Belege") ??
      wb.worksheets[0] ??
      wb.addWorksheet("Belege");

    // Falls jemand die Spalten/Headers gelöscht hat: sicherstellen
    if (!ws.columns || ws.columns.length === 0) {
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

  // 2) ✅ Neue Zeile immer direkt unter letzte "echte" Datenzeile setzen
  const lastDataRow = findLastDataRow(ws);
  const targetRowIndex = Math.max(2, lastDataRow + 1); // mindestens 2 (unter Header)

  // Werte vorbereiten
  const rowValues = {
    date: row.date ?? "",
    vendor: row.vendor ?? "",
    total: normalizeTotal(row.total), // ✅ number|null
    currency: row.currency ?? "",
    category: row.category,
    pdfName: row.pdfName,
    pdfWebViewLink: row.pdfWebViewLink ?? "",
    pdfFileId: row.pdfFileId ?? "",
    confidence: typeof row.confidence === "number" ? row.confidence : 0,
  };

  // insertRow ist stabiler als addRow bei "Ghost" rowCounts
  ws.insertRow(targetRowIndex, rowValues);

  // Debug/Return
  const rowCountAfter = ws.actualRowCount || ws.rowCount;
  const appendedRow = {
    ...rowValues,
    targetRowIndex,
    lastDataRow,
  };

  // 3) XLSX wieder speichern -> Buffer
  const out = await wb.xlsx.writeBuffer();
  const outBuffer = Buffer.from(out as ArrayBuffer);

  // 4) Upload: create oder update
  if (!existing) {
    const created = await drive.files.create({
      requestBody: {
        name: excelName,
        parents: [rootFolderId],
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      media: {
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
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
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        body: Readable.from(outBuffer),
      },
      fields: "id, webViewLink",
    });

    // updated.data.id kann leer sein, daher existing.id verwenden
    return {
      id: existing.id,
      webViewLink: updated.data.webViewLink,
      rowCountAfter,
      appendedRow,
      createdNew: false,
    };
  }
}