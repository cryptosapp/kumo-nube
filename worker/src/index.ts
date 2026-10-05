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
}

const VERSION = '1.0.0';
const GROQ_MODELOS = ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b', 'llama-3.3-70b-versatile'];

type Json = Record<string, any>;

const CONFIG_DEFECTO: Json = {
  modo: 'simulacion', pausado: false, quote: 'USDT', objetivo: { BTC: 40, ETH: 30 },
  monto_min: 5, monto_max: 25, rsi_compra: 35, rsi_venta: 68, banda: 3, ganancia_min: 1.5,
  stop_perdida: 0, nunca_vender_con_perdida: true, ia: 'veto', ia_conf_min: 65, max_ops_ciclo: 2,
  marco: '1h', saldo_simulado: 1000, radar_pedidos: [],
};

// Límites duros: la app no puede guardar valores fuera de estos rangos.
const RANGOS: Record<string, [number, number]> = {
  monto_min: [1, 1000], monto_max: [1, 5000], rsi_compra: [5, 60], rsi_venta: [40, 95], banda: [0, 20],
  ganancia_min: [0, 50], stop_perdida: [0, 50], ia_conf_min: [0, 100], max_ops_ciclo: [0, 10], saldo_simulado: [10, 1000000],
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

// ---------------------------------------------------------------- Runner
async function runnerReporte(env: Env, r: Json): Promise<Response> {
  const estado = await leer<Json>(env, 'estado', {});
  const ciclo = (estado.ciclo || 0) + 1;
  const ahora = Date.now();
  const historial: [number, number][] = estado.historial || [];
  if (r.ok && typeof r.total === 'number') historial.push([ahora, r.total]);
  const { radar, cartera_sim, costos, ...ultimo } = r;
  const nuevo: Json = {
    ciclo, actualizado: ahora, ultimo: { ...ultimo, ts: ahora },
    historial: historial.slice(-500),
    runner: { costos: costos ?? estado.runner?.costos ?? {}, cartera_sim: cartera_sim ?? estado.runner?.cartera_sim ?? null },
    radar: Array.isArray(radar) && radar.length ? radar : estado.radar || [],
    radar_ts: Array.isArray(radar) && radar.length ? ahora : estado.radar_ts || null,
  };
  await env.KUMO.put('estado', JSON.stringify(nuevo));

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
  return json({ config, estado_runner: estado.runner || {} });
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

async function iaChat(env: Env, mensajes: Json[]): Promise<{ datos: Json; modelo: string }> {
  const p = proveedorIA(env);
  if (!p) throw new Error('Tu nube no tiene IA configurada: elige un proveedor en Config → Cambiar claves');
  if (!p.modelos.length) throw new Error(`Falta IA_MODELOS para ${p.nombre}`);
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
  return json(datos);
}

// ---------------------------------------------------------------- API app
async function api(req: Request, env: Env, ruta: string, url: URL): Promise<Response> {
  const cuerpo: Json = req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Json) : {};
  switch (`${req.method} ${ruta}`) {
    case 'GET /api/estado': {
      const [config, estado] = await Promise.all([leerConfig(env), leer<Json>(env, 'estado', {})]);
      const { runner, radar, ...resto } = estado;
      return json({ version: VERSION, config, ...resto, costos: runner?.costos || {} });
    }
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
      return radarAnalizar(env, cuerpo).catch((e) => json({ error: String(e.message || e) }, 502));
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
        return json({ ok: true, nombre: 'kumo-bot', version: VERSION, ciclo: estado.ciclo || 0, ultimo_ciclo: estado.actualizado || null });
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
