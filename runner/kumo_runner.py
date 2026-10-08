#!/usr/bin/env python3
"""Un ciclo de Kumo Bot: lee la config de tu nube, decide, opera y reporta.

Variables de entorno (secretos de tu repositorio de GitHub):
  KUMO_RUNNER_TOKEN, IA_URL, IA_MODELOS, IA_CLAVE (o GROQ_API_KEY en nubes viejas),
  EXCHANGE_ID, EXCHANGE_API_KEY,
  EXCHANGE_SECRET, EXCHANGE_PASSWORD (opcional). La URL de la nube se lee de
  kumo.json (lo escribe el workflow de instalación) o de KUMO_URL.
"""
import json
import os
import sys
import time
import traceback
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))

import estrategia as E  # noqa: E402
import ia  # noqa: E402
import noticias as N  # noqa: E402
import ordenes as O  # noqa: E402
import predicciones as PR  # noqa: E402
import supervisor as SUP  # noqa: E402
from exchanges import ESTABLES, ErrorExchange, Simulador, crear_exchange, crear_publico  # noqa: E402

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def url_nube():
    if os.getenv("KUMO_URL"):
        return os.getenv("KUMO_URL").rstrip("/")
    try:
        with open(os.path.join(RAIZ, "kumo.json")) as f:
            return json.load(f)["url"].rstrip("/")
    except (OSError, KeyError, ValueError):
        return ""


def http(metodo, url, token, cuerpo=None):
    datos = json.dumps(cuerpo).encode() if cuerpo is not None else None
    req = urllib.request.Request(url, data=datos, method=metodo, headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": "kumo-runner/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode() or "{}")


MARCOS_GRAFICA = ("1h", "4h", "1d")
MAX_GRAFICAS = 8


def _sig(x):
    """Redondea a 6 cifras significativas para que las gráficas pesen poco en la nube."""
    return float(f"{x:.6g}")


def graficas(ex, simbolos, cache):
    """Velas de 1h, 4h y 1d de tus activos para las gráficas de la app.
    {SIM: {marco: {"t": [ms…], "c": [cierres…]}}}. Lo que se lee queda en `cache`
    para que los indicadores no vuelvan a pedir las mismas velas."""
    out = {}
    for s in simbolos[:MAX_GRAFICAS]:
        g = {}
        for m in MARCOS_GRAFICA:
            try:
                v = ex.velas_ts(s, m, 100)
            except (ErrorExchange, AttributeError):
                continue
            cache[(s, m)] = [c for _, c in v]
            if len(v) >= 2:
                g[m] = {"t": [t for t, _ in v], "c": [_sig(c) for _, c in v]}
        if g:
            out[s] = g
    return out


def indicadores(ex, simbolos, marco, cache=None):
    out = {}
    for s in simbolos:
        try:
            cierres = (cache or {}).get((s, marco)) or ex.velas(s, marco, 100)
        except ErrorExchange:
            continue
        if len(cierres) > 20:
            out[s] = {"rsi": E.rsi(cierres), "tendencia": E.tendencia(cierres), "cambio_marco": round((cierres[-1] / cierres[-25] - 1) * 100, 2) if len(cierres) > 25 else None}
    return out


def tomar_ordenes(ids):
    """Reserva en la nube las órdenes aprobadas antes de enviarlas («ejecutando»): si el
    ciclo se cae después de operar, no se repiten. Devuelve los ids tomados, o None si
    la nube no respondió (entonces no se ejecuta ninguna)."""
    if not ids:
        return set()
    url = url_nube()
    if not url:  # sin nube instalada (pruebas locales)
        return set(ids)
    try:
        return set(http("POST", url + "/runner/tomar", os.getenv("KUMO_RUNNER_TOKEN", ""), {"ids": list(ids)}).get("ids") or [])
    except Exception:
        return None


def ciclo(remoto, parcial=None):
    """`parcial` (dict) recibe lo ya operado a medida que avanza: si el ciclo falla a
    mitad, el reporte de error igual lleva las órdenes ejecutadas."""
    parcial = parcial if parcial is not None else {}
    cfg = {**E.CONFIG_DEFECTO, **(remoto.get("config") or {})}
    ia.PREFERIDO = remoto.get("ia_pref") or None
    # Proveedores de IA (con sus claves, ya descifradas) y consenso: los manda la nube.
    ia.configurar(remoto.get("ia_proveedores"), remoto.get("ia_consenso"))
    ia.LOG.clear()
    O.BLOQUEOS.clear()
    estado = remoto.get("estado_runner") or {}
    quote = cfg["quote"].upper()
    exchange_id = os.getenv("EXCHANGE_ID", "kraken").strip().lower() or "kraken"
    clave, secreto, pase = os.getenv("EXCHANGE_API_KEY", ""), os.getenv("EXCHANGE_SECRET", ""), os.getenv("EXCHANGE_PASSWORD", "")
    errores, notas = [], []

    if clave:
        base = crear_exchange(exchange_id, quote, clave, secreto, pase)
    else:
        base = crear_publico(exchange_id, quote)

    simulado = cfg["modo"] != "real"
    if not simulado and not clave:
        errores.append("Modo REAL sin claves del exchange: sigo en simulación")
        simulado = True

    if simulado:
        cartera = {k: float(v) for k, v in (estado.get("cartera_sim") or {}).items()}
        if not cartera:
            cartera = {quote: float(cfg["saldo_simulado"])}
            notas.append(f"Cartera simulada nueva con {cfg['saldo_simulado']:.0f} {quote} virtuales")
        ex = Simulador(base, cartera)
    else:
        ex = base

    saldos = ex.saldos()
    real = saldo_real(base, exchange_id, quote, saldos if not simulado else None, notas) if clave else None
    tenidos = [s for s in saldos if s != quote and s not in ESTABLES]
    pendientes = [o for o in (remoto.get("ordenes") or []) if o.get("estado") in ("propuesta", "aprobada")]
    simbolos = sorted(set(cfg["objetivo"]) | set(tenidos) | {o["simbolo"] for o in pendientes if o.get("tipo") != "prediccion"})
    mercado = ex.precios(simbolos)
    precios = {s: d["precio"] for s, d in mercado.items()}
    sin_par = [s for s in tenidos if s not in precios]
    if sin_par:
        notas.append("Sin par " + quote + " para: " + ", ".join(sin_par[:8]))
    # Gráficas primero: tus activos y luego el reparto objetivo y las órdenes pendientes.
    cache = {}
    orden_g = [s for s in tenidos if s in precios] + [s for s in simbolos if s in precios and s not in tenidos]
    try:
        graf = graficas(ex, orden_g, cache)
    except Exception as e:  # las gráficas nunca deben tumbar el ciclo
        graf = {}
        notas.append(f"Gráficas: {type(e).__name__}")
    ind = indicadores(ex, [s for s in simbolos if s in precios], cfg["marco"], cache)

    costos = E.actualizar_costos(estado.get("costos") or {}, saldos, precios)
    if not simulado:
        costos = E.costos_del_exchange(costos, getattr(base, "entradas", None))

    # Mercados de predicción con el modelo (de la nube), una sola lectura por ciclo.
    cache_pred = {}

    def mercados_pred():
        if "lista" not in cache_pred:
            try:
                d = http("GET", url_nube() + "/runner/predicciones", os.getenv("KUMO_RUNNER_TOKEN", ""))
                cache_pred.update(lista=d.get("mercados") or [], glob=d.get("global"))
            except Exception as e:
                cache_pred.update(lista=None, glob=None, error=type(e).__name__)
        return cache_pred["lista"]

    # 1) Órdenes que tú aprobaste (o creaste) y las de la IA ya aprobadas.
    ordenes_upd, ejecutadas = [], []
    parcial.update(ordenes_upd=ordenes_upd, ejecutadas=ejecutadas)
    # Solo se reservan las que se pueden intentar ya (las que esperan su precio siguen en cola).
    aprobadas_ya = [o for o in pendientes if o.get("estado") == "aprobada" and O.lista_para_intentar(o, precios)]
    if aprobadas_ya and not cfg["pausado"]:
        tomadas = tomar_ordenes([o["id"] for o in aprobadas_ya])
        if tomadas is None:
            errores.append("No pude reservar tus órdenes aprobadas en la nube: no ejecuto ninguna en este ciclo (para no repetirlas). Si sigue, actualiza la nube.")
            aprobadas_ya = []
        else:
            aprobadas_ya = [o for o in aprobadas_ya if o["id"] in tomadas]
    if not cfg["pausado"]:
        for o in aprobadas_ya:
            necesita = o.get("tipo") == "prediccion" and o.get("accion") == "COMPRAR" and o.get("origen") == "ia"
            upd, op = O.ejecutar(ex, o, saldos, precios, costos, cfg, simulado, mercados_pred() if necesita else None)
            if upd.get("_op_pago"):
                ejecutadas.append(upd.pop("_op_pago"))
                saldos = ex.saldos()
            ordenes_upd.append(upd)
            if op:
                ejecutadas.append(op)
                saldos = ex.saldos()
            elif upd.get("error"):
                errores.append(f"Orden {o['accion']} {o['simbolo']}: {upd['error']}")
    propuestas, notas_e = E.proponer(cfg, saldos, precios, ind, costos)
    notas += notas_e

    # Mercado global (de la nube, el mismo que ve la app) y titulares de 24 h para la IA.
    glob, titulares = None, []
    if cfg["ia"] != "off":
        mercados_pred()
        glob = cache_pred.get("glob")
        try:
            titulares = N.titulares()
        except Exception as e:  # las noticias nunca tumban el ciclo
            notas.append(f"Noticias: {type(e).__name__}")
    # Con turbulencia o aversión al riesgo se exige más confianza para comprar (+5).
    if glob and (glob.get("turbulencia") or glob.get("tono") == "bajista"):
        cfg = {**cfg, "ia_conf_min": float(cfg.get("ia_conf_min") or 65) + 5,
               "pred_conf_min": float(cfg.get("pred_conf_min") if cfg.get("pred_conf_min") is not None else cfg.get("ia_conf_min") or 65) + 5}
        notas.append(f"Mercado {'turbulento' if glob.get('turbulencia') else 'con aversión al riesgo'}: la IA necesita +5 de confianza para comprar")
    contexto = {"exchange": exchange_id, "quote": quote, "mercado": {s: {**mercado.get(s, {}), **ind.get(s, {})} for s in simbolos if s in precios}}
    if glob and glob.get("resumen"):
        contexto["mercado_global"] = glob["resumen"]
    if titulares:
        contexto["noticias_24h"] = titulares
    # La IA opina de las propuestas y además da su señal de las monedas del reparto
    # y las que tienes, para que la app muestre en cada ciclo qué está pensando.
    vigilar = [s for s in simbolos if s in precios][:8]
    opiniones, modelo, error_ia = ia.opinar(propuestas, contexto, vigilar) if cfg["ia"] != "off" else ({}, None, None)
    for s, o in opiniones.items():
        if s in precios:
            o["precio"] = precios[s]
    if error_ia:
        errores.append(error_ia)
    aprobadas, bloqueadas = E.aplicar_ia(cfg, propuestas, opiniones)

    # 2) Señales fuertes de la IA → órdenes nuevas (propuestas, o ejecutadas en modo auto).
    nuevas = O.de_la_ia(cfg, opiniones, saldos, precios, pendientes, notas)
    parcial["ordenes_nuevas"] = nuevas
    for i, o in enumerate(nuevas):
        o["id"] = f"ia{int(time.time())}{i}"
        o["estado"] = "propuesta"
        if cfg.get("ordenes_ia") == "auto" and not cfg["pausado"]:
            o["estado"] = "aprobada"
            upd, op = O.ejecutar(ex, o, saldos, precios, costos, cfg, simulado)
            o.update({k: v for k, v in upd.items() if k != "id"})
            if op:
                ejecutadas.append(op)
                saldos = ex.saldos()

    fallidas = {}
    if cfg["pausado"]:
        notas.append("Bot en pausa: no se ejecutan operaciones")
    else:
        for p in aprobadas[: int(cfg["max_ops_ciclo"])]:
            sym = p["simbolo"]
            try:
                previa = saldos.get(sym, 0.0)
                if p["accion"] == "COMPRAR":
                    r = ex.comprar(sym, p["monto"])
                    E.registrar_compra(costos, sym, previa, r["cantidad"], r["precio"])
                else:
                    # Nunca por debajo del costo + comisión (salvo tu stop de pérdida).
                    c = costos.get(sym) or {}
                    minimo = O.minimo_spot(c.get("costo")) if cfg["nunca_vender_con_perdida"] and not p.get("stop") else None
                    r = ex.vender(sym, min(p["cantidad"], previa), minimo)
                costo = (costos.get(sym) or {}).get("costo")
                ejecutadas.append({"ts": int(time.time()), "simbolo": sym, "accion": p["accion"], "cantidad": r["cantidad"], "precio": r["precio"], "total": round(r["total"], 2), "motivo": p["motivo"], "simulada": simulado, "pnl": round((r["precio"] / costo - 1) * 100, 2) if p["accion"] == "VENDER" and costo else None, "ia": p.get("ia")})
                saldos = ex.saldos()
            except ErrorExchange as e:
                errores.append(f"{p['accion']} {sym}: {e}")
                fallidas[(sym, p["accion"])] = str(e)[:160]

    # Mercados de predicción de Hyperliquid de tu cuenta real.
    def describir_preds():
        if not (clave and getattr(base, "predicciones", None)):
            return []
        try:
            return PR.describir(base.predicciones, base._info_hl, getattr(base, "entradas", None))
        except Exception as e:  # nunca deben tumbar el ciclo
            notas.append(f"Predicciones: {type(e).__name__}")
            return []
    preds = describir_preds()

    # 3) Beta: la IA revisa los mercados de predicción y tus posiciones en cada ciclo
    #    y propone órdenes (o las ejecuta si activaste «IA ejecuta sola»).
    pred_ia, revision = None, None
    pred_activo = not simulado and exchange_id == "hyperliquid" and cfg["ia"] != "off" and cfg.get("pred_ia", "proponer") != "off" and hasattr(base, "_info_hl")
    if pred_activo:
        libre_p = saldos.get("USDC", saldos.get(quote, 0.0))
        pagar = str(cfg.get("pred_pagar_con") or "").upper()
        if pagar and pagar != "USDC" and saldos.get(pagar):
            try:
                libre_p += saldos[pagar] * ((ex.precios([pagar]).get(pagar) or {}).get("precio") or 0) * 0.97
            except ErrorExchange:
                pass
        nuevas_p, pred_ia = predicciones_ia(base, ex, cfg, preds, pendientes, libre_p, notas, mercados_pred, cache_pred, titulares)
        for o in nuevas_p:
            if cfg.get("pred_ia") == "auto" and not cfg["pausado"]:
                # «Solo corto plazo»: lo que vence más lejos queda como propuesta para que tú decidas.
                if not o.get("regla") and not solo_corto_ok(cfg, o):
                    o["nota"] = f"Vence en {o.get('horas') or '?'} h: más allá de tu corto plazo ({cfg.get('pred_corto_horas') or 36} h), necesita tu aprobación"
                    continue
                o["estado"] = "aprobada"
                upd, op = O.ejecutar_prediccion(ex, o, simulado, cfg, mercados_pred())
                if upd.get("_op_pago"):
                    ejecutadas.append(upd.pop("_op_pago"))
                    saldos = ex.saldos()
                o.update({k: v for k, v in upd.items() if k != "id"})
                if op:
                    ejecutadas.append(op)
                    saldos = ex.saldos()
                    preds = describir_preds()
                elif upd.get("error"):
                    errores.append(f"IA predicción {o['accion']} {o['etiqueta']}: {upd['error']}")
        nuevas += nuevas_p
        # Supervisor IA: cada 6 h revisa cómo van y puede ajustar los parámetros (con límites).
        if SUP.toca(cfg, (remoto.get("estado_runner") or {}).get("super_ts")):
            try:
                revision = SUP.revisar(cfg, remoto.get("ordenes_pred") or [], preds, pred_ia, ia.chat_json)
            except Exception as e:  # nunca debe tumbar el ciclo
                notas.append(f"Supervisor IA: {type(e).__name__}")

    precios_fin = dict(precios)
    total, activos = E.valorar(saldos, precios_fin, quote)
    valor_preds = round(sum(p["valor"] or 0 for p in preds), 2)
    if not simulado and valor_preds:
        total = round(total + valor_preds, 2)
        for a in activos:
            a["peso"] = round(100 * a["valor"] / total, 2) if total else 0
    for a in activos:
        c = (costos.get(a["simbolo"]) or {}).get("costo")
        a["costo"] = c
        a["pnl"] = round((a["precio"] / c - 1) * 100, 2) if c else None
        a["objetivo"] = cfg["objetivo"].get(a["simbolo"], 0)
        a.update({k: v for k, v in (ind.get(a["simbolo"]) or {}).items()})

    radar = []
    try:
        top = ex.mercados_top(20)
        pedidos = [s.upper() for s in (cfg.get("radar_pedidos") or [])][:5]
        ind_r = indicadores(ex, [f["simbolo"] for f in top[:10]] + pedidos, "1d")
        vistos = set()
        for f in top + [{"simbolo": s, **(ex.precios([s]).get(s) or {})} for s in pedidos]:
            if f["simbolo"] in vistos or not f.get("precio"):
                continue
            vistos.add(f["simbolo"])
            radar.append({**f, **ind_r.get(f["simbolo"], {}), "en_cartera": f["simbolo"] in saldos, "pedido": f["simbolo"] in pedidos})
    except ErrorExchange as e:
        errores.append(f"Radar: {e}")

    return {
        "exchange": exchange_id, "modo": "simulacion" if simulado else "real", "quote": quote,
        "total": total, "libre": round(saldos.get(quote, 0.0), 2), "activos": activos,
        "costos": costos, "cartera_sim": ex.cartera if simulado else None,
        "propuestas": propuestas, "bloqueadas": bloqueadas, "ejecutadas": ejecutadas,
        "notas": notas[:20], "errores": errores[:10], "ia": {"modelo": modelo, "modo": cfg["ia"], "opiniones": opiniones},
        "radar": radar, "real": real,
        "ordenes_upd": ordenes_upd, "ordenes_nuevas": nuevas, "ia_log": ia.LOG[-20:],
        "ordenes": ordenes_ia(propuestas, bloqueadas, ejecutadas, fallidas, cfg["pausado"], opiniones),
        "graficas": graf,
        "predicciones": preds, "valor_predicciones": valor_preds, "pred_ia": pred_ia,
        "supervisor": revision,
        # Ventas que el candado frenó (P/L < +0.5 % o costo desconocido): se ven en la bitácora.
        "bloqueos_perdida": O.BLOQUEOS[-10:],
        "ia_consenso": {**ia.CONSENSO, "proveedores": [p["nombre"] for p in ia.proveedores()]},
    }


def solo_corto_ok(cfg, o):
    """¿Puede la IA ejecutar sola esta orden? Con «solo corto plazo» (por defecto) solo
    si el mercado vence dentro de `pred_corto_horas`."""
    if cfg.get("pred_auto_solo_corto", True) is False:
        return True
    h = o.get("horas")
    return h is not None and h <= float(cfg.get("pred_corto_horas") or 36)


def predicciones_ia(base, ex, cfg, preds, pendientes, libre, notas, mercados_pred=None, cache=None, titulares=None):
    """Pide a la IA sus órdenes de predicción. Los mercados (con el modelo) vienen de
    la nube; cada orden lleva como límite el mejor precio REAL del libro (no el
    precio medio, que casi nunca se llena). Devuelve (órdenes, resumen)."""
    try:
        if mercados_pred is not None:
            lista = mercados_pred()
            if lista is None:
                raise RuntimeError((cache or {}).get("error") or "sin mercados")
            glob = (cache or {}).get("glob")
        else:
            datos = http("GET", url_nube() + "/runner/predicciones", os.getenv("KUMO_RUNNER_TOKEN", ""))
            lista, glob = datos.get("mercados") or [], datos.get("global")
        nuevas, notas_p, resumen = PR.proponer(cfg, lista, preds, pendientes, libre, lambda c, p: ia.opinar_predicciones(c, p, glob, titulares),
                                               base.mejor_precio_prediccion, glob)
    except Exception as e:  # nunca debe tumbar el ciclo
        notas.append(f"IA predicciones: {type(e).__name__}")
        return [], None
    notas += notas_p
    listas = []
    for i, o in enumerate(nuevas):
        if o["accion"] == "VENDER":
            mejor = base.mejor_precio_prediccion(int(o["coin"][1:]), False)
            if not mejor or not mejor.get("precio"):
                notas.append(f"Predicciones: quería vender «{o['etiqueta']}» pero no hay compradores ahora")
                continue
            if not o.get("min_venta") or mejor["precio"] < o["min_venta"]:
                desde = f" (sin pérdida vendería desde {o['min_venta']:g})" if o.get("min_venta") else ""
                notas.append(f"Predicciones: quería vender «{o['etiqueta']}» pero el mejor comprador solo paga {mejor['precio']:g}{desde}: no vendo con pérdida")
                continue
            o["limite"] = mejor["precio"]
        o.update({"limite": float(f"{o['limite']:.5g}"), "id": f"iap{int(time.time())}{i}", "estado": "propuesta",
                  "caduca": int(time.time() * 1000) + 2 * 3_600_000})  # el precio cambia rápido: caduca en 2 h
        listas.append(o)
    return listas, resumen


def ordenes_ia(propuestas, bloqueadas, ejecutadas, fallidas, pausado, opiniones):
    """Qué pasó con cada orden propuesta y qué dijo la IA de ella."""
    hechas = {(o["simbolo"], o["accion"]): o for o in ejecutadas}
    frenadas = {(b["simbolo"], b["accion"]) for b in bloqueadas}
    out = []
    for p in propuestas:
        k = (p["simbolo"], p["accion"])
        if k in hechas:
            res, total = "ejecutada", hechas[k]["total"]
        elif k in frenadas:
            res, total = "frenada", None
        elif pausado:
            res, total = "pausa", None
        elif k in fallidas:
            res, total = "error", None
        else:
            res, total = "pendiente", None
        o = opiniones.get(p["simbolo"])
        out.append({"simbolo": p["simbolo"], "accion": p["accion"], "monto": p.get("monto"), "motivo": p.get("motivo"),
                    "resultado": res, "total": total, "error": fallidas.get(k), "ia": o})
    return out


def saldo_real(base, exchange_id, quote, saldos=None, notas=None):
    """Lo que de verdad hay en el exchange (solo lectura), también en simulación,
    para que el usuario compruebe que sus claves funcionan antes de pasar a real."""
    notas = notas if notas is not None else []
    try:
        saldos = saldos if saldos is not None else base.saldos()
    except ErrorExchange as e:
        return {"error": str(e)[:200]}
    if getattr(base, "aviso_cuenta", None):
        notas.append(base.aviso_cuenta)
    estables = sum(v for k, v in saldos.items() if k == quote or k in ESTABLES)
    out = {"libre": round(saldos.get(quote, 0.0), 2), "estables": round(estables, 2),
           "saldos": {k: round(v, 8) for k, v in sorted(saldos.items(), key=lambda kv: -kv[1])[:12]}}
    perps = getattr(base, "saldo_perps", lambda: 0.0)()
    if perps > 0:
        out["perps_usdc"] = round(perps, 2)
        if saldos.get(quote, 0.0) < 1:
            notas.append(f"Tienes {perps:.2f} USDC en Perps de Hyperliquid y Kumo opera en Spot: pásalos en Hyperliquid con Transfer → Perps a Spot.")
    if exchange_id == "hyperliquid" and not saldos and perps <= 0:
        notas.append("Hyperliquid no muestra saldo en esa dirección. Usa la dirección de tu cuenta principal (tu billetera), no la de la API wallet, y espera a que llegue el depósito.")
    return out


def enviar_reporte(url, token, reporte, intentos=4, espera=5):
    """El reporte dice qué órdenes ya se ejecutaron: se reintenta si la red falla."""
    for i in range(intentos):
        try:
            return http("POST", url + "/runner/reporte", token, reporte)
        except Exception:
            if i == intentos - 1:
                raise
            time.sleep(espera * (i + 1))


def main():
    url, token = url_nube(), os.getenv("KUMO_RUNNER_TOKEN", "")
    if not url or not token:
        print("Kumo aún no está instalado (falta kumo.json o KUMO_RUNNER_TOKEN). Nada que hacer.")
        return 0
    remoto = http("GET", url + "/runner/config", token)
    inicio = time.time()
    parcial = {}
    try:
        reporte = ciclo(remoto, parcial)
        reporte["ok"] = True
    except Exception as e:  # se reporta para que la app lo muestre
        traceback.print_exc()
        # Con qué exchange falló: si el usuario cambia de exchange, la app no
        # debe mostrar el error viejo como si fuera del nuevo.
        cfg = remoto.get("config") or {}
        reporte = {"ok": False, "exchange": os.getenv("EXCHANGE_ID", "kraken").strip().lower() or "kraken",
                   "modo": "real" if cfg.get("modo") == "real" else "simulacion",
                   "errores": [f"{type(e).__name__}: {str(e)[:300]}"]}
        # Lo que alcanzó a operar antes del fallo también se informa (si no, la nube no
        # sabría que esas órdenes ya se ejecutaron).
        for k in ("ordenes_upd", "ejecutadas", "ordenes_nuevas"):
            if parcial.get(k):
                reporte[k] = parcial[k]
    reporte["duracion"] = round(time.time() - inicio, 1)
    resp = enviar_reporte(url, token, reporte)
    # Sin saldos ni claves en el log: solo un resumen.
    print(f"Ciclo {resp.get('ciclo')} · ok={reporte['ok']} · ops={len(reporte.get('ejecutadas') or [])} · errores={len(reporte.get('errores') or [])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
