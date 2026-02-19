"use client";

import { useEffect, useState } from "react";
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

  const onPick = (f: File | null) => {
    setResult(null);
    setFile(f);
    setPreview(f ? URL.createObjectURL(f) : null);
  };

  const loadReceipts = async () => {
    if (!session) return;
    setLoadingList(true);
    try {
      const res = await fetch("/api/receipts");
      const text = await res.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }

      if (!res.ok) {
        setResult({ error: true, status: res.status, data });
        setItems([]);
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

      // Nach erfolgreichem Upload: Liste aktualisieren + Reset
      await loadReceipts();
      onPick(null);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (session) loadReceipts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  return (
    <main style={{ padding: 20, maxWidth: 720, margin: "0 auto" }}>
      <h1>Buchhaltung Web</h1>

      {status === "loading" ? (
        <p>Laden…</p>
      ) : !session ? (
        <button onClick={() => signIn("google")}>Mit Google anmelden</button>
      ) : (
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div>Angemeldet als {session.user?.email}</div>
          <button onClick={() => signOut()}>Logout</button>
        </div>
      )}

      <hr style={{ margin: "16px 0" }} />

      <h2 style={{ margin: "0 0 8px" }}>Neuen Beleg hochladen</h2>
      <p style={{ marginTop: 0, opacity: 0.8 }}>Am iPhone öffnet das die Kamera:</p>

      <input
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
        disabled={!session || busy}
      />

      {preview && (
        <div style={{ marginTop: 12 }}>
          <img
            src={preview}
            alt="preview"
            style={{ maxWidth: "100%", borderRadius: 8, border: "1px solid #333" }}
          />
        </div>
      )}

      <div style={{ marginTop: 12, display: "flex", gap: 12, flexWrap: "wrap" }}>
        <button onClick={upload} disabled={!session || !file || busy}>
          {busy ? "Upload…" : "Upload als PDF in Drive"}
        </button>
        <button onClick={() => onPick(null)} disabled={busy || (!file && !preview)}>
          Reset
        </button>

        {result?.excel?.webViewLink && (
          <a href={result.excel.webViewLink} target="_blank" rel="noreferrer">
            Excel öffnen
          </a>
        )}
      </div>

      {result && (
        <pre
          style={{
            marginTop: 12,
            background: "#111",
            color: "#0f0",
            padding: 12,
            borderRadius: 8,
            overflow: "auto",
          }}
        >
          {JSON.stringify(result, null, 2)}
        </pre>
      )}

      <hr style={{ margin: "16px 0" }} />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <h2 style={{ margin: 0 }}>Letzte Belege</h2>
        <button onClick={loadReceipts} disabled={!session || loadingList}>
          {loadingList ? "Laden…" : "Aktualisieren"}
        </button>
      </div>

      {!session ? (
        <p>Bitte einloggen, um Belege zu sehen.</p>
      ) : items.length === 0 ? (
        <p style={{ opacity: 0.7, marginTop: 12 }}>Noch keine Belege gefunden.</p>
      ) : (
        <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
          {items.map((it) => (
            <div
              key={it.id}
              style={{
                border: "1px solid #333",
                borderRadius: 10,
                padding: 12,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, wordBreak: "break-word" }}>{it.name}</div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>
                  {it.createdTime ? new Date(it.createdTime).toLocaleString() : ""}
                </div>
              </div>

              <div style={{ display: "flex", gap: 10, alignItems: "center", flexShrink: 0 }}>
                {it.webViewLink ? (
                  <a href={it.webViewLink} target="_blank" rel="noreferrer">
                    Öffnen
                  </a>
                ) : (
                  <span style={{ opacity: 0.6 }}>kein Link</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
