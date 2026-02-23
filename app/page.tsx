"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { signIn, signOut, useSession } from "next-auth/react";

type ReceiptItem = {
  id: string;
  name: string;
  webViewLink?: string | null;
  createdTime?: string | null;
};

export default function Page() {
  const { data: session, status } = useSession();

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);

  const [items, setItems] = useState<ReceiptItem[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const isLoggedIn = !!session;

  const onPick = (f: File | null) => {
    if (f) setResult(null);
    setFile(f);
    setPreview(f ? URL.createObjectURL(f) : null);
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

      setItems((data.items ?? []) as ReceiptItem[]);
    } finally {
      setLoadingList(false);
    }
  };

  const upload = async () => {
    if (!file) return;

    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("image", file);

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
      localStorage.setItem("lastResult", JSON.stringify(data));

      // Liste aktualisieren + Reset
      await loadReceipts();
      onPick(null);
    } finally {
      setBusy(false);
    }
  };

  // lastResult wiederherstellen (damit’s nicht “weg” ist)
  useEffect(() => {
    const saved = localStorage.getItem("lastResult");
    if (saved) {
      try {
        setResult(JSON.parse(saved));
      } catch {}
    }
  }, []);

  // Beim Login Liste laden
  useEffect(() => {
    if (session) loadReceipts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Menü schließen bei Klick außerhalb
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const excelLink = useMemo(() => result?.excel?.webViewLink ?? null, [result]);

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

  // ✅ Startscreen (nicht eingeloggt)
  if (!isLoggedIn) {
    return (
      <main style={styles.page}>
        <div style={styles.card}>
          <h1 style={styles.title}>Buchhaltung Web</h1>
          <p style={{ ...styles.muted, marginTop: 6 }}>
            Belege fotografieren und automatisch in Drive + Excel speichern.
          </p>

          <div style={{ marginTop: 18 }}>
            <button style={styles.primaryBtn} onClick={() => signIn("google")}>
              Login
            </button>
          </div>
        </div>
      </main>
    );
  }

  // ✅ Eingeloggt
  return (
    <main style={styles.page}>
      <div style={styles.card}>
        {/* Header */}
        <div style={styles.headerRow}>
          <div>
            <h1 style={styles.title}>Buchhaltung Web</h1>
            <div style={styles.mutedSmall}>Angemeldet als {session.user?.email}</div>
          </div>

          {/* Menü oben rechts */}
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

        {/* Upload Bereich */}
        <section>
          <h2 style={styles.sectionTitle}>Neuen Beleg hochladen</h2>
          <p style={{ ...styles.muted, marginTop: 6 }}>
            Am iPhone öffnet das die Kamera.
          </p>

          <div style={styles.uploadRow}>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => onPick(e.target.files?.[0] ?? null)}
              disabled={busy}
              style={styles.fileInput}
            />

            <button
              style={{ ...styles.primaryBtn, opacity: !file || busy ? 0.6 : 1 }}
              onClick={upload}
              disabled={!file || busy}
            >
              {busy ? "Upload…" : "Upload"}
            </button>

            <button
              style={{ ...styles.secondaryBtn, opacity: busy ? 0.6 : 1 }}
              onClick={() => onPick(null)}
              disabled={busy || (!file && !preview)}
            >
              Reset
            </button>

            {excelLink && (
              <a style={styles.linkBtn} href={excelLink} target="_blank" rel="noreferrer">
                Excel öffnen
              </a>
            )}
          </div>

          {preview && (
            <div style={{ marginTop: 12 }}>
              <img
                src={preview}
                alt="preview"
                style={styles.previewImg}
              />
            </div>
          )}

          {/* Debug / Ergebnis (nicht mehr so riesig, aber verfügbar) */}
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

              {/* “Verlauf löschen” machen wir später (API + Drive Delete) */}
              <button style={{ ...styles.secondaryBtn, opacity: 0.5 }} disabled title="Kommt später">
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
    </main>
  );
}

/* ---------------- Styles ---------------- */

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100d  vh",
    padding: 18,
    background: "#0b0b0c",
    color: "#f3f3f3",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
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
  title: {
    margin: 0,
    fontSize: 34,
    letterSpacing: 0.2,
  },
  sectionTitle: {
    margin: 0,
    fontSize: 18,
  },
  sectionHeaderRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "center",
    flexWrap: "wrap",
  },
  muted: {
    opacity: 0.8,
    margin: 0,
  },
  mutedSmall: {
    opacity: 0.75,
    fontSize: 12,
    marginTop: 6,
  },
  hr: {
    margin: "16px 0",
    border: "none",
    borderTop: "1px solid #2a2c31",
  },
  uploadRow: {
    marginTop: 10,
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
    alignItems: "center",
  },
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
  previewImg: {
    maxWidth: "100%",
    borderRadius: 12,
    border: "1px solid #2a2c31",
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
  detailsSummary: {
    cursor: "pointer",
    opacity: 0.9,
  },
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
  itemTitle: {
    fontWeight: 700,
    wordBreak: "break-word",
  },
  itemMeta: {
    fontSize: 12,
    opacity: 0.7,
    marginTop: 4,
  },
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
};