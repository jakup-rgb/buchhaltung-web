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
    fields: "files(id,name,modifiedTime,size)",
    spaces: "drive",
  });

  return res.data.files?.[0] ?? null;
}

// ✅ Robust: googleapis liefert je nach env Buffer/ArrayBuffer/Uint8Array
function toNodeBuffer(x: any): Buffer {
  if (!x) return Buffer.alloc(0);
  if (Buffer.isBuffer(x)) return x;
  if (x instanceof ArrayBuffer) return Buffer.from(new Uint8Array(x));
  if (ArrayBuffer.isView(x)) return Buffer.from(x as Uint8Array);
  return Buffer.from(x);
}

function ensureHeader(ws: ExcelJS.Worksheet) {
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

  const r1 = ws.getRow(1);
  const hasAnyHeader = headers.some((_, i) => {
    const v = r1.getCell(i + 1).value;
    return v !== null && v !== undefined && String(v).trim() !== "";
  });

  if (!hasAnyHeader) {
    headers.forEach((h, i) => (r1.getCell(i + 1).value = h));
    r1.font = { bold: true };
    r1.commit?.();
  }

  const widths = [12, 24, 10, 8, 14, 40, 50, 24, 10];
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
}

function normalizeDate(d: RowData["date"]) {
  if (!d || d === "null") return "";
  return d;
}

function normalizeTotal(total: RowData["total"]) {
  if (typeof total === "number" && Number.isFinite(total)) return total;
  return null;
}

function findLastDataRow(ws: ExcelJS.Worksheet) {
  const max = Math.max(ws.actualRowCount || 0, ws.rowCount || 0, 1);
  for (let r = max; r >= 2; r--) {
    const row = ws.getRow(r);
    for (let c = 1; c <= 9; c++) {
      const v = row.getCell(c).value;
      if (v !== null && v !== undefined && String(v).trim() !== "") return r;
    }
  }
  return 1;
}

export async function appendRowToDriveExcel(params: {
  drive: any;
  rootFolderId: string;
  excelName?: string;
  row: RowData;
}) {
  const { drive, rootFolderId, row } = params;
  const excelName = params.excelName ?? "belege.xlsx";

  const existing = await findFile(drive, excelName, rootFolderId);

  const wb = new ExcelJS.Workbook();
  let ws: ExcelJS.Worksheet;

  if (existing) {
    const dl = await drive.files.get(
      { fileId: existing.id, alt: "media" },
      { responseType: "arraybuffer" }
    );

    const buf = toNodeBuffer(dl.data);
    await wb.xlsx.load(buf as any);

    ws = wb.getWorksheet("Belege") ?? wb.worksheets[0] ?? wb.addWorksheet("Belege");
  } else {
    ws = wb.addWorksheet("Belege");
  }

  ensureHeader(ws);

  const lastDataRow = findLastDataRow(ws);
  const targetRowIndex = lastDataRow + 1;

  // ✅ Werte direkt in Zellen schreiben (super stabil)
  const r = ws.getRow(targetRowIndex);
  r.getCell(1).value = normalizeDate(row.date);
  r.getCell(2).value = row.vendor ?? "";
  r.getCell(3).value = normalizeTotal(row.total);
  r.getCell(4).value = row.currency ?? "";
  r.getCell(5).value = row.category ?? "";
  r.getCell(6).value = row.pdfName ?? "";
  r.getCell(7).value = row.pdfWebViewLink ?? "";
  r.getCell(8).value = row.pdfFileId ?? "";
  r.getCell(9).value = typeof row.confidence === "number" ? row.confidence : 0;
  r.commit?.();

  const out = await wb.xlsx.writeBuffer();
  const outBuffer = toNodeBuffer(out);

  // Upload create/update
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
      fields: "id, webViewLink, modifiedTime, size",
    });

    return {
      id: created.data.id,
      webViewLink: created.data.webViewLink,
      createdNew: true,
      appendedRow: { targetRowIndex, lastDataRow },
      metaAfter: created.data,
      verifyLastRow: null,
    };
  } else {
    const updated = await drive.files.update({
      fileId: existing.id,
      media: {
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        body: Readable.from(outBuffer),
      },
      fields: "id, webViewLink, modifiedTime, size",
    });

    // ✅ Verify: direkt danach nochmal laden und letzte Zeile auslesen
    let verifyLastRow: any = null;
    try {
      const dl2 = await drive.files.get(
        { fileId: existing.id, alt: "media" },
        { responseType: "arraybuffer" }
      );
      const buf2 = toNodeBuffer(dl2.data);
      const wb2 = new ExcelJS.Workbook();
      await wb2.xlsx.load(buf2 as any);
      const ws2 = wb2.getWorksheet("Belege") ?? wb2.worksheets[0];
      if (ws2) {
        const last = findLastDataRow(ws2);
        const rr = ws2.getRow(last);
        verifyLastRow = {
          lastRow: last,
          A: rr.getCell(1).value ?? null,
          B: rr.getCell(2).value ?? null,
          C: rr.getCell(3).value ?? null,
          D: rr.getCell(4).value ?? null,
          E: rr.getCell(5).value ?? null,
          F: rr.getCell(6).value ?? null,
        };
      }
    } catch (e: any) {
      verifyLastRow = { error: e?.message ?? String(e) };
    }

    const meta = await drive.files.get({
      fileId: existing.id,
      fields: "id,name,modifiedTime,size",
    });

    return {
      id: existing.id,
      webViewLink: updated.data.webViewLink,
      createdNew: false,
      appendedRow: { targetRowIndex, lastDataRow },
      metaBefore: {
        id: existing.id,
        name: existing.name,
        modifiedTime: existing.modifiedTime,
        size: existing.size,
      },
      metaAfter: meta.data,
      verifyLastRow,
    };
  }
}