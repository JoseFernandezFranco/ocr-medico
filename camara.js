// Modo vídeo: la cámara en directo hace la foto sola cuando, tras un movimiento claro (pasar de página,
// mover el móvil), la imagen vuelve a estar quieta y nítida. Los fotogramas no se guardan: cada captura va
// directa a la cola de OCR.
//
// Por qué «movimiento» y no «imagen distinta»: con texto, un temblor de pulso de 2 px cambia la miniatura más
// que pasar a otro informe con la misma plantilla (medido con los informes de prueba). Mejor una página
// repetida (no altera los datos) que una perdida.

const LADO_W = 160, LADO_H = 120; // miniatura para contraste
const BLOQUE = 5;                 // 160x120 -> 32x24 promediando bloques: para movimiento, ignora el temblor fino
// Diferencia media en 32x24 (0-255): temblor de 2–10 px ≈ 3,5–8; mover 40 px ≈ 12; 200 px ≈ 31.
const MOVIMIENTO_MAX = 8;         // por debajo, la imagen se considera quieta
const SACUDIDA = 12;              // por encima, ha habido un movimiento claro: se rearma la captura
const CONTRASTE_MIN = 18;         // por debajo: no hay un documento delante
const QUIETAS_NECESARIAS = 3;     // fotogramas quietos seguidos (~0,75 s)
// Varianza del laplaciano en el centro a 480 px: texto nítido ≈ 4000–8000; algo borroso ≈ 100–200;
// muy borroso < 15 (medido con los informes de prueba). Solo se descarta lo claramente desenfocado.
const NITIDEZ_MIN = 60;

function gris(ctx, w, h) {
  const p = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114;
  return g;
}

const diferencia = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
};

function reducir(g) {
  const w = LADO_W / BLOQUE, r = new Float32Array(w * (LADO_H / BLOQUE));
  for (let y = 0; y < LADO_H; y++) {
    for (let x = 0; x < LADO_W; x++) r[((y / BLOQUE) | 0) * w + ((x / BLOQUE) | 0)] += g[y * LADO_W + x] / (BLOQUE * BLOQUE);
  }
  return r;
}

function desviacion(g) {
  let m = 0;
  for (const v of g) m += v;
  m /= g.length;
  let s = 0;
  for (const v of g) s += (v - m) ** 2;
  return Math.sqrt(s / g.length);
}

/** Varianza del laplaciano: alta = bordes de letras nítidos, baja = desenfocado o movido. */
function nitidez(g, w, h) {
  let suma = 0, suma2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      suma += l;
      suma2 += l * l;
      n++;
    }
  }
  const m = suma / n;
  return suma2 / n - m * m;
}

export const camaraDisponible = () => Boolean(navigator.mediaDevices?.getUserMedia) && isSecureContext;

export class CamaraAuto {
  /** alCapturar(File) recibe cada página; alEstado(texto, nivel) informa de lo que pasa (nivel: espera|ok|aviso). */
  constructor(video, { alCapturar, alEstado }) {
    this.video = video;
    this.alCapturar = alCapturar;
    this.alEstado = alEstado;
    this.automatico = true;
  }

  async abrir() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    });
    const pista = this.stream.getVideoTracks()[0];
    try { await pista.applyConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch {}
    this.video.srcObject = this.stream;
    await this.video.play();
    this.mini = document.createElement("canvas");
    this.mini.width = LADO_W;
    this.mini.height = LADO_H;
    this.ctxMini = this.mini.getContext("2d", { willReadFrequently: true });
    this.med = document.createElement("canvas");
    this.ctxMed = this.med.getContext("2d", { willReadFrequently: true });
    this.anterior = null;
    this.armado = true; // la primera página no necesita movimiento previo
    this.quietas = 0;
    this.mejorQuieta = 0;
    this.activo = true;
    this.bucle();
  }

  muestra() {
    this.ctxMini.drawImage(this.video, 0, 0, LADO_W, LADO_H);
    return gris(this.ctxMini, LADO_W, LADO_H);
  }

  medirNitidez() {
    // Centro de la imagen a resolución media: donde suele estar el texto.
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    const w = 480, h = Math.round((480 * vh) / vw);
    this.med.width = w;
    this.med.height = h;
    this.ctxMed.drawImage(this.video, vw * 0.15, vh * 0.15, vw * 0.7, vh * 0.7, 0, 0, w, h);
    return nitidez(gris(this.ctxMed, w, h), w, h);
  }

  bucle() {
    if (!this.activo) return;
    if (this.video.readyState >= 2 && !this.ocupado) {
      const g = this.muestra();
      const r = reducir(g);
      const mov = this.anterior ? diferencia(r, this.anterior) : 99;
      this.anterior = r;
      this.quietas = mov < MOVIMIENTO_MAX ? this.quietas + 1 : 0;
      if (mov > SACUDIDA) this.armado = true;
      if (this.quietas === 0) this.mejorQuieta = 0; // empieza otra ventana de imagen quieta
      if (desviacion(g) < CONTRASTE_MIN) this.alEstado("Apunta al informe", "espera");
      else if (!this.armado) this.alEstado("Página capturada: pasa a la siguiente", "ok");
      else if (this.quietas < QUIETAS_NECESARIAS - 1) this.alEstado("Mantén el móvil quieto…", "espera");
      else if (this.automatico) {
        // Mientras está quieta, el autoenfoque puede seguir afinando: captura el fotograma más nítido.
        const n = this.medirNitidez();
        this.mejorQuieta = Math.max(this.mejorQuieta, n);
        if (n < NITIDEZ_MIN) this.alEstado("Desenfocado: acerca o aleja un poco", "aviso");
        else if (this.quietas >= QUIETAS_NECESARIAS && n >= this.mejorQuieta * 0.85) this.capturar();
        else this.alEstado("Enfocando…", "espera");
      }
    }
    this.temporizador = setTimeout(() => this.bucle(), 250);
  }

  /** Foto a resolución completa del fotograma actual. */
  async capturar() {
    if (this.ocupado || !this.activo) return;
    this.ocupado = true;
    try {
      const c = document.createElement("canvas");
      c.width = this.video.videoWidth;
      c.height = this.video.videoHeight;
      c.getContext("2d").drawImage(this.video, 0, 0);
      const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.92));
      c.width = c.height = 0; // libera la memoria del fotograma
      this.quietas = 0;
      this.armado = false; // hasta que se mueva otra vez
      this.alCapturar(new File([blob], "video.jpg", { type: "image/jpeg" }));
    } finally {
      this.ocupado = false;
    }
  }

  cerrar() {
    this.activo = false;
    clearTimeout(this.temporizador);
    this.stream?.getTracks().forEach((t) => t.stop()); // apaga la cámara
    this.video.srcObject = null;
  }
}
