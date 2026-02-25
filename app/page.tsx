"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import Cropper from "react-easy-crop";
import { cropImageToBlob, type CroppedAreaPixels } from "@/lib/cropImage";

type ReceiptItem = {
  id: string;
  name: string;
  webViewLink?: string | null;
  createdTime?: string | null;
};

type Category = "KFZ" | "MARKT" | "BUERO" | "RESTAURANT" | "SONSTIGES";

type ReviewForm = {
  date: string;
  time: string;
  vendor: string;
  total: string;
  currency: string;
  category: Category;
  invoiceNumber: string;
  companyType: "INTERN" | "EXTERN";
  internalCompany: "RWD" | "DIEM" | "";
  confidence: number;
};

const HISTORY_KEY = "historyClearedAt";
const LAST_RESULT_KEY = "lastResult";
const MAX_VISIBLE_RECEIPTS = 50;

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

  // Datei + Preview
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Modal / Review
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

  // Crop
  const [cropMode, setCropMode] = useState(false);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<CroppedAreaPixels | null>(null);

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
    setCropMode(false);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setCroppedAreaPixels(null);
  };

  const openReviewForFile = async (f: File) => {
    setResult(null);
    setReviewBusy(true);

    // alte preview url freigeben
    if (previewUrl) URL.revokeObjectURL(previewUrl);

    setPickedFile(f);
    const url = URL.createObjectURL(f);
    setPreviewUrl(url);

    // defaults reset
    setReviewForm((p) => ({
      ...p,
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
    }));

    setReviewOpen(true);

    // Extract
    try {
      const fd = new FormData();
      fd.append("image", f);

      const res = await fetch("/api/extract", { method: "POST", body: fd });
      const text = await res.text();

      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }

      if (res.ok) {
        const ex = data?.extracted ?? {};
        setReviewForm((prev) => ({
          ...prev,
          date: ex.date ?? "",
          time: ex.time ?? "",
          vendor: ex.vendor ?? "",
          total:
            typeof ex.total === "number" ? String(ex.total)
            : typeof ex.total === "string" ? ex.total
            : "",
          currency: ex.currency ?? "EUR",
          category: (ex.category as Category) ?? "SONSTIGES",
          invoiceNumber: ex.invoiceNumber ?? "",
          companyType: ex.companyType === "INTERN" ? "INTERN" : "EXTERN",
          internalCompany: ex.internalCompany ?? "",
          confidence: typeof ex.confidence === "number" ? ex.confidence : 0,
        }));
      } else {
        setResult({ error: true, where: "/api/extract", status: res.status, data });
      }
    } catch (e: any) {
      setResult({ error: true, where: "/api/extract", message: e?.message ?? String(e) });
    } finally {
      setReviewBusy(false);
    }
  };

  const onPick = async (f: File | null) => {
    if (!f) return;
    await openReviewForFile(f);
  };

  const onCropComplete = (_: any, croppedPixels: CroppedAreaPixels) => {
    setCroppedAreaPixels(croppedPixels);
  };

  const confirmAndUpload = async () => {
    if (!pickedFile || !previewUrl) return;

    setBusy(true);
    try {
      let uploadFile = pickedFile;

      // wenn Crop aktiv und crop area vorhanden → zuschneiden
      if (cropMode && croppedAreaPixels) {
        const croppedBlob = await cropImageToBlob(previewUrl, croppedAreaPixels, 0.95);
        uploadFile = new File(
          [croppedBlob],
          pickedFile.name.replace(/\.\w+$/, "") + "_crop.jpg",
          { type: "image/jpeg" }
        );
      }

      const fd = new FormData();
      fd.append("image", uploadFile);

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

      await loadReceipts();
      closeReview();
    } finally {
      setBusy(false);
    }
  };

  // restore last result + history
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

  if (!isLoggedIn) {
    return (
      <main style={styles.page}>
        <div style={{ width: "100%", maxWidth: 820 }}>
          <h1 style={styles.titleTop}>Buchhaltung Web</h1>
          <p style={styles.subtitleTop}>Belege fotografieren und automatisch in Drive + Excel speichern.</p>
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
        <div style={styles.headerRow}>
          <div>
            <h1 style={styles.title}>Buchhaltung Web</h1>
            <div style={styles.mutedSmall}>Angemeldet {session.user?.email}</div>
          </div>

          <div style={{ position: "relative" }} ref={menuRef}>
            <button style={styles.menuBtn} onClick={() => setMenuOpen((v) => !v)} aria-label="Menü" title="Menü">
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

        <section>
          <div style={styles.sectionHeaderRow}>
            <h2 style={styles.sectionTitle}>Letzte Belege</h2>

            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button style={{ ...styles.secondaryBtn, opacity: loadingList ? 0.6 : 1 }} onClick={loadReceipts} disabled={loadingList}>
                {loadingList ? "Laden…" : "Aktualisieren"}
              </button>

              <button style={{ ...styles.secondaryBtn, opacity: loadingList ? 0.6 : 1 }} onClick={clearHistoryView} disabled={loadingList}>
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
                    <div style={styles.itemMeta}>{it.createdTime ? new Date(it.createdTime).toLocaleString() : ""}</div>
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
                <div style={styles.mutedSmall}>{reviewBusy ? "Analysiere…" : "Daten prüfen und ggf. korrigieren"}</div>
              </div>

              <button style={styles.modalClose} onClick={closeReview} disabled={reviewBusy || busy}>
                ✕
              </button>
            </div>

            <div style={styles.modalBody}>
              {/* Bildbereich */}
              <div style={styles.modalPreview}>
                {previewUrl ? (
                  cropMode ? (
                    <div style={{ position: "relative", width: "100%", height: 320, background: "#000", borderRadius: 12, overflow: "hidden" }}>
                      <Cropper
                        image={previewUrl}
                        crop={crop}
                        zoom={zoom}
                        aspect={3 / 4}
                        onCropChange={setCrop}
                        onZoomChange={setZoom}
                        onCropComplete={onCropComplete}
                      />
                    </div>
                  ) : (
                    <div style={{ width: "100%", height: 320, borderRadius: 12, overflow: "hidden", background: "#000" }}>
                      <img
                        src={previewUrl}
                        alt="preview"
                        style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
                      />
                    </div>
                  )
                ) : (
                  <div style={styles.muted}>Kein Preview</div>
                )}
              </div>

              {/* Formular */}
              <div style={styles.modalForm}>
                <label style={styles.label}>
                  Datum (YYYY-MM-DD)
                  <input style={styles.input} value={reviewForm.date} onChange={(e) => setReviewForm((p) => ({ ...p, date: e.target.value }))} disabled={reviewBusy || busy} />
                </label>

                <label style={styles.label}>
                  Uhrzeit (optional)
                  <input style={styles.input} value={reviewForm.time} onChange={(e) => setReviewForm((p) => ({ ...p, time: e.target.value }))} disabled={reviewBusy || busy} />
                </label>

                <label style={styles.label}>
                  Händler / Vendor
                  <input style={styles.input} value={reviewForm.vendor} onChange={(e) => setReviewForm((p) => ({ ...p, vendor: e.target.value }))} disabled={reviewBusy || busy} />
                </label>

                <label style={styles.label}>
                  Betrag
                  <input style={styles.input} value={reviewForm.total} onChange={(e) => setReviewForm((p) => ({ ...p, total: e.target.value }))} inputMode="decimal" disabled={reviewBusy || busy} />
                </label>

                <label style={styles.label}>
                  Währung
                  <input style={styles.input} value={reviewForm.currency} onChange={(e) => setReviewForm((p) => ({ ...p, currency: e.target.value }))} disabled={reviewBusy || busy} />
                </label>

                <label style={styles.label}>
                  Kategorie
                  <select style={styles.input} value={reviewForm.category} onChange={(e) => setReviewForm((p) => ({ ...p, category: e.target.value as Category }))} disabled={reviewBusy || busy}>
                    <option value="KFZ">KFZ</option>
                    <option value="MARKT">MARKT</option>
                    <option value="BUERO">BUERO</option>
                    <option value="RESTAURANT">RESTAURANT</option>
                    <option value="SONSTIGES">SONSTIGES</option>
                  </select>
                </label>

                <label style={styles.label}>
                  Rechnungsnummer (optional)
                  <input style={styles.input} value={reviewForm.invoiceNumber} onChange={(e) => setReviewForm((p) => ({ ...p, invoiceNumber: e.target.value }))} disabled={reviewBusy || busy} />
                </label>

                <label style={styles.label}>
                  Firma (Intern/Extern)
                  <select
                    style={styles.input}
                    value={reviewForm.companyType}
                    onChange={(e) => setReviewForm((p) => ({ ...p, companyType: e.target.value as "INTERN" | "EXTERN" }))}
                    disabled={reviewBusy || busy}
                  >
                    <option value="EXTERN">EXTERN</option>
                    <option value="INTERN">INTERN</option>
                  </select>
                </label>

                {reviewForm.companyType === "INTERN" && (
                  <label style={styles.label}>
                    Interne Firma
                    <select
                      style={styles.input}
                      value={reviewForm.internalCompany}
                      onChange={(e) => setReviewForm((p) => ({ ...p, internalCompany: e.target.value as "RWD" | "DIEM" | "" }))}
                      disabled={reviewBusy || busy}
                    >
                      <option value="">Bitte wählen…</option>
                      <option value="RWD">RWD</option>
                      <option value="DIEM">DIEM</option>
                    </select>
                  </label>
                )}

                <div style={{ marginTop: 8, opacity: 0.8 }}>
                  Confidence: {Math.round((reviewForm.confidence ?? 0) * 100)}%
                </div>
              </div>
            </div>

            <div style={styles.modalFooter}>
              <button style={styles.secondaryBtn} onClick={closeReview} disabled={busy || reviewBusy}>
                Abbrechen
              </button>

              <button style={styles.secondaryBtn} onClick={() => setCropMode((v) => !v)} disabled={busy || reviewBusy || !previewUrl}>
                {cropMode ? "Crop fertig" : "Manuell zuschneiden"}
              </button>

              <button style={styles.primaryBtn} onClick={confirmAndUpload} disabled={busy || reviewBusy}>
                {busy ? "Upload…" : "Bestätigen & Upload"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

/* -------- Minimal Styles (du kannst deine behalten, wichtig sind modal styles) -------- */
const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: "100dvh", padding: 18, background: "#0b0b0c", color: "#f3f3f3", display: "flex", justifyContent: "center" },
  card: { width: "100%", maxWidth: 820, background: "#111214", border: "1px solid #26282c", borderRadius: 16, padding: 18 },
  headerRow: { display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" },
  title: { margin: 0, fontSize: 34 },
  sectionTitle: { margin: 0, fontSize: 18 },
  sectionHeaderRow: { display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" },
  muted: { opacity: 0.8, margin: 0 },
  mutedSmall: { opacity: 0.75, fontSize: 12, marginTop: 6 },
  hr: { margin: "16px 0", border: "none", borderTop: "1px solid #2a2c31" },
  uploadRow: { marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" },
  fileInput: { background: "#0d0e10", border: "1px solid #2a2c31", borderRadius: 10, padding: 10, color: "#f3f3f3" },
  primaryBtn: { background: "#f3f3f3", color: "#0b0b0c", border: "none", borderRadius: 10, padding: "10px 14px", cursor: "pointer", fontWeight: 700 },
  secondaryBtn: { background: "transparent", color: "#f3f3f3", border: "1px solid #2a2c31", borderRadius: 10, padding: "10px 14px", cursor: "pointer", fontWeight: 600 },
  linkBtn: { color: "#f3f3f3", textDecoration: "none", border: "1px solid #2a2c31", borderRadius: 10, padding: "10px 14px", display: "inline-block" },
  detailsSummary: { cursor: "pointer", opacity: 0.9 },
  codeBlock: { marginTop: 10, background: "#0b0b0c", color: "#45ff6a", padding: 12, borderRadius: 12, overflow: "auto", border: "1px solid #26282c", maxHeight: 360 },
  listItem: { border: "1px solid #26282c", borderRadius: 12, padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, background: "#0f1012" },
  itemTitle: { fontWeight: 700, wordBreak: "break-word" },
  itemMeta: { fontSize: 12, opacity: 0.7, marginTop: 4 },
  menuBtn: { background: "transparent", color: "#f3f3f3", border: "1px solid #2a2c31", borderRadius: 10, padding: "8px 10px", cursor: "pointer", fontSize: 18, lineHeight: 1 },
  menuDropdown: { position: "absolute", top: 42, right: 0, minWidth: 180, background: "#0f1012", border: "1px solid #26282c", borderRadius: 12, overflow: "hidden", zIndex: 10 },
  menuItem: { width: "100%", textAlign: "left", background: "transparent", color: "#f3f3f3", border: "none", padding: "12px 12px", cursor: "pointer", fontWeight: 700 },
  titleTop: { margin: 0, fontSize: 36, textAlign: "center" },
  subtitleTop: { opacity: 0.8, marginTop: 8, textAlign: "center" },
  loginCenter: { position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)" },
  primaryBtnLarge: { background: "#f3f3f3", color: "#0b0b0c", border: "none", borderRadius: 14, padding: "16px 28px", cursor: "pointer", fontWeight: 700, fontSize: 18 },

  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 1000 },
  modalCard: { width: "100%", maxWidth: 980, background: "#111214", border: "1px solid #26282c", borderRadius: 16, overflow: "hidden" },
  modalHeader: { display: "flex", justifyContent: "space-between", gap: 12, padding: 14, borderBottom: "1px solid #26282c" },
  modalClose: { background: "transparent", color: "#f3f3f3", border: "1px solid #2a2c31", borderRadius: 10, padding: "8px 10px", cursor: "pointer" },

  modalBody: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, padding: 14, maxHeight: "75vh", overflow: "auto" },
  modalPreview: { display: "grid", gap: 10 },
  modalForm: { display: "grid", gap: 10, alignContent: "start" },

  label: { display: "grid", gap: 6, fontWeight: 700 },
  input: { background: "#0d0e10", border: "1px solid #2a2c31", borderRadius: 10, padding: 10, color: "#f3f3f3" },

  modalFooter: { display: "flex", justifyContent: "flex-end", gap: 10, padding: 14, borderTop: "1px solid #26282c" },
};