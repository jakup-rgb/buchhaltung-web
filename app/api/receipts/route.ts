import { NextResponse } from "next/server";
import { google } from "googleapis";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    // @ts-expect-error
    const accessToken = session?.accessToken;

    if (!accessToken) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    const drive = google.drive({ version: "v3", auth });

    // Bei drive.file: wir sehen sowieso nur Dateien, die unsere App erstellt hat.
    // Daher: einfach alle PDFs auflisten, newest first.
    const res = await drive.files.list({
      q: `mimeType='application/pdf' and trashed=false`,
      pageSize: 30,
      orderBy: "createdTime desc",
      fields: "files(id,name,webViewLink,createdTime)",
      spaces: "drive",
    });

    const items = 
      res.data.files?.map((f) => ({
        id: f.id!,
        name: f.name ?? "", 
        webViewLink: f.webViewLink ?? null,
        createdTime: f.createdTime ?? null,
      })) ?? [];

    return NextResponse.json({ items });
  } catch (e: any) {
    console.error("RECEIPTS_ERROR", e);
    return NextResponse.json(
      { error: "Failed to list receipts", message: e?.message ?? String(e) },
      { status: 500 }
    );
  }
}
