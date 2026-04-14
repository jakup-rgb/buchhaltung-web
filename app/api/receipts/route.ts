import { NextResponse } from "next/server";
import { google } from "googleapis";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

async function listChildFolders(drive: any, parentId: string) {
  const res = await drive.files.list({
    q: `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id,name)",
    spaces: "drive",
    pageSize: 200,
  });
  return res.data.files ?? [];
}

async function listPdfsInFolder(drive: any, folderId: string, userEmail: string) {
  const safeEmail = userEmail.replace(/'/g, "\\'");

  const res = await drive.files.list({
    q: `'${folderId}' in parents and mimeType='application/pdf' and trashed=false and properties has { key='uploadedBy' and value='${safeEmail}' }`,
    fields: "files(id,name,webViewLink,createdTime,properties)",
    spaces: "drive",
    orderBy: "createdTime desc",
    pageSize: 200,
  });
  return res.data.files ?? [];
}

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    // @ts-expect-error
    const accessToken = session?.accessToken;
    const userEmail = session?.user?.email;

    if (!accessToken || !userEmail) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    const drive = google.drive({ version: "v3", auth });

    const rootFolderIdFromEnv = process.env.DRIVE_ROOT_FOLDER_ID?.trim();
    const rootName = process.env.DRIVE_ROOT_FOLDER || "Belege";
    const safeEmail = userEmail.replace(/'/g, "\\'");

    if (!rootFolderIdFromEnv) {
      // Fallback: ohne festen Root-Ordner, aber trotzdem nur eigene Uploads
      const res = await drive.files.list({
        q: `mimeType='application/pdf' and trashed=false and properties has { key='uploadedBy' and value='${safeEmail}' }`,
        pageSize: 30,
        orderBy: "createdTime desc",
        fields: "files(id,name,webViewLink,createdTime,properties)",
        spaces: "drive",
      });

      const items =
        res.data.files?.map((f) => ({
          id: f.id!,
          name: f.name ?? "",
          webViewLink: f.webViewLink ?? null,
          createdTime: f.createdTime ?? null,
        })) ?? [];

      return NextResponse.json({ items, root: { mode: "name", rootName } });
    }

    const rootId = rootFolderIdFromEnv;

    // Rekursiv: Root -> Unterordner -> PDFs
    const queue: string[] = [rootId];
    const pdfs: any[] = [];

    while (queue.length) {
      const current = queue.shift()!;
      const folders = await listChildFolders(drive, current);
      for (const f of folders) queue.push(f.id!);

      const files = await listPdfsInFolder(drive, current, userEmail);
      pdfs.push(...files);
    }

    // Sort newest first + limit 30
    pdfs.sort((a, b) => {
      const ta = a.createdTime ? new Date(a.createdTime).getTime() : 0;
      const tb = b.createdTime ? new Date(b.createdTime).getTime() : 0;
      return tb - ta;
    });

    const items = pdfs.slice(0, 30).map((f) => ({
      id: f.id!,
      name: f.name ?? "",
      webViewLink: f.webViewLink ?? null,
      createdTime: f.createdTime ?? null,
    }));

    return NextResponse.json({ items, root: { mode: "id", rootId } });
  } catch (e: any) {
    console.error("RECEIPTS_ERROR", e);
    return NextResponse.json(
      { error: "Failed to list receipts", message: e?.message ?? String(e) },
      { status: 500 }
    );
  }
}