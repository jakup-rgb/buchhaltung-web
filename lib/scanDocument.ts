/* lib/scanDocument.ts
   OpenCV “Scanner” (robuster):
   - wartet bis cv geladen ist
   - downscale für Stabilität/Speed
   - edges + morph close
   - findet bestes 4-Eck (Area + rectangularity)
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

/** Score: wie “rechteckig” ist das 4-Eck im Vergleich zur BoundingRect? 0..1 */
function rectangularityScore(quad: any) {
  // quad: approx Mat (4 Punkte)
  const cnt = quad;
  const area = cv.contourArea(cnt);
  const rect = cv.boundingRect(cnt);
  const rectArea = rect.width * rect.height;
  if (!rectArea) return 0;
  return area / rectArea;
}

export async function scanDocumentFromImage(imageFile: File): Promise<Blob> {
  try {
    await waitForOpenCV();
  } catch {
    return fileToJpegBlob(imageFile);
  }

  const imageBitmap = await createImageBitmap(imageFile);

  // Canvas from input
  const canvas = document.createElement("canvas");
  canvas.width = imageBitmap.width;
  canvas.height = imageBitmap.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(imageBitmap, 0, 0);

  // Read to Mat
  const srcFull = cv.imread(canvas);

  // --- Downscale (stabiler + schneller) ---
  const maxDim = 1200; // gute Balance
  const scale = Math.min(1, maxDim / Math.max(srcFull.cols, srcFull.rows));
  const src = new cv.Mat();
  if (scale < 1) {
    const dsize = new cv.Size(Math.round(srcFull.cols * scale), Math.round(srcFull.rows * scale));
    cv.resize(srcFull, src, dsize, 0, 0, cv.INTER_AREA);
  } else {
    srcFull.copyTo(src);
  }

  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edged = new cv.Mat();
  const closed = new cv.Mat();

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  // Preprocess: gray
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  // Blur: bilateral ist bei Papier oft besser als Gaussian (Kanten bleiben schärfer)
  // fallback: Gaussian
  try {
    cv.bilateralFilter(gray, blurred, 9, 75, 75);
  } catch {
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
  }

  // Canny edges
  cv.Canny(blurred, edged, 50, 150);

  // Morph close: Kanten “schließen” (wichtig bei Kassenzettel, wo Kanten unterbrochen sind)
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  cv.morphologyEx(edged, closed, cv.MORPH_CLOSE, kernel);

  // Contours
  cv.findContours(closed, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

  let bestApprox: any = null;
  let bestScore = 0;

  const imgArea = src.cols * src.rows;

  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i);
    const area = cv.contourArea(contour);

    // zu klein weg
    if (area < imgArea * 0.05) continue; // <5% der Fläche ignorieren

    const peri = cv.arcLength(contour, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(contour, approx, 0.02 * peri, true);

    if (approx.rows === 4) {
      // Score: große Fläche + rechteckig
      const rectScore = rectangularityScore(approx); // 0..1
      const areaScore = area / imgArea;               // 0..1

      const score = areaScore * 0.8 + rectScore * 0.2;

      // Extra: sehr “schlanke” Rechtecke können falsch sein → rectScore hilft
      if (score > bestScore) {
        if (bestApprox) bestApprox.delete?.();
        bestApprox = approx;
        bestScore = score;
      } else {
        approx.delete?.();
      }
    } else {
      approx.delete?.();
    }
  }

  // Fallback
  if (!bestApprox) {
    // cleanup
    srcFull.delete();
    src.delete();
    gray.delete();
    blurred.delete();
    edged.delete();
    closed.delete();
    contours.delete();
    hierarchy.delete();
    kernel.delete();

    return fileToJpegBlob(imageFile);
  }

  // Punkte aus approx lesen (scaled Koordinaten)
  const ptsScaled = [
    { x: bestApprox.data32S[0], y: bestApprox.data32S[1] },
    { x: bestApprox.data32S[2], y: bestApprox.data32S[3] },
    { x: bestApprox.data32S[4], y: bestApprox.data32S[5] },
    { x: bestApprox.data32S[6], y: bestApprox.data32S[7] },
  ];

  // zurück auf Full-Resolution (wenn gescaled)
  const invScale = scale < 1 ? 1 / scale : 1;
  const pts = ptsScaled.map((p) => ({ x: p.x * invScale, y: p.y * invScale }));

  const [tl, tr, br, bl] = orderPoints(pts);

  // Zielgröße berechnen
  const widthA = distance(br, bl);
  const widthB = distance(tr, tl);
  const maxW = Math.max(widthA, widthB);

  const heightA = distance(tr, br);
  const heightB = distance(tl, bl);
  const maxH = Math.max(heightA, heightB);

  const dstW = Math.max(1, Math.round(maxW));
  const dstH = Math.max(1, Math.round(maxH));

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

  // Warp auf FULL-res Quelle (wichtig!)
  cv.warpPerspective(srcFull, dst, M, new cv.Size(dstW, dstH));

  // Optional: “scanner look” leicht erhöhen (kannst du aktivieren)
  // const dstGray = new cv.Mat();
  // cv.cvtColor(dst, dstGray, cv.COLOR_RGBA2GRAY);
  // cv.adaptiveThreshold(dstGray, dstGray, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 21, 10);
  // cv.cvtColor(dstGray, dst, cv.COLOR_GRAY2RGBA);
  // dstGray.delete();

  const outCanvas = document.createElement("canvas");
  outCanvas.width = dstW;
  outCanvas.height = dstH;
  cv.imshow(outCanvas, dst);

  // Cleanup
  srcFull.delete();
  src.delete();
  gray.delete();
  blurred.delete();
  edged.delete();
  closed.delete();
  contours.delete();
  hierarchy.delete();
  kernel.delete();
  bestApprox.delete?.();
  srcTri.delete();
  dstTri.delete();
  M.delete();
  dst.delete();

  return await new Promise<Blob>((resolve, reject) => {
    outCanvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))),
      "image/jpeg",
      0.95
    );
  });
}