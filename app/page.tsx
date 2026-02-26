"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import ReactCrop, { type Crop, type PixelCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";

type ReceiptItem = {
  id: string;
  name: string;
  webViewLink?: string | null;
  createdTime?: string | null;
};

type Category = "KFZ" | "MARKT" | "BUERO" | "RESTAURANT" | "SONSTIGES";

type ReviewForm = {
  date: string;
  time: string; // optional
  vendor: string;
  total: string; // string fürs Input (wir wandeln beim Upload um)
  currency: string;
  category: Category;
  invoiceNumber: string;
  companyType: "INTERN" | "EXTERN";
  internalCompany: "RWD" | "DIEM" | "";
  confidence: number; // 0..1
};

const HISTORY_KEY = "historyClearedAt";
const LAST_RESULT_KEY = "lastResult";
const MAX_VISIBLE_RECEIPTS = 50;

function clampStr(v: any) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function centerCropPercent(imageWidth: number, imageHeight: number): Crop {
  // Start-Crop: großer Bereich mittig (in %), user kann dann Handles ziehen
  const w = 92;
  const h = 92;
  return {
    unit: "%",
    x: (100 - w) / 2,
    y: (100 - h) / 2,
    width: w,
    height: h,
  };
}

async function createCroppedBlobFromImageElement(
  image: HTMLImageElement,
  crop: PixelCrop
): Promise<Blob> {
  const canvas = document.createElement("canvas");

  const scaleX = image.naturalWidth / image.width;
  const scaleY = image.naturalHeight / image.height;

  const pixelRatio = window.devicePixelRatio || 1;

  canvas.width = Math.max(1, Math.floor(crop.width * scaleX * pixelRatio));
  canvas.height = Math.max(1, Math.floor(crop.height * scaleY * pixelRatio));

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No canvas context");

  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.imageSmoothingQuality = "high";

  const sx = crop.x * scaleX;
  const sy = crop.y * scaleY;
  const sw = crop.width * scaleX;
  const sh = crop.height * scaleY;

  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, crop.width * scaleX, crop.height * scaleY);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/jpeg",
      0.95
    );
  });
}

export default function Page() {
  const { data: session, status } = useSession();
  const isLoggedIn = !!session;

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);

  const [items, setItems] = useState<ReceiptItem[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const [historyClearedAt, setHistoryClearedAt] = useState<number>(0);

  // ---- Datei & Preview ----
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // ---- Review Modal ----
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewForm, setReviewForm] = useState<ReviewForm>({
    date: "",
    time: "",
    vendor: "",
    total: "",
    currency: "EUR",
    category: "SONSTIGES",
    invoiceNumber: "",
    companyType: "EXTERN",
    internalCompany: "",
    confidence: 0,
  });

  // ---- Crop (handles) ----
  const [cropOpen, setCropOpen] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState<Crop>({ unit: "%", x: 4, y: 4, width: 92, height: 92 });
  const [completedCrop, setCompletedCrop] = useState<PixelCrop | null>(null);

  const excelLink = useMemo(() => result?.excel?.webViewLink ?? null, [result]);

  const applyHistoryFilter = (all: ReceiptItem[], clearedAt: number) => {
    const filtered = all.filter((it) => {
      if (!clearedAt) return true;
      if (!it.createdTime) return true;
      return new Date(it.createdTime).getTime() > clearedAt;
    });
    return filtered.slice(0, MAX_VISIBLE_RECEIPTS);
  };

  const loadReceipts = async () => {
    if (!session) return;
    setLoadingList(true);
    try {
      const res = await fetch("/api/receipts", { cache: "no-store" });
      const text = await res.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
      if (!res.ok) {
        setItems([]);
        setResult({ error: true, status: res.status, data });
        return;
      }
      const all = (data.items ?? []) as ReceiptItem[];
      setItems(applyHistoryFilter(all, historyClearedAt));
    } finally {
      setLoadingList(false);
    }
  };

  const clearHistoryView = () => {
    const ts = Date.now();
    setHistoryClearedAt(ts);
    localStorage.setItem(HISTORY_KEY, String(ts));
    setItems([]);
  };

  const closeReview = () => {
    setReviewOpen(false);
    setCropOpen(false);
  };

  // ---- Extraktion (für Vorschau) ----
  const runExtract = async (imgFile: File) => {
    setReviewBusy(true);
    try {
      const fd = new FormData();
      fd.append("image", imgFile);

      const res = await fetch("/api/extract", { method: "POST", body: fd });
      if (!res.ok) return;

      const data = await res.json();
      const ex = data?.extracted ?? data ?? {};

      setReviewForm((prev) => ({
        ...prev,
        date: clampStr(ex.date ?? prev.date),
        time: clampStr(ex.time ?? ""),
        vendor: clampStr(ex.vendor ?? ""),
        total:
          typeof ex.total === "number"
            ? String(ex.total)
            : typeof ex.total === "string"
            ? ex.total
            : "",
        currency: clampStr(ex.currency ?? "EUR"),
        category: (ex.category as Category) ?? "SONSTIGES",
        invoiceNumber: clampStr(ex.invoiceNumber ?? ""),
        companyType: ex.companyType === "INTERN" ? "INTERN" : "EXTERN",
        internalCompany: clampStr(ex.internalCompany ?? "") as any,
        confidence: typeof ex.confidence === "number" ? ex.confidence : 0,
      }));
    } finally {
      setReviewBusy(false);
    }
  };

  // ---- Datei gewählt -> Preview + Extract + Modal ----
  const openReviewForFile = async (f: File) => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);

    const url = URL.createObjectURL(f);
    setPreviewUrl(url);
    setFile(f);

    // Reset Form
    setReviewForm({
      date: "",
      time: "",
      vendor: "",
      total: "",
      currency: "EUR",
      category: "SONSTIGES",
      invoiceNumber: "",
      companyType: "EXTERN",
      internalCompany: "",
      confidence: 0,
    });

    setReviewOpen(true);
    setCropOpen(false);

    // Crop default
    // wird nach img onLoad nochmal zentriert
    setCrop({ unit: "%", x: 4, y: 4, width: 92, height: 92 });
    setCompletedCrop(null);

    await runExtract(f);
  };

  const onPick = async (f: File | null) => {
    setResult(null);

    if (!f) {
      setFile(null);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      closeReview();
      return;
    }

    await openReviewForFile(f);
  };

  // ---- Crop anwenden ----
  const applyCrop = async () => {
    if (!file || !imgRef.current || !completedCrop) return;

    setReviewBusy(true);
    try {
      const croppedBlob = await createCroppedBlobFromImageElement(imgRef.current, completedCrop);

      const croppedFile = new File(
        [croppedBlob],
        file.name.replace(/\.\w+$/, "") + "_crop.jpg",
        { type: "image/jpeg" }
      );

      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const newUrl = URL.createObjectURL(croppedFile);

      setFile(croppedFile);
      setPreviewUrl(newUrl);

      setCropOpen(false);

      // nach Crop nochmal extrahieren
      await runExtract(croppedFile);
    } finally {
      setReviewBusy(false);
    }
  };

  // ---- Upload (nach Bestätigen) ----
  const confirmAndUpload = async () => {
    if (!file) return;

    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("image", file);

      const overrides = {
        date: reviewForm.date || null,
        time: reviewForm.time || null,
        vendor: reviewForm.vendor || null,
        total:
          reviewForm.total.trim() === ""
            ? null
            : Number(String(reviewForm.total).replace(",", ".")),
        currency: reviewForm.currency || null,
        category: reviewForm.category,
        invoiceNumber: reviewForm.invoiceNumber || null,
        companyType: reviewForm.companyType,
        internalCompany: reviewForm.internalCompany || null,
        confidence: reviewForm.confidence ?? 0,
      };

      fd.append("overrides", JSON.stringify(overrides));

      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const text = await res.text();

      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }

      if (!res.ok) {
        setResult({ error: true, status: res.status, data });
        return;
      }

      setResult(data);
      localStorage.setItem(LAST_RESULT_KEY, JSON.stringify(data));

      closeReview();
      await loadReceipts();
      await onPick(null);
    } finally {
      setBusy(false);
    }
  };

  // restore lastResult + history
  useEffect(() => {
    const saved = localStorage.getItem(LAST_RESULT_KEY);
    if (saved) {
      try {
        setResult(JSON.parse(saved));
      } catch {}
    }

    const cleared = localStorage.getItem(HISTORY_KEY);
    if (cleared) {
      const n = Number(cleared);
      if (!Number.isNaN(n)) setHistoryClearedAt(n);
    }
  }, []);

  useEffect(() => {
    if (session) loadReceipts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    setItems((prev) => applyHistoryFilter(prev, historyClearedAt));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyClearedAt]);

  // Menü schließen bei Klick außerhalb
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  // UI
  if (status === "loading") {
    return (
      <main style={styles.page}>
        <div style={styles.card}>
          <h1 style={styles.title}>Buchhaltung Web</h1>
          <p style={styles.muted}>Laden…</p>
        </div>
      </main>
    );
  }

  // Startscreen
  if (!isLoggedIn) {
    return (
      <main style={styles.page}>
        <div style={{ width: "100%", maxWidth: 820 }}>
          <h1 style={styles.titleTop}>Buchhaltung Web</h1>
          <p style={styles.subtitleTop}>
            Belege fotografieren und automatisch in Drive + Excel speichern.
          </p>

          <div style={styles.loginCenter}>
            <button style={styles.primaryBtnLarge} onClick={() => signIn("google")}>
              Login
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main style={styles.page}>
      <div style={styles.card}>
        {/* Header */}
        <div style={styles.headerRow}>
          <div>
            <h1 style={styles.title}>Buchhaltung Web</h1>
            <div style={styles.mutedSmall}>Angemeldet {session.user?.email}</div>
          </div>

          {/* Menü */}
          <div style={{ position: "relative" }} ref={menuRef}>
            <button
              style={styles.menuBtn}
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="Menü"
              title="Menü"
            >
              ☰
            </button>

            {menuOpen && (
              <div style={styles.menuDropdown}>
                <button
                  style={styles.menuItem}
                  onClick={() => {
                    setMenuOpen(false);
                    signOut();
                  }}
                >
                  Logout
                </button>
              </div>
            )}
          </div>
        </div>

        <hr style={styles.hr} />

        {/* Upload */}
        <section>
          <h2 style={styles.sectionTitle}>Neuen Beleg hochladen</h2>
          <p style={{ ...styles.muted, marginTop: 6 }}>Am iPhone öffnet das die Kamera.</p>

          <div style={styles.uploadRow}>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => onPick(e.target.files?.[0] ?? null)}
              disabled={busy}
              style={styles.fileInput}
            />

            {excelLink && (
              <a style={styles.linkBtn} href={excelLink} target="_blank" rel="noreferrer">
                Excel öffnen
              </a>
            )}
          </div>

          {result && (
            <details style={{ marginTop: 12 }}>
              <summary style={styles.detailsSummary}>Letztes Ergebnis anzeigen</summary>
              <pre style={styles.codeBlock}>{JSON.stringify(result, null, 2)}</pre>
            </details>
          )}
        </section>

        <hr style={styles.hr} />

        {/* Verlauf */}
        <section>
          <div style={styles.sectionHeaderRow}>
            <h2 style={styles.sectionTitle}>Letzte Belege</h2>

            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button
                style={{ ...styles.secondaryBtn, opacity: loadingList ? 0.6 : 1 }}
                onClick={loadReceipts}
                disabled={loadingList}
              >
                {loadingList ? "Laden…" : "Aktualisieren"}
              </button>

              <button
                style={{ ...styles.secondaryBtn, opacity: loadingList ? 0.6 : 1 }}
                onClick={clearHistoryView}
                disabled={loadingList}
                title="Löscht nur die Anzeige (nicht Drive/Excel)"
              >
                Verlauf löschen
              </button>
            </div>
          </div>

          {items.length === 0 ? (
            <p style={{ ...styles.muted, marginTop: 10 }}>Noch keine Belege gefunden.</p>
          ) : (
            <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
              {items.map((it) => (
                <div key={it.id} style={styles.listItem}>
                  <div style={{ minWidth: 0 }}>
                    <div style={styles.itemTitle}>{it.name}</div>
                    <div style={styles.itemMeta}>
                      {it.createdTime ? new Date(it.createdTime).toLocaleString() : ""}
                    </div>
                  </div>

                  <div style={{ flexShrink: 0 }}>
                    {it.webViewLink ? (
                      <a style={styles.linkBtn} href={it.webViewLink} target="_blank" rel="noreferrer">
                        Öffnen
                      </a>
                    ) : (
                      <span style={styles.mutedSmall}>kein Link</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* -------- Review Modal -------- */}
      {reviewOpen && (
        <div style={styles.modalOverlay} role="dialog" aria-modal="true">
          <div style={styles.modalCard}>
            <div style={styles.modalHeader}>
              <div>
                <div style={styles.modalTitle}>Beleg prüfen</div>
                <div style={styles.mutedSmall}>
                  {reviewBusy ? "Analysiere…" : "Daten prüfen und ggf. korrigieren"}
                </div>
              </div>
              <button style={styles.modalClose} onClick={closeReview} aria-label="Schließen">
                ✕
              </button>
            </div>

            <div style={styles.modalBody}>
              {/* Bild oben */}
              <div style={styles.modalImageWrap}>
                {previewUrl ? (
                  <img
                    src={previewUrl}
                    alt="preview"
                    style={styles.modalImg}
                    onClick={() => setCropOpen(true)}
                    title="Tippen um zu zuschneiden"
                  />
                ) : (
                  <div style={{ padding: 12, opacity: 0.6 }}>Kein Bild verfügbar</div>
                )}
              </div>

              {/* Crop UI (mit Handles) */}
              {cropOpen && previewUrl && (
                <div style={styles.cropWrap}>
                  <div style={styles.cropTopRow}>
                    <div style={{ fontWeight: 800 }}>Zuschneiden</div>
                    <button
                      style={styles.secondaryBtn}
                      onClick={() => setCropOpen(false)}
                      disabled={reviewBusy || busy}
                    >
                      Schließen
                    </button>
                  </div>

                  <div style={styles.cropArea}>
                    <ReactCrop
                      crop={crop}
                      onChange={(_, p) => setCrop(p)}
                      onComplete={(c) => setCompletedCrop(c)}
                      keepSelection
                      ruleOfThirds
                    >
                      <img
                        ref={imgRef}
                        src={previewUrl}
                        alt="crop"
                        style={{ maxHeight: 520, width: "100%", objectFit: "contain", display: "block" }}
                        onLoad={(e) => {
                          const img = e.currentTarget;
                          setCrop(centerCropPercent(img.width, img.height));
                        }}
                      />
                    </ReactCrop>
                  </div>

                  <div style={styles.cropControls}>
                    <button
                      style={styles.secondaryBtn}
                      onClick={() => setCropOpen(false)}
                      disabled={reviewBusy || busy}
                    >
                      Abbrechen
                    </button>
                    <button
                      style={styles.primaryBtn}
                      onClick={applyCrop}
                      disabled={reviewBusy || busy || !completedCrop || completedCrop.width < 5 || completedCrop.height < 5}
                    >
                      Zuschneiden übernehmen
                    </button>
                  </div>
                </div>
              )}

              {/* Form */}
              <div style={styles.formGrid}>
                <Field label="Datum (YYYY-MM-DD)">
                  <input
                    style={styles.input}
                    value={reviewForm.date}
                    onChange={(e) => setReviewForm((p) => ({ ...p, date: e.target.value }))}
                    placeholder="2026-02-19"
                  />
                </Field>

                <Field label="Uhrzeit (optional)">
                  <input
                    style={styles.input}
                    value={reviewForm.time}
                    onChange={(e) => setReviewForm((p) => ({ ...p, time: e.target.value }))}
                    placeholder="17:45"
                  />
                </Field>

                <Field label="Händler / Vendor">
                  <input
                    style={styles.input}
                    value={reviewForm.vendor}
                    onChange={(e) => setReviewForm((p) => ({ ...p, vendor: e.target.value }))}
                    placeholder="BILLA / OMV / ..."
                  />
                </Field>

                <Field label="Betrag">
                  <input
                    style={styles.input}
                    value={reviewForm.total}
                    onChange={(e) => setReviewForm((p) => ({ ...p, total: e.target.value }))}
                    placeholder="13.97"
                    inputMode="decimal"
                  />
                </Field>

                <Field label="Währung">
                  <input
                    style={styles.input}
                    value={reviewForm.currency}
                    onChange={(e) => setReviewForm((p) => ({ ...p, currency: e.target.value }))}
                    placeholder="EUR"
                  />
                </Field>

                <Field label="Kategorie">
                  <select
                    style={styles.input}
                    value={reviewForm.category}
                    onChange={(e) => setReviewForm((p) => ({ ...p, category: e.target.value as Category }))}
                  >
                    <option value="KFZ">KFZ</option>
                    <option value="MARKT">MARKT</option>
                    <option value="BUERO">BUERO</option>
                    <option value="RESTAURANT">RESTAURANT</option>
                    <option value="SONSTIGES">SONSTIGES</option>
                  </select>
                </Field>

                <Field label="Rechnungsnummer (optional)">
                  <input
                    style={styles.input}
                    value={reviewForm.invoiceNumber}
                    onChange={(e) => setReviewForm((p) => ({ ...p, invoiceNumber: e.target.value }))}
                    placeholder="z.B. 012345"
                  />
                </Field>

                <Field label="Firma (Intern/Extern)">
                  <select
                    style={styles.input}
                    value={reviewForm.companyType}
                    onChange={(e) =>
                      setReviewForm((p) => ({
                        ...p,
                        companyType: e.target.value as "INTERN" | "EXTERN",
                      }))
                    }
                  >
                    <option value="EXTERN">EXTERN</option>
                    <option value="INTERN">INTERN</option>
                  </select>
                </Field>

                {reviewForm.companyType === "INTERN" && (
                  <Field label="Interne Firma">
                    <select
                      style={styles.input}
                      value={reviewForm.internalCompany}
                      onChange={(e) =>
                        setReviewForm((p) => ({
                          ...p,
                          internalCompany: e.target.value as "RWD" | "DIEM" | "",
                        }))
                      }
                    >
                      <option value="">Bitte wählen…</option>
                      <option value="RWD">RWD</option>
                      <option value="DIEM">DIEM</option>
                    </select>
                  </Field>
                )}

                <div style={{ marginTop: 6, opacity: 0.8 }}>
                  Confidence: {Math.round((reviewForm.confidence ?? 0) * 100)}%
                </div>

                <div style={{ marginTop: 10 }}>
                  <button
                    style={styles.secondaryBtn}
                    onClick={() => setCropOpen(true)}
                    disabled={!previewUrl || reviewBusy || busy}
                  >
                    Manuell zuschneiden
                  </button>
                </div>
              </div>
            </div>

            <div style={styles.modalFooter}>
              <button style={{ ...styles.secondaryBtn, opacity: busy ? 0.6 : 1 }} onClick={closeReview} disabled={busy}>
                Abbrechen
              </button>
              <button
                style={{ ...styles.primaryBtn, opacity: busy ? 0.6 : 1 }}
                onClick={confirmAndUpload}
                disabled={busy}
              >
                {busy ? "Upload…" : "Bestätigen & Upload"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ fontWeight: 700 }}>{label}</div>
      {children}
    </div>
  );
}

/* ---------------- Styles ---------------- */

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100dvh",
    padding: 18,
    background: "#0b0b0c",
    color: "#f3f3f3",
    display: "flex",
    justifyContent: "center",
    alignItems: "self-start",
  },
  card: {
    width: "100%",
    maxWidth: 820,
    background: "#111214",
    border: "1px solid #26282c",
    borderRadius: 16,
    padding: 18,
    boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
  },
  headerRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "flex-start",
  },
  title: { margin: 0, fontSize: 34, letterSpacing: 0.2 },
  sectionTitle: { margin: 0, fontSize: 18 },
  sectionHeaderRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "center",
    flexWrap: "wrap",
  },
  muted: { opacity: 0.8, margin: 0 },
  mutedSmall: { opacity: 0.75, fontSize: 12, marginTop: 6 },
  hr: { margin: "16px 0", border: "none", borderTop: "1px solid #2a2c31" },
  uploadRow: { marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" },
  fileInput: {
    background: "#0d0e10",
    border: "1px solid #2a2c31",
    borderRadius: 10,
    padding: 10,
    color: "#f3f3f3",
  },
  primaryBtn: {
    background: "#f3f3f3",
    color: "#0b0b0c",
    border: "none",
    borderRadius: 10,
    padding: "10px 14px",
    cursor: "pointer",
    fontWeight: 700,
  },
  secondaryBtn: {
    background: "transparent",
    color: "#f3f3f3",
    border: "1px solid #2a2c31",
    borderRadius: 10,
    padding: "10px 14px",
    cursor: "pointer",
    fontWeight: 600,
  },
  linkBtn: {
    color: "#f3f3f3",
    textDecoration: "none",
    border: "1px solid #2a2c31",
    borderRadius: 10,
    padding: "10px 14px",
    display: "inline-block",
  },
  codeBlock: {
    marginTop: 10,
    background: "#0b0b0c",
    color: "#45ff6a",
    padding: 12,
    borderRadius: 12,
    overflow: "auto",
    border: "1px solid #26282c",
    maxHeight: 360,
  },
  detailsSummary: { cursor: "pointer", opacity: 0.9 },
  listItem: {
    border: "1px solid #26282c",
    borderRadius: 12,
    padding: 12,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    background: "#0f1012",
  },
  itemTitle: { fontWeight: 700, wordBreak: "break-word" },
  itemMeta: { fontSize: 12, opacity: 0.7, marginTop: 4 },
  menuBtn: {
    background: "transparent",
    color: "#f3f3f3",
    border: "1px solid #2a2c31",
    borderRadius: 10,
    padding: "8px 10px",
    cursor: "pointer",
    fontSize: 18,
    lineHeight: 1,
  },
  menuDropdown: {
    position: "absolute",
    top: 42,
    right: 0,
    minWidth: 180,
    background: "#0f1012",
    border: "1px solid #26282c",
    borderRadius: 12,
    overflow: "hidden",
    boxShadow: "0 12px 30px rgba(0,0,0,0.4)",
    zIndex: 10,
  },
  menuItem: {
    width: "100%",
    textAlign: "left",
    background: "transparent",
    color: "#f3f3f3",
    border: "none",
    padding: "12px 12px",
    cursor: "pointer",
    fontWeight: 700,
  },
  titleTop: { margin: 0, fontSize: 36, textAlign: "center" },
  subtitleTop: { opacity: 0.8, marginTop: 8, textAlign: "center" },
  loginCenter: { position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)" },
  primaryBtnLarge: {
    background: "#f3f3f3",
    color: "#0b0b0c",
    border: "none",
    borderRadius: 14,
    padding: "16px 28px",
    cursor: "pointer",
    fontWeight: 700,
    fontSize: 18,
    boxShadow: "0 8px 30px rgba(0,0,0,0.4)",
  },

  // Modal
  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.65)",
    display: "flex",
    justifyContent: "center",
    alignItems: "flex-start",
    padding: 16,
    zIndex: 50,
    overflowY: "auto",
  },
  modalCard: {
    width: "100%",
    maxWidth: 920,
    background: "#111214",
    border: "1px solid #26282c",
    borderRadius: 16,
    boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
    overflow: "hidden",
  },
  modalHeader: {
    padding: 14,
    borderBottom: "1px solid #2a2c31",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
  },
  modalTitle: { fontSize: 22, fontWeight: 800 },
  modalClose: {
    background: "transparent",
    color: "#f3f3f3",
    border: "1px solid #2a2c31",
    borderRadius: 10,
    padding: "6px 10px",
    cursor: "pointer",
    fontWeight: 800,
  },
  modalBody: {
    padding: 14,
    display: "grid",
    gap: 14,
  },
  modalImageWrap: {
    border: "1px solid #26282c",
    borderRadius: 12,
    background: "#0f1012",
    padding: 10,
  },
  modalImg: {
    width: "100%",
    height: "auto",
    borderRadius: 10,
    border: "1px solid #2a2c31",
    display: "block",
  },
  formGrid: {
    border: "1px solid #26282c",
    borderRadius: 12,
    background: "#0f1012",
    padding: 12,
    display: "grid",
    gap: 12,
  },
  input: {
    background: "#0b0b0c",
    border: "1px solid #2a2c31",
    borderRadius: 10,
    padding: "10px 12px",
    color: "#f3f3f3",
    outline: "none",
    width: "100%",
  },
  modalFooter: {
    padding: 14,
    borderTop: "1px solid #2a2c31",
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
  },

  // Crop UI
  cropWrap: {
    border: "1px solid #26282c",
    borderRadius: 12,
    overflow: "hidden",
    background: "#0f1012",
  },
  cropTopRow: {
    padding: 10,
    borderBottom: "1px solid #26282c",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
  },
  cropArea: {
    padding: 10,
  },
  cropControls: {
    padding: 10,
    borderTop: "1px solid #26282c",
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
    alignItems: "center",
    flexWrap: "wrap",
  },
};