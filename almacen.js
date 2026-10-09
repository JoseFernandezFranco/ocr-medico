// Base de datos local del navegador (IndexedDB). Solo guarda resultados y evidencias anonimizadas:
// nunca fotos ni el texto completo del informe.
const NOMBRE = "ocrmed";

function abrir() {
  return new Promise((ok, mal) => {
    const pet = indexedDB.open(NOMBRE, 1);
    pet.onupgradeneeded = () => {
      pet.result.createObjectStore("informes", { keyPath: "id", autoIncrement: true });
      pet.result.createObjectStore("meta");
    };
    pet.onsuccess = () => ok(pet.result);
    pet.onerror = () => mal(pet.error);
  });
}

async function operar(almacen, modo, fn) {
  const db = await abrir();
  return new Promise((ok, mal) => {
    const tx = db.transaction(almacen, modo);
    const pet = fn(tx.objectStore(almacen));
    tx.oncomplete = () => {
      db.close();
      ok(pet?.result);
    };
    tx.onerror = () => mal(tx.error);
  });
}

/** Crea (sin id) o actualiza (con id) un informe. Devuelve su id. */
export const guardarInforme = (inf) => operar("informes", "readwrite", (s) => s.put(inf));
export const obtenerInforme = (id) => operar("informes", "readonly", (s) => s.get(id));
export const informes = () => operar("informes", "readonly", (s) => s.getAll());
export const borrarInforme = (id) => operar("informes", "readwrite", (s) => s.delete(id));
export const borrarTodo = () => operar("informes", "readwrite", (s) => s.clear());
export const leerMeta = (clave) => operar("meta", "readonly", (s) => s.get(clave));
export const escribirMeta = (clave, valor) => operar("meta", "readwrite", (s) => s.put(valor, clave));
export const borrarMeta = (clave) => operar("meta", "readwrite", (s) => s.delete(clave));

/** Clave del seudónimo del paciente: aleatoria, creada una vez y guardada solo en este dispositivo. */
export async function claveSeudonimos() {
  let clave = await leerMeta("clave_seudonimos");
  if (!clave) {
    clave = crypto.getRandomValues(new Uint8Array(32));
    await escribirMeta("clave_seudonimos", clave);
  }
  return clave;
}
