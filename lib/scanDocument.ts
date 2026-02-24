declare const cv: any;

export async function scanDocumentFromImage(
  imageFile: File
): Promise<Blob> {
  const imageBitmap = await createImageBitmap(imageFile);

  const canvas = document.createElement("canvas");
  canvas.width = imageBitmap.width;
  canvas.height = imageBitmap.height;

  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(imageBitmap, 0, 0);

  // @ts-ignore
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edged = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
  cv.Canny(blurred, edged, 75, 200);

  cv.findContours(
    edged,
    contours,
    hierarchy,
    cv.RETR_LIST,
    cv.CHAIN_APPROX_SIMPLE
  );

  let biggestContour = null;
  let maxArea = 0;

  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i);
    const area = cv.contourArea(contour);

    if (area > maxArea) {
      const peri = cv.arcLength(contour, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(contour, approx, 0.02 * peri, true);

      if (approx.rows === 4) {
        biggestContour = approx;
        maxArea = area;
      }
    }
  }

  if (!biggestContour) {
    src.delete();
    return imageFile;
  }

  const dst = new cv.Mat();
  const width = src.cols;
  const height = src.rows;

  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    biggestContour.data32S[0],
    biggestContour.data32S[1],
    biggestContour.data32S[2],
    biggestContour.data32S[3],
    biggestContour.data32S[4],
    biggestContour.data32S[5],
    biggestContour.data32S[6],
    biggestContour.data32S[7],
  ]);

  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0,
    0,
    width,
    0,
    width,
    height,
    0,
    height,
  ]);

  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  cv.warpPerspective(src, dst, M, new cv.Size(width, height));

  cv.imshow(canvas, dst);

  src.delete();
  gray.delete();
  blurred.delete();
  edged.delete();
  contours.delete();
  hierarchy.delete();
  dst.delete();

  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      resolve(blob!);
    }, "image/jpeg", 0.95);
  });
}