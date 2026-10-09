// OCR dentro del navegador (Tesseract.js, sin internet) y lectura de PDF (pdf.js).
// Las imágenes solo existen en memoria mientras se leen; nada se guarda.
import { letras } from "./extraer.js";

const base = (ruta) => new URL(ruta, document.baseURI).href;
let trabajador = null;

export async function iniciarOCR(aviso) {
  if (trabajador) return trabajador;
  trabajador = await window.Tesseract.createWorker("spa", 1, {
    workerPath: base("vendor/worker.min.js"),
    corePath: base("vendor/core/"),
    langPath: base("vendor/lang/"),
    gzip: true,
    workerBlobURL: false,
    logger: (m) => aviso?.(m),
  });
  // 3 = detecta bloques y columnas sola; no necesita el modelo de orientación (la foto ya llega derecha).
  await trabajador.setParameters({ tessedit_pageseg_mode: "3", preserve_interword_spaces: "1" });
  return trabajador;
}

/** Gris + contraste automático; desenfoque mínimo si es foto de pantalla (quita el moiré). */
function preparar(fuente, ancho, alto, pantalla) {
  const largo = Math.max(ancho, alto);
  // Tesseract lee mejor con letras de ~30 px: amplía capturas pequeñas y reduce fotos enormes (memoria).
  const escala = largo > 3200 ? 3200 / largo : largo < 1600 ? Math.min(2, 1600 / largo) : 1;
  const w = Math.round(ancho * escala), h = Math.round(alto * escala);
  const lienzo = document.createElement("canvas");
  lienzo.width = w;
  lienzo.height = h;
  const ctx = lienzo.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(fuente, 0, 0, w, h);
  const imagen = ctx.getImageData(0, 0, w, h);
  const p = imagen.data;
  let gris = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; j < gris.length; i += 4, j++) gris[j] = (p[i] * 299 + p[i + 1] * 587 + p[i + 2] * 114) / 1000;
  if (pantalla) gris = desenfocar(gris, w, h);
  // Contraste: estira entre el percentil 1 y el 99.
  const hist = new Uint32Array(256);
  for (const g of gris) hist[g]++;
  const corte = gris.length * 0.01;
  let lo = 0, hi = 255, acum = 0;
  while (lo < 255 && (acum += hist[lo]) < corte) lo++;
  acum = 0;
  while (hi > 0 && (acum += hist[hi]) < corte) hi--;
  const rango = Math.max(1, hi - lo);
  for (let i = 0, j = 0; j < gris.length; i += 4, j++) {
    const v = ((gris[j] - lo) * 255) / rango;
    p[i] = p[i + 1] = p[i + 2] = v;
  }
  ctx.putImageData(imagen, 0, 0);
  return lienzo;
}

function desenfocar(g, w, h) {
  const s = new Uint8ClampedArray(g.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      s[i] = (4 * g[i] + 2 * (g[i - 1] + g[i + 1] + g[i - w] + g[i + w]) + g[i - w - 1] + g[i - w + 1] + g[i + w - 1] + g[i + w + 1]) / 16;
    }
  }
  return s;
}

async function reconocer(lienzo, aviso) {
  const ocr = await iniciarOCR(aviso);
  const { data } = await ocr.recognize(lienzo);
  return { texto: data.text, confianza: Math.round(data.confidence) };
}

/** Imagen (foto o captura de pantalla). */
export async function leerImagen(archivo, { pantalla = false, aviso } = {}) {
  const bmp = await createImageBitmap(archivo, { imageOrientation: "from-image" });
  try {
    return await reconocer(preparar(bmp, bmp.width, bmp.height, pantalla), aviso);
  } finally {
    bmp.close();
  }
}

/** PDF: usa el texto que ya trae; si una página es escaneada (sin texto), la pasa por OCR. */
export async function leerPDF(archivo, { aviso } = {}) {
  const pdfjs = window.pdfjsLib;
  pdfjs.GlobalWorkerOptions.workerSrc = base("vendor/pdf.worker.min.js");
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await archivo.arrayBuffer()), isEvalSupported: false }).promise;
  const paginas = [];
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      aviso?.({ status: `PDF página ${n} de ${pdf.numPages}`, progress: n / pdf.numPages });
      const pagina = await pdf.getPage(n);
      const contenido = await pagina.getTextContent();
      let texto = contenido.items.map((it) => it.str + (it.hasEOL ? "\n" : "")).join("");
      let confianza = 100;
      if (letras(texto) < 40) {
        const vista = pagina.getViewport({ scale: 2.5 });
        const lienzo = document.createElement("canvas");
        lienzo.width = vista.width;
        lienzo.height = vista.height;
        await pagina.render({ canvasContext: lienzo.getContext("2d"), viewport: vista }).promise;
        ({ texto, confianza } = await reconocer(preparar(lienzo, lienzo.width, lienzo.height, false), aviso));
      }
      paginas.push({ texto, confianza });
    }
  } finally {
    pdf.destroy();
  }
  return paginas;
}
