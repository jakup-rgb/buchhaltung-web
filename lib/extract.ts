import OpenAI from "openai";

function getClient() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY");
  return new OpenAI({ apiKey: key });
}


export type Extracted = {
  vendor: string | null;        // z.B. "BILLA"
  date: string | null;          // ISO: "2026-02-19"
  total: number | null;         // z.B. 23.4
  currency: string | null;      // z.B. "EUR"
  category: "KFZ" | "MARKT" | "BUERO" | "RESTAURANT" | "SONSTIGES";
  confidence: number;           // 0..1
};

export async function extractFromReceiptImage(params: {
  mimeType: string;      // "image/jpeg" | "image/png"
  base64: string;        // ohne data: prefix
}): Promise<Extracted> {
  const { mimeType, base64 } = params;

  const schema = {
    name: "receipt_extract",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        vendor: { type: ["string", "null"] },
        date: { type: ["string", "null"], description: "ISO date YYYY-MM-DD if available" },
        total: { type: ["number", "null"] },
        currency: { type: ["string", "null"] },
        category: {
          type: "string",
          enum: ["KFZ", "MARKT", "BUERO", "RESTAURANT", "SONSTIGES"],
        },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["vendor", "date", "total", "currency", "category", "confidence"],
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
          "Du extrahierst Felder aus Kassenbelegen/Belegen. Antworte ausschließlich im JSON-Format nach Schema.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `
Extrahiere vendor, date (YYYY-MM-DD), total (Zahl), currency (z.B. EUR), category und confidence.
Kategorie-Regeln:
- KFZ: Tankstelle, Werkstatt, Autoteile, Versicherung, Reifen, Öl
- MARKT: Supermarkt, Drogerie, Lebensmittel, Haushalt
- BUERO: Bürobedarf, Elektronik, Software, Druck, Papier
- RESTAURANT: Gastronomie, Cafe, Imbiss, Lieferdienst
- SONSTIGES: sonst/unklar
Wenn Datum oder Summe nicht sicher erkennbar sind: null setzen.
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
    return { vendor: null, date: null, total: null, currency: null, category: "SONSTIGES", confidence: 0 };
  }
  return JSON.parse(json) as Extracted;
}
