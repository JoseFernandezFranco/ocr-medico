import * as almacen from "./almacen.js";
import { anonimizar, cargarVariables, extraer, letras, quitarTildes, seudonimo } from "./extraer.js";
import { iniciarOCR, leerImagen, leerPDF } from "./ocr.js";
import { CamaraAuto, camaraDisponible } from "./camara.js";

const $ = (s) => document.querySelector(s);
const MIN_LETRAS = 40;

let datosVars = null; // variables.yaml como objeto editable { identificador, ocultar, variables: [...] }
let config = null;    // las mismas, compiladas: { identificador, variables, ocultar }

// Sesión de escaneo: fotos que se van leyendo en segundo plano.
// informe: { num, id, creado, abierto, paginas: [{ estado, texto, paciente }], guardado }
// estado de página: cola | leyendo | ok | ilegible | error
let sesion = null;
const cola = [];
let trabajando = false;
let esperas = [];

// ---------- utilidades ----------
function mostrar(id) {
  for (const s of document.querySelectorAll("main > section")) s.hidden = s.id !== id;
  scrollTo(0, 0);
}

let temporizador;
function aviso(texto, ms = 3000) {
  const t = $("#toast");
  t.textContent = texto;
  t.classList.add("ver");
  clearTimeout(temporizador);
  temporizador = setTimeout(() => t.classList.remove("ver"), ms);
}

/** Confirmación dentro de la página (confirm() no funciona en todos los visores). */
function confirmar(pregunta, textoSi = "Sí, borrar") {
  return new Promise((ok) => {
    const capa = $("#confirmar");
    $("#confirmar-txt").textContent = pregunta;
    $("#confirmar-si").textContent = textoSi;
    capa.hidden = false;
    const cerrar = (r) => {
      capa.hidden = true;
      $("#confirmar-si").onclick = $("#confirmar-no").onclick = null;
      ok(r);
    };
    $("#confirmar-si").onclick = () => cerrar(true);
    $("#confirmar-no").onclick = () => cerrar(false);
    $("#confirmar-no").focus();
  });
}

const escapar = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ahora = () => { // hora local, no UTC
  const d = new Date();
  return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
};
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

function resumenDe(resultados) {
  const vals = Object.values(resultados);
  return { hallados: vals.filter((r) => r.valor).length, total: vals.length, dudas: vals.filter((r) => r.estado === "dudoso").length };
}

function chipsResumen(inf) {
  const { hallados, total, dudas } = resumenDe(inf.resultados);
  return `<span class="chip ${hallados ? "ok" : "no_encontrado"}">${hallados}/${total} datos</span>` +
    (dudas ? `<span class="chip dudoso">${plural(dudas, "duda", "dudas")}</span>` : "") +
    (inf.avisos || []).map((a) => `<span class="chip no_encontrado">⚠️ ${escapar(a)}</span>`).join("");
}

// ---------- variables ----------
async function cargarConfig() {
  const propio = await almacen.leerMeta("variables_yaml");
  const yaml = propio || (await (await fetch("variables.yaml", { cache: "no-cache" })).text());
  config = cargarVariables(yaml);
  datosVars = window.jsyaml.load(yaml);
  $("#resumen-vars").textContent = `${plural(config.variables.length, "variable", "variables")}: ` +
    config.variables.map((v) => v.nombre).join(", ") + ".";
}

/** Valida y guarda el conjunto de variables (lanza Error con un mensaje legible si algo falla). */
async function guardarVariables(datos) {
  const yaml = window.jsyaml.dump(datos, { lineWidth: -1, noRefs: true });
  cargarVariables(yaml); // valida antes de aceptar
  await almacen.escribirMeta("variables_yaml", yaml);
  await cargarConfig();
}

// ---------- inicio ----------
async function pintarInicio() {
  const lista = (await almacen.informes()).reverse();
  $("#n-informes").textContent = lista.length;
  $("#n-dudas").textContent = lista.filter((i) => resumenDe(i.resultados).dudas || i.avisos?.length).length;
  $("#lista").innerHTML = lista.length
    ? lista.slice(0, 40).map((i) => `<li><div class="info">
        <div class="titulo">#${i.id} <span class="suave">· ${escapar(i.creado.slice(5, 16).replace("T", " "))} · ${plural(i.paginas, "foto", "fotos")}</span></div>
        <div class="det">${chipsResumen(i)}</div></div>
        <div class="acciones"><button class="peq" data-revisar="${i.id}">Revisar</button>
        <button class="peq" data-borrar="${i.id}" aria-label="Borrar informe ${i.id}">✕</button></div></li>`).join("")
    : `<li class="suave">Aún no hay informes.</li>`;
}

$("#lista").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.revisar) return abrirRevision(Number(b.dataset.revisar), "inicio");
  const id = Number(b.dataset.borrar);
  if (id && (await confirmar(`¿Borrar el informe #${id}?`))) {
    await almacen.borrarInforme(id);
    pintarInicio();
  }
});

// ---------- sesión de escaneo ----------
function empezarSesion() {
  if (!sesion) sesion = { lote: ahora(), informes: [], actual: null };
  mostrar("sesion");
}

/** El informe al que van las fotos nuevas (lo crea si no hay uno abierto). */
function informeActual() {
  if (!sesion.actual?.abierto) {
    const inf = { num: sesion.informes.length + 1, id: null, creado: ahora(), abierto: true, paginas: [], guardado: null };
    sesion.informes.push(inf);
    sesion.actual = inf;
  }
  return sesion.actual;
}

function anadirArchivos(archivos) {
  if (!archivos.length) return;
  empezarSesion();
  const inf = informeActual();
  for (const archivo of archivos) {
    const pagina = { estado: "cola", texto: "" };
    inf.paginas.push(pagina);
    cola.push({ inf, pagina, archivo });
  }
  pintarSesion();
  procesarCola();
}

for (const id of ["#in-foto", "#in-archivo"]) {
  $(id).addEventListener("change", (e) => {
    const archivos = [...e.target.files];
    e.target.value = ""; // suelta la imagen: no queda referencia a ella en la página
    anadirArchivos(archivos);
  });
}

async function procesarCola() {
  if (trabajando) return;
  trabajando = true;
  const pantalla = $("#op-pantalla").checked;
  while (cola.length) {
    const t = cola.shift();
    t.pagina.estado = "leyendo";
    pintarSesion();
    try {
      const esPdf = t.archivo.type === "application/pdf" || /\.pdf$/i.test(t.archivo.name);
      if (esPdf) {
        // Cada página del PDF pasa a ser una página del informe.
        const leidas = await leerPDF(t.archivo);
        const nuevas = leidas.map((p) => ({ estado: letras(p.texto) >= MIN_LETRAS ? "ok" : "ilegible", texto: p.texto }));
        t.inf.paginas.splice(t.inf.paginas.indexOf(t.pagina), 1, ...nuevas);
      } else {
        const { texto } = await leerImagen(t.archivo, { pantalla });
        t.pagina.texto = texto;
        t.pagina.estado = letras(texto) >= MIN_LETRAS ? "ok" : "ilegible";
      }
    } catch (err) {
      console.error(err);
      t.pagina.estado = "error";
    }
    t.archivo = null;
    if (t.inf.paginas.some((p) => p === t.pagina && (p.estado === "ilegible" || p.estado === "error"))) {
      aviso(`⚠️ Informe ${t.inf.num}: una foto no se lee. Repítela más cerca y recta.`, 6000);
      navigator.vibrate?.([200, 100, 200]);
    }
    await finalizarSiListo(t.inf);
    pintarSesion();
  }
  trabajando = false;
  pintarSesion();
  esperas.forEach((ok) => ok());
  esperas = [];
}

const esperarCola = () => new Promise((ok) => (trabajando || cola.length ? esperas.push(ok) : ok()));
const pendiente = (inf) => inf.paginas.some((p) => p.estado === "cola" || p.estado === "leyendo");

async function finalizarSiListo(inf) {
  if (!inf.abierto && !pendiente(inf)) await finalizar(inf);
}

/** Junta las páginas legibles, anonimiza, extrae y guarda (o actualiza) el informe. */
async function finalizar(inf) {
  const buenas = inf.paginas.filter((p) => p.estado === "ok");
  const malas = inf.paginas.length - buenas.length;
  const avisos = [];
  if (malas) avisos.push(`${plural(malas, "foto ilegible", "fotos ilegibles")}`);
  if (!buenas.length) avisos.push("sin texto legible");
  const clave = await almacen.claveSeudonimos();
  const pacientes = new Set();
  for (const p of buenas) {
    p.paciente ??= await seudonimo(p.texto, config.identificador, clave);
    if (p.paciente) pacientes.add(p.paciente);
  }
  if (pacientes.size > 1) avisos.push("fotos con NHC distintos");
  const texto = anonimizar(buenas.map((p) => p.texto).join("\n\n"), config.identificador, config.ocultar);
  const registro = {
    creado: inf.creado, lote: sesion.lote, num: inf.num, paginas: inf.paginas.length,
    paciente: [...pacientes][0] || "", avisos, resultados: extraer(texto, config.variables),
  };
  if (inf.id) registro.id = inf.id;
  inf.id = await almacen.guardarInforme(registro);
  inf.guardado = registro;
}

async function cerrarActual() {
  const inf = sesion?.actual;
  if (!inf?.abierto) return;
  inf.abierto = false;
  sesion.actual = null;
  if (!inf.paginas.length) sesion.informes.splice(sesion.informes.indexOf(inf), 1);
  else await finalizarSiListo(inf);
}

const ETIQUETA = { cola: ["neutro", "en cola"], leyendo: ["dudoso", "leyendo…"], ok: ["ok", "✓"], ilegible: ["no_encontrado", "✗ no se lee"], error: ["no_encontrado", "✗ error"] };

function pintarSesion() {
  if (!sesion) return;
  const inf = sesion.actual;
  const siguienteNum = sesion.informes.filter((i) => i !== inf).length + 1;
  $("#encurso-num").textContent = inf ? `Informe ${inf.num}` : `Informe ${siguienteNum}`;
  $("#encurso-etq").textContent = inf && inf.guardado ? "Añadiendo fotos a" : "Informe en curso";
  $("#encurso-fotos").innerHTML = inf?.paginas.length
    ? inf.paginas.map((p, i) => `<span class="chip ${ETIQUETA[p.estado][0]}">Foto ${i + 1}: ${ETIQUETA[p.estado][1]}</span>`).join("")
    : `<span class="suave">Aún sin fotos. Pulsa «Hacer foto».</span>`;
  $("#b-siguiente").disabled = !inf?.paginas.length;
  const n = cola.length + (trabajando ? 1 : 0);
  $("#cam-info").textContent = $("#encurso-num").textContent;
  $("#cam-fotos").textContent = `${plural(inf?.paginas.length || 0, "página", "páginas")}` + (n ? ` · leyendo ${n}` : "") +
    ` · ${plural(sesion.informes.filter((i) => i !== inf).length, "informe cerrado", "informes cerrados")}`;
  $("#cola-estado").textContent = n ? `Leyendo ${plural(n, "foto", "fotos")} en segundo plano. Puedes seguir haciendo fotos.` : "";
  const otros = sesion.informes.filter((i) => i !== inf).slice().reverse();
  $("#lista-sesion").innerHTML = otros.length
    ? otros.map((i) => `<li><div class="info"><div class="titulo">Informe ${i.num} <span class="suave">· ${plural(i.paginas.length, "foto", "fotos")}</span></div>
        <div class="det">${pendiente(i) ? `<span class="chip dudoso">leyendo…</span>` : i.guardado ? chipsResumen(i.guardado) : ""}</div></div>
        <div class="acciones">${i.guardado && !pendiente(i) ? `<button class="peq" data-revisar="${i.id}">Revisar</button>` : ""}
        <button class="peq" data-anadir="${i.num}" aria-label="Añadir fotos al informe ${i.num}">+ foto</button></div></li>`).join("")
    : `<li class="suave">Los informes que cierres aparecerán aquí.</li>`;
}

$("#lista-sesion").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.revisar) return abrirRevision(Number(b.dataset.revisar), "sesion");
  if (b.dataset.anadir) {
    // Reabre un informe ya cerrado para añadirle fotos (se recalcula al cerrarlo otra vez).
    await cerrarActual();
    const inf = sesion.informes.find((i) => i.num === Number(b.dataset.anadir));
    inf.abierto = true;
    sesion.actual = inf;
    pintarSesion();
    scrollTo(0, 0);
    aviso(`Las próximas fotos irán al informe ${inf.num}`);
  }
});

async function siguienteInforme() {
  const inf = sesion?.actual;
  if (!inf?.paginas.length) return aviso("Este informe aún no tiene páginas.");
  await cerrarActual();
  pintarSesion();
  aviso(`✓ Informe ${inf.num} cerrado. Pasa al siguiente.`);
}
$("#b-siguiente").addEventListener("click", siguienteInforme);

// ---------- modo vídeo ----------
let camara = null;

async function abrirVideo() {
  empezarSesion();
  $("#camara").hidden = false;
  pintarSesion();
  camara = new CamaraAuto($("#cam-video"), {
    alCapturar: (archivo) => {
      const flash = $("#cam-flash");
      flash.classList.add("ver");
      setTimeout(() => flash.classList.remove("ver"), 60);
      navigator.vibrate?.(60);
      anadirArchivos([archivo]);
      estadoCamara(`✓ Página ${sesion.actual.paginas.length} capturada. Pasa a la siguiente.`, "ok");
    },
    alEstado: estadoCamara,
  });
  camara.automatico = $("#cam-auto-op").checked;
  try {
    await camara.abrir();
  } catch (err) {
    cerrarVideo();
    aviso("⚠️ No se puede abrir la cámara: " + (err.name === "NotAllowedError" ? "falta el permiso." : err.message), 7000);
  }
}

let ultimoEstado = "";
function estadoCamara(texto, nivel) {
  if (texto === ultimoEstado) return;
  ultimoEstado = texto;
  const e = $("#cam-estado");
  e.textContent = texto;
  e.className = nivel;
}

function cerrarVideo() {
  camara?.cerrar();
  camara = null;
  ultimoEstado = "";
  $("#camara").hidden = true;
  pintarSesion();
}

for (const b of document.querySelectorAll("[data-video]")) b.addEventListener("click", abrirVideo);
$("#cam-cerrar").addEventListener("click", cerrarVideo);
$("#cam-siguiente").addEventListener("click", siguienteInforme);
$("#cam-capturar").addEventListener("click", () => camara?.capturar());
$("#cam-auto-op").addEventListener("change", (e) => {
  if (camara) camara.automatico = e.target.checked;
  estadoCamara(e.target.checked ? "Automático: deja quieta cada página" : "Manual: pulsa «Capturar ahora»", "espera");
});

$("#b-terminar").addEventListener("click", async () => {
  if (!sesion) return mostrar("inicio");
  await cerrarActual();
  $("#esperando").hidden = false;
  await esperarCola();
  $("#esperando").hidden = true;
  const ids = new Set(sesion.informes.map((i) => i.id).filter(Boolean));
  const lista = (await almacen.informes()).filter((i) => ids.has(i.id));
  sesion = null; // suelta de la memoria los textos de esta sesión
  await pintarInicio();
  mostrar("inicio");
  if (!lista.length) return aviso("No se ha guardado ningún informe.");
  await exportar(lista, "sesion");
});

// ---------- pegar texto ----------
let volverDePegar = "inicio";
for (const b of document.querySelectorAll("[data-pegar]")) {
  b.addEventListener("click", () => {
    volverDePegar = sesion ? "sesion" : "inicio";
    $("#texto-pegado").value = "";
    mostrar("pegar");
    $("#texto-pegado").focus();
  });
}
$("#b-cancelar-texto").addEventListener("click", () => mostrar(volverDePegar));
$("#b-usar-texto").addEventListener("click", () => {
  const texto = $("#texto-pegado").value;
  $("#texto-pegado").value = ""; // no queda en la página
  if (letras(texto) < MIN_LETRAS) return aviso("⚠️ Pega el texto completo del informe.");
  empezarSesion();
  informeActual().paginas.push({ estado: "ok", texto });
  pintarSesion();
  aviso("✓ Texto añadido al informe");
});

// ---------- revisión de un informe guardado ----------
let revisando = null;
let volverDeRevision = "inicio";

async function abrirRevision(id, desde) {
  revisando = await almacen.obtenerInforme(id);
  if (!revisando) return;
  volverDeRevision = desde;
  const res = revisando.resultados;
  const { hallados, total, dudas } = resumenDe(res);
  $("#rev-titulo").textContent = `Informe #${revisando.id}` + (revisando.num ? ` (nº ${revisando.num} de su sesión)` : "");
  $("#resumen").innerHTML =
    `<div class="aviso ${dudas ? "dudoso" : hallados ? "ok" : "no_encontrado"}">Encontrados ${hallados} de ${total} datos` +
    (dudas ? ` · ${plural(dudas, "dudoso", "dudosos")}: revísalos` : "") + `</div>` +
    (revisando.avisos || []).map((a) => `<div class="aviso no_encontrado">⚠️ ${escapar(a)}</div>`).join("") +
    (revisando.paciente ? "" : `<p class="suave">No se ha encontrado el NHC: el informe no tiene código de paciente.</p>`);
  // Variables actuales y también las que tuviera el informe aunque ya no existan.
  const nombres = [...new Set([...config.variables.map((v) => v.nombre), ...Object.keys(res)])];
  $("#variables").innerHTML = nombres.map((n) => {
    const r = res[n] || { valor: "", estado: "no_encontrado", evidencia: "Variable añadida después de escanear este informe" };
    return `<div class="var"><div class="cab"><span class="nombre">${escapar(n)}</span>
      <span class="chip ${r.estado}">${r.estado.replace("_", " ")}</span></div>
      <input data-var="${escapar(n)}" value="${escapar(r.valor)}" autocomplete="off" aria-label="${escapar(n)}">
      ${r.evidencia ? `<div class="evid">↳ ${escapar(r.evidencia)}</div>` : ""}</div>`;
  }).join("");
  mostrar("revision");
}

$("#b-guardar").addEventListener("click", async () => {
  for (const input of document.querySelectorAll("#variables input")) {
    const n = input.dataset.var;
    const r = revisando.resultados[n] || { valor: "", estado: "no_encontrado", evidencia: "" };
    const valor = input.value.trim();
    if (valor !== r.valor) {
      revisando.resultados[n] = { valor, estado: "corregido", evidencia: `Corregido a mano (leído: «${r.valor}») ‖ ${r.evidencia}` };
    }
  }
  await almacen.guardarInforme(revisando);
  const enSesion = sesion?.informes.find((i) => i.id === revisando.id);
  if (enSesion) enSesion.guardado = revisando;
  aviso(`✓ Informe #${revisando.id} guardado`);
  revisando = null;
  await pintarInicio();
  pintarSesion();
  mostrar(volverDeRevision);
});
$("#b-volver-rev").addEventListener("click", () => mostrar(volverDeRevision));

// ---------- exportar ----------
function csv(filas, sep = ";") {
  const celda = (x) => {
    const s = String(x ?? "");
    return /[";\n\r]/.test(s) || s.includes(sep) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + filas.map((f) => f.map(celda).join(sep)).join("\r\n") + "\r\n";
}

/** Dos CSV (datos y revisión), una fila por informe en orden de escaneo. */
async function exportar(lista, sufijo) {
  // Por sesión y número de informe dentro de ella (el id depende de cuándo terminó de leerse).
  lista = lista.slice().sort((a, b) => (a.lote || "").localeCompare(b.lote || "") || (a.num || 0) - (b.num || 0) || a.id - b.id);
  const nombres = config.variables.map((v) => v.nombre);
  const numericas = new Set(config.variables.filter((v) => v.tipo === "numero").map((v) => v.nombre));
  const datos = [["id_informe", "id_paciente", "fecha_captura", "sesion", "n_en_sesion", "fotos", "avisos", "variables_a_revisar", ...nombres]];
  const rev = [["id_informe", "variable", "valor", "estado", "evidencia"]];
  for (const inf of lista) {
    const fila = [], aRevisar = [];
    for (const n of nombres) {
      const r = inf.resultados[n];
      if (!r) {
        fila.push("");
        aRevisar.push(n + "(sin_procesar)");
        continue;
      }
      const valor = numericas.has(n) && r.valor ? r.valor.replace(".", ",") : r.valor;
      fila.push(valor);
      if (r.estado === "dudoso") aRevisar.push(n);
      rev.push([inf.id, n, valor, r.estado, r.evidencia]);
    }
    datos.push([inf.id, inf.paciente, inf.creado, inf.lote || "", inf.num || "", inf.paginas,
      (inf.avisos || []).join(" | "), aRevisar.join(" "), ...fila]);
  }
  const sello = ahora().replace(/[-:]/g, "").replace("T", "_");
  const archivos = [
    new File([csv(datos)], `ocrmed_${sello}_${sufijo}_datos.csv`, { type: "text/csv" }),
    new File([csv(rev)], `ocrmed_${sello}_${sufijo}_revision.csv`, { type: "text/csv" }),
  ];
  const hecho = `✓ CSV con ${plural(lista.length, "informe", "informes")}`;
  // Dentro de Claude: su sistema de descargas (pide confirmación por cada archivo).
  const descargas = await window.claude?.use?.("downloads").catch(() => null);
  if (descargas) {
    try {
      for (const f of archivos) await descargas.save({ filename: f.name, data: f });
      return aviso(hecho);
    } catch (e) {
      return aviso(e.code === "declined" ? "Exportación cancelada" : "⚠️ No se pudo guardar: " + (e.message || e.code), 6000);
    }
  }
  if (navigator.canShare?.({ files: archivos })) {
    try {
      await navigator.share({ files: archivos });
      return aviso(hecho);
    } catch (e) {
      if (e.name === "AbortError") return aviso("Puedes volver a descargarlo desde «Descargar CSV».", 5000);
    }
  }
  for (const f of archivos) {
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(f), download: f.name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  aviso(hecho);
}

$("#b-exportar").addEventListener("click", async () => {
  const lista = await almacen.informes();
  if (!lista.length) return aviso("No hay informes que exportar.");
  exportar(lista, "todos");
});

$("#b-borrar-todo").addEventListener("click", async () => {
  if (!(await confirmar("¿Borrar TODOS los informes de este móvil? Descarga antes el CSV.", "Sí, borrar todo"))) return;
  await almacen.borrarTodo();
  pintarInicio();
  aviso("Informes borrados");
});

// ---------- editor de variables ----------
const TIPO_TXT = { numero: "número", si_no: "sí / no", categoria: "opciones", texto: "texto" };

function pintarVariables() {
  $("#lista-vars").innerHTML = datosVars.variables.map((v, i) => `<li><div class="info">
      <div class="titulo">${escapar(v.nombre)}</div>
      <div class="det"><span class="chip neutro">${TIPO_TXT[v.tipo || "texto"]}</span>${escapar(v.descripcion || (v.frases || []).join(" · "))}</div></div>
      <div class="acciones"><button class="peq" data-editar="${i}">Editar</button></div></li>`).join("");
  mostrar("variables-pant");
}

$("#b-variables").addEventListener("click", pintarVariables);
$("#b-volver-vars").addEventListener("click", () => mostrar("inicio"));
$("#lista-vars").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-editar]");
  if (b) abrirVariable(Number(b.dataset.editar));
});
$("#b-nueva-var").addEventListener("click", () => abrirVariable(-1));

// Texto llano -> expresión regular tolerante (sin tildes, espacios flexibles).
const escRe = (s) => quitarTildes(String(s).trim()).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
const pareceRegex = (s) => /[\\[\]()?*+|^$]/.test(s);
const lineas = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean);
const NUM = "(?P<valor>\\d+(?:[.,]\\d+)?)";

function patronesDesdeFrases(tipo, frases, unidad) {
  return frases.flatMap((f) => {
    const e = escRe(f);
    if (tipo === "numero") {
      // Sin unidad: el primer número detrás de las palabras ("CEA: 4,2").
      if (!unidad) return [`${e}[^\\n\\d]{0,40}${NUM}`];
      const u = `\\s*${escRe(unidad)}`;
      return [
        // Número detrás: "Distancia al margen anal: 8 cm", "tumoración de 38 mm"; salta cifras con otra
        // unidad ("tumor a 5 cm del margen, de 40 mm").
        `${e}[^\\n.]{0,60}?${NUM}${u}`,
        // Número delante: "a 8 cm del margen anal". Solo con unidad, para no confundir recuentos ("14 ganglios").
        `${NUM}${u}[^\\n\\d.]{0,20}${e}`,
      ];
    }
    if (tipo === "si_no") return [e];
    return [`${e}\\W{0,5}(?P<valor>[^\\n.;]{1,80})`]; // texto (o categoría sin opciones)
  });
}

let editando = -1;

function abrirVariable(i) {
  editando = i;
  const v = i >= 0 ? datosVars.variables[i] : { nombre: "", tipo: "numero" };
  $("#var-titulo").textContent = i >= 0 ? `Editar ${v.nombre}` : "Nueva variable";
  $("#v-nombre").value = v.nombre || "";
  $("#v-tipo").value = v.tipo || "texto";
  $("#v-frases").value = (v.frases || []).join("\n");
  $("#v-unidad").value = v.unidad || "";
  $("#v-min").value = v.rango ? v.rango[0] : "";
  $("#v-max").value = v.rango ? v.rango[1] : "";
  $("#v-opciones").value = Object.entries(v.opciones || {})
    .map(([val, pats]) => `${val} = ${(Array.isArray(pats) ? pats : [pats]).join(" ; ")}`).join("\n");
  $("#v-desc").value = v.descripcion || "";
  $("#v-patrones").value = v.frases?.length ? "" : (v.patrones || []).join("\n");
  $("#v-patrones").closest("details").open = Boolean(!v.frases?.length && v.patrones?.length);
  $("#v-resultado").textContent = "";
  $("#b-borrar-var").hidden = i < 0;
  tipoCambiado();
  mostrar("variable-pant");
}

function tipoCambiado() {
  const t = $("#v-tipo").value;
  $("#v-bloque-numero").hidden = t !== "numero";
  $("#v-bloque-opciones").hidden = t !== "categoria";
  $("#v-frases-ayuda").textContent = t === "si_no"
    ? "Cómo se nombra (p. ej. «invasión perineural»). La app detecta sola si lo afirma o lo niega."
    : t === "categoria"
      ? "Para opciones no hace falta: rellena las opciones de abajo."
      : "Las palabras que van justo antes del dato. Si se escribe de varias formas, pon una por línea.";
}
$("#v-tipo").addEventListener("change", tipoCambiado);

/** Lee el formulario y devuelve la variable tal como irá en variables.yaml. */
function variableDelFormulario() {
  const previa = editando >= 0 ? datosVars.variables[editando] : {};
  const nombre = quitarTildes($("#v-nombre").value).trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "v_$1");
  const tipo = $("#v-tipo").value;
  const frases = lineas($("#v-frases").value);
  const v = { nombre, tipo };
  const desc = $("#v-desc").value.trim();
  if (desc) v.descripcion = desc;
  if (previa.si_varios) v.si_varios = previa.si_varios;
  if (frases.length) v.frases = frases;
  if (tipo === "numero") {
    const unidad = $("#v-unidad").value.trim();
    if (unidad) v.unidad = unidad;
    const min = $("#v-min").value.trim().replace(",", "."), max = $("#v-max").value.trim().replace(",", ".");
    if (min !== "" || max !== "") v.rango = [min === "" ? 0 : Number(min), max === "" ? 1e9 : Number(max)];
  }
  if (tipo === "categoria") {
    const opciones = {};
    for (const l of lineas($("#v-opciones").value)) {
      const [val, resto = ""] = l.split(/=(.*)/s);
      const items = resto.split(";").map((x) => x.trim()).filter(Boolean);
      if (val.trim() && items.length) opciones[val.trim()] = items.map((x) => (pareceRegex(x) ? x : escRe(x)));
    }
    if (Object.keys(opciones).length) v.opciones = opciones;
  }
  v.patrones = frases.length ? patronesDesdeFrases(tipo, frases, v.unidad) : lineas($("#v-patrones").value);
  if (!v.patrones.length) delete v.patrones;
  return v;
}

$("#b-probar").addEventListener("click", () => {
  const salida = $("#v-resultado");
  try {
    const v = variableDelFormulario();
    const { variables } = cargarVariables(window.jsyaml.dump({ variables: [v] }));
    const r = extraer(anonimizar($("#v-prueba").value, config.identificador, config.ocultar), variables)[v.nombre];
    salida.innerHTML = r.valor
      ? `<b>${escapar(v.nombre)} = ${escapar(r.valor)}</b> <span class="chip ${r.estado}">${r.estado}</span><br>↳ ${escapar(r.evidencia)}`
      : `<span class="chip no_encontrado">no encontrado</span> Revisa las palabras o el texto de prueba.`;
  } catch (err) {
    salida.textContent = "⚠️ " + err.message;
  }
});

$("#form-var").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = variableDelFormulario();
  if (!v.nombre) return aviso("⚠️ Pon un nombre a la variable.");
  const otra = datosVars.variables.findIndex((x) => x.nombre === v.nombre);
  if (otra >= 0 && otra !== editando) return aviso(`⚠️ Ya hay una variable «${v.nombre}».`, 5000);
  const nuevos = structuredClone(datosVars);
  if (editando >= 0) nuevos.variables[editando] = v;
  else nuevos.variables.push(v);
  try {
    await guardarVariables(nuevos);
  } catch (err) {
    return aviso("⚠️ " + err.message, 8000);
  }
  aviso(`✓ Variable «${v.nombre}» guardada`);
  pintarVariables();
});

$("#b-cancelar-var").addEventListener("click", pintarVariables);
$("#b-borrar-var").addEventListener("click", async () => {
  const v = datosVars.variables[editando];
  if (!(await confirmar(`¿Borrar la variable «${v.nombre}»? Dejará de salir en el CSV.`))) return;
  const nuevos = structuredClone(datosVars);
  nuevos.variables.splice(editando, 1);
  try {
    await guardarVariables(nuevos);
  } catch (err) {
    return aviso("⚠️ " + err.message, 8000);
  }
  aviso("Variable borrada");
  pintarVariables();
});

$("#b-yaml-guardar").addEventListener("click", async () => {
  const yaml = (await almacen.leerMeta("variables_yaml")) || window.jsyaml.dump(datosVars, { lineWidth: -1 });
  const f = new File([yaml], "variables.txt", { type: "text/plain" });
  const descargas = await window.claude?.use?.("downloads").catch(() => null);
  if (descargas) return descargas.save({ filename: f.name, data: f }).catch(() => {});
  if (navigator.canShare?.({ files: [f] })) return navigator.share({ files: [f] }).catch(() => {});
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(f), download: f.name });
  a.click();
});

$("#in-yaml").addEventListener("change", async (e) => {
  const archivo = e.target.files[0];
  e.target.value = "";
  if (!archivo) return;
  try {
    await guardarVariables(window.jsyaml.load(await archivo.text()));
  } catch (err) {
    return aviso("⚠️ " + err.message, 8000);
  }
  aviso("✓ Variables cargadas");
  pintarVariables();
});

$("#b-yaml-original").addEventListener("click", async () => {
  if (!(await confirmar("¿Volver a las variables de fábrica? Se pierden las que hayas añadido.", "Sí, volver"))) return;
  await almacen.borrarMeta("variables_yaml");
  await cargarConfig();
  aviso("✓ Variables de fábrica");
  pintarVariables();
});

// ---------- ajustes ----------
$("#b-ajustes").addEventListener("click", () => mostrar("ajustes"));
$("#b-cerrar-ajustes").addEventListener("click", () => mostrar(sesion ? "sesion" : "inicio"));
try { $("#op-pantalla").checked = localStorage.getItem("pantalla") === "1"; } catch {}
$("#op-pantalla").addEventListener("change", (e) => { try { localStorage.setItem("pantalla", e.target.checked ? "1" : "0"); } catch {} });

// Avisa antes de cerrar la app con fotos sin leer.
addEventListener("beforeunload", (e) => {
  if (cola.length || trabajando || sesion?.actual?.paginas.length) e.preventDefault();
});

// ---------- arranque ----------
async function arrancar() {
  try {
    await cargarConfig();
  } catch (err) {
    aviso("⚠️ Variables: " + err.message, 10000);
  }
  await pintarInicio();
  if (camaraDisponible()) {
    for (const b of document.querySelectorAll("[data-video]")) b.hidden = false;
    $("#l-empezar-foto").classList.add("sec");
    $("#l-empezar-foto").textContent = "📷 Escanear con fotos";
  }
  iniciarOCR()
    .then(() => ($("#estado-ocr").textContent = "Lector listo. Funciona sin internet."))
    .catch((err) => ($("#estado-ocr").textContent = "⚠️ El lector no ha podido arrancar: " + err.message));
  if ("serviceWorker" in navigator && isSecureContext) navigator.serviceWorker.register("sw.js").catch(() => {});
}
arrancar();
