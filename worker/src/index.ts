// Kumo Bot · nube personal (Cloudflare Worker).
// Guarda la config y el estado del bot en KV y sirve la API de la app.
// Las claves del exchange NUNCA llegan aquí: viven solo en los secretos de
// GitHub del usuario y las usa el runner.

export interface Env {
  KUMO: KVNamespace;
  APP_TOKEN: string;
  RUNNER_TOKEN: string;
  // IA: cualquier proveedor compatible con OpenAI. IA_CLAVE va vacía en los
  // que no piden cuenta (Kilo). GROQ_* queda para nubes instaladas antes.
  IA_URL?: string;
  IA_MODELOS?: string;
  IA_CLAVE?: string;
  GROQ_API_KEY?: string;
  GROQ_MODEL?: string;
  // Versión del código de la nube (runner/version.txt), la pone instalar.yml.
  KUMO_VERSION?: string;
}

const GROQ_MODELOS = ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b', 'llama-3.3-70b-versatile'];

type Json = Record<string, any>;

const CONFIG_DEFECTO: Json = {
  modo: 'simulacion', pausado: false, quote: 'USDT', objetivo: { BTC: 40, ETH: 30 },
  monto_min: 5, monto_max: 25, rsi_compra: 35, rsi_venta: 68, banda: 3, ganancia_min: 1.5,
  stop_perdida: 0, nunca_vender_con_perdida: true, ia: 'veto', ia_conf_min: 65, max_ops_ciclo: 2,
  marco: '1h', saldo_simulado: 1000, radar_pedidos: [], ordenes_ia: 'proponer', orden_horas: 24,
};

// Límites duros: la app no puede guardar valores fuera de estos rangos.
const RANGOS: Record<string, [number, number]> = {
  monto_min: [1, 1000], monto_max: [1, 5000], rsi_compra: [5, 60], rsi_venta: [40, 95], banda: [0, 20],
  ganancia_min: [0, 50], stop_perdida: [0, 50], ia_conf_min: [0, 100], max_ops_ciclo: [0, 10], saldo_simulado: [10, 1000000], orden_horas: [1, 168],
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
};

function json(datos: unknown, status = 200): Response {
  return new Response(JSON.stringify(datos), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS } });
}

function iguales(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function token(req: Request): string {
  const h = req.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

async function leer<T>(env: Env, clave: string, defecto: T): Promise<T> {
  return ((await env.KUMO.get(clave, 'json')) as T) ?? defecto;
}

async function leerConfig(env: Env): Promise<Json> {
  const c = await leer<Json>(env, 'config', {});
  return { ...CONFIG_DEFECTO, ...c, objetivo: c.objetivo ?? CONFIG_DEFECTO.objetivo };
}

function limpiarSimbolo(s: unknown): string {
  return String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

function validarConfig(actual: Json, cambios: Json): { config?: Json; error?: string } {
  const c: Json = { ...actual };
  for (const [k, [min, max]] of Object.entries(RANGOS)) {
    if (cambios[k] === undefined) continue;
    const v = Number(cambios[k]);
    if (!Number.isFinite(v) || v < min || v > max) return { error: `${k} debe estar entre ${min} y ${max}` };
    c[k] = v;
  }
  if (c.monto_min > c.monto_max) return { error: 'monto_min no puede ser mayor que monto_max' };
  if (c.rsi_compra >= c.rsi_venta) return { error: 'rsi_compra debe ser menor que rsi_venta' };
  if (cambios.quote !== undefined) c.quote = limpiarSimbolo(cambios.quote) || 'USDT';
  if (cambios.marco !== undefined) {
    if (!['15m', '1h', '4h', '1d'].includes(cambios.marco)) return { error: 'marco inválido' };
    c.marco = cambios.marco;
  }
  if (cambios.ia !== undefined) {
    if (!['off', 'veto', 'confirmar'].includes(cambios.ia)) return { error: 'ia inválida' };
    c.ia = cambios.ia;
  }
  if (cambios.ordenes_ia !== undefined) {
    if (!['off', 'proponer', 'auto'].includes(cambios.ordenes_ia)) return { error: 'ordenes_ia inválido' };
    c.ordenes_ia = cambios.ordenes_ia;
  }
  if (cambios.nunca_vender_con_perdida !== undefined) c.nunca_vender_con_perdida = Boolean(cambios.nunca_vender_con_perdida);
  if (cambios.objetivo !== undefined) {
    const obj: Json = {};
    let suma = 0;
    for (const [k, v] of Object.entries(cambios.objetivo || {})) {
      const s = limpiarSimbolo(k), n = Number(v);
      if (!s || !Number.isFinite(n) || n < 0 || n > 100) return { error: `objetivo inválido para ${k}` };
      if (n > 0) { obj[s] = Math.round(n * 10) / 10; suma += n; }
    }
    if (suma > 100) return { error: `El reparto suma ${suma}%: máximo 100%` };
    if (Object.keys(obj).length > 30) return { error: 'Máximo 30 monedas' };
    c.objetivo = obj;
  }
  if (cambios.modo !== undefined) {
    if (!['simulacion', 'real'].includes(cambios.modo)) return { error: 'modo inválido' };
    if (cambios.modo === 'real' && actual.modo !== 'real' && cambios.confirmar_real !== true) return { error: 'Activar dinero real requiere confirmar_real: true' };
    c.modo = cambios.modo;
  }
  return { config: c };
}

async function avisar(env: Env, items: Json[]) {
  if (!items.length) return;
  const feed = await leer<Json[]>(env, 'feed', []);
  const ts = Date.now();
  const nuevos = items.map((it, i) => ({ id: `${ts}-${i}`, ts, ...it }));
  await env.KUMO.put('feed', JSON.stringify([...nuevos.reverse(), ...feed].slice(0, 30)));
}

// ---------------------------------------------------------------- Señales de la IA
// Historial de lo que dijo la IA en cada ciclo y qué pasó con cada orden, para
// que la app lo muestre en vivo. Una escritura de KV por ciclo con señales.
const MAX_SENALES = 60;
async function guardarSenales(env: Env, ciclo: number, ts: number, r: Json): Promise<void> {
  const op: Json = r.ia?.opiniones || {};
  const senales = Object.keys(op).map((s) => ({ simbolo: s, ...op[s] }));
  const ordenes: Json[] = Array.isArray(r.ordenes) ? r.ordenes : [];
  if (!senales.length && !ordenes.length) return;
  const lista = await leer<Json[]>(env, 'senales', []);
  const item = { tipo: 'ciclo', ciclo, ts, modelo: r.ia?.modelo || null, modo_ia: r.ia?.modo || null, modo: r.modo, quote: r.quote, senales, ordenes };
  await env.KUMO.put('senales', JSON.stringify([item, ...lista].slice(0, MAX_SENALES)));
}

// ---------------------------------------------------------------- Órdenes
// Cola de órdenes explícitas: propuestas por la IA o creadas por el usuario.
// propuesta → (aprobar) → aprobada → (el runner la ejecuta) → ejecutada | error
// propuesta/aprobada → cancelada | caducada (orden_horas sin ejecutarse).
const MAX_ORDENES = 80;
const PENDIENTE = (o: Json) => o.estado === 'propuesta' || o.estado === 'aprobada';

async function leerOrdenes(env: Env): Promise<Json[]> {
  return leer<Json[]>(env, 'ordenes', []);
}
async function guardarOrdenes(env: Env, lista: Json[]): Promise<void> {
  // Las pendientes nunca se recortan; de las cerradas quedan las más nuevas.
  const pend = lista.filter(PENDIENTE), cerradas = lista.filter((o) => !PENDIENTE(o));
  await env.KUMO.put('ordenes', JSON.stringify([...pend, ...cerradas].sort((a, b) => b.ts - a.ts).slice(0, Math.max(MAX_ORDENES, pend.length))));
}
function nuevoId(prefijo: string): string {
  return prefijo + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function textoOrden(o: Json): string {
  return `${o.accion === 'COMPRAR' ? 'Compra' : 'Venta'} ${o.simbolo} ${o.accion === 'COMPRAR' ? `${o.monto} ${o.quote || ''}`.trim() : `${o.pct}%`}${o.limite ? ` si ${o.accion === 'COMPRAR' ? '≤' : '≥'} ${o.limite}` : ''}`;
}

// Valida lo que llega de la app o de la IA. Devuelve la orden limpia o un error.
function limpiarOrden(base: Json, c: Json, config: Json): { orden?: Json; error?: string } {
  const o: Json = { ...base };
  if (c.simbolo !== undefined) { o.simbolo = limpiarSimbolo(c.simbolo); if (!o.simbolo) return { error: 'Moneda inválida' }; }
  if (c.accion !== undefined) {
    const a = String(c.accion).toUpperCase();
    if (!['COMPRAR', 'VENDER'].includes(a)) return { error: 'La acción debe ser COMPRAR o VENDER' };
    o.accion = a;
  }
  if (!o.simbolo || !o.accion) return { error: 'Falta la moneda o la acción' };
  if (o.simbolo === String(config.quote).toUpperCase()) return { error: `${o.simbolo} es tu moneda base` };
  if (o.accion === 'COMPRAR') {
    const m = Number(c.monto ?? o.monto);
    if (!(m >= 1 && m <= 100000)) return { error: 'Monto inválido (mínimo 1)' };
    o.monto = Math.round(m * 100) / 100; delete o.pct;
  } else {
    const p = Number(c.pct ?? o.pct ?? 100);
    if (!(p >= 1 && p <= 100)) return { error: 'El % a vender va de 1 a 100' };
    o.pct = Math.round(p); delete o.monto;
  }
  if (c.limite !== undefined) {
    const l = c.limite === null || c.limite === '' ? null : Number(c.limite);
    if (l !== null && !(l > 0)) return { error: 'Precio límite inválido' };
    o.limite = l;
  }
  if (c.permitir_perdida !== undefined) o.permitir_perdida = Boolean(c.permitir_perdida);
  if (c.razon !== undefined) o.razon = String(c.razon).slice(0, 240);
  o.quote = config.quote;
  return { orden: o };
}

async function mezclarOrdenes(env: Env, ahora: number, r: Json): Promise<void> {
  const upd: Json[] = Array.isArray(r.ordenes_upd) ? r.ordenes_upd : [];
  const nuevas: Json[] = Array.isArray(r.ordenes_nuevas) ? r.ordenes_nuevas : [];
  let lista = await leerOrdenes(env);
  const config = await leerConfig(env);
  let cambio = false;
  const eventos: Json[] = [];
  for (const u of upd) {
    const o = lista.find((x) => x.id === u.id);
    if (!o) continue;
    // Si el usuario la canceló mientras corría el ciclo, solo cuenta si de verdad se ejecutó.
    if (o.estado === 'cancelada' && u.estado !== 'ejecutada') continue;
    if (o.estado !== u.estado) eventos.push({ tipo: 'orden', ok: u.estado !== 'error', texto: `${textoOrden(o)}: ${u.estado}${u.error ? ` · ${u.error}` : ''}`, id: o.id });
    if (o.estado !== u.estado || o.nota !== u.nota) cambio = true;
    Object.assign(o, { estado: u.estado, nota: u.nota || null, error: u.error || null, resultado: u.resultado || o.resultado || null, ts_mod: ahora });
  }
  for (const n of nuevas) {
    const v = limpiarOrden({}, n, config);
    if (!v.orden) continue;
    const previa = lista.find((x) => PENDIENTE(x) && x.origen === 'ia' && x.simbolo === v.orden!.simbolo && x.accion === v.orden!.accion);
    if (previa) continue;
    const o: Json = { ...v.orden, id: n.id || nuevoId('ia'), ts: ahora, origen: 'ia', confianza: n.confianza, ia: n.ia || null,
      estado: ['propuesta', 'aprobada', 'ejecutada', 'error'].includes(n.estado) ? n.estado : 'propuesta',
      nota: n.nota || null, error: n.error || null, resultado: n.resultado || null,
      vence: ahora + (config.orden_horas || 24) * 3600_000,
      historia: [{ ts: ahora, quien: 'ia', texto: `Propuesta con ${n.confianza}% de confianza: ${n.razon || ''}`.trim() }] };
    lista.unshift(o);
    cambio = true;
    eventos.push({ tipo: 'orden', ok: o.estado !== 'error', texto: `IA ${o.estado === 'ejecutada' ? 'ejecutó' : 'propuso'}: ${textoOrden(o)}`, id: o.id });
  }
  for (const o of lista) {
    if (PENDIENTE(o) && o.vence && o.vence < ahora) {
      o.estado = 'caducada'; o.ts_mod = ahora; cambio = true;
      eventos.push({ tipo: 'orden', ok: true, texto: `Caducó: ${textoOrden(o)}`, id: o.id });
    }
  }
  if (cambio) await guardarOrdenes(env, lista);
  if (eventos.length) await bitacora(env, eventos.map((e) => ({ ...e, ts: ahora })));
}

async function ordenesApi(env: Env, c: Json): Promise<Response> {
  const config = await leerConfig(env);
  const lista = await leerOrdenes(env);
  const ahora = Date.now();
  const accion = String(c.accion || '');
  const o = c.id ? lista.find((x) => x.id === c.id) : null;
  if (c.id && !o) return json({ error: 'Esa orden ya no existe' }, 404);
  if (o && !PENDIENTE(o)) return json({ error: `La orden ya está ${o.estado}` }, 409);
  const hist = (x: Json, quien: string, texto: string) => { x.historia = [...(x.historia || []), { ts: ahora, quien, texto }].slice(-12); x.ts_mod = ahora; };

  if (accion === 'crear') {
    const v = limpiarOrden({}, c.orden || {}, config);
    if (!v.orden) return json({ error: v.error }, 400);
    const n: Json = { ...v.orden, id: nuevoId('u'), ts: ahora, origen: 'usuario', estado: 'aprobada', vence: ahora + (config.orden_horas || 24) * 3600_000 };
    hist(n, 'usuario', `Creada: ${textoOrden(n)}`);
    lista.unshift(n);
    await guardarOrdenes(env, lista);
    await bitacora(env, [{ ts: ahora, tipo: 'orden', ok: true, texto: `Creaste: ${textoOrden(n)}`, id: n.id }]);
    return json({ ok: true, orden: n });
  }
  if (accion === 'editar' && o) {
    const v = limpiarOrden(o, c.cambios || {}, config);
    if (!v.orden) return json({ error: v.error }, 400);
    Object.assign(o, v.orden);
    hist(o, 'usuario', `Editada: ${textoOrden(o)}`);
    await guardarOrdenes(env, lista);
    await bitacora(env, [{ ts: ahora, tipo: 'orden', ok: true, texto: `Editaste: ${textoOrden(o)}`, id: o.id }]);
    return json({ ok: true, orden: o });
  }
  if ((accion === 'aprobar' || accion === 'cancelar') && o) {
    o.estado = accion === 'aprobar' ? 'aprobada' : 'cancelada';
    if (accion === 'aprobar') o.vence = Math.max(o.vence || 0, ahora + (config.orden_horas || 24) * 3600_000);
    hist(o, 'usuario', accion === 'aprobar' ? 'Aprobada: se ejecuta en el próximo ciclo' : 'Cancelada');
    await guardarOrdenes(env, lista);
    await bitacora(env, [{ ts: ahora, tipo: 'orden', ok: true, texto: `${accion === 'aprobar' ? 'Aprobaste' : 'Cancelaste'}: ${textoOrden(o)}`, id: o.id }]);
    return json({ ok: true, orden: o });
  }
  if (accion === 'ia') {
    const instruccion = String(c.instruccion || '').trim().slice(0, 400);
    if (!instruccion) return json({ error: 'Escribe qué quieres que haga la IA' }, 400);
    return ordenConIA(env, config, lista, o ?? null, instruccion);
  }
  return json({ error: 'Acción de orden desconocida' }, 400);
}

// La IA crea una orden a partir de lo que escribes, o edita una existente.
// El resultado siempre queda como «propuesta»: tú la apruebas.
async function ordenConIA(env: Env, config: Json, lista: Json[], o: Json | null, instruccion: string): Promise<Response> {
  const estado = await leer<Json>(env, 'estado', {});
  const ahora = Date.now();
  const mercado = (estado.radar || []).slice(0, 25).map((f: Json) => ({ s: f.simbolo, p: f.precio, rsi: f.rsi, t: f.tendencia, c24: f.cambio_24h }));
  const cartera = (estado.ultimo?.activos || []).map((a: Json) => ({ s: a.simbolo, cant: a.cantidad, valor: a.valor }));
  const t0 = Date.now();
  let d: Json, modelo: string;
  try {
    ({ datos: d, modelo } = await iaChat(env, [
      { role: 'system', content: 'Preparas órdenes spot para un bot cripto. Respondes SOLO JSON válido en español. Eres prudente y no inventas precios.' },
      { role: 'user', content: `${o ? `Orden actual: ${JSON.stringify({ simbolo: o.simbolo, accion: o.accion, monto: o.monto, pct: o.pct, limite: o.limite ?? null })}\nEl usuario pide cambiarla así: "${instruccion}"` : `El usuario pide esta orden: "${instruccion}"`}
Moneda base: ${config.quote}. Mínimo por orden: ${config.monto_min} ${config.quote}. Cartera: ${JSON.stringify(cartera)}. Mercado: ${JSON.stringify(mercado)}.
COMPRAR usa "monto" en ${config.quote}; VENDER usa "pct" (1-100 de lo que tiene). "limite" es un precio opcional (null = a mercado).
Formato: {"simbolo":"HYPE","accion":"COMPRAR|VENDER","monto":12,"pct":null,"limite":null,"razon":"máx. 25 palabras","aviso":"riesgo o duda, o vacío"}` },
    ]));
  } catch (e: any) {
    await bitacora(env, [{ ts: ahora, tipo: 'ia', ok: false, texto: `IA (órdenes) falló: ${String(e.message || e).slice(0, 160)}`, ms: Date.now() - t0 }]);
    return json({ error: String(e.message || e) }, 502);
  }
  const v = limpiarOrden(o || {}, { simbolo: d.simbolo, accion: d.accion, monto: d.monto ?? undefined, pct: d.pct ?? undefined, limite: d.limite ?? null, razon: d.razon }, config);
  await bitacora(env, [{ ts: ahora, tipo: 'ia', ok: !!v.orden, texto: `IA (órdenes) respondió con ${modelo} en ${((Date.now() - t0) / 1000).toFixed(1)} s${v.error ? ` · orden inválida: ${v.error}` : ''}`, ms: Date.now() - t0, modelo }]);
  if (!v.orden) return json({ error: `La IA propuso algo inválido: ${v.error}` }, 422);
  const n: Json = o || { id: nuevoId('ia'), ts: ahora, vence: ahora + (config.orden_horas || 24) * 3600_000 };
  Object.assign(n, v.orden, { origen: o ? o.origen : 'ia', estado: 'propuesta', ia: { accion: v.orden.accion, confianza: null, razon: v.orden.razon || '' }, aviso: String(d.aviso || '').slice(0, 200) || null });
  n.historia = [...(n.historia || []), { ts: ahora, quien: 'ia', texto: `${o ? 'Editada' : 'Creada'} por la IA («${instruccion.slice(0, 80)}»): ${textoOrden(n)}` }].slice(-12);
  n.ts_mod = ahora;
  if (!o) lista.unshift(n);
  await guardarOrdenes(env, lista);
  await bitacora(env, [{ ts: ahora, tipo: 'orden', ok: true, texto: `IA ${o ? 'editó' : 'creó'}: ${textoOrden(n)} (espera tu aprobación)`, id: n.id }]);
  return json({ ok: true, orden: n, modelo });
}

// ---------------------------------------------------------------- Bitácora
// Historial para saber si todo funciona: ciclos, llamadas a la IA (modelo,
// tiempo, error), órdenes y errores. Una escritura por ciclo y por acción.
const MAX_LOG = 200;
async function bitacora(env: Env, items: Json[]): Promise<void> {
  if (!items.length) return;
  const lista = await leer<Json[]>(env, 'bitacora', []);
  await env.KUMO.put('bitacora', JSON.stringify([...items.slice().reverse(), ...lista].slice(0, MAX_LOG)));
}
async function bitacoraCiclo(env: Env, ciclo: number, ahora: number, r: Json): Promise<void> {
  const items: Json[] = [];
  const log: Json[] = Array.isArray(r.ia_log) ? r.ia_log : [];
  for (const l of log) {
    items.push({ ts: Number(l.ts) || ahora, tipo: 'ia', ok: !!l.ok, ms: l.ms, modelo: l.modelo,
      texto: l.ok ? `IA ${l.proveedor || ''} respondió con ${l.modelo} en ${(Number(l.ms) / 1000).toFixed(1)} s` : `IA ${l.proveedor || ''} falló con ${l.modelo}: ${l.error || 'error'}` });
  }
  if (!log.length && r.ok && r.ia?.modo && r.ia.modo !== 'off') items.push({ ts: ahora, tipo: 'ia', ok: true, texto: 'IA: no hubo nada que consultar en este ciclo' });
  const errs: string[] = Array.isArray(r.errores) ? r.errores : [];
  for (const e of errs.slice(0, 5)) items.push({ ts: ahora, tipo: 'error', ok: false, texto: String(e).slice(0, 240) });
  const ops = Array.isArray(r.ejecutadas) ? r.ejecutadas.length : 0;
  items.push({ ts: ahora, tipo: 'ciclo', ok: r.ok !== false, ciclo,
    texto: `Ciclo #${ciclo} ${r.ok === false ? 'con error' : 'OK'} · ${r.exchange || '?'} · ${r.modo || '?'} · ${ops} operaci${ops === 1 ? 'ón' : 'ones'} · ${errs.length} error${errs.length === 1 ? '' : 'es'}${r.duracion ? ` · ${r.duracion} s` : ''}` });
  await bitacora(env, items);
}

// ---------------------------------------------------------------- Runner
async function runnerReporte(env: Env, r: Json): Promise<Response> {
  const estado = await leer<Json>(env, 'estado', {});
  const ciclo = (estado.ciclo || 0) + 1;
  const ahora = Date.now();
  let historial: [number, number][] = estado.historial || [];
  // La gráfica solo compara peras con peras: al cambiar de exchange o entre
  // simulación y real empieza de cero (si no, 1000 simulados → 10 reales sale -99%).
  const serie = r.ok ? `${r.exchange}|${r.modo}` : estado.serie;
  if (r.ok && estado.serie !== serie) historial = [];
  if (r.ok && typeof r.total === 'number') historial.push([ahora, r.total]);
  const { radar, cartera_sim, costos, graficas, ...ultimo } = r;
  const nuevo: Json = {
    ciclo, actualizado: ahora, serie, ultimo: { ...ultimo, ts: ahora },
    historial: historial.slice(-500),
    runner: { costos: costos ?? estado.runner?.costos ?? {}, cartera_sim: cartera_sim ?? estado.runner?.cartera_sim ?? null },
    radar: Array.isArray(radar) && radar.length ? radar : estado.radar || [],
    radar_ts: Array.isArray(radar) && radar.length ? ahora : estado.radar_ts || null,
  };
  await env.KUMO.put('estado', JSON.stringify(nuevo));
  // Velas de tus activos para las gráficas de la app: una escritura por ciclo,
  // aparte del estado para que el Panel no tenga que descargarlas.
  if (r.ok && graficas && typeof graficas === 'object' && Object.keys(graficas).length) {
    await env.KUMO.put('graficas', JSON.stringify({ ts: ahora, exchange: r.exchange, quote: r.quote, datos: graficas }));
  }

  await guardarSenales(env, ciclo, ahora, r);
  await mezclarOrdenes(env, ahora, r);
  await bitacoraCiclo(env, ciclo, ahora, r);

  const ops: Json[] = Array.isArray(r.ejecutadas) ? r.ejecutadas : [];
  if (ops.length) {
    const lista = await leer<Json[]>(env, 'operaciones', []);
    await env.KUMO.put('operaciones', JSON.stringify([...ops.slice().reverse(), ...lista].slice(0, 200)));
  }
  const avisos: Json[] = ops.map((o) => ({
    tipo: 'operacion',
    titulo: `${o.simulada ? '🧪 ' : ''}${o.accion === 'COMPRAR' ? 'Compra' : 'Venta'} ${o.simbolo}`,
    texto: `${Number(o.total).toFixed(2)} ${r.quote} a ${o.precio} · ${o.motivo}`,
  }));
  const errores: string[] = r.errores || [];
  const previos: string[] = estado.ultimo?.errores || [];
  const nuevosErr = errores.filter((e) => !previos.includes(e));
  if (nuevosErr.length) avisos.push({ tipo: 'error', titulo: 'Kumo necesita tu atención', texto: nuevosErr.join(' · ').slice(0, 240) });
  await avisar(env, avisos);
  return json({ ok: true, ciclo });
}

async function runnerConfig(env: Env): Promise<Response> {
  const [config, estado] = await Promise.all([leerConfig(env), leer<Json>(env, 'estado', {})]);
  const ordenes = (await leerOrdenes(env)).filter((o) => o.estado === 'propuesta' || o.estado === 'aprobada');
  const ia_pref = await env.KUMO.get('ia_pref');
  return json({ config, estado_runner: estado.runner || {}, ordenes, ia_pref });
}

// ---------------------------------------------------------------- IA radar
const analisisMem = new Map<string, { ts: number; datos: Json }>();

function proveedorIA(env: Env): { url: string; clave: string; modelos: string[]; nombre: string } | null {
  const url = (env.IA_URL || '').trim().replace(/\/+$/, '');
  if (url) {
    const modelos = (env.IA_MODELOS || '').split(',').map((m) => m.trim()).filter(Boolean);
    return { url, clave: (env.IA_CLAVE || '').trim(), modelos, nombre: url.replace(/^https?:\/\/(api\.)?/, '').split('/')[0] };
  }
  if (env.GROQ_API_KEY) {
    return { url: 'https://api.groq.com/openai/v1', clave: env.GROQ_API_KEY, modelos: [env.GROQ_MODEL, ...GROQ_MODELOS].filter(Boolean) as string[], nombre: 'groq.com' };
  }
  return null;
}

// Algunos modelos envuelven el JSON en ```json``` o en <think>…</think>.
function extraerJson(texto: string): Json {
  const t = (texto || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  try { return JSON.parse(t); } catch {
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error('JSON inválido');
  }
}

// Modelo que respondió en la última prueba del semáforo: se prueba primero.
async function modelosOrdenados(env: Env, modelos: string[]): Promise<string[]> {
  const pref = await env.KUMO.get('ia_pref');
  return pref && modelos.includes(pref) ? [pref, ...modelos.filter((m) => m !== pref)] : modelos;
}

async function iaChat(env: Env, mensajes: Json[], soloModelos?: string[]): Promise<{ datos: Json; modelo: string }> {
  const p = proveedorIA(env);
  if (!p) throw new Error('Tu nube no tiene IA configurada: elige un proveedor en Config → Cambiar claves');
  if (!p.modelos.length) throw new Error(`Falta IA_MODELOS para ${p.nombre}`);
  p.modelos = soloModelos || await modelosOrdenados(env, p.modelos);
  const cab: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'kumo-bot/1.0' };
  if (p.clave) cab.Authorization = `Bearer ${p.clave}`;
  let ultimo = '';
  for (const modelo of p.modelos) {
    for (const formatoJson of [true, false]) {
      const cuerpo: Json = { model: modelo, messages: mensajes, temperature: 0.2 };
      if (formatoJson) cuerpo.response_format = { type: 'json_object' };
      let r: Response;
      try {
        r = await fetch(`${p.url}/chat/completions`, { method: 'POST', headers: cab, body: JSON.stringify(cuerpo) });
      } catch (e) {
        ultimo = `${p.nombre}: sin conexión con ${modelo}`;
        break;
      }
      if (r.ok) {
        const d: any = await r.json().catch(() => ({}));
        try { return { datos: extraerJson(d.choices?.[0]?.message?.content || ''), modelo }; } catch { ultimo = `${p.nombre}: ${modelo} no respondió JSON`; break; }
      }
      ultimo = `${p.nombre} HTTP ${r.status} con ${modelo}`;
      if (r.status === 401 || r.status === 403) throw new Error(`${p.nombre} rechazó la clave de IA (HTTP ${r.status})`);
      if (r.status === 400 && formatoJson) continue; // no acepta response_format: reintenta sin él
      break;
    }
  }
  throw new Error(ultimo || 'La IA no respondió');
}

async function radarAnalizar(env: Env, cuerpo: Json): Promise<Response> {
  const sym = limpiarSimbolo(cuerpo.simbolo);
  if (!sym) return json({ error: 'Falta el símbolo' }, 400);
  const mem = analisisMem.get(sym);
  if (mem && Date.now() - mem.ts < 10 * 60_000) return json({ ...mem.datos, cache: true });
  const [estado, config] = await Promise.all([leer<Json>(env, 'estado', {}), leerConfig(env)]);
  const fila = (estado.radar || []).find((f: Json) => f.simbolo === sym);
  if (!fila) return json({ error: `${sym} aún no tiene datos. Pide el análisis y espera el próximo ciclo.`, pendiente: true }, 404);
  const cartera = (estado.ultimo?.activos || []).map((a: Json) => ({ s: a.simbolo, peso: a.peso }));
  const t0 = Date.now();
  const { datos: d, modelo } = await iaChat(env, [
    { role: 'system', content: 'Eres un analista cripto prudente para principiantes. Respondes SOLO JSON válido en español.' },
    { role: 'user', content: `Evalúa si conviene INCORPORAR la moneda ${sym} a un bot de trading spot.\nDatos de mercado (velas diarias del exchange del usuario): ${JSON.stringify(fila)}\nCartera actual (peso %): ${JSON.stringify(cartera)}\nModo: ${config.modo}.\nIncluye qué es el proyecto si lo conoces (sin inventar cifras), riesgos y una entrada sugerida.\nFormato: {"veredicto":"INCORPORAR|ESPERAR|NO INCORPORAR","confianza":0-100,"resena":"2-4 frases","riesgos":["..."],"entrada":numero|null,"pct_sugerido":1-10}` },
  ]);
  const veredicto = ['INCORPORAR', 'ESPERAR', 'NO INCORPORAR'].includes(String(d.veredicto).toUpperCase()) ? String(d.veredicto).toUpperCase() : 'ESPERAR';
  const datos = {
    simbolo: sym, fila, modelo, veredicto,
    confianza: Math.max(0, Math.min(100, Number(d.confianza) || 0)),
    resena: String(d.resena || '').slice(0, 800),
    riesgos: (Array.isArray(d.riesgos) ? d.riesgos : []).slice(0, 5).map((x: unknown) => String(x).slice(0, 160)),
    entrada: Number(d.entrada) > 0 ? Number(d.entrada) : null,
    pct_sugerido: Math.max(1, Math.min(10, Number(d.pct_sugerido) || 3)),
  };
  analisisMem.set(sym, { ts: Date.now(), datos });
  await bitacora(env, [{ ts: Date.now(), tipo: 'ia', ok: true, modelo, ms: Date.now() - t0, texto: `IA (Radar ${sym}) respondió con ${modelo} en ${((Date.now() - t0) / 1000).toFixed(1)} s: ${veredicto}` }]);
  const lista = await leer<Json[]>(env, 'senales', []);
  const item = { tipo: 'radar', ts: Date.now(), modelo, senales: [{ simbolo: sym, accion: veredicto, confianza: datos.confianza, razon: datos.resena.slice(0, 200), precio: fila.precio }] };
  await env.KUMO.put('senales', JSON.stringify([item, ...lista].slice(0, MAX_SENALES)));
  return json(datos);
}

// ---------------------------------------------------------------- Gráficas
// Las velas las lee el runner de TU exchange en cada ciclo (1h, 4h y 1d).
async function graficasApi(env: Env, url: URL): Promise<Response> {
  const sym = limpiarSimbolo(url.searchParams.get('simbolo'));
  const g = await leer<Json>(env, 'graficas', {});
  const datos: Json = g.datos || {};
  if (!sym) return json({ ts: g.ts || null, simbolos: Object.keys(datos) });
  if (!datos[sym]) return json({ error: `${sym} aún no tiene gráfica: aparece en el próximo ciclo si está en tu cartera o en tu reparto.`, pendiente: true, simbolos: Object.keys(datos) }, 404);
  return json({ simbolo: sym, ts: g.ts, exchange: g.exchange, quote: g.quote, marcos: datos[sym] });
}

// ---------------------------------------------------------------- Semáforo
// Lo que la nube sabe de sí misma; la app le suma la latencia y GitHub Actions.
async function semaforo(env: Env): Promise<Response> {
  const [estado, config, log] = await Promise.all([leer<Json>(env, 'estado', {}), leerConfig(env), leer<Json[]>(env, 'bitacora', [])]);
  const u: Json = estado.ultimo || {};
  const ia = log.filter((l) => l.tipo === 'ia' && l.modelo).slice(0, 6);
  const p = proveedorIA(env);
  return json({
    version: env.KUMO_VERSION || '1.0.0', ahora: Date.now(),
    ciclo: estado.ciclo || 0, actualizado: estado.actualizado || null, ok: u.ok !== false && !!estado.ciclo,
    errores: u.errores || [], exchange: u.exchange || null, modo: config.modo, pausado: !!config.pausado,
    real: u.real ? { error: u.real.error || null, libre: u.real.libre ?? null } : null, libre: u.libre ?? null,
    monto_min: config.monto_min, quote: config.quote, objetivo: config.objetivo,
    ia: { modo: config.ia, proveedor: p?.nombre || null, modelos: p?.modelos || [], preferido: await env.KUMO.get('ia_pref'), ultimas: ia },
  });
}

// Prueba la IA con una pregunta mínima. Con `todos` prueba cada modelo y deja
// como preferido el primero que responde (así el bot deja de perder tiempo con
// modelos caídos). Solo escribe en KV si el preferido cambia.
async function iaProbar(env: Env, c: Json): Promise<Response> {
  const p = proveedorIA(env);
  if (!p) return json({ ok: false, codigo: 'sin_ia', error: 'Tu nube no tiene IA configurada' });
  if (!p.modelos.length) return json({ ok: false, codigo: 'sin_modelos', error: `Falta IA_MODELOS para ${p.nombre}` });
  const mensajes = [{ role: 'system', content: 'Respondes SOLO JSON.' }, { role: 'user', content: 'Responde exactamente {"ok":true}' }];
  const lista = (await modelosOrdenados(env, p.modelos)).slice(0, c.todos ? 5 : 3);
  const pruebas: Json[] = [];
  for (const m of lista) {
    const t0 = Date.now();
    try {
      await iaChat(env, mensajes, [m]);
      pruebas.push({ modelo: m, ok: true, ms: Date.now() - t0 });
      if (!c.todos) break;
    } catch (e: any) {
      const error = String(e?.message || e).slice(0, 160);
      pruebas.push({ modelo: m, ok: false, ms: Date.now() - t0, error });
      if (/rechazó la clave/.test(error)) break;
    }
  }
  const bueno = pruebas.find((x) => x.ok);
  const previo = await env.KUMO.get('ia_pref');
  let cambio = null;
  if (bueno && bueno.modelo !== (previo || p.modelos[0])) {
    await env.KUMO.put('ia_pref', bueno.modelo);
    cambio = bueno.modelo;
    await bitacora(env, [{ ts: Date.now(), tipo: 'ia', ok: true, texto: `Autocorrección: ${bueno.modelo} queda como modelo principal (respondió en ${(bueno.ms / 1000).toFixed(1)} s)` }]);
  }
  const clave = pruebas.some((x) => /rechazó la clave/.test(x.error || ''));
  return json({ ok: !!bueno, proveedor: p.nombre, modelo: bueno?.modelo || null, ms: bueno?.ms ?? null, pruebas, preferido_nuevo: cambio,
    codigo: bueno ? 'ok' : clave ? 'clave' : 'caida', error: bueno ? null : pruebas[pruebas.length - 1]?.error || 'La IA no respondió' });
}

// La IA lee el diagnóstico de la app y elige arreglos SOLO de la lista que la
// app le ofrece (nunca inventa acciones ni toca montos o el modo real).
async function iaDiagnosticar(env: Env, c: Json): Promise<Response> {
  const hallazgos = (Array.isArray(c.hallazgos) ? c.hallazgos : []).slice(0, 12).map((h: Json) => ({ id: String(h.id).slice(0, 30), estado: String(h.estado).slice(0, 10), detalle: String(h.detalle || '').slice(0, 300) }));
  const arreglos = (Array.isArray(c.arreglos) ? c.arreglos : []).slice(0, 10).map((a: Json) => ({ id: String(a.id).slice(0, 40), texto: String(a.texto || '').slice(0, 200) }));
  const t0 = Date.now();
  const { datos: d, modelo } = await iaChat(env, [
    { role: 'system', content: 'Eres el técnico de soporte de Kumo Bot (bot de trading en GitHub Actions + Cloudflare Worker). Explicas en español sencillo a un principiante. Respondes SOLO JSON válido.' },
    { role: 'user', content: `Diagnóstico automático:\n${JSON.stringify(hallazgos)}\nArreglos disponibles (elige solo ids de esta lista, los que de verdad resuelvan algo):\n${JSON.stringify(arreglos)}\nFormato: {"resumen":"1-3 frases: qué falla y por qué","pasos":["pasos que debe hacer el usuario si algo no se arregla solo"],"arreglos":["id",...]}` },
  ]);
  const validos = new Set(arreglos.map((a: Json) => a.id));
  const elegidos = (Array.isArray(d.arreglos) ? d.arreglos : []).map(String).filter((x: string) => validos.has(x));
  await bitacora(env, [{ ts: Date.now(), tipo: 'ia', ok: true, modelo, ms: Date.now() - t0, texto: `IA (diagnóstico) respondió con ${modelo}: ${elegidos.length ? 'arreglos ' + elegidos.join(', ') : 'sin arreglos automáticos'}` }]);
  return json({ modelo, resumen: String(d.resumen || '').slice(0, 600), pasos: (Array.isArray(d.pasos) ? d.pasos : []).slice(0, 6).map((x: unknown) => String(x).slice(0, 240)), arreglos: [...new Set(elegidos)] });
}

// ---------------------------------------------------------------- API app
async function api(req: Request, env: Env, ruta: string, url: URL): Promise<Response> {
  const cuerpo: Json = req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Json) : {};
  switch (`${req.method} ${ruta}`) {
    case 'GET /api/estado': {
      const [config, estado] = await Promise.all([leerConfig(env), leer<Json>(env, 'estado', {})]);
      const { runner, radar, ...resto } = estado;
      return json({ version: env.KUMO_VERSION || '1.0.0', config, ...resto, costos: runner?.costos || {} });
    }
    case 'GET /api/ordenes':
      return json({ ordenes: await leerOrdenes(env), modo: (await leerConfig(env)).ordenes_ia });
    case 'POST /api/ordenes':
      return ordenesApi(env, cuerpo);
    case 'GET /api/historial':
      return json({ items: await leer<Json[]>(env, 'bitacora', []) });
    case 'GET /api/graficas':
      return graficasApi(env, url);
    case 'GET /api/semaforo':
      return semaforo(env);
    case 'POST /api/ia/probar':
      return iaProbar(env, cuerpo);
    case 'POST /api/ia/diagnosticar':
      return iaDiagnosticar(env, cuerpo).catch((e) => json({ error: String(e?.message || e) }, 502));
    case 'GET /api/senales':
      return json({ senales: await leer<Json[]>(env, 'senales', []) });
    case 'GET /api/operaciones':
      return json({ operaciones: await leer<Json[]>(env, 'operaciones', []) });
    case 'GET /api/config':
      return json({ config: await leerConfig(env), rangos: RANGOS });
    case 'POST /api/config': {
      const v = validarConfig(await leerConfig(env), cuerpo);
      if (v.error) return json({ error: v.error }, 400);
      await env.KUMO.put('config', JSON.stringify(v.config));
      return json({ ok: true, config: v.config });
    }
    case 'POST /api/control': {
      const config = await leerConfig(env);
      if (cuerpo.accion === 'pausar' || cuerpo.accion === 'reanudar') {
        config.pausado = cuerpo.accion === 'pausar';
        await env.KUMO.put('config', JSON.stringify(config));
        return json({ ok: true, pausado: config.pausado });
      }
      if (cuerpo.accion === 'reiniciar_simulacion') {
        const estado = await leer<Json>(env, 'estado', {});
        estado.runner = { costos: {}, cartera_sim: null };
        estado.historial = [];
        await env.KUMO.put('estado', JSON.stringify(estado));
        return json({ ok: true });
      }
      return json({ error: 'acción desconocida' }, 400);
    }
    case 'GET /api/radar': {
      const estado = await leer<Json>(env, 'estado', {});
      return json({ radar: estado.radar || [], actualizado: estado.radar_ts || null, quote: estado.ultimo?.quote, exchange: estado.ultimo?.exchange });
    }
    case 'POST /api/radar/analizar':
      return radarAnalizar(env, cuerpo).catch(async (e) => {
        await bitacora(env, [{ ts: Date.now(), tipo: 'ia', ok: false, texto: `IA (Radar) falló: ${String(e.message || e).slice(0, 160)}` }]);
        return json({ error: String(e.message || e) }, 502);
      });
    case 'POST /api/radar/pedir': {
      const sym = limpiarSimbolo(cuerpo.simbolo);
      if (!sym) return json({ error: 'Falta el símbolo' }, 400);
      const config = await leerConfig(env);
      config.radar_pedidos = [sym, ...(config.radar_pedidos || []).filter((s: string) => s !== sym)].slice(0, 5);
      await env.KUMO.put('config', JSON.stringify(config));
      return json({ ok: true, pedidos: config.radar_pedidos });
    }
    case 'POST /api/radar/incluir': {
      const sym = limpiarSimbolo(cuerpo.simbolo);
      const pct = Number(cuerpo.pct);
      if (!sym || !(pct > 0 && pct <= 25)) return json({ error: 'Elige un % entre 1 y 25' }, 400);
      const config = await leerConfig(env);
      const v = validarConfig(config, { objetivo: { ...config.objetivo, [sym]: pct } });
      if (v.error) return json({ error: v.error }, 400);
      await env.KUMO.put('config', JSON.stringify(v.config));
      return json({ ok: true, config: v.config });
    }
    case 'GET /api/feed': {
      const desde = Number(url.searchParams.get('since') || 0);
      const feed = await leer<Json[]>(env, 'feed', []);
      return json({ now: Date.now(), items: feed.filter((f) => f.ts > desde).map((f) => ({ id: f.id, ts: f.ts, kind: f.tipo, title: f.titulo, body: f.texto })) });
    }
    case 'POST /api/avisos/probar':
      await avisar(env, [{ tipo: 'prueba', titulo: '¡Kumo conectado! ☁️', texto: 'Las notificaciones de tu nube funcionan.' }]);
      return json({ ok: true });
  }
  return json({ error: 'Ruta no encontrada' }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const ruta = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (ruta === '/' || ruta === '/api/salud') {
        const estado = await leer<Json>(env, 'estado', {});
        return json({ ok: true, nombre: 'kumo-bot', version: env.KUMO_VERSION || '1.0.0', ciclo: estado.ciclo || 0, ultimo_ciclo: estado.actualizado || null });
      }
      if (ruta.startsWith('/runner/')) {
        if (!iguales(token(req), env.RUNNER_TOKEN)) return json({ error: 'No autorizado' }, 401);
        if (req.method === 'GET' && ruta === '/runner/config') return runnerConfig(env);
        if (req.method === 'POST' && ruta === '/runner/reporte') return runnerReporte(env, (await req.json()) as Json);
        return json({ error: 'Ruta no encontrada' }, 404);
      }
      if (ruta.startsWith('/api/')) {
        if (!iguales(token(req), env.APP_TOKEN)) return json({ error: 'Token inválido' }, 401);
        return await api(req, env, ruta, url);
      }
      return json({ error: 'Ruta no encontrada' }, 404);
    } catch (e: any) {
      return json({ error: `Error interno: ${String(e?.message || e).slice(0, 200)}` }, 500);
    }
  },
};
