import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export type Category = "KFZ" | "MARKT" | "BUERO" | "RESTAURANT" | "SONSTIGES";

const ALLOWED: Category[] = ["KFZ", "MARKT", "BUERO", "RESTAURANT", "SONSTIGES"];

export async function classifyReceiptFromText(text: string): Promise<Category> {
  const prompt = `
Du bist ein Beleg-Klassifizierer für Buchhaltung.
Ordne den Beleg einer dieser Kategorien zu:
- KFZ (Tankstelle, Werkstatt, Autoteile, Versicherung, Zulassung, Öl, Reifen)
- MARKT (Supermarkt, Drogerie, Lebensmittel, Haushalt)
- BUERO (Büromaterial, Software, Elektronik, Druck, Papier)
- RESTAURANT (Gastronomie, Cafe, Imbiss, Lieferdienst)
- SONSTIGES (wenn unklar)

Gib NUR das Kategorie-Wort zurück, genau eins aus: ${ALLOWED.join(", ")}.

Belegtext:
${text}
`.trim();

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
  });

  const out = resp.choices[0]?.message?.content?.trim().toUpperCase() ?? "SONSTIGES";
  return (ALLOWED.includes(out as Category) ? (out as Category) : "SONSTIGES");
}
