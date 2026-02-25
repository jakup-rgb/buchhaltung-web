"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import Cropper, { Area } from "react-easy-crop";

type ReceiptItem = {
  id: string;
  name: string;
  webViewLink?: string | null;
  createdTime?: string | null;
};

type Category = "KFZ" | "MARKT" | "BUERO" | "RESTAURANT" | "SONSTIGES";
const CATEGORIES: Category[] = ["KFZ", "MARKT", "BUERO", "RESTAURANT", "SONSTIGES"];

type ReviewForm = {
  date: string;
  vendor: string;
  total: string;
  currency: string;
  category: Category;
  confidence: number; // 0..1
};

const HISTORY_KEY = "historyClearedAt";
const LAST_RESULT_KEY = "lastResult";
const MAX_VISIBLE_RECEIPTS = 50;

function fileExtToMime(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

// ---- Crop helpers ----
function createImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.crossOrigin = "anonymous";
    img.src = url;
  });
}

async function getCroppedBlob(imageSrc: string, crop: Area): Promise<Blob> {
  const image = await createImage(imageSrc);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D context");

  canvas.width = Math.max(1, Math.round(crop.width));
  canvas.height = Math.max(1, Math.round(crop.height));

  ctx.drawImage(
    image,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    canvas.width,
    canvas.height
  );

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

  // ---- File picker preview on main page ----
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  // ---- Review Modal ----
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewImageUrl, setReviewImageUrl] = useState<string | null>(null);

  // This is the image that will actually be uploaded (original or cropped)
  const [reviewBlob, setReviewBlob] = useState<Blob | null>(null);
  const [reviewFileName, setReviewFileName] = useState<string>("receipt.jpg");

  const [form, setForm] = useState<ReviewForm>({
    date: "",
    vendor: "",
    total: "",
    currency: "EUR",
    category: "SONSTIGES",
    confidence: 0,
  });

  // ---- Crop Modal ----
  const [cropOpen, setCropOpen] = useState(false);
  const [crop, setCrop] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);

  const excelLink = useMemo(() => result?.excel?.webViewLink ?? null, [result]);

  // -------------- helpers --------------
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
    setReviewBusy(false);
    setCropOpen(false);

    if (reviewImageUrl) URL.revokeObjectURL(reviewImageUrl);
    setReviewImageUrl(null);

    setReviewBlob(null);
    setReviewFileName("receipt.jpg");

    // reset crop state
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setCroppedAreaPixels(null);

    // also clear main file picker (optional)
    setFile(null);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
  };

  async function runPreviewExtraction(blobOrFile: Blob, nameForMime: string) {
    setReviewBusy(true);
    try {
      const fd = new FormData();
      const mime = (blobOrFile as any).type || fileExtToMime(nameForMime);
      const upFile = blobOrFile instanceof File ? blobOrFile : new File([blobOrFile], nameForMime, { type: mime });

      fd.append("image", upFile);

      const res = await fetch("/api/preview", { method: "POST", body: fd });
      if (!res.ok) return;

      const data = await res.json();
      const ex = data?.extracted ?? data ?? {};

      setForm({
        date: ex.date ?? "",
        vendor: ex.vendor ?? "",
        total:
          typeof ex.total === "number"
            ? String(ex.total)
            : typeof ex.total === "string"
            ? ex.total
            : "",
        currency: ex.currency ?? "EUR",
        category: (ex.category as Category) ?? "SONSTIGES",
        confidence: typeof ex.confidence === "number" ? ex.confidence : 0,
      });
    } finally {
      setReviewBusy(false);
    }
  }

  // -------------- Review Open (after file selection) --------------
  const openReview = async (originalFile: File) => {
    // set preview for modal
    const url = URL.createObjectURL(originalFile);
    setReviewImageUrl(url);

    // IMPORTANT: no auto-cropping anymore
    setReviewBlob(originalFile);
    setReviewFileName(originalFile.name || "receipt.jpg");

    // reset form before extraction
    setForm({
      date: "",
      vendor: "",
      total: "",
      currency: "EUR",
      category: "SONSTIGES",
      confidence: 0,
    });

    setReviewOpen(true);

    // run extraction
    await runPreviewExtraction(originalFile, originalFile.name || "receipt.jpg");
  };

  // ----- File picker -----
  const onPick = async (f: File | null) => {
    if (f) setResult(null);

    setFile(f);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(f ? URL.createObjectURL(f) : null);

    if (f) {
      await openReview(f);
    }
  };

  // -------------- Manual crop actions --------------
  const onCropComplete = (_: Area, croppedPixels: Area) => {
    setCroppedAreaPixels(croppedPixels);
  };

  const applyCrop = async () => {
    if (!reviewImageUrl || !croppedAreaPixels) {
      setCropOpen(false);
      return;
    }

    setReviewBusy(true);
    try {
      const cropped = await getCroppedBlob(reviewImageUrl, croppedAreaPixels);

      // update upload blob
      setReviewBlob(cropped);
      const newName = (reviewFileName || "receipt").replace(/\.\w+$/, "") + "_crop.jpg";
      setReviewFileName(newName);

      // update preview image
      const newUrl = URL.createObjectURL(cropped);
      if (reviewImageUrl) URL.revokeObjectURL(reviewImageUrl);
      setReviewImageUrl(newUrl);

      // re-run extraction on cropped image (usually improves accuracy)
      await runPreviewExtraction(cropped, newName);
    } finally {
      setReviewBusy(false);
      setCropOpen(false);
    }
  };

  // -------------- Upload (after confirm) --------------
  const confirmAndUpload = async () => {
    if (!reviewBlob) return;

    setBusy(true);
    try {
      const fd = new FormData();

      const mime = (reviewBlob as any).type || "image/jpeg";
      const uploadFile = reviewBlob instanceof File
        ? reviewBlob
        : new File([reviewBlob], reviewFileName || "receipt.jpg", { type: mime });

      fd.append("image", uploadFile);

      // overrides from modal
      const overrides = {
        date: form.date || null,
        vendor: form.vendor || null,
        total: form.total.trim() === "" ? null : Number(String(form.total).replace(",", ".")),
        currency: form.currency || null,
        category: form.category,
        confidence: form.confidence ?? 0,
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

      await loadReceipts();
      closeReview();
    } finally {
      setBusy(false);
    }
  };

  // Restore last result + history
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

  // Load list on login
  useEffect(() => {
    if (session) loadReceipts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Refilter when history changes
  useEffect(() => {
    setItems((prev) => applyHistoryFilter(prev, historyClearedAt));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyClearedAt]);

  // Close menu on outside click
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  // ---------- UI ----------
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

          {/* optional preview under input */}
          {preview && (
            <div style={{ marginTop: 12 }}>
              <img src={preview} alt="preview" style={styles.previewImg} />
            </div>
          )}

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

      {/* ---------- Review Modal ---------- */}
      {reviewOpen && (
        <div style={styles.modalOverlay} role="dialog" aria-modal="true">
          <div style={styles.modalCard}>
            <div style={styles.modalHeader}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 18 }}>Beleg prüfen</div>
                <div style={styles.mutedSmall}>
                  {reviewBusy ? "Analysiere…" : "Daten prüfen und ggf. korrigieren"}
                </div>
              </div>

              <button style={styles.modalClose} onClick={closeReview} disabled={reviewBusy || busy}>
                ✕
              </button>
            </div>

            <div style={styles.modalBody}>
              <div style={styles.modalGrid}>
                <div style={styles.modalPreview}>
                  {reviewImageUrl ? (
                    <img src={reviewImageUrl} alt="preview" style={styles.modalImg} />
                  ) : (
                    <div style={styles.muted}>Kein Preview</div>
                  )}
                </div>

                <div style={styles.modalForm}>
                  <label style={styles.label}>
                    Datum (YYYY-MM-DD)
                    <input
                      style={styles.input}
                      value={form.date}
                      onChange={(e) => setForm((p) => ({ ...p, date: e.target.value }))}
                      placeholder="2026-02-24"
                      disabled={reviewBusy || busy}
                    />
                  </label>

                  <label style={styles.label}>
                    Händler / Vendor
                    <input
                      style={styles.input}
                      value={form.vendor}
                      onChange={(e) => setForm((p) => ({ ...p, vendor: e.target.value }))}
                      placeholder="BILLA / OMV / ..."
                      disabled={reviewBusy || busy}
                    />
                  </label>

                  <label style={styles.label}>
                    Betrag
                    <input
                      style={styles.input}
                      value={form.total}
                      onChange={(e) => setForm((p) => ({ ...p, total: e.target.value }))}
                      placeholder="13.97"
                      inputMode="decimal"
                      disabled={reviewBusy || busy}
                    />
                  </label>

                  <label style={styles.label}>
                    Währung
                    <input
                      style={styles.input}
                      value={form.currency}
                      onChange={(e) => setForm((p) => ({ ...p, currency: e.target.value }))}
                      disabled={reviewBusy || busy}
                    />
                  </label>

                  <label style={styles.label}>
                    Kategorie
                    <select
                      style={styles.input}
                      value={form.category}
                      onChange={(e) => setForm((p) => ({ ...p, category: e.target.value as Category }))}
                      disabled={reviewBusy || busy}
                    >
                      {CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div style={{ ...styles.mutedSmall, marginTop: 8 }}>
                    Confidence: {Math.round((form.confidence ?? 0) * 100)}%
                  </div>
                </div>
              </div>
            </div>

            <div style={styles.modalFooter}>
              <button style={styles.secondaryBtn} onClick={closeReview} disabled={busy || reviewBusy}>
                Abbrechen
              </button>

              <button
                style={{ ...styles.secondaryBtn, opacity: busy || reviewBusy ? 0.6 : 1 }}
                onClick={() => setCropOpen(true)}
                disabled={busy || reviewBusy || !reviewImageUrl}
                title="Beleg manuell zuschneiden"
              >
                Manuell zuschneiden
              </button>

              <button
                style={{ ...styles.primaryBtn, opacity: busy || reviewBusy ? 0.6 : 1 }}
                onClick={confirmAndUpload}
                disabled={busy || reviewBusy}
              >
                {busy ? "Upload…" : "Bestätigen & Upload"}
              </button>
            </div>
          </div>

          {/* ---- Crop Modal (on top of review) ---- */}
          {cropOpen && reviewImageUrl && (
            <div style={styles.cropOverlay} role="dialog" aria-modal="true">
              <div style={styles.cropCard}>
                <div style={styles.cropHeader}>
                  <div style={{ fontWeight: 800 }}>Zuschneiden</div>
                  <button
                    style={styles.modalClose}
                    onClick={() => setCropOpen(false)}
                    disabled={reviewBusy}
                    aria-label="Schließen"
                  >
                    ✕
                  </button>
                </div>

                <div style={styles.cropBody}>
                  <div style={styles.cropperWrap}>
                    <Cropper
                      image={reviewImageUrl}
                      crop={crop}
                      zoom={zoom}
                      aspect={3 / 4} // typisch Beleg; wenn du "frei" willst: setz aspect={undefined} geht hier nicht, easy-crop braucht number
                      onCropChange={setCrop}
                      onZoomChange={setZoom}
                      onCropComplete={onCropComplete}
                      objectFit="contain"
                    />
                  </div>

                  <div style={styles.cropControls}>
                    <div style={{ fontWeight: 700, marginBottom: 8 }}>Zoom</div>
                    <input
                      type="range"
                      min={1}
                      max={3}
                      step={0.01}
                      value={zoom}
                      onChange={(e) => setZoom(Number(e.target.value))}
                      style={{ width: "100%" }}
                    />
                    <div style={{ ...styles.mutedSmall, marginTop: 8 }}>
                      Tipp: Rahmen ziehen/verschieben, dann „Übernehmen“.
                    </div>
                  </div>
                </div>

                <div style={styles.cropFooter}>
                  <button
                    style={styles.secondaryBtn}
                    onClick={() => setCropOpen(false)}
                    disabled={reviewBusy}
                  >
                    Abbrechen
                  </button>
                  <button
                    style={{ ...styles.primaryBtn, opacity: reviewBusy ? 0.6 : 1 }}
                    onClick={applyCrop}
                    disabled={reviewBusy}
                  >
                    Übernehmen
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </main>
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
  previewImg: { maxWidth: "100%", borderRadius: 12, border: "1px solid #2a2c31" },
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

  // Review modal
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
  modalClose: {
    background: "transparent",
    color: "#f3f3f3",
    border: "1px solid #2a2c31",
    borderRadius: 10,
    padding: "6px 10px",
    cursor: "pointer",
    fontWeight: 800,
  },
  modalBody: { padding: 14 },
  modalGrid: { display: "grid", gridTemplateColumns: "1fr", gap: 14 },
  modalPreview: {
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
  modalForm: {
    border: "1px solid #26282c",
    borderRadius: 12,
    background: "#0f1012",
    padding: 12,
    display: "grid",
    gap: 10,
  },
  label: {
    display: "grid",
    gap: 6,
    fontSize: 12,
    opacity: 0.9,
    fontWeight: 700,
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
    flexWrap: "wrap",
  },

  // Crop modal
  cropOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.75)",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    padding: 16,
    zIndex: 80,
  },
  cropCard: {
    width: "100%",
    maxWidth: 920,
    background: "#111214",
    border: "1px solid #26282c",
    borderRadius: 16,
    overflow: "hidden",
    boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
  },
  cropHeader: {
    padding: 12,
    borderBottom: "1px solid #2a2c31",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  cropBody: {
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: 12,
    padding: 12,
  },
  cropperWrap: {
    position: "relative",
    width: "100%",
    height: "50vh",
    minHeight: 280,
    background: "#0b0b0c",
    borderRadius: 12,
    border: "1px solid #26282c",
    overflow: "hidden",
  },
  cropControls: {
    border: "1px solid #26282c",
    borderRadius: 12,
    background: "#0f1012",
    padding: 12,
  },
  cropFooter: {
    padding: 12,
    borderTop: "1px solid #2a2c31",
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
  },
};