/**
 * Minimal PDF export: renders the drawing canvas to a PDF with the image
 * embedded as a JPEG. No external library needed — generates a valid PDF 1.4
 * file from scratch using a binary-safe builder.
 */

/** Export an HTML canvas as a PDF Blob (A4 landscape). */
export function exportCanvasAsPDF(canvas: HTMLCanvasElement): Blob {
  // Get canvas data as JPEG (smaller than PNG for photos/renders).
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  const base64 = dataUrl.split(',')[1]!;
  const imgBytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

  const pageW = 842; // A4 landscape width in points (297mm)
  const pageH = 595; // A4 landscape height in points (210mm)
  const margin = 36; // 12.7mm margin

  // Compute image placement: fit within the page with margins, preserving aspect ratio.
  const imgW = canvas.width;
  const imgH = canvas.height;
  const availW = pageW - margin * 2;
  const availH = pageH - margin * 2;
  const scale = Math.min(availW / imgW, availH / imgH);
  const drawW = imgW * scale;
  const drawH = imgH * scale;
  const drawX = margin + (availW - drawW) / 2;
  const drawY = margin + (availH - drawH) / 2;

  // Content stream: place the image at the computed position.
  const content = `q\n${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${drawX.toFixed(2)} ${drawY.toFixed(2)} cm\n/Img Do\nQ`;

  // Build PDF using a binary-safe approach (TextEncoder for text, raw bytes for image).
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const objOffsets: number[] = [];
  let pos = 0;

  const write = (text: string) => {
    const bytes = enc.encode(text);
    parts.push(bytes);
    pos += bytes.length;
  };

  const startObj = () => { objOffsets.push(pos); };

  write('%PDF-1.4\n');

  // 1: Catalog
  startObj();
  write('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  // 2: Pages
  startObj();
  write('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

  // 3: Page
  startObj();
  write(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Contents 4 0 R /Resources << /XObject << /Img 5 0 R >> >> >>\nendobj\n`);

  // 4: Content stream
  startObj();
  write(`4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

  // 5: Image XObject (JPEG)
  startObj();
  write(`5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imgBytes.length} >>\nstream\n`);
  parts.push(imgBytes);
  pos += imgBytes.length;
  write('\nendstream\nendobj\n');

  // Cross-reference table
  const xrefPos = pos;
  write('xref\n');
  write(`0 ${objOffsets.length + 1}\n`);
  write('0000000000 65535 f \n');
  for (const off of objOffsets) {
    write(`${String(off).padStart(10, '0')} 00000 n \n`);
  }

  // Trailer
  write('trailer\n');
  write(`<< /Size ${objOffsets.length + 1} /Root 1 0 R >>\n`);
  write('startxref\n');
  write(`${xrefPos}\n`);
  write('%%EOF');

  // Concatenate all parts into a single buffer.
  const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return new Blob([result.buffer], { type: 'application/pdf' });
}
