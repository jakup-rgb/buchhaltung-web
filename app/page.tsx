"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import { scanDocumentFromImage } from "@/lib/scanDocument";

type ReceiptItem = {
  id: string;
  name: string;
  webViewLink?: string | null;
  createdTime?: string | null;
};

type Extracted = {
  date?: string | null;
  vendor?: string | null;
  total?: number | string | null; // manche Extracts liefern string
  currency?: string | null;
  category?: string | null;
  confidence?: number | null;
};

const HISTORY_KEY = "historyClearedAt";
const LAST_RESULT_KEY = "lastResult";
const MAX_VISIBLE_RECEIPTS = 50;

const CATEGORIES = ["MARKT", "KFZ", "RESTAURANT", "BÜRO", "SONSTIGES"];

export default function Page() {
  const { data: session, status } = useSession();
  const isLoggedIn = !!session;

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);

  const [items, setItems] = useState<ReceiptItem[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const [historyClearedAt, setHistoryClearedAt] = useState<number>(0);

  // ----- Review Modal State -----
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [scanBlob, setScanBlob] = useState<Blob | null>(null);
  const [reviewImageUrl, setReviewImageUrl] = useState<string | null>(null);

  const [form, setForm] = useState<{
    date: string;
    vendor: string;
    total: string; // als String im Input
    currency: string;
    category: string;
    confidence: number;
  }>({
    date: "",
    vendor: "",
    total: "",
    currency: "EUR",
    category: "SONSTIGES",
    confidence: 0,
  });

  const excelLink = useMemo(() => result?.excel?.webViewLink ?? null, [result]);

  const clearHistoryView = () => {
    const ts = Date.now();
    setHistoryClearedAt(ts);
    localStorage.setItem(HISTORY_KEY, String(ts));
    setItems([]);
  };

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

  // ----- Review flow -----
  const openReview = async (originalFile: File) => {
    if (!session) return;

    setReviewOpen(true);
    setReviewBusy(true);
    setScanBlob(null);
    setReviewImageUrl(null);

    try {
      // 1) OpenCV scan/crop -> Blob
      const scanned = await scanDocumentFromImage(originalFile);
      setScanBlob(scanned);

      const imgUrl = URL.createObjectURL(scanned);
      setReviewImageUrl(imgUrl);

      // 2) Preview API: OCR/Extract (ohne Upload)
      const fd = new FormData();
      fd.append(
        "image",
        new File([scanned], originalFile.name || "scan.jpg", { type: "image/jpeg" })
      );

      const res = await fetch("/api/preview", { method: "POST", body: fd });
      const text = await res.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }

      if (!res.ok) {
        setResult({ error: true, status: res.status, data });
        setReviewOpen(false);
        return;
      }

      const ex: Extracted = data.extracted ?? {};

      const totalStr =
        typeof ex.total === "number"
          ? String(ex.total)
          : typeof ex.total === "string"
          ? ex.total
          : "";

      setForm({
        date: (ex.date ?? "") as any,
        vendor: (ex.vendor ?? "") as any,
        total: totalStr,
        currency: (ex.currency ?? "EUR") as any,
        category: (ex.category ?? "SONSTIGES") as any,
        confidence: typeof ex.confidence === "number" ? ex.confidence : 0,
      });
    } finally {
      setReviewBusy(false);
    }
  };

  const closeReview = () => {
    setReviewOpen(false);
    setReviewBusy(false);
    setScanBlob(null);

    if (reviewImageUrl) URL.revokeObjectURL(reviewImageUrl);
    setReviewImageUrl(null);

    // Auswahl zurücksetzen
    setFile(null);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
  };

  const confirmAndUpload = async () => {
    if (!file || !scanBlob) return;

    setBusy(true);
    try {
      const fd = new FormData();

      const scannedFile = new File([scanBlob], file.name || "scan.jpg", {
        type: "image/jpeg",
      });
      fd.append("image", scannedFile);

      const normalizedTotal =
        form.total.trim() === ""
          ? null
          : Number(String(form.total).replace(",", "."));

      const overrides = {
        date: form.date.trim() === "" ? null : form.date.trim(),
        vendor: form.vendor.trim() === "" ? null : form.vendor.trim(),
        total: Number.isFinite(normalizedTotal as any) ? normalizedTotal : null,
        currency: form.currency.trim() === "" ? null : form.currency.trim(),
        category: form.category || null,
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

  // ----- File picker -----
  const onPick = async (f: File | null) => {
    if (f) setResult(null);

    setFile(f);
    setPreview(f ? URL.createObjectURL(f) : null);

    if (f) {
      await openReview(f); // ✅ richtig
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

          {/* optional: preview unterm input */}
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
                    <img src={reviewImageUrl} alt="scan preview" style={styles.modalImg} />
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
                      onChange={(e) => setForm((p) => ({ ...p, category: e.target.value }))}
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
                style={{ ...styles.primaryBtn, opacity: busy || reviewBusy ? 0.6 : 1 }}
                onClick={confirmAndUpload}
                disabled={busy || reviewBusy}
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

  // Modal styles
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
  },
};