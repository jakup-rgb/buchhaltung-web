/* lib/scanDocument.ts
   OpenCV “Scanner”:
   - wartet bis cv geladen ist
   - findet größtes 4-Eck (Beleg)
   - sortiert Punkte korrekt (TL, TR, BR, BL)
   - Perspective Warp auf echte Zielgröße
   - Fallback: wenn kein Beleg gefunden → Originalbild als JPEG zurück
*/

declare const cv: any;

function waitForOpenCV(timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        // cv ist global von opencv.js
        if (typeof cv !== "undefined" && cv && cv.imread) return resolve();
      } catch {}
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("OpenCV not loaded (timeout)"));
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// sortiert 4 Punkte zu: [topLeft, topRight, bottomRight, bottomLeft]
function orderPoints(pts: { x: number; y: number }[]) {
  const sum = pts.map((p) => p.x + p.y);
  const diff = pts.map((p) => p.x - p.y);

  const tl = pts[sum.indexOf(Math.min(...sum))];
  const br = pts[sum.indexOf(Math.max(...sum))];
  const tr = pts[diff.indexOf(Math.min(...diff))];
  const bl = pts[diff.indexOf(Math.max(...diff))];

  return [tl, tr, br, bl];
}

async function fileToJpegBlob(file: File, quality = 0.95): Promise<Blob> {
  const imageBitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = imageBitmap.width;
  canvas.height = imageBitmap.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(imageBitmap, 0, 0);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))),
      "image/jpeg",
      quality
    );
  });
}

export async function scanDocumentFromImage(imageFile: File): Promise<Blob> {
  // ✅ sicherstellen dass OpenCV bereit ist
  try {
    await waitForOpenCV();
  } catch {
    // Fallback: OpenCV nicht da → einfach als JPEG zurück
    return fileToJpegBlob(imageFile);
  }

  const imageBitmap = await createImageBitmap(imageFile);

  // Arbeitscanvas
  const canvas = document.createElement("canvas");
  canvas.width = imageBitmap.width;
  canvas.height = imageBitmap.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(imageBitmap, 0, 0);

  // OpenCV Mats
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edged = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  // Preprocess
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  // etwas stärkerer blur für stabilere edges
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

  // Edges
  cv.Canny(blurred, edged, 75, 200);

  // Konturen finden
  cv.findContours(edged, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

  let bestApprox: any = null;
  let maxArea = 0;

  // größtes 4-eck suchen
  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i);
    const area = cv.contourArea(contour);
    if (area < 1000) continue; // zu klein ignorieren

    const peri = cv.arcLength(contour, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(contour, approx, 0.02 * peri, true);

    if (approx.rows === 4 && area > maxArea) {
      if (bestApprox) bestApprox.delete?.();
      bestApprox = approx;
      maxArea = area;
    } else {
      approx.delete?.();
    }
  }

  // Wenn kein 4-eck gefunden → fallback
  if (!bestApprox) {
    src.delete();
    gray.delete();
    blurred.delete();
    edged.delete();
    contours.delete();
    hierarchy.delete();

    return fileToJpegBlob(imageFile);
  }

  // Punkte aus approx lesen
  // approx.data32S enthält [x0,y0,x1,y1,x2,y2,x3,y3]
  const pts = [
    { x: bestApprox.data32S[0], y: bestApprox.data32S[1] },
    { x: bestApprox.data32S[2], y: bestApprox.data32S[3] },
    { x: bestApprox.data32S[4], y: bestApprox.data32S[5] },
    { x: bestApprox.data32S[6], y: bestApprox.data32S[7] },
  ];

  const [tl, tr, br, bl] = orderPoints(pts);

  // Zielbreite/-höhe anhand der Distanzen berechnen
  const widthA = distance(br, bl);
  const widthB = distance(tr, tl);
  const maxW = Math.max(widthA, widthB);

  const heightA = distance(tr, br);
  const heightB = distance(tl, bl);
  const maxH = Math.max(heightA, heightB);

  const dstW = Math.max(1, Math.round(maxW));
  const dstH = Math.max(1, Math.round(maxH));

  // Source / Dest Mat für Perspective Transform
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    tl.x, tl.y,
    tr.x, tr.y,
    br.x, br.y,
    bl.x, bl.y,
  ]);

  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    dstW - 1, 0,
    dstW - 1, dstH - 1,
    0, dstH - 1,
  ]);

  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  const dst = new cv.Mat();

  cv.warpPerspective(src, dst, M, new cv.Size(dstW, dstH));

  // Ergebnis in canvas schreiben
  const outCanvas = document.createElement("canvas");
  outCanvas.width = dstW;
  outCanvas.height = dstH;
  cv.imshow(outCanvas, dst);

  // Cleanup
  src.delete();
  gray.delete();
  blurred.delete();
  edged.delete();
  contours.delete();
  hierarchy.delete();
  bestApprox.delete?.();
  srcTri.delete();
  dstTri.delete();
  M.delete();
  dst.delete();

  // Blob erzeugen
  return await new Promise<Blob>((resolve, reject) => {
    outCanvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))),
      "image/jpeg",
      0.95
    );
  });
}