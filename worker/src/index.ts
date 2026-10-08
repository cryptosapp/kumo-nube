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
  // Beta: la IA revisa los mercados de predicción en cada ciclo.
  pred_ia: 'proponer', pred_monto: 11, pred_max_total: 30, pred_ventaja: 8, pred_conf_min: 65, pred_max_ciclo: 1,
  pred_prob_min: 5, pred_prob_max: 95, pred_horas_min: 1, pred_categorias: ['cripto_hoy'], pred_vender_ia: true, pred_tomar_ganancia: 0,
  pred_auto_solo_corto: true, pred_corto_horas: 36, pred_pagar_con: '',
  pred_supervisor: true, pred_monto_techo: 11, pred_max_total_techo: 30, pred_supervisor_log: [],
};
const PRED_CATEGORIAS = ['cripto_hoy', 'cripto_mediano', 'bolsa'];

// Límites duros: la app no puede guardar valores fuera de estos rangos.
const RANGOS: Record<string, [number, number]> = {
  monto_min: [1, 1000], monto_max: [1, 5000], rsi_compra: [5, 60], rsi_venta: [40, 95], banda: [0, 20],
  ganancia_min: [0, 50], stop_perdida: [0, 50], ia_conf_min: [0, 100], max_ops_ciclo: [0, 10], saldo_simulado: [10, 1000000], orden_horas: [1, 168],
  pred_monto: [10, 500], pred_max_total: [10, 5000], pred_ventaja: [3, 40], pred_conf_min: [0, 100], pred_max_ciclo: [1, 5],
  pred_prob_min: [1, 50], pred_prob_max: [50, 99], pred_horas_min: [0, 48], pred_tomar_ganancia: [0, 99], pred_corto_horas: [1, 168],
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
  if (cambios.pred_ia !== undefined) {
    if (!['off', 'proponer', 'auto'].includes(cambios.pred_ia)) return { error: 'pred_ia inválido' };
    c.pred_ia = cambios.pred_ia;
  }
  if (c.pred_monto > c.pred_max_total) return { error: 'El monto por compra no puede pasar del tope total' };
  if (c.pred_tomar_ganancia > 0 && c.pred_tomar_ganancia < 50) return { error: 'Asegurar ganancia: 0 (apagado) o entre 50 y 99%' };
  if (cambios.pred_categorias !== undefined) {
    const l = Array.isArray(cambios.pred_categorias) ? [...new Set(cambios.pred_categorias.map(String))] : null;
    if (!l || l.some((x) => !PRED_CATEGORIAS.includes(x))) return { error: 'Categorías de predicción inválidas' };
    c.pred_categorias = l;
  }
  if (cambios.pred_vender_ia !== undefined) c.pred_vender_ia = Boolean(cambios.pred_vender_ia);
  if (cambios.pred_supervisor !== undefined) c.pred_supervisor = Boolean(cambios.pred_supervisor);
  // Moneda que se vende si falta USDC para pagar una predicción ('' = solo USDC).
  if (cambios.pred_pagar_con !== undefined) c.pred_pagar_con = cambios.pred_pagar_con ? limpiarSimbolo(cambios.pred_pagar_con) : '';
  if (cambios.pred_auto_solo_corto !== undefined) c.pred_auto_solo_corto = Boolean(cambios.pred_auto_solo_corto);
  // Lo que pone el usuario es el techo: el supervisor IA solo puede bajarlo.
  if (cambios.pred_monto !== undefined) c.pred_monto_techo = c.pred_monto;
  if (cambios.pred_max_total !== undefined) c.pred_max_total_techo = c.pred_max_total;
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

// Supervisor IA de predicciones: solo parámetros de la lista, validados igual que
// los del usuario, y el dinero nunca por encima del techo que puso el usuario.
const SUPERVISABLES = ['pred_ventaja', 'pred_conf_min', 'pred_prob_min', 'pred_prob_max', 'pred_horas_min', 'pred_max_ciclo', 'pred_monto', 'pred_max_total', 'pred_categorias'];
async function aplicarSupervisor(env: Env, ahora: number, s: Json): Promise<void> {
  const actual = await leerConfig(env);
  if (actual.pred_supervisor === false) return;
  const cambios: Json = {};
  for (const k of SUPERVISABLES) if (s.cambios[k] !== undefined) cambios[k] = s.cambios[k];
  if (cambios.pred_monto !== undefined) cambios.pred_monto = Math.min(Number(cambios.pred_monto), Number(actual.pred_monto_techo ?? actual.pred_monto));
  if (cambios.pred_max_total !== undefined) cambios.pred_max_total = Math.min(Number(cambios.pred_max_total), Number(actual.pred_max_total_techo ?? actual.pred_max_total));
  if (cambios.pred_conf_min !== undefined) cambios.pred_conf_min = Math.max(50, Number(cambios.pred_conf_min));
  const v = validarConfig(actual, cambios);
  if (!v.config) {
    await bitacora(env, [{ ts: ahora, tipo: 'supervisor', ok: false, texto: `Supervisor IA: cambio rechazado (${v.error})` }]);
    return;
  }
  // validarConfig trata lo que llega como si fuera del usuario: los techos no se mueven.
  v.config.pred_monto_techo = actual.pred_monto_techo ?? actual.pred_monto;
  v.config.pred_max_total_techo = actual.pred_max_total_techo ?? actual.pred_max_total;
  const hechos = Object.keys(cambios).filter((k) => JSON.stringify(actual[k]) !== JSON.stringify(v.config![k]))
    .map((k) => ({ k, antes: actual[k], despues: v.config![k] }));
  if (!hechos.length) return;
  v.config.pred_supervisor_log = [{ ts: ahora, modelo: s.modelo || null, razon: String(s.razon || '').slice(0, 300), cambios: hechos }, ...(actual.pred_supervisor_log || [])].slice(0, 8);
  await env.KUMO.put('config', JSON.stringify(v.config));
  const txt = hechos.map((h) => `${h.k} ${JSON.stringify(h.antes)} → ${JSON.stringify(h.despues)}`).join(', ');
  await bitacora(env, [{ ts: ahora, tipo: 'supervisor', ok: true, texto: `Supervisor IA ajustó predicciones: ${txt}. ${String(s.razon || '').slice(0, 160)}` }]);
  await avisar(env, [{ kind: 'supervisor', title: '🎲 El supervisor IA ajustó tus predicciones', body: txt.slice(0, 160) }]);
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
  if (o.tipo === 'prediccion') return `${o.accion === 'COMPRAR' ? 'Compra' : 'Venta'} ${o.unidades} × ${o.etiqueta || o.coin} a ${o.accion === 'COMPRAR' ? '≤' : '≥'} ${o.limite}`;
  return `${o.accion === 'COMPRAR' ? 'Compra' : 'Venta'} ${o.simbolo} ${o.accion === 'COMPRAR' ? `${o.monto} ${o.quote || ''}`.trim() : `${o.pct}%`}${o.limite ? ` si ${o.accion === 'COMPRAR' ? '≤' : '≥'} ${o.limite}` : ''}`;
}

// Valida lo que llega de la app o de la IA. Devuelve la orden limpia o un error.
function limpiarOrden(base: Json, c: Json, config: Json): { orden?: Json; error?: string } {
  if (c.tipo === 'prediccion' || base.tipo === 'prediccion') return limpiarPrediccion(base, c, config);
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

// Órdenes en mercados de predicción de Hyperliquid: «#N» (N = 10 × mercado + lado),
// unidades enteras y precio límite = probabilidad (0.001–0.999). Se ejecutan como IOC.
function limpiarPrediccion(base: Json, c: Json, config: Json): { orden?: Json; error?: string } {
  const o: Json = { ...base, tipo: 'prediccion' };
  if (c.coin !== undefined) { if (!/^#\d{2,9}$/.test(String(c.coin))) return { error: 'Mercado inválido' }; o.coin = String(c.coin); }
  if (c.accion !== undefined) {
    const a = String(c.accion).toUpperCase();
    if (!['COMPRAR', 'VENDER'].includes(a)) return { error: 'La acción debe ser COMPRAR o VENDER' };
    o.accion = a;
  }
  if (!o.coin || !o.accion) return { error: 'Falta el mercado o la acción' };
  const u = Number(c.unidades ?? o.unidades);
  if (!(Number.isInteger(u) && u >= 1 && u <= 100000)) return { error: 'Unidades: número entero desde 1' };
  const l = Number(c.limite ?? o.limite);
  if (!(l >= 0.001 && l <= 0.999)) return { error: 'El precio límite va de 0.001 a 0.999' };
  o.unidades = u; o.limite = Number(l.toPrecision(5)); o.simbolo = o.coin;
  if (c.etiqueta !== undefined) o.etiqueta = String(c.etiqueta).slice(0, 90);
  if (c.pagar_con !== undefined) { const m = c.pagar_con ? limpiarSimbolo(c.pagar_con) : ''; if (m) o.pagar_con = m; else delete o.pagar_con; } // 'USDC' = esta orden solo con USDC
  if (c.razon !== undefined) o.razon = String(c.razon).slice(0, 240);
  // Vender con pérdida solo si TÚ lo marcas a propósito (el runner lo bloquea si no).
  if (c.permitir_perdida !== undefined) { if (c.permitir_perdida === true && o.accion === 'VENDER') o.permitir_perdida = true; else delete o.permitir_perdida; }
  if (o.accion !== 'VENDER') delete o.permitir_perdida;
  o.quote = config.quote; delete o.monto; delete o.pct;
  return { orden: o };
}

const o_tipo = (n: Json) => (n.tipo === 'prediccion' ? 'Predicción · ' : '');
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
      vence: Math.min(ahora + (config.orden_horas || 24) * 3600_000, Number(n.caduca) > ahora ? Number(n.caduca) : Infinity),
      historia: [{ ts: ahora, quien: 'ia', texto: `${o_tipo(n)}Propuesta con ${n.confianza}% de confianza: ${n.razon || ''}`.trim() }] };
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
    runner: { costos: costos ?? estado.runner?.costos ?? {}, cartera_sim: cartera_sim ?? estado.runner?.cartera_sim ?? null,
      super_ts: r.supervisor?.ts ?? estado.runner?.super_ts ?? null },
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
  if (r.supervisor && r.supervisor.cambios && Object.keys(r.supervisor.cambios).length) await aplicarSupervisor(env, ahora, r.supervisor);
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
  const ordenes_pred = (await leerOrdenes(env)).filter((o) => o.tipo === 'prediccion').slice(0, 20);
  return json({ config, estado_runner: estado.runner || {}, ordenes, ia_pref, ordenes_pred });
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

// ---------------------------------------------------------------- Predicciones (Hyperliquid HIP-4)
// La IA analiza una posición y SUGIERE (mantener, vender o comprar más). Kumo no
// ejecuta nada: el usuario decide y, si quiere, lo hace en Hyperliquid.
const prediccionMem = new Map<string, { ts: number; datos: Json }>();
async function hlInfo(cuerpo: Json): Promise<any> {
  const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
  if (!r.ok) throw new Error(`Hyperliquid HTTP ${r.status}`);
  return r.json();
}
function campos(desc: unknown): Json {
  const out: Json = {};
  for (const parte of String(desc || '').split('|')) { const i = parte.indexOf(':'); if (i > 0) out[parte.slice(0, i).trim()] = parte.slice(i + 1).trim(); }
  return out;
}
function venceMs(t: unknown): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(String(t || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
}
// Φ(x) (Abramowitz-Stegun 7.1.26).
function normal(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const e = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
  return x >= 0 ? (1 + e) / 2 : (1 - e) / 2;
}
// Probabilidad de que el precio termine ≥ objetivo con un modelo log-normal y la
// volatilidad por hora del plazo (1 h / 24 h / 48 h por tramos). Referencia, no certeza.
function probModelo(ahora: number, objetivo: number, sigmaH: number, horas: number): number | null {
  if (!(ahora > 0 && objetivo > 0 && sigmaH > 0 && horas > 0)) return null;
  const s = sigmaH * Math.sqrt(horas);
  return normal((Math.log(ahora / objetivo) - s * s / 2) / s);
}
// Volatilidad por hora en tres ventanas, con velas de 15 min de las últimas 49 h
// (una sola petición por activo: el plan gratis de Cloudflare permite 50 por llamada):
//  · 1 h: rango alto-bajo de las 4 últimas velas (Parkinson, más estable que 4 cierres);
//  · 24 h y 48 h: desviación de los cierres.
// También el cambio de precio en 1 h, 24 h y 48 h (para el análisis del mercado global).
const volMem = new Map<string, { ts: number; v: Json }>();
async function volatilidades(subyacentes: string[]): Promise<Json> {
  const out: Json = {}, ahora = Date.now();
  await Promise.all(subyacentes.slice(0, 26).map(async (u) => {
    const m = volMem.get(u);
    if (m && ahora - m.ts < 3 * 60_000) { out[u] = m.v; return; }
    try {
      const velas: Json[] = await hlInfo({ type: 'candleSnapshot', req: { coin: u, interval: '15m', startTime: ahora - 49 * 3_600_000, endTime: ahora } });
      const v = velas.map((x) => ({ c: Number(x.c), h: Number(x.h), l: Number(x.l) })).filter((x) => x.c > 0 && x.h > 0 && x.l > 0);
      if (v.length < 12) return;
      const c = v.map((x) => x.c), n = c.length - 1;
      const sd = (xs: number[]) => {
        const r = xs.slice(1).map((x, i) => Math.log(x / xs[i])), me = r.reduce((a, b) => a + b, 0) / r.length;
        return Math.sqrt(r.reduce((a, b) => a + (b - me) ** 2, 0) / Math.max(1, r.length - 1));
      };
      // Por hora = por vela de 15 min × √4.
      const s24 = sd(c.slice(-97)) * 2, s48 = sd(c) * 2;
      const park = Math.sqrt(v.slice(-4).reduce((a, x) => a + Math.log(x.h / x.l) ** 2, 0) / 4 / (4 * Math.LN2)) * 2;
      // Una hora sin movimiento no significa que el riesgo desapareció: piso en la mitad de la de 24 h.
      const s1 = Math.max(park || 0, s24 * 0.5);
      const cambio = (k: number) => (n >= k ? Math.round((c[n] / c[n - k] - 1) * 10000) / 100 : null);
      const r = s48 > 0 ? s1 / s48 : 1;
      const x: Json = { sigma_1h: s1, sigma_24h: s24, sigma_48h: s48, cambio_1h_pct: cambio(4), cambio_24h_pct: cambio(96), cambio_48h_pct: cambio(Math.min(n, 192)),
        regimen: r >= 1.8 ? 'turbulento' : r <= 0.5 ? 'calmo' : 'normal' };
      volMem.set(u, { ts: ahora, v: x });
      out[u] = x;
    } catch { /* sin velas: sin modelo */ }
  }));
  return out;
}
// Volatilidad para un plazo de h horas, por tramos: la primera hora con la vol de 1 h,
// hasta 24 h con la de 24 h y el resto con la de 48 h (varianzas que se suman).
function sigmaPlazo(v: Json, h: number): number {
  const var_ = v.sigma_1h ** 2 * Math.min(h, 1) + v.sigma_24h ** 2 * Math.min(Math.max(h - 1, 0), 23) + v.sigma_48h ** 2 * Math.max(h - 24, 0);
  return Math.sqrt(var_ / h);
}
// Movimiento típico (1 desviación) en %, para mostrar.
const movTipico = (v: Json) => ({ h1: Math.round(v.sigma_1h * 10000) / 100, h24: Math.round(v.sigma_24h * Math.sqrt(24) * 10000) / 100, h48: Math.round(v.sigma_48h * Math.sqrt(48) * 10000) / 100 });
// ---- Mercado global: cripto, bolsa, oro y petróleo en 1 h / 24 h / 48 h. Entra en
// cada decisión (IA y reglas): tono (apetito o aversión al riesgo) y turbulencia.
const GLOBALES = ['BTC', 'ETH', 'SOL', 'HYPE', 'xyz:SP500', 'xyz:XYZ100', 'xyz:GOLD', 'xyz:CL'];
function mercadoGlobal(mids: Json, vol: Json, ahora: number): Json {
  const activos = GLOBALES.filter((s) => vol[s] && mids[s] != null).map((s) => ({ sub: s, nombre: nombreSub(s), precio: Number(mids[s]),
    cambio_1h_pct: vol[s].cambio_1h_pct, cambio_24h_pct: vol[s].cambio_24h_pct, cambio_48h_pct: vol[s].cambio_48h_pct, regimen: vol[s].regimen, mov: movTipico(vol[s]) }));
  const prom = (subs: string[]) => {
    const xs = activos.filter((a) => subs.includes(a.sub) && a.cambio_24h_pct != null).map((a) => a.cambio_24h_pct as number);
    return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 100) / 100 : null;
  };
  const cripto = prom(['BTC', 'ETH', 'SOL', 'HYPE']), bolsa = prom(['xyz:SP500', 'xyz:XYZ100']), oro = prom(['xyz:GOLD']), petroleo = prom(['xyz:CL']);
  const riesgo = [cripto, bolsa].filter((x) => x != null) as number[];
  let tono = 'mixto';
  if (riesgo.length && riesgo.every((x) => x >= 0.5)) tono = 'alcista';
  else if (riesgo.length && riesgo.every((x) => x <= -0.5)) tono = 'bajista';
  const refugio = oro != null && oro >= 0.5 && (bolsa ?? 0) < 0;
  const turb = activos.filter((a) => a.regimen === 'turbulento');
  const turbulencia = turb.length > 0 && (turb.length * 3 >= activos.length || turb.some((a) => a.sub === 'BTC' || a.sub === 'xyz:SP500'));
  const f = (x: number | null) => (x == null ? '—' : `${x > 0 ? '+' : ''}${x}%`);
  const resumen = `24 h: cripto ${f(cripto)}, bolsa ${f(bolsa)}, oro ${f(oro)}, petróleo ${f(petroleo)}. ` +
    (tono === 'alcista' ? 'Apetito por riesgo (todo sube).' : tono === 'bajista' ? 'Aversión al riesgo (cripto y bolsa caen).' : 'Tono mixto.') +
    (refugio ? ' El oro sube mientras la bolsa baja: buscan refugio.' : '') +
    (turbulencia ? ` Turbulencia: la última hora se mueve mucho más que lo normal (${turb.map((a) => a.nombre).join(', ')}); Kumo exige más ventaja.` : ' Volatilidad normal.');
  return { ts: ahora, activos, cripto_24h_pct: cripto, bolsa_24h_pct: bolsa, oro_24h_pct: oro, petroleo_24h_pct: petroleo, tono, refugio, turbulencia, resumen };
}
// Mejor comprador y mejor vendedor ahora (libro público de Hyperliquid).
async function prediccionLibro(url: URL): Promise<Response> {
  const coin = String(url.searchParams.get('coin') || '');
  if (!/^#\d{2,9}$/.test(coin)) return json({ error: 'Mercado inválido' }, 400);
  const d: Json = await hlInfo({ type: 'l2Book', coin });
  const [compras, ventas] = d?.levels || [[], []];
  const nivel = (x: Json | undefined) => (x ? { precio: Number(x.px), unidades: Number(x.sz) } : null);
  return json({ coin, ts: Date.now(), mejor_compra: nivel(compras[0]), mejor_venta: nivel(ventas[0]),
    compras: compras.slice(0, 5).map(nivel), ventas: ventas.slice(0, 5).map(nivel) });
}
// Gráficas para decidir: probabilidad del lado (velas 15 min, 48 h) y precio del
// subyacente en 1H/4H/1D con la línea del objetivo. Datos públicos de Hyperliquid.
const graficaPredMem = new Map<string, { ts: number; datos: Json }>();
async function prediccionGrafica(url: URL): Promise<Response> {
  const coin = String(url.searchParams.get('coin') || '').replace(/^\+/, '#');
  if (!/^#\d{2,9}$/.test(coin)) return json({ error: 'Mercado inválido' }, 400);
  const mem = graficaPredMem.get(coin);
  if (mem && Date.now() - mem.ts < 60_000) return json({ ...mem.datos, cache: true });
  const cod = Number(coin.slice(1)), mercado = Math.floor(cod / 10), lado = cod % 10;
  const todo = await listaMercados(), lista: Json[] = todo.mercados || [];
  const m = lista.find((x) => x.mercado === mercado);
  if (!m) return json({ error: 'Ese mercado ya no está abierto.' }, 404);
  const ahora = Date.now(), ld = m.lados[lado] || {};
  const velas = async (c: string, intervalo: string, horas: number) => {
    try {
      const v: Json[] = await hlInfo({ type: 'candleSnapshot', req: { coin: c, interval: intervalo, startTime: ahora - horas * 3_600_000, endTime: ahora } });
      return { t: v.map((x) => Number(x.t)), c: v.map((x) => Number(x.c)) };
    } catch { return { t: [], c: [] }; }
  };
  const [prob, h1, h4, d1] = await Promise.all([
    velas(coin, '15m', 48),
    m.subyacente ? velas(m.subyacente, '1h', 100) : null,
    m.subyacente ? velas(m.subyacente, '4h', 400) : null,
    m.subyacente ? velas(m.subyacente, '1d', 2400) : null,
  ]);
  const datos: Json = { coin, mercado, lado, pregunta: m.pregunta, lado_nombre: ld.nombre, precio_lado: ld.precio ?? null, ventaja: ld.ventaja ?? null,
    prob_modelo: ld.prob_modelo ?? null, regla: m.regla, tipo: m.tipo, lineas: m.lineas || [], nombre_sub: m.nombre_sub,
    subyacente: m.subyacente, objetivo: m.objetivo, precio_actual: m.precio_actual ?? null, vence: m.vence, ts: ahora, prob,
    lados: m.lados, mov: m.mov || null, regimen: m.regimen || null, cambio_1h_pct: m.cambio_1h_pct ?? null, cambio_24h_pct: m.cambio_24h_pct ?? null, cambio_48h_pct: m.cambio_48h_pct ?? null,
    sigma_plazo_pct: m.sigma_plazo_pct ?? null,
    marcos: m.subyacente ? { '1h': h1, '4h': h4, '1d': d1 } : null, global: todo.global || null };
  graficaPredMem.set(coin, { ts: ahora, datos });
  return json(datos);
}
// ---- Lectura de los mercados de Hyperliquid (HIP-4). Sin deportes. Categorías:
// cripto (hoy / mediano plazo), bolsa y materias primas (perps «xyz:»), economía
// y empresas (tasa de la Fed, salidas a bolsa) y otros.
const NOMBRES_SUB: Json = { 'xyz:XYZ100': 'Nasdaq 100', 'xyz:SP500': 'S&P 500', 'xyz:CL': 'Petróleo WTI', 'xyz:BRENTOIL': 'Petróleo Brent', 'xyz:GOLD': 'Oro', 'xyz:SILVER': 'Plata', 'xyz:SPCX': 'SpaceX' };
const nombreSub = (s: string) => NOMBRES_SUB[s] || s.replace(/^xyz:/, '');
// Miles con espacio (85 501) para que no se confundan con decimales (88.303).
const cifra = (n: number) => (n >= 1000 ? String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : String(Number(n.toPrecision(6))));
const ES_DEPORTE = /sport|award|contest/i;
const HORAS_HOY = 36;
function nombreLado(n: unknown): string {
  const x = String(n || '').replace(/^template:/, '');
  return x === 'Yes' ? 'Sí' : x === 'Over' ? 'Más' : x === 'Under' ? 'Menos' : x;
}
function fechaCorta(ms: number | null): string {
  return ms ? new Date(ms).toLocaleDateString('es', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '';
}
// Qué pregunta un mercado y cómo modelarlo. null = deportes o relleno («otro resultado»).
function leerMercado(o: Json, q: Json | undefined): Json | null {
  const nombre = String(o.name || ''), desc = String(o.description || ''), c = campos(desc), cq = q ? campos(q.description) : {};
  if (ES_DEPORTE.test(nombre) || ES_DEPORTE.test(String(q?.name || '')) || c.participant || c.competition || c.candidate || cq.sport || cq.competition || cq.award) return null;
  if (/fallback/i.test(nombre) || desc === 'other') return null;
  const perp = desc.startsWith('perp:') ? desc.split('|')[0].slice(5) : null;
  if (c.class === 'priceBinary' && c.underlying) return { tipo: 'precio', sub: c.underlying, objetivo: Number(c.targetPrice), vence: venceMs(c.expiry) };
  if (nombre === 'template:binaryPrice' && perp) return { tipo: 'precio', sub: perp, objetivo: Number(c.threshold), vence: venceMs(c.time) };
  if (nombre === 'template:priceTouch' && perp) return { tipo: 'toque', sub: perp, objetivo: Number(c.target), vence: venceMs(c.time) };
  if (nombre === 'template:binaryPriceExternal') return { tipo: 'precio', externo: c.shortName || c.instrument, objetivo: Number(c.threshold), vence: venceMs(c.time) };
  if (cq.class === 'priceBucket' && cq.underlying && c.index != null) {
    const t = String(cq.priceThresholds || '').split(',').map(Number).filter((x) => x > 0), k = Number(c.index);
    return { tipo: 'rango', sub: cq.underlying, desde: k > 0 ? t[k - 1] : null, hasta: k < t.length ? t[k] : null, vence: venceMs(cq.expiry) };
  }
  if (/^template:policyRate/.test(nombre)) {
    const quien = /federal/i.test(String(cq.institution || '')) ? 'la Fed' : String(cq.institution || 'el banco central');
    const que = /NoChange/.test(nombre) ? 'mantiene' : /Decrease/.test(nombre) ? 'baja' : 'sube';
    return { tipo: 'evento', categoria: 'economia', pregunta: `¿${quien[0].toUpperCase() + quien.slice(1)} ${que} la tasa de interés (${cq.decisionLabel || 'próxima decisión'})?`,
      regla: `«Sí» gana si ${quien} ${que} la tasa en esa decisión.`, vence: venceMs(cq.scheduledDecision) ?? venceMs(cq.decisionDeadline) };
  }
  if (nombre === 'template:companyIpoConfirmed') {
    const v = venceMs(c.dateTime);
    return { tipo: 'evento', categoria: 'economia', pregunta: `¿${c.company} confirma su salida a bolsa antes del ${fechaCorta(v)}?`, regla: `«Sí» gana si ${c.company} confirma oficialmente su salida a bolsa antes del ${fechaCorta(v)}.`, vence: v };
  }
  if (nombre === 'template:companyIpoFirstDayMarketCap') {
    const b = Number(c.marketCapThresholdB);
    return { tipo: 'evento', categoria: 'economia', pregunta: `¿${c.company} vale ${b >= 1000 ? cifra(b / 1000) + ' billones' : cifra(b) + ' mil millones'} de USD o más en su primer día en bolsa?`,
      regla: `«Sí» gana si ${c.company} sale a bolsa antes del ${fechaCorta(venceMs(c.listingDeadline))} y cierra su primer día con ese valor o más.`, vence: venceMs(c.listingDeadline) };
  }
  const n2 = nombre.replace(/^template:/, '');
  return { tipo: 'evento', categoria: 'otro', pregunta: desc && desc !== 'other' ? `${n2} · ${desc.slice(0, 80)}` : n2, vence: venceMs(cq.resolutionDeadline) };
}
function probSobre(ahora: number, nivel: number, sigmaH: number, horas: number): number | null {
  return probModelo(ahora, nivel, sigmaH, horas);
}
// Probabilidad de TOCAR un nivel antes de vencer (principio de reflexión, sin tendencia).
function probToque(ahora: number, nivel: number, sigmaH: number, horas: number): number | null {
  if (!(ahora > 0 && nivel > 0 && sigmaH > 0 && horas > 0)) return null;
  return Math.min(1, 2 * (1 - normal(Math.abs(Math.log(nivel / ahora)) / (sigmaH * Math.sqrt(horas)))));
}
let mercadosMem: { ts: number; datos: Json } | null = null;
async function listaMercados(): Promise<Json> {
  if (mercadosMem && Date.now() - mercadosMem.ts < 60_000) return { ...mercadosMem.datos, cache: true };
  const [meta, mids, midsXyz] = await Promise.all([hlInfo({ type: 'outcomeMeta' }), hlInfo({ type: 'allMids' }), hlInfo({ type: 'allMids', dex: 'xyz' }).catch(() => ({}))]);
  const todos: Json = { ...mids, ...midsXyz };
  const preguntas: Json = {};
  for (const q of meta.questions || []) for (const n of [...(q.namedOutcomes || []), q.fallbackOutcome]) preguntas[n] = q;
  const ahora = Date.now(), lista: Json[] = [];
  for (const o of meta.outcomes || []) {
    const m = leerMercado(o, preguntas[o.outcome]);
    if (!m) continue;
    if (m.vence && m.vence < ahora) continue;
    if (m.externo && todos['xyz:' + m.externo]) m.sub = 'xyz:' + m.externo;
    const lados = (o.sideSpecs || []).map((sd: Json, i: number) => {
      const cod = o.outcome * 10 + i;
      return { nombre: nombreLado(sd.name), coin: `#${cod}`, precio: todos[`#${cod}`] != null ? Number(todos[`#${cod}`]) : null };
    });
    if (!lados.some((l: Json) => l.precio != null)) continue;
    // 0.5 / 0.5 exactos = libro vacío: ese precio no es real y la «ventaja» sería falsa.
    const sinOfertas = lados.length === 2 && lados.every((l: Json) => l.precio === 0.5);
    const N = m.sub ? nombreSub(m.sub) : m.externo || '';
    let pregunta = m.pregunta, regla = m.regla, lineas: Json[] = [];
    if (m.tipo === 'precio') { pregunta = `¿${N} ≥ ${cifra(m.objetivo)} al vencer?`; regla = `«Sí» gana si ${N} está en ${cifra(m.objetivo)} o más al vencer.`; lineas = [{ p: m.objetivo, t: 'objetivo' }]; }
    if (m.tipo === 'toque') { pregunta = `¿${N} toca ${cifra(m.objetivo)} antes del ${fechaCorta(m.vence)}?`; regla = `«Sí» gana si ${N} toca ${cifra(m.objetivo)} en cualquier momento antes de vencer.`; lineas = [{ p: m.objetivo, t: 'toque' }]; }
    if (m.tipo === 'rango') {
      pregunta = m.desde == null ? `¿${N} < ${cifra(m.hasta)} al vencer?` : m.hasta == null ? `¿${N} ≥ ${cifra(m.desde)} al vencer?` : `¿${N} entre ${cifra(m.desde)} y ${cifra(m.hasta)} al vencer?`;
      regla = `«Sí» gana si al vencer ${N} está ${m.desde == null ? `por debajo de ${cifra(m.hasta)}` : m.hasta == null ? `en ${cifra(m.desde)} o más` : `entre ${cifra(m.desde)} y ${cifra(m.hasta)}`}.`;
      lineas = [m.desde, m.hasta].filter((x) => x != null).map((p) => ({ p, t: 'límite' }));
    }
    const horas = m.vence ? Math.round((m.vence - ahora) / 360_000) / 10 : null;
    const categoria = m.categoria || (m.sub ? (m.sub.startsWith('xyz:') ? 'bolsa' : 'cripto') : m.externo ? 'bolsa' : 'otro');
    lista.push({ mercado: o.outcome, pregunta, regla: regla || null, tipo: m.tipo, categoria, plazo: horas != null && horas <= HORAS_HOY ? 'hoy' : 'mediano',
      subyacente: m.sub || null, nombre_sub: N || null, objetivo: m.tipo === 'rango' ? null : m.objetivo ?? null, desde: m.desde ?? null, hasta: m.hasta ?? null, lineas,
      vence: m.vence || null, horas, lados, quote: o.quoteToken || 'USDC', sin_ofertas: sinOfertas || undefined });
  }
  // Primero los activos del mercado global, luego los subyacentes con más mercados.
  const usos: Json = {};
  for (const m of lista) if (m.subyacente && todos[m.subyacente]) usos[m.subyacente] = (usos[m.subyacente] || 0) + 1;
  const subs = [...GLOBALES.filter((g) => todos[g] != null), ...Object.keys(usos).filter((u) => !GLOBALES.includes(u)).sort((a, b) => usos[b] - usos[a])];
  const vol = await volatilidades(subs);
  for (const m of lista) {
    if (!m.subyacente || !todos[m.subyacente]) continue;
    const S = Number(todos[m.subyacente]), v = vol[m.subyacente];
    m.precio_actual = S;
    if (m.objetivo) m.distancia_pct = Math.round((S / m.objetivo - 1) * 10000) / 100;
    if (!v || !m.horas || m.horas <= 0) continue;
    Object.assign(m, { cambio_1h_pct: v.cambio_1h_pct, cambio_24h_pct: v.cambio_24h_pct, cambio_48h_pct: v.cambio_48h_pct, regimen: v.regimen, mov: movTipico(v) });
    const sg = sigmaPlazo(v, m.horas);
    m.sigma_plazo_pct = Math.round(sg * Math.sqrt(m.horas) * 10000) / 100;
    let p: number | null = null;
    if (m.tipo === 'precio') p = probSobre(S, m.objetivo, sg, m.horas);
    else if (m.tipo === 'toque') p = probToque(S, m.objetivo, sg, m.horas);
    else if (m.tipo === 'rango') {
      const a = m.desde == null ? 1 : probSobre(S, m.desde, sg, m.horas), b = m.hasta == null ? 0 : probSobre(S, m.hasta, sg, m.horas);
      p = a != null && b != null ? Math.max(0, a - b) : null;
    }
    if (p == null) continue;
    m.prob_modelo = Math.round(p * 1000) / 10;
    // Ventaja = probabilidad del modelo − precio del mercado, para cada lado.
    m.lados.forEach((l: Json, i: number) => {
      const pl = i === 0 ? p! : 1 - p!;
      l.prob_modelo = Math.round(pl * 1000) / 10;
      if (l.precio != null && !m.sin_ofertas) l.ventaja = Math.round((pl - l.precio) * 1000) / 10;
    });
  }
  const orden: Json = { cripto: 0, bolsa: 1, economia: 2, otro: 3 };
  lista.sort((a, b) => orden[a.categoria] - orden[b.categoria] || (a.vence || 9e15) - (b.vence || 9e15));
  const cuenta: Json = {};
  for (const m of lista) { const k = m.categoria === 'cripto' ? `cripto_${m.plazo}` : m.categoria; cuenta[k] = (cuenta[k] || 0) + 1; }
  const datos = { ts: ahora, mercados: lista.slice(0, 200), total: lista.length, cuenta, global: mercadoGlobal(todos, vol, ahora) };
  mercadosMem = { ts: ahora, datos };
  return datos;
}
async function prediccionMercados(): Promise<Response> {
  return json(await listaMercados());
}

async function prediccionAnalizar(env: Env, c: Json): Promise<Response> {
  // Una posición tuya («+N»), un lado de un mercado («mercado» + «lado») o el mercado
  // completo («mercado» sin lado): entonces la IA elige entre comprar Sí, No o no entrar.
  const explorar = c.mercado != null;
  const ambos = explorar && (c.lado == null || c.lado === '');
  const coin = explorar ? `+${Number(c.mercado) * 10 + (Number(c.lado) ? 1 : 0)}` : String(c.coin || '');
  if (!/^\+\d+$/.test(coin)) return json({ error: 'Predicción inválida' }, 400);
  const clave = ambos ? `m${Number(c.mercado)}` : coin;
  const mem = prediccionMem.get(clave);
  if (mem && Date.now() - mem.ts < 10 * 60_000) return json({ ...mem.datos, cache: true });
  const estado = await leer<Json>(env, 'estado', {});
  const mias: Json[] = estado.ultimo?.predicciones || [];
  let p = mias.find((x) => x.coin === coin);
  // Datos del mercado (regla, modelo, volatilidad) de la lista abierta, tengas o no posición.
  const cod0 = Number(coin.slice(1)), todo: Json = await listaMercados().catch(() => ({ mercados: [] }));
  const lista: Json[] = todo.mercados || [];
  const mm = lista.find((x) => x.mercado === Math.floor(cod0 / 10)), ld = mm?.lados[cod0 % 10];
  if (!p && explorar && mm) p = { coin, pregunta: mm.pregunta, lado_nombre: ld?.nombre, cantidad: 0, pago_si_acierta: 0, vence: mm.vence };
  if (p && mm) Object.assign(p, { subyacente: mm.subyacente, objetivo: mm.objetivo, regla: mm.regla, tipo: mm.tipo, prob_modelo_lado: ld?.prob_modelo ?? null, desde: mm.desde, hasta: mm.hasta });
  if (!p) return json({ error: explorar ? 'Ese mercado ya no está abierto.' : 'Esa predicción no está en tu último ciclo: espera al próximo.' }, 404);
  if (p.vence && p.vence < Date.now()) return json({ error: 'Esta predicción ya venció: se liquida sola.' }, 409);
  // Si ya tienes un lado de este mercado, el análisis completo lo tiene en cuenta.
  const tuya = ambos && mm ? mias.find((x) => Math.floor(Number(String(x.coin).slice(1)) / 10) === mm.mercado) : null;
  const mercado: Json = { pregunta: p.pregunta, regla: p.regla || null, tipo_mercado: p.tipo || null,
    rango: p.tipo === 'rango' ? [p.desde, p.hasta] : undefined, horas_para_vencer: p.vence ? Math.round((p.vence - Date.now()) / 360_000) / 10 : null };
  if (ambos) {
    mercado.lados = (mm?.lados || []).map((l: Json) => ({ lado: l.nombre, precio: l.precio, prob_modelo_pct: l.prob_modelo ?? null, ventaja_pts: l.ventaja ?? null }));
    if (tuya) mercado.ya_tienes = { lado: tuya.lado_nombre, unidades: tuya.cantidad };
  } else Object.assign(mercado, { tu_lado: p.lado_nombre, unidades: p.cantidad, pago_si_aciertas: p.pago_si_acierta, tiene_posicion: (p.cantidad || 0) > 0,
    prob_modelo_estadistico_tu_lado_pct: p.prob_modelo_lado ?? null });
  // Volatilidad del subyacente en 1 h / 24 h / 48 h y el mercado global.
  if (mm?.mov) Object.assign(mercado, { movimiento_tipico_pct: mm.mov, regimen_volatilidad: mm.regimen, cambio_1h_pct: mm.cambio_1h_pct, cambio_48h_pct: mm.cambio_48h_pct,
    movimiento_esperado_hasta_vencer_pct: mm.sigma_plazo_pct });
  const global = todo.global || null;
  // Datos frescos y públicos: probabilidad actual, precio del subyacente y sus últimas 24 h.
  try {
    const [m1, m2] = await Promise.all([hlInfo({ type: 'allMids' }), hlInfo({ type: 'allMids', dex: 'xyz' }).catch(() => ({}))]);
    const mids: Json = { ...m1, ...m2 }, cod = coin.slice(1);
    if (ambos) (mm?.lados || []).forEach((l: Json, i: number) => { if (mids[l.coin] != null) mercado.lados[i].precio = Number(mids[l.coin]); });
    else {
      mercado.precio_tu_lado = Number(mids['#' + cod] ?? p.precio);
      mercado.prob_mercado_tu_lado_pct = Math.round(mercado.precio_tu_lado * 1000) / 10;
    }
    if (p.subyacente && mids[p.subyacente]) {
      const ahora = Number(mids[p.subyacente]);
      mercado.subyacente = p.subyacente; mercado.precio_actual = ahora; mercado.objetivo = p.objetivo;
      mercado.distancia_al_objetivo_pct = p.objetivo ? Math.round((ahora / p.objetivo - 1) * 10000) / 100 : null;
      const velas: Json[] = await hlInfo({ type: 'candleSnapshot', req: { coin: p.subyacente, interval: '1h', startTime: Date.now() - 7 * 24 * 3_600_000, endTime: Date.now() } });
      const todas = velas.map((v) => Number(v.c)).filter((x) => x > 0), cierres = todas.slice(-25);
      if (todas.length > 30) {
        mercado.cambio_7d_pct = Math.round((ahora / todas[0] - 1) * 10000) / 100;
        mercado.rango_7d = [Math.min(...todas), Math.max(...todas)];
      }
      if (cierres.length > 2) {
        const max = Math.max(...cierres), min = Math.min(...cierres);
        mercado.cambio_24h_pct = Math.round((ahora / cierres[0] - 1) * 10000) / 100;
        mercado.rango_24h = [min, max];
        mercado.rango_24h_pct = Math.round((max / min - 1) * 10000) / 100;
      }
    }
  } catch (e: any) {
    mercado.aviso = `Sin datos frescos de Hyperliquid (${String(e?.message || e).slice(0, 80)})`;
    if (!ambos) mercado.precio_tu_lado = p.precio;
  }
  const nombres: string[] = ambos ? (mm?.lados || []).map((l: Json) => String(l.nombre)) : [];
  const pide = ambos
    ? `El usuario mira este mercado completo y quiere saber si comprar un lado. Sugiere UNA acción: COMPRAR con "lado" = ${nombres.map((n) => `"${n}"`).join(' o ')}, o NO ENTRAR (lado null).${mercado.ya_tienes ? ' Ya tiene posición en este mercado: tenlo en cuenta.' : ''}`
    : mercado.tiene_posicion ? 'Sugiere UNA acción: MANTENER (esperar al vencimiento), VENDER (cerrar ahora al precio del mercado) o COMPRAR MÁS.' : 'El usuario aún NO tiene posición en este lado: sugiere COMPRAR (entrar en este lado) o NO ENTRAR.';
  const t0 = Date.now();
  const { datos: d, modelo } = await iaChat(env, [
    { role: 'system', content: 'Eres un analista prudente de mercados de predicción. Explicas a un principiante en español sencillo. No prometes resultados. Respondes SOLO JSON válido.' },
    { role: 'user', content: `Mercado de predicción de Hyperliquid (cada unidad paga 1 si acierta y 0 si no; el precio es la probabilidad que le da el mercado):\n${JSON.stringify(mercado)}\nMercado global ahora: ${global ? JSON.stringify({ resumen: global.resumen, tono: global.tono, turbulencia: global.turbulencia }) : 'sin datos'}\n` +
      `Lee la regla. Si depende de un precio, compara precio actual con objetivo, el tiempo que queda y cuánto se mueve: «movimiento_tipico_pct» es 1 desviación en 1 h, 24 h y 48 h; «movimiento_esperado_hasta_vencer_pct» es la que usa el modelo hasta el vencimiento; si el régimen es «turbulento», la última hora se mueve mucho más que lo normal. Ten en cuenta el mercado global (tono de riesgo, refugio, turbulencia) y la tendencia de 1 h / 24 h / 48 h. Si es un evento (economía, empresas), usa lo que sepas y di claramente si tu información puede estar desactualizada. Compara tu probabilidad con la del mercado. ${pide}\n` +
      `Formato: {"sugerencia":"${ambos ? 'COMPRAR|NO ENTRAR' : 'MANTENER|VENDER|COMPRAR MÁS|COMPRAR|NO ENTRAR'}",${ambos ? '"lado":"' + (nombres[0] || 'Sí') + '",' : ''}"confianza":0-100,"prob_estimada":0-100,"analisis":"2-4 frases","riesgos":["..."]}${ambos ? ' (prob_estimada = probabilidad de que el lado sugerido acierte; si NO ENTRAR, la de «' + (nombres[0] || 'Sí') + '»)' : ''}` },
  ]);
  let sug: string, ladoSug: number | null = null;
  if (ambos) {
    const i = nombres.findIndex((n) => n.toLowerCase() === String(d.lado || '').trim().toLowerCase() || (n === 'Sí' && /^s[ií]$|^yes$/i.test(String(d.lado || '').trim())));
    sug = String(d.sugerencia).toUpperCase() === 'COMPRAR' && i >= 0 ? 'COMPRAR' : 'NO ENTRAR';
    if (sug === 'COMPRAR') ladoSug = i;
  } else {
    const validas = mercado.tiene_posicion ? ['MANTENER', 'VENDER', 'COMPRAR MÁS'] : ['COMPRAR', 'NO ENTRAR'];
    sug = validas.includes(String(d.sugerencia).toUpperCase()) ? String(d.sugerencia).toUpperCase() : validas[0] === 'MANTENER' ? 'MANTENER' : 'NO ENTRAR';
  }
  const datos: Json = {
    coin: ladoSug != null ? `+${mm!.mercado * 10 + ladoSug}` : coin, modelo, mercado, sugerencia: ladoSug != null ? `COMPRAR ${nombres[ladoSug].toUpperCase()}` : sug,
    confianza: Math.max(0, Math.min(100, Number(d.confianza) || 0)),
    prob_estimada: Number.isFinite(Number(d.prob_estimada)) ? Math.max(0, Math.min(100, Number(d.prob_estimada))) : null,
    analisis: String(d.analisis || '').slice(0, 800),
    riesgos: (Array.isArray(d.riesgos) ? d.riesgos : []).slice(0, 4).map((x: unknown) => String(x).slice(0, 160)),
    global: global ? { resumen: global.resumen, tono: global.tono, turbulencia: global.turbulencia } : null,
    ts: Date.now(),
  };
  if (ambos) Object.assign(datos, { mercado_id: mm!.mercado, lado_sugerido: ladoSug, lado_nombre: ladoSug != null ? nombres[ladoSug] : null });
  prediccionMem.set(clave, { ts: Date.now(), datos });
  await bitacora(env, [{ ts: Date.now(), tipo: 'ia', ok: true, modelo, ms: Date.now() - t0, texto: `IA (predicción ${p.pregunta}${ambos ? '' : ' · ' + p.lado_nombre}) sugirió ${datos.sugerencia} con ${modelo} en ${((Date.now() - t0) / 1000).toFixed(1)} s` }]);
  return json(datos);
}

// «Pedir a la IA» en la pestaña 🎲: el usuario escribe qué quiere y la IA propone
// órdenes de predicción concretas. Quedan como «propuesta» (el usuario aprueba),
// con el mejor precio real del libro como límite.
function relevantes(lista: Json[], instruccion: string): Json[] {
  const t = instruccion.toLowerCase();
  const palabras = t.split(/[^a-z0-9áéíóúñ&]+/).filter((w) => w.length >= 3);
  const quiere = (re: RegExp) => re.test(t);
  const puntos = (m: Json) => {
    const txt = `${m.pregunta} ${m.nombre_sub || ''} ${m.subyacente || ''} ${m.categoria}`.toLowerCase();
    let p = palabras.reduce((a, w) => a + (txt.includes(w) ? 3 : 0), 0);
    if (quiere(/hoy|corto|ahora|rápid/) && m.plazo === 'hoy') p += 2;
    if (quiere(/mediano|largo|semana|mes|noviembre|octubre/) && m.plazo === 'mediano') p += 2;
    if (quiere(/bolsa|acci|índice|indice|oro|plata|petr|s&p|nasdaq/) && m.categoria === 'bolsa') p += 2;
    if (quiere(/fed|tasa|econom|empresa|ipo|bolsa de valores|anthropic|openai/) && m.categoria === 'economia') p += 2;
    if (quiere(/cripto|btc|eth|sol|hype|bitcoin/) && m.categoria === 'cripto') p += 2;
    if (quiere(/ventaja|oportunidad|mejor|barat/)) p += Math.max(0, ...m.lados.map((l: Json) => l.ventaja || 0)) / 5;
    return p;
  };
  return lista.filter((m) => !m.sin_ofertas).map((m) => ({ m, p: puntos(m) })).sort((a, b) => b.p - a.p || (a.m.vence || 9e15) - (b.m.vence || 9e15)).slice(0, 35).map((x) => x.m);
}

async function prediccionPedir(env: Env, c: Json): Promise<Response> {
  const instruccion = String(c.instruccion || '').trim().slice(0, 400);
  if (!instruccion) return json({ error: 'Escribe qué quieres que busque la IA' }, 400);
  const [config, estado, lista0] = await Promise.all([leerConfig(env), leer<Json>(env, 'estado', {}), listaMercados()]);
  const lista: Json[] = lista0.mercados || [];
  const mias: Json[] = estado.ultimo?.predicciones || [];
  const libre = estado.ultimo?.libre ?? null;
  const filas = relevantes(lista, instruccion).map((m) => ({ q: m.pregunta, cat: m.categoria === 'cripto' ? `cripto_${m.plazo}` : m.categoria, horas: m.horas,
    ahora: m.precio_actual ?? undefined, regla: m.regla || undefined, mov_1h_24h_48h_pct: m.mov ? [m.mov.h1, m.mov.h24, m.mov.h48] : undefined,
    cambio_1h_24h_pct: m.mov ? [m.cambio_1h_pct, m.cambio_24h_pct] : undefined, turbulento: m.regimen === 'turbulento' || undefined,
    lados: m.lados.map((l: Json) => ({ coin: l.coin, lado: l.nombre, precio: l.precio, modelo_pct: l.prob_modelo ?? undefined, ventaja: l.ventaja ?? undefined })) }));
  const pos = mias.map((p) => ({ coin: '#' + String(p.coin).slice(1), q: p.pregunta, lado: p.lado_nombre, unidades: p.cantidad, precio: p.precio,
    pagaste: p.costo ?? undefined, vender_solo_desde: p.min_venta ?? undefined }));
  const t0 = Date.now(), ahora = Date.now();
  let d: Json, modelo: string;
  try {
    ({ datos: d, modelo } = await iaChat(env, [
      { role: 'system', content: 'Preparas órdenes en mercados de predicción de Hyperliquid para un usuario principiante. Prudente: si nada convence, no propongas nada y explícalo. Nunca inventas mercados: usa solo los «coin» de la lista. Respondes SOLO JSON válido en español.' },
      { role: 'user', content: `El usuario pide: "${instruccion}"
Cada unidad paga 1 USDC si acierta y 0 si no; «precio» es el precio MEDIO (la compra real se paga al vendedor más barato, que puede ser bastante más caro; Kumo lo comprueba). «modelo_pct» es un modelo estadístico con la volatilidad de 1 h, 24 h y 48 h (no es certeza); «ventaja» = modelo − precio en puntos; «mov_1h_24h_48h_pct» = movimiento típico del subyacente.
Mercado global: ${lista0.global?.resumen || 'sin datos'} Tenlo en cuenta (con turbulencia sé más exigente).
USDC libres: ${libre ?? 'desconocido'}.${config.pred_pagar_con ? ` Si falta USDC, Kumo vende ${config.pred_pagar_con} para pagar (tiene ${(estado.ultimo?.activos || []).find((a: Json) => a.simbolo === config.pred_pagar_con)?.valor ?? '?'} USDC en ${config.pred_pagar_con}).` : ''} Por compra suele usar ${config.pred_monto} USDC (mínimo 10). Tope total en predicciones: ${config.pred_max_total} USDC.
Sus posiciones: ${JSON.stringify(pos)}
Mercados abiertos (los más relevantes a su pedido): ${JSON.stringify(filas)}
Propón como mucho 3 órdenes. COMPRAR lleva "monto_usdc"; VENDER (solo de sus posiciones) lleva "unidades". REGLA DEL USUARIO: nunca vender con pérdida; VENDER solo si el precio llega a «vender_solo_desde».
Formato: {"respuesta":"2-4 frases para el usuario","propuestas":[{"coin":"#90170","accion":"COMPRAR","monto_usdc":11,"unidades":null,"confianza":70,"razon":"máx. 25 palabras"}]}` },
    ]));
  } catch (e: any) {
    await bitacora(env, [{ ts: ahora, tipo: 'ia', ok: false, texto: `IA (pedir predicciones) falló: ${String(e.message || e).slice(0, 160)}`, ms: Date.now() - t0 }]);
    return json({ error: String(e.message || e) }, 502);
  }
  const porCoin: Json = {};
  for (const m of lista) m.lados.forEach((l: Json) => { porCoin[l.coin] = { m, l }; });
  const ordenes = await leerOrdenes(env), creadas: Json[] = [], descartadas: string[] = [];
  // Lo que ya tienes en predicciones + compras pendientes: las propuestas no pasan tu tope.
  let expuesto = mias.reduce((a, p) => a + (Number(p.valor) || 0), 0) + ordenes.filter((o) => PENDIENTE(o) && o.tipo === 'prediccion' && o.accion === 'COMPRAR')
    .reduce((a, o) => a + Number(o.unidades) * Number(o.limite), 0);
  for (const x of (Array.isArray(d.propuestas) ? d.propuestas : []).slice(0, 3)) {
    const coin = String(x.coin || '').trim(), accion = String(x.accion || '').toUpperCase();
    const ref = porCoin[coin], mia = mias.find((p) => '#' + String(p.coin).slice(1) === coin);
    if (!ref && !mia) { descartadas.push(`${coin || '?'}: ese mercado no existe o ya cerró`); continue; }
    if (!['COMPRAR', 'VENDER'].includes(accion)) { descartadas.push(`${coin}: acción inválida`); continue; }
    if (accion === 'VENDER' && !mia) { descartadas.push(`${coin}: no tienes esa posición para vender`); continue; }
    const etiqueta = ref ? `${ref.m.pregunta} · ${ref.l.nombre}` : `${mia!.pregunta} · ${mia!.lado_nombre}`;
    let libro: Json;
    try { libro = await hlInfo({ type: 'l2Book', coin }); } catch { descartadas.push(`${etiqueta}: no pude leer el libro`); continue; }
    const nivel = ((libro?.levels || [[], []])[accion === 'COMPRAR' ? 1 : 0] || [])[0];
    if (!nivel) { descartadas.push(`${etiqueta}: ahora no hay ${accion === 'COMPRAR' ? 'vendedores' : 'compradores'}`); continue; }
    const px = Number(nivel.px);
    // Vender: nunca por debajo de lo que pagaste (comisión incluida), por mínima que sea la pérdida.
    if (accion === 'VENDER') {
      if (mia!.min_venta == null) { descartadas.push(`${etiqueta}: no sé a cuánto la compraste (espera al próximo ciclo): no vendo para no arriesgar una pérdida`); continue; }
      if (px < mia!.min_venta) { descartadas.push(`${etiqueta}: el mejor comprador paga ${px} y la compraste a ${mia!.costo}: no vendo con pérdida (sin pérdida desde ${mia!.min_venta})`); continue; }
    }
    // El «precio» de la lista es el medio; se paga el del vendedor más barato. Si a ese
    // precio el modelo ya no ve ventaja, la compra es mala aunque la IA la vea barata.
    let aviso = '';
    if (accion === 'COMPRAR' && ref) {
      const pm = ref.l.prob_modelo != null ? ref.l.prob_modelo / 100 : null;
      if (pm != null && px >= pm - 0.02) { descartadas.push(`${etiqueta}: el vendedor más barato pide ${px} y el modelo le da ${ref.l.prob_modelo}%: a ese precio no hay ventaja`); continue; }
      if (ref.l.precio != null && px > ref.l.precio + 0.05) aviso = `Ojo: el precio medio es ${ref.l.precio} pero el vendedor más barato pide ${px} (libro con pocas ofertas).`;
    }
    const monto = Math.min(Math.max(10, Number(x.monto_usdc) || config.pred_monto || 11), config.pred_max_total || 30);
    const unidades = accion === 'COMPRAR' ? Math.max(1, Math.ceil(monto / px)) : Math.min(Math.floor(mia!.cantidad), Math.max(1, Math.floor(Number(x.unidades) || mia!.cantidad)));
    if (accion === 'COMPRAR' && expuesto + unidades * px > (config.pred_max_total || 30) + 0.5) {
      descartadas.push(`${etiqueta}: pasaría tu tope de ${config.pred_max_total} USDC en predicciones (ya usas ${expuesto.toFixed(2)})`); continue;
    }
    const v = limpiarPrediccion({}, { coin, accion, unidades, limite: px, etiqueta, razon: String(x.razon || ''), pagar_con: accion === 'COMPRAR' ? config.pred_pagar_con : '' }, config);
    if (!v.orden) { descartadas.push(`${etiqueta}: ${v.error}`); continue; }
    const conf = Math.max(0, Math.min(100, Number(x.confianza) || 0));
    const n: Json = { ...v.orden, id: nuevoId('iap'), ts: ahora, origen: 'ia', estado: 'propuesta', confianza: conf, ...(aviso ? { aviso } : {}),
      ia: { accion, confianza: conf, razon: String(x.razon || '').slice(0, 240) },
      vence: Math.min(ahora + 2 * 3600_000, ref?.m.vence || Infinity),
      historia: [{ ts: ahora, quien: 'ia', texto: `Propuesta al pedirle «${instruccion.slice(0, 80)}»: ${String(x.razon || '').slice(0, 160)}` }] };
    ordenes.unshift(n);
    creadas.push(n);
    if (accion === 'COMPRAR') expuesto += unidades * px;
  }
  if (creadas.length) await guardarOrdenes(env, ordenes);
  await bitacora(env, [{ ts: ahora, tipo: 'ia', ok: true, modelo, ms: Date.now() - t0,
    texto: `IA (pedir predicciones) respondió con ${modelo} en ${((Date.now() - t0) / 1000).toFixed(1)} s: ${creadas.length} propuesta${creadas.length === 1 ? '' : 's'}` },
    ...creadas.map((o) => ({ ts: ahora, tipo: 'orden', ok: true, texto: `IA propuso: ${textoOrden(o)} (espera tu aprobación)`, id: o.id }))]);
  return json({ ok: true, modelo, respuesta: String(d.respuesta || '').slice(0, 800), ordenes: creadas, descartadas });
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
    case 'GET /api/predicciones/mercados':
      return prediccionMercados().catch((e) => json({ error: `Hyperliquid no respondió: ${String(e?.message || e).slice(0, 120)}` }, 502));
    case 'GET /api/predicciones/grafica':
      return prediccionGrafica(url).catch((e) => json({ error: `Hyperliquid no respondió: ${String(e?.message || e).slice(0, 120)}` }, 502));
    case 'GET /api/predicciones/libro':
      return prediccionLibro(url).catch((e) => json({ error: `Hyperliquid no respondió: ${String(e?.message || e).slice(0, 120)}` }, 502));
    case 'POST /api/predicciones/pedir':
      return prediccionPedir(env, cuerpo).catch((e) => json({ error: `No pude preparar la propuesta: ${String(e?.message || e).slice(0, 120)}` }, 502));
    case 'POST /api/predicciones/analizar':
      return prediccionAnalizar(env, cuerpo).catch(async (e) => {
        await bitacora(env, [{ ts: Date.now(), tipo: 'ia', ok: false, texto: `IA (predicción) falló: ${String(e?.message || e).slice(0, 160)}` }]);
        return json({ error: String(e?.message || e) }, 502);
      });
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
        // El runner usa la misma lectura de mercados y el mismo modelo que la app.
        if (req.method === 'GET' && ruta === '/runner/predicciones') return json(await listaMercados());
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
