import * as almacen from "./almacen.js";
import { anonimizar, cargarVariables, extraer, letras, seudonimo } from "./extraer.js";
import { iniciarOCR, leerImagen, leerPDF } from "./ocr.js";

const $ = (s) => document.querySelector(s);
const MIN_LETRAS = 40;

let config = null;   // { identificador, variables, ocultar }
let actual = null;   // informe en curso: { creado, paginas: [{ nombre, texto, confianza, letras }] }
let revision = null; // { idPaciente, texto, resultados }

// ---------- utilidades de interfaz ----------
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

/** Confirmación dentro de la página (confirm() no funciona en todos los visores). Resuelve true/false. */
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

const escapar = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ahora = () => { // hora local, no UTC
  const d = new Date();
  return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
};

function progreso(m) {
  const caja = $("#progreso");
  if (!m) return void (caja.hidden = true);
  caja.hidden = false;
  const estados = { "recognizing text": "Leyendo el texto", "loading language traineddata": "Cargando el idioma" };
  $("#progreso-txt").textContent = (estados[m.status] || m.status || "Leyendo") + "…";
  $("#progreso-barra").value = m.progress ?? 0;
}

// ---------- variables ----------
async function cargarConfig() {
  const propio = await almacen.leerMeta("variables_yaml");
  const yaml = propio || (await (await fetch("variables.yaml", { cache: "no-cache" })).text());
  config = cargarVariables(yaml);
  $("#origen-variables").textContent = propio ? "cargadas en este móvil" : "las de la app";
  $("#n-variables").textContent = config.variables.length;
}

// ---------- inicio ----------
async function pintarInicio() {
  const lista = (await almacen.informes()).reverse();
  const conDudas = lista.filter((i) => Object.values(i.resultados).some((r) => r.estado === "dudoso")).length;
  $("#n-informes").textContent = lista.length;
  $("#n-dudas").textContent = conDudas;
  $("#lista").innerHTML = lista.length
    ? lista.slice(0, 30).map((i) => {
        const res = Object.values(i.resultados);
        const hallados = res.filter((r) => r.valor).length;
        const dudas = res.filter((r) => r.estado === "dudoso").length;
        return `<tr><td>#${i.id}</td><td>${escapar(i.creado.slice(5, 16).replace("T", " "))}</td>
          <td>${hallados}/${res.length} datos</td><td>${dudas ? `<span class="chip dudoso">${dudas} dudas</span>` : ""}</td>
          <td><button class="sec" data-borrar="${i.id}" aria-label="Borrar informe ${i.id}">✕</button></td></tr>`;
      }).join("")
    : `<tr><td class="suave">Aún no hay informes.</td></tr>`;
}

$("#lista").addEventListener("click", async (e) => {
  const id = Number(e.target.dataset.borrar);
  if (id && (await confirmar(`¿Borrar el informe #${id}?`))) {
    await almacen.borrarInforme(id);
    pintarInicio();
  }
});

// ---------- informe en curso ----------
function pintarPaginas() {
  $("#paginas").innerHTML = actual.paginas.map((p, i) => {
    const mal = p.letras < MIN_LETRAS;
    return `<li><span>Página ${i + 1} <span class="suave">· ${escapar(p.nombre)}</span></span>
      <span>${mal ? `<span class="chip no_encontrado">no se lee</span>` : `<span class="chip ok">${p.letras} letras</span>`}
      <button class="sec" data-quitar="${i}" aria-label="Quitar página ${i + 1}">✕</button></span></li>`;
  }).join("");
  $("#b-revisar").disabled = !actual.paginas.some((p) => p.letras >= MIN_LETRAS);
}

$("#paginas").addEventListener("click", (e) => {
  const i = e.target.dataset.quitar;
  if (i !== undefined) {
    actual.paginas.splice(Number(i), 1);
    pintarPaginas();
  }
});

async function anadirArchivos(archivos) {
  if (!archivos.length) return;
  if (!actual) actual = { creado: ahora(), paginas: [] };
  mostrar("informe");
  pintarPaginas();
  const pantalla = $("#op-pantalla").checked;
  for (const archivo of archivos) {
    try {
      progreso({ status: "Leyendo", progress: 0 });
      const esPdf = archivo.type === "application/pdf" || /\.pdf$/i.test(archivo.name);
      const leidas = esPdf ? await leerPDF(archivo, { aviso: progreso }) : [await leerImagen(archivo, { pantalla, aviso: progreso })];
      leidas.forEach((p, i) => actual.paginas.push({
        nombre: esPdf ? `PDF p. ${i + 1}` : "imagen", // no se muestra el nombre del archivo: puede llevar datos
        texto: p.texto, confianza: p.confianza, letras: letras(p.texto),
      }));
      const ultima = actual.paginas[actual.paginas.length - 1];
      if (ultima.letras < MIN_LETRAS) aviso("⚠️ No se lee el texto. Repite la foto más cerca y recta.", 5000);
      else aviso(`✓ Página leída (${ultima.letras} letras)`);
    } catch (err) {
      console.error(err);
      aviso("⚠️ No se pudo leer: " + err.message, 6000);
    }
  }
  progreso(null);
  pintarPaginas();
}

for (const id of ["#in-foto", "#in-archivo"]) {
  $(id).addEventListener("change", (e) => {
    const archivos = [...e.target.files];
    e.target.value = ""; // suelta la imagen: no queda referencia a ella
    anadirArchivos(archivos);
  });
}

// Pegar texto: lo más fiable si el programa del hospital deja copiar el informe.
for (const b of document.querySelectorAll("[data-pegar]")) {
  b.addEventListener("click", () => {
    $("#texto-pegado").value = "";
    mostrar("pegar");
    $("#texto-pegado").focus();
  });
}
$("#b-cancelar-texto").addEventListener("click", () => mostrar(actual ? "informe" : "inicio"));
$("#b-usar-texto").addEventListener("click", () => {
  const texto = $("#texto-pegado").value;
  $("#texto-pegado").value = ""; // no queda en la página
  if (letras(texto) < MIN_LETRAS) return aviso("⚠️ Pega el texto completo del informe.");
  if (!actual) actual = { creado: ahora(), paginas: [] };
  actual.paginas.push({ nombre: "texto pegado", texto, confianza: 100, letras: letras(texto) });
  mostrar("informe");
  pintarPaginas();
  aviso(`✓ Texto añadido (${letras(texto)} letras)`);
});

$("#b-cancelar").addEventListener("click", async () => {
  if (actual.paginas.length && !(await confirmar("¿Descartar este informe?", "Sí, descartar"))) return;
  actual = null;
  mostrar("inicio");
});

// ---------- revisión ----------
$("#b-revisar").addEventListener("click", async () => {
  const bruto = actual.paginas.filter((p) => p.letras >= MIN_LETRAS).map((p) => p.texto).join("\n\n");
  const idPaciente = await seudonimo(bruto, config.identificador, await almacen.claveSeudonimos());
  const texto = anonimizar(bruto, config.identificador, config.ocultar); // el original no sale de aquí
  revision = { idPaciente, texto, resultados: extraer(texto, config.variables) };
  pintarRevision();
  mostrar("revision");
});

function pintarRevision() {
  const res = revision.resultados;
  const vals = Object.values(res);
  const hallados = vals.filter((r) => r.valor).length;
  const dudas = vals.filter((r) => r.estado === "dudoso").length;
  $("#resumen").innerHTML =
    `<div class="aviso ${dudas ? "dudoso" : hallados ? "ok" : "no_encontrado"}">Encontrados ${hallados} de ${vals.length} datos` +
    (dudas ? ` · ${dudas} dudosos: revísalos` : "") + `</div>` +
    (revision.idPaciente ? "" : `<p class="suave">No se ha encontrado el NHC: el informe se guardará sin código de paciente.</p>`);
  $("#variables").innerHTML = config.variables.map((v) => {
    const r = res[v.nombre];
    return `<div class="var"><div class="cab"><span class="nombre" title="${escapar(v.descripcion)}">${escapar(v.nombre)}</span>
      <span class="chip ${r.estado}">${r.estado.replace("_", " ")}</span></div>
      <input data-var="${v.nombre}" value="${escapar(r.valor)}" inputmode="${v.tipo === "numero" ? "decimal" : "text"}" autocomplete="off" aria-label="${escapar(v.nombre)}">
      ${r.evidencia ? `<div class="evid">↳ ${escapar(r.evidencia)}</div>` : ""}</div>`;
  }).join("");
  $("#texto").textContent = revision.texto;
}

$("#b-guardar").addEventListener("click", async () => {
  const resultados = {};
  for (const v of config.variables) {
    const r = revision.resultados[v.nombre];
    const valor = $(`input[data-var="${v.nombre}"]`).value.trim().replace(",", v.tipo === "numero" ? "." : ",");
    resultados[v.nombre] = valor === r.valor ? r : { valor, estado: "corregido", evidencia: `Corregido a mano (leído: «${r.valor}») ‖ ${r.evidencia}` };
  }
  const id = await almacen.guardarInforme({
    creado: actual.creado, paginas: actual.paginas.length, paciente: revision.idPaciente, resultados,
  });
  actual = revision = null;
  await pintarInicio();
  mostrar("inicio");
  aviso(`✓ Informe #${id} guardado`);
});

$("#b-volver").addEventListener("click", () => mostrar("informe"));
$("#b-descartar").addEventListener("click", async () => {
  if (!(await confirmar("¿Descartar este informe sin guardarlo?", "Sí, descartar"))) return;
  actual = revision = null;
  mostrar("inicio");
});

// ---------- exportar ----------
function csv(filas, sep = ";") {
  const celda = (x) => {
    const s = String(x ?? "");
    return /[";\n\r]/.test(s) || s.includes(sep) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + filas.map((f) => f.map(celda).join(sep)).join("\r\n") + "\r\n";
}

$("#b-exportar").addEventListener("click", async () => {
  const lista = await almacen.informes();
  if (!lista.length) return aviso("No hay informes que exportar.");
  const nombres = config.variables.map((v) => v.nombre);
  const numericas = new Set(config.variables.filter((v) => v.tipo === "numero").map((v) => v.nombre));
  const datos = [["id_informe", "id_paciente", "fecha_captura", "paginas", "variables_a_revisar", ...nombres]];
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
    datos.push([inf.id, inf.paciente, inf.creado, inf.paginas, aRevisar.join(" "), ...fila]);
  }
  const sello = ahora().replace(/[-:]/g, "").replace("T", "_");
  const archivos = [
    new File([csv(datos)], `ocrmed_${sello}_datos.csv`, { type: "text/csv" }),
    new File([csv(rev)], `ocrmed_${sello}_revision.csv`, { type: "text/csv" }),
  ];
  // Dentro de Claude: su sistema de descargas (pide confirmación por cada archivo).
  const descargas = await window.claude?.use?.("downloads").catch(() => null);
  if (descargas) {
    try {
      for (const f of archivos) await descargas.save({ filename: f.name, data: f });
      return aviso(`✓ Exportados ${lista.length} informes`);
    } catch (e) {
      return aviso(e.code === "declined" ? "Exportación cancelada" : "⚠️ No se pudo guardar: " + (e.message || e.code), 6000);
    }
  }
  if (navigator.canShare?.({ files: archivos })) {
    try {
      await navigator.share({ files: archivos });
      return aviso(`✓ Exportados ${lista.length} informes`);
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  for (const f of archivos) {
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(f), download: f.name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  aviso(`✓ Exportados ${lista.length} informes`);
});

$("#b-borrar-todo").addEventListener("click", async () => {
  if (!(await confirmar("¿Borrar TODOS los informes de este móvil? Exporta antes el CSV.", "Sí, borrar todo"))) return;
  await almacen.borrarTodo();
  pintarInicio();
  aviso("Informes borrados");
});

// ---------- ajustes ----------
$("#b-ajustes").addEventListener("click", () => mostrar("ajustes"));
$("#b-cerrar-ajustes").addEventListener("click", () => mostrar(actual ? "informe" : "inicio"));
try { $("#op-pantalla").checked = localStorage.getItem("pantalla") === "1"; } catch {}
$("#op-pantalla").addEventListener("change", (e) => { try { localStorage.setItem("pantalla", e.target.checked ? "1" : "0"); } catch {} });

$("#in-yaml").addEventListener("change", async (e) => {
  const archivo = e.target.files[0];
  e.target.value = "";
  if (!archivo) return;
  const texto = await archivo.text();
  try {
    cargarVariables(texto); // valida antes de aceptar
  } catch (err) {
    return aviso("⚠️ " + err.message, 8000);
  }
  await almacen.escribirMeta("variables_yaml", texto);
  await cargarConfig();
  aviso("✓ Variables cargadas");
});

$("#b-yaml-original").addEventListener("click", async () => {
  await almacen.borrarMeta("variables_yaml");
  await cargarConfig();
  aviso("✓ Variables de la app");
});

// ---------- arranque ----------
async function arrancar() {
  try {
    await cargarConfig();
  } catch (err) {
    aviso("⚠️ Variables: " + err.message, 10000);
  }
  await pintarInicio();
  iniciarOCR()
    .then(() => ($("#estado-ocr").textContent = "Lector listo. Funciona sin internet."))
    .catch((err) => ($("#estado-ocr").textContent = "⚠️ El lector no ha podido arrancar: " + err.message));
  if ("serviceWorker" in navigator && isSecureContext) navigator.serviceWorker.register("sw.js").catch(() => {});
}
arrancar();
