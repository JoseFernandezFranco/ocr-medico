// Extracción de variables por reglas (expresiones regulares). Traducción fiel de ocrmed/extraer.py
// para que el móvil y la Pi den los mismos resultados con el mismo variables.yaml.

const TIPOS = new Set(["numero", "categoria", "si_no", "texto"]);
const SI_VARIOS = new Set(["dudoso", "primero", "ultimo", "maximo", "minimo"]);
const BANDERAS = "gim";

// Negación/afirmación alrededor de una mención (para variables si_no). El texto ya va sin tildes.
const NEG_ANTES = /(?:\bno\b|\bsin\b|\bni\b|ausencia de|negativ[oa]s? (?:para|de)|libre de|descart)/im;
const NEG_DESPUES = /^\W{0,3}(?:no\b|negativ|ausente|no identificad|no se (?:observa|identifica|objetiva|aprecia))/im;
const POS_ANTES = /(?:presencia de|se (?:observa|identifica|objetiva|aprecia)n?|\bcon\b|positiv[oa]s? para)/im;
const POS_DESPUES = /^\W{0,3}(?:si\b|presente|positiv|identificad|focal|extens)/im;
const NEG_LISTA = /(?:\bno\s+se\s+(?:observa|identifica|objetiva|aprecia|visualiza|detecta)n?\b|\bsin\b|ausencia de|\bno hay\b)/gim;

export function quitarTildes(texto) {
  return texto.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

// Código TNM con confusiones típicas del OCR en las cifras: "ypT4aNZa" -> "ypT4aN2a", "pT3NO" -> "pT3N0".
const TNM = /(?<![A-Za-z])((?:y?p|c|m?r)?T)([0-4OoIlZ])([a-d]?|is|x) ?N(?:[OoIlZ](?=[0-3]))?([0-3OoIlZx])([a-c]?)(?![A-Za-z0-9])/g;
const N_SUELTA = /(?<![A-Za-z])((?:y?p|[cC]|m?r)N)(?:[OoIlZ](?=[0-3]))?([0-3OoIlZx])([a-c]?)(?![A-Za-z0-9])/g;
const CIFRAS_OCR = { O: "0", o: "0", I: "1", l: "1", Z: "2" };
const cifras = (s) => s.replace(/[OoIlZ]/g, (c) => CIFRAS_OCR[c]);

export function normalizar(texto) {
  let t = quitarTildes(texto.replace(/\r/g, ""));
  t = t.replace(/(\w)-\n(\w)/g, "$1$2");
  t = t.replace(/[ \t]+/g, " ");
  // Une las frases partidas en dos líneas ("a 8 cm del\nmargen anal"), pero no las "Campo: valor".
  t = t.replace(/([a-z0-9,]) ?\n(?:[ \t]*\n)*(?=[a-z0-9(])/g, "$1 ");
  t = t.replace(/(\d\s?)crn\b/g, "$1cm");
  t = t.replace(/(\d\s?)rnm\b/g, "$1mm");
  t = t.replace(TNM, (_, a, b, c, d, e) => `${a}${cifras(b)}${c}N${cifras(d)}${e}`);
  t = t.replace(N_SUELTA, (_, a, b, c) => `${a}${cifras(b)}${c}`);
  return t;
}

function compilar(patron, contexto) {
  // Sintaxis de Python -> JavaScript: (?P<nombre>...) -> (?<nombre>...)
  const js = quitarTildes(String(patron)).replace(/\(\?P</g, "(?<");
  try {
    return new RegExp(js, BANDERAS);
  } catch (e) {
    throw new Error(`${contexto}: patrón inválido «${patron}» (${e.message})`);
  }
}

const tieneGrupoValor = (re) => /\(\?<valor>/.test(re.source);
const numGrupos = (re) => new RegExp(re.source + "|").exec("").length - 1;

/** Lee y valida el YAML de variables (texto). Devuelve {identificador, variables, ocultar}. */
export function cargarVariables(textoYaml) {
  let datos;
  try {
    datos = window.jsyaml.load(textoYaml) || {};
  } catch (e) {
    throw new Error(`El YAML no se puede leer: ${e.message}`);
  }
  if (typeof datos !== "object" || !Array.isArray(datos.variables) || !datos.variables.length) {
    throw new Error("Falta la lista «variables:».");
  }
  const identificador = datos.identificador?.patron ? compilar(datos.identificador.patron, "identificador") : null;
  const ocultar = (datos.ocultar || []).map((p) => compilar(p, "ocultar"));

  const variables = [];
  const nombres = new Set();
  datos.variables.forEach((d, i) => {
    if (!d || typeof d !== "object" || !d.nombre) throw new Error(`La variable nº ${i + 1} no tiene «nombre».`);
    const nombre = String(d.nombre).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(nombre)) {
      throw new Error(`«${nombre}»: usa solo letras sin tildes, números y _ (es el nombre de la columna).`);
    }
    if (nombres.has(nombre)) throw new Error(`«${nombre}» está repetida.`);
    nombres.add(nombre);
    const tipo = d.tipo || "texto";
    if (!TIPOS.has(tipo)) throw new Error(`«${nombre}»: tipo «${tipo}» no válido (usa ${[...TIPOS].sort().join(", ")}).`);
    const siVarios = d.si_varios || "dudoso";
    if (!SI_VARIOS.has(siVarios)) throw new Error(`«${nombre}»: si_varios debe ser uno de ${[...SI_VARIOS].sort().join(", ")}.`);

    const patrones = (d.patrones || []).map((p) => compilar(p, nombre));
    const opciones = {};
    if (tipo === "categoria" && d.opciones) {
      for (const [valor, pats] of Object.entries(d.opciones)) {
        opciones[String(valor)] = (Array.isArray(pats) ? pats : [pats]).map((p) => compilar(p, `${nombre}/${valor}`));
      }
    }
    const hayOpciones = Object.keys(opciones).length > 0;
    if (!patrones.length && !hayOpciones) throw new Error(`«${nombre}»: necesita «patrones» (u «opciones» si es categoría).`);
    if (tipo === "numero" || tipo === "texto" || (tipo === "categoria" && !hayOpciones)) {
      for (const p of patrones) {
        if (!tieneGrupoValor(p) && numGrupos(p) === 0) {
          throw new Error(`«${nombre}»: el patrón «${p.source}» debe marcar el dato con (?P<valor>...).`);
        }
      }
    }
    variables.push({
      nombre, tipo, patrones, opciones, siVarios,
      rango: d.rango ? d.rango.map(Number) : null,
      mayusculas: Boolean(d.mayusculas),
      descripcion: d.descripcion || "",
    });
  });
  return { identificador, variables, ocultar };
}

/** Texto normalizado sin NHC ni lo que marquen los patrones «ocultar» (nombre, DNI…). */
export function anonimizar(texto, identificador, ocultar) {
  let t = normalizar(texto);
  for (const p of (identificador ? [identificador] : []).concat(ocultar)) {
    t = t.replace(p, "[oculto]");
  }
  return t;
}

function fragmento(texto, ini, fin, margen = 60) {
  const a = Math.max(0, ini - margen, texto.lastIndexOf("\n", ini - 1) + 1);
  let b = texto.indexOf("\n", fin);
  b = Math.min(texto.length, fin + margen, b !== -1 ? b : texto.length);
  return (a && texto[a - 1] !== "\n" ? "…" : "") + texto.slice(a, b).split(/\s+/).filter(Boolean).join(" ") +
    (b < texto.length && texto[b] !== "\n" ? "…" : "");
}

function valorCapturado(m, re) {
  if (tieneGrupoValor(re)) return m.groups?.valor ?? "";
  return m.length > 1 ? (m[1] ?? "") : m[0];
}

// Igual que f"{x:g}" de Python: 6 cifras significativas sin ceros sobrantes.
const formatoNumero = (x) => String(Number(x.toPrecision(6)));

function resolver(encontrados, siVarios, numerico = false) {
  const distintos = [...new Set(encontrados.map(([v]) => v))];
  let evidencia = [...new Set(encontrados.map(([, f]) => f))].slice(0, 3).join(" ‖ ");
  let valor, estado;
  if (distintos.length === 1) {
    [valor, estado] = [distintos[0], "ok"];
  } else {
    const formato = numerico ? formatoNumero : String;
    evidencia = "Varios valores: " + distintos.map(formato).join(" | ") + " ‖ " + evidencia;
    if (siVarios === "primero") [valor, estado] = [distintos[0], "ok"];
    else if (siVarios === "ultimo") [valor, estado] = [distintos[distintos.length - 1], "ok"];
    else if ((siVarios === "maximo" || siVarios === "minimo") && numerico) {
      [valor, estado] = [siVarios === "maximo" ? Math.max(...distintos) : Math.min(...distintos), "ok"];
    } else [valor, estado] = [distintos[0], "dudoso"];
  }
  if (numerico) valor = formatoNumero(valor);
  return { valor: String(valor), estado, evidencia };
}

const vacio = () => ({ valor: "", estado: "no_encontrado", evidencia: "" });

function* coincidencias(texto, patrones) {
  const vistas = new Set();
  for (const p of patrones) {
    for (const m of texto.matchAll(p)) {
      const clave = `${m.index}:${m.index + m[0].length}`;
      if (!vistas.has(clave)) {
        vistas.add(clave);
        yield [m, p];
      }
    }
  }
}

function sentido(texto, m) {
  const ini = m.index, fin = m.index + m[0].length;
  const antes = texto.slice(Math.max(0, ini - 50), ini).split(/[.;:\n,()]/).pop();
  let despues = texto.slice(fin, fin + 45).replace(/^\s*\([^)\n]{0,20}\)/, ""); // salta "(ILV)"
  despues = despues.split(/[.;\n,(]/)[0];
  if (NEG_ANTES.test(antes) || NEG_DESPUES.test(despues)) return "no";
  if (POS_ANTES.test(antes) || POS_DESPUES.test(despues)) return "si";
  // Enumeración negada: «No se identifican nódulos, microcalcificaciones agrupadas ni asimetrías».
  const clausula = texto.slice(Math.max(0, ini - 150), ini).split(/[.;:\n()]/).pop();
  const negaciones = [...clausula.matchAll(NEG_LISTA)];
  if (negaciones.length) {
    const ultima = negaciones[negaciones.length - 1];
    if (!POS_ANTES.test(clausula.slice(ultima.index + ultima[0].length))) return "no";
  }
  return null;
}

const span = (m) => [m.index, m.index + m[0].length];

export function extraerVariable(texto, v) {
  if (v.tipo === "numero") {
    const validos = [], fuera = [];
    for (const [m, p] of coincidencias(texto, v.patrones)) {
      const crudo = valorCapturado(m, p).replace(/,/g, ".").trim();
      const x = Number(crudo);
      if (crudo === "" || Number.isNaN(x)) continue;
      const frag = fragmento(texto, ...span(m));
      (v.rango && !(v.rango[0] <= x && x <= v.rango[1]) ? fuera : validos).push([x, frag]);
    }
    if (validos.length) return resolver(validos, v.siVarios, true);
    if (fuera.length) return { valor: formatoNumero(fuera[0][0]), estado: "dudoso", evidencia: "Fuera de rango ‖ " + fuera[0][1] };
    return vacio();
  }

  if (v.tipo === "categoria" && Object.keys(v.opciones).length) {
    const encontrados = [];
    for (const [valor, pats] of Object.entries(v.opciones)) {
      for (const [m] of coincidencias(texto, pats)) encontrados.push([m.index, valor, fragmento(texto, ...span(m))]);
    }
    encontrados.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    return encontrados.length ? resolver(encontrados.map(([, val, f]) => [val, f]), v.siVarios) : vacio();
  }

  if (v.tipo === "categoria" || v.tipo === "texto") {
    const encontrados = [];
    for (const [m, p] of coincidencias(texto, v.patrones)) {
      const valor = valorCapturado(m, p).split(/\s+/).filter(Boolean).join(" ");
      if (valor) encontrados.push([v.mayusculas ? valor.toUpperCase() : valor, fragmento(texto, ...span(m))]);
    }
    return encontrados.length ? resolver(encontrados, v.siVarios) : vacio();
  }

  // si_no: la ausencia de mención NO es un "no"; se deja vacío.
  const claros = [], ambiguos = [];
  for (const [m] of coincidencias(texto, v.patrones)) {
    const frag = fragmento(texto, ...span(m));
    const s = sentido(texto, m);
    (s ? claros : ambiguos).push([s, frag]);
  }
  if (claros.length) return resolver(claros, v.siVarios);
  if (ambiguos.length) return { valor: "si", estado: "dudoso", evidencia: "Mencionado sin afirmar ni negar ‖ " + ambiguos[0][1] };
  return vacio();
}

/** Descarta fotos sin informe (la mesa, la pantalla apagada…). */
export function letras(texto) {
  return texto.replace(/[\W_]/g, "").length;
}

export function extraer(texto, variables) {
  const t = normalizar(texto);
  return Object.fromEntries(variables.map((v) => [v.nombre, extraerVariable(t, v)]));
}

/** Identificador estable del paciente sin guardar el NHC: HMAC-SHA256 con una clave del dispositivo. */
export async function seudonimo(texto, patron, clave) {
  if (!patron) return "";
  patron.lastIndex = 0;
  const m = new RegExp(patron.source, "im").exec(normalizar(texto));
  if (!m) return "";
  const capturado = valorCapturado(m, patron);
  const nhc = capturado.replace(/\D/g, "") || capturado.trim();
  const k = await crypto.subtle.importKey("raw", clave, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const firma = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(nhc)));
  return [...firma].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}
