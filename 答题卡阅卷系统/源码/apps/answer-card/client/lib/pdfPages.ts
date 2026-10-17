import { getDocument } from "pdfjs-dist";

const PDF_RENDER_DPI = 200;
const MAX_PDF_PAGES = 300;
const MAX_RENDER_DIMENSION = 5600;

function renderScale(page: { getViewport: (options: { scale: number }) => { width: number; height: number } }) {
  const base = PDF_RENDER_DPI / 72;
  const viewport = page.getViewport({ scale: base });
  const longest = Math.max(viewport.width, viewport.height);
  return longest > MAX_RENDER_DIMENSION ? base * (MAX_RENDER_DIMENSION / longest) : base;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("PDF 页面转图片失败"));
    }, "image/png");
  });
}

/**
 * 将扫描 PDF 按页转换为现有识别接口可接受的图片文件。
 * 页序保持不变；文件名包含原 PDF 名称和页码，便于识别失败时定位原页。
 */
export async function rasterizePdf(file: File, onProgress?: (finished: number, total: number) => void): Promise<File[]> {
  const data = new Uint8Array(await file.arrayBuffer());
  // The server and Electron webview both serve the same static bundle. Running
  // PDF.js without a worker avoids a fragile cross-origin worker URL and keeps
  // this feature working under /yuejuan as well as from a local file tab.
  const loadingTask = getDocument({ data, disableWorker: true } as any);
  const pdf = await loadingTask.promise;
  const total = pdf.numPages;
  if (!Number.isInteger(total) || total < 1) {
    await pdf.destroy();
    throw new Error("PDF 没有可识别的页面");
  }
  if (total > MAX_PDF_PAGES) {
    await pdf.destroy();
    throw new Error(`PDF 页数过多（${total} 页），单批最多支持 ${MAX_PDF_PAGES} 页`);
  }

  const output: File[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const scale = renderScale(page);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("浏览器不支持 PDF 页面绘制");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      const blob = await canvasToBlob(canvas);
      const baseName = file.name.replace(/\.pdf$/i, "") || "答题卡";
      output.push(new File([blob], `${baseName}-p${String(pageNumber).padStart(3, "0")}.png`, { type: "image/png" }));
      page.cleanup();
      canvas.width = 1;
      canvas.height = 1;
      onProgress?.(pageNumber, total);
    }
  } finally {
    await pdf.destroy();
  }
  return output;
}

