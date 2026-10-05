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


def indicadores(ex, simbolos, marco):
    out = {}
    for s in simbolos:
        try:
            cierres = ex.velas(s, marco, 100)
        except ErrorExchange:
            continue
        if len(cierres) > 20:
            out[s] = {"rsi": E.rsi(cierres), "tendencia": E.tendencia(cierres), "cambio_marco": round((cierres[-1] / cierres[-25] - 1) * 100, 2) if len(cierres) > 25 else None}
    return out


def ciclo(remoto):
    cfg = {**E.CONFIG_DEFECTO, **(remoto.get("config") or {})}
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
    simbolos = sorted(set(cfg["objetivo"]) | set(tenidos))
    mercado = ex.precios(simbolos)
    precios = {s: d["precio"] for s, d in mercado.items()}
    sin_par = [s for s in tenidos if s not in precios]
    if sin_par:
        notas.append("Sin par " + quote + " para: " + ", ".join(sin_par[:8]))
    ind = indicadores(ex, [s for s in simbolos if s in precios], cfg["marco"])

    costos = E.actualizar_costos(estado.get("costos") or {}, saldos, precios)
    propuestas, notas_e = E.proponer(cfg, saldos, precios, ind, costos)
    notas += notas_e

    contexto = {"exchange": exchange_id, "quote": quote, "mercado": {s: {**mercado.get(s, {}), **ind.get(s, {})} for s in simbolos if s in precios}}
    opiniones, modelo, error_ia = ia.opinar(propuestas, contexto) if cfg["ia"] != "off" else ({}, None, None)
    if error_ia:
        errores.append(error_ia)
    aprobadas, bloqueadas = E.aplicar_ia(cfg, propuestas, opiniones)

    ejecutadas = []
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
                    r = ex.vender(sym, min(p["cantidad"], previa))
                costo = (costos.get(sym) or {}).get("costo")
                ejecutadas.append({"ts": int(time.time()), "simbolo": sym, "accion": p["accion"], "cantidad": r["cantidad"], "precio": r["precio"], "total": round(r["total"], 2), "motivo": p["motivo"], "simulada": simulado, "pnl": round((r["precio"] / costo - 1) * 100, 2) if p["accion"] == "VENDER" and costo else None, "ia": p.get("ia")})
                saldos = ex.saldos()
            except ErrorExchange as e:
                errores.append(f"{p['accion']} {sym}: {e}")

    precios_fin = dict(precios)
    total, activos = E.valorar(saldos, precios_fin, quote)
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
    }


def saldo_real(base, exchange_id, quote, saldos=None, notas=None):
    """Lo que de verdad hay en el exchange (solo lectura), también en simulación,
    para que el usuario compruebe que sus claves funcionan antes de pasar a real."""
    notas = notas if notas is not None else []
    try:
        saldos = saldos if saldos is not None else base.saldos()
    except ErrorExchange as e:
        return {"error": str(e)[:200]}
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


def main():
    url, token = url_nube(), os.getenv("KUMO_RUNNER_TOKEN", "")
    if not url or not token:
        print("Kumo aún no está instalado (falta kumo.json o KUMO_RUNNER_TOKEN). Nada que hacer.")
        return 0
    remoto = http("GET", url + "/runner/config", token)
    inicio = time.time()
    try:
        reporte = ciclo(remoto)
        reporte["ok"] = True
    except Exception as e:  # se reporta para que la app lo muestre
        traceback.print_exc()
        reporte = {"ok": False, "errores": [f"{type(e).__name__}: {str(e)[:300]}"]}
    reporte["duracion"] = round(time.time() - inicio, 1)
    resp = http("POST", url + "/runner/reporte", token, reporte)
    # Sin saldos ni claves en el log: solo un resumen.
    print(f"Ciclo {resp.get('ciclo')} · ok={reporte['ok']} · ops={len(reporte.get('ejecutadas') or [])} · errores={len(reporte.get('errores') or [])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
