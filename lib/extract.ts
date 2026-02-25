import OpenAI from "openai";

function getClient() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY");
  return new OpenAI({ apiKey: key });
}

export type Extracted = {
  vendor: string | null;
  date: string | null;             // YYYY-MM-DD
  time: string | null;             // HH:MM
  invoiceNumber: string | null;    // Rechnungs-/Belegnummer
  total: number | null;
  currency: string | null;
  category: "KFZ" | "MARKT" | "BUERO" | "RESTAURANT" | "SONSTIGES";
  companyType: "INTERN" | "EXTERN";
  internalCompany: "RWD" | "DIEM" | null;
  confidence: number;
};

export async function extractFromReceiptImage(params: {
  mimeType: string;
  base64: string;
}): Promise<Extracted> {
  const { mimeType, base64 } = params;

  const schema = {
    name: "receipt_extract",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        vendor: { type: ["string", "null"] },
        date: {
          type: ["string", "null"],
          description: "ISO date YYYY-MM-DD",
        },
        time: {
          type: ["string", "null"],
          description: "Time HH:MM if available",
        },
        invoiceNumber: {
          type: ["string", "null"],
          description:
            "Rechnungsnummer, Belegnummer, Invoice No., Beleg-Nr., etc.",
        },
        total: { type: ["number", "null"] },
        currency: { type: ["string", "null"] },
        category: {
          type: "string",
          enum: ["KFZ", "MARKT", "BUERO", "RESTAURANT", "SONSTIGES"],
        },
        confidence: {
          type: "number",
          minimum: 0,
          maximum: 1,
        },
      },
      required: [
        "vendor",
        "date",
        "time",
        "invoiceNumber",
        "total",
        "currency",
        "category",
        "confidence",
      ],
    },
  } as const;

  const client = getClient();

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_schema", json_schema: schema as any },
    messages: [
      {
        role: "system",
        content:
          "Du extrahierst strukturierte Daten aus deutschsprachigen Kassenbelegen. Antworte ausschließlich im JSON-Format nach Schema.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `
Extrahiere folgende Felder:

- vendor (Firmenname)
- date im Format YYYY-MM-DD
- time im Format HH:MM (24h)
- invoiceNumber (Belegnummer/Rechnungsnummer)
- total (nur Zahl, kein Text)
- currency (z.B. EUR)
- category
- confidence (0-1)

Regeln:

1. Wenn Datum im Format DD.MM.YYYY steht → konvertiere zu YYYY-MM-DD.
2. Wenn mehrere Zahlen existieren → wähle die Haupt-Endsumme.
3. invoiceNumber ist NICHT Terminal-ID oder Trace-ID.
4. Wenn unsicher → null.
5. confidence:
   - 0.9–1 wenn klar lesbar
   - 0.6–0.8 wenn etwas unsicher
   - <0.5 wenn schlecht erkennbar

Kategorie-Regeln:
- KFZ: Tankstelle, Werkstatt, Autoteile, Versicherung
- MARKT: Supermarkt, Drogerie, Haushalt
- BUERO: Bürobedarf, Elektronik, Software
- RESTAURANT: Gastronomie, Cafe, Imbiss
- SONSTIGES: sonst/unklar
`.trim(),
          },
          {
            type: "image_url",
            image_url: { url: `data:${mimeType};base64,${base64}` },
          },
        ],
      },
    ],
  });

  const json = resp.choices[0]?.message?.content;

  if (!json) {
    return fallback();
  }

  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    return fallback();
  }

  // -------- INTERN / EXTERN Logik --------
  let companyType: "INTERN" | "EXTERN" = "EXTERN";
  let internalCompany: "RWD" | "DIEM" | null = null;

  const vendorUpper = parsed.vendor?.toUpperCase() ?? "";

  if (vendorUpper.includes("RWD")) {
    companyType = "INTERN";
    internalCompany = "RWD";
  }

  if (vendorUpper.includes("DIEM")) {
    companyType = "INTERN";
    internalCompany = "DIEM";
  }

  return {
    vendor: parsed.vendor ?? null,
    date: parsed.date ?? null,
    time: parsed.time ?? null,
    invoiceNumber: parsed.invoiceNumber ?? null,
    total: typeof parsed.total === "number" ? parsed.total : null,
    currency: parsed.currency ?? null,
    category: parsed.category ?? "SONSTIGES",
    companyType,
    internalCompany,
    confidence:
      typeof parsed.confidence === "number"
        ? parsed.confidence
        : 0,
  };
}

function fallback(): Extracted {
  return {
    vendor: null,
    date: null,
    time: null,
    invoiceNumber: null,
    total: null,
    currency: null,
    category: "SONSTIGES",
    companyType: "EXTERN",
    internalCompany: null,
    confidence: 0,
  };
}