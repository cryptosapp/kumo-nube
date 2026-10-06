"""Órdenes explícitas: las que propone la IA y las que crea o aprueba el usuario.

Viven en la nube (KV `ordenes`). Cada ciclo el runner recibe las aprobadas, las
ejecuta si se cumple su precio límite y devuelve qué pasó con cada una. También
convierte las señales fuertes de la IA en órdenes nuevas: «propuesta» (esperan
tu aprobación) o, en modo auto, ejecutadas en el mismo ciclo.
"""
import time

from exchanges import ErrorExchange

MAX_IA_CICLO = 2  # órdenes nuevas de la IA por ciclo


def _cantidad_venta(o, saldos):
    pct = max(1.0, min(100.0, float(o.get("pct") or 100)))
    return saldos.get(o["simbolo"], 0.0) * pct / 100


def ejecutar_prediccion(ex, o, simulado):
    """Órdenes en mercados de predicción de Hyperliquid (solo en dinero real)."""
    upd = {"id": o["id"]}
    if simulado:
        return {**upd, "estado": "error", "error": "Las predicciones solo se operan en dinero real"}, None
    if not hasattr(ex, "orden_prediccion"):
        return {**upd, "estado": "error", "error": "Tu exchange no tiene mercados de predicción"}, None
    try:
        cod, unidades, lim = int(str(o["coin"]).lstrip("#")), int(o["unidades"]), float(o["limite"])
    except (KeyError, TypeError, ValueError):
        return {**upd, "estado": "error", "error": "Orden de predicción incompleta"}, None
    compra = o["accion"] == "COMPRAR"
    try:
        r = ex.orden_prediccion(cod, compra, unidades, lim)
    except ErrorExchange as e:
        return {**upd, "estado": "error", "error": str(e)[:200]}, None
    if r["cantidad"] <= 0:
        mejor = r.get("mejor")
        if mejor and mejor.get("precio"):
            pista = (f" El más barato vendía a {mejor['precio']:g} ({mejor['unidades']:g} u.): reintenta con límite {mejor['precio']:g} o más." if compra
                     else f" El mejor comprador pagaba {mejor['precio']:g} ({mejor['unidades']:g} u.): reintenta con límite {mejor['precio']:g} o menos.")
        else:
            pista = f" No había {'vendedores' if compra else 'compradores'} en el libro: prueba más tarde."
        return {**upd, "estado": "error", "error": f"No se llenó: nadie {'vendía' if compra else 'compraba'} a {lim:g} o mejor. No se movió nada.{pista}", "mejor": mejor}, None
    etiqueta = o.get("etiqueta") or o["coin"]
    op = {"ts": int(time.time()), "simbolo": etiqueta, "accion": o["accion"], "cantidad": r["cantidad"], "precio": r["precio"],
          "total": round(r["total"], 2), "motivo": f"Predicción {etiqueta}", "simulada": False, "pnl": None, "orden": o["id"], "prediccion": o["coin"]}
    nota = f"Se llenaron {r['cantidad']:g} de {unidades}" if r["cantidad"] < unidades else None
    return {**upd, "estado": "ejecutada", "nota": nota, "resultado": {"precio": r["precio"], "cantidad": r["cantidad"], "total": round(r["total"], 2), "ts": int(time.time() * 1000)}}, op


def ejecutar(ex, o, saldos, precios, costos, cfg, simulado):
    """Intenta ejecutar una orden aprobada. Devuelve (actualizacion, operacion|None).
    Si aún no se cumple su condición, la orden sigue «aprobada» con una nota."""
    if o.get("tipo") == "prediccion":
        return ejecutar_prediccion(ex, o, simulado)
    sym, acc = o["simbolo"], o["accion"]
    upd = {"id": o["id"]}
    precio = precios.get(sym)
    if not precio:
        return {**upd, "estado": "error", "error": f"Sin precio para {sym} en tu exchange"}, None
    lim = o.get("limite")
    if lim and ((acc == "COMPRAR" and precio > lim) or (acc == "VENDER" and precio < lim)):
        return {**upd, "estado": "aprobada", "nota": f"Esperando precio {'≤' if acc == 'COMPRAR' else '≥'} {lim} (ahora {precio:.6g})"}, None
    minimo = float(cfg.get("monto_min") or 1)
    quote = cfg["quote"].upper()
    try:
        if acc == "COMPRAR":
            libre = saldos.get(quote, 0.0)
            monto = min(float(o.get("monto") or 0), libre)
            if monto < minimo:
                return {**upd, "estado": "aprobada", "nota": f"Saldo libre insuficiente: {libre:.2f} {quote} (mínimo {minimo:g})"}, None
            r = ex.comprar(sym, monto)
            from estrategia import registrar_compra
            registrar_compra(costos, sym, saldos.get(sym, 0.0), r["cantidad"], r["precio"])
        else:
            cant = _cantidad_venta(o, saldos)
            if cant * precio < minimo:
                return {**upd, "estado": "error", "error": f"No tienes suficiente {sym} para vender (mínimo {minimo:g} {quote})"}, None
            costo = (costos.get(sym) or {}).get("costo")
            if costo and precio < costo and cfg.get("nunca_vender_con_perdida", True) and not o.get("permitir_perdida"):
                return {**upd, "estado": "aprobada", "nota": f"Sería con pérdida ({(precio / costo - 1) * 100:.1f}%): espero o marca «vender aunque pierda»"}, None
            r = ex.vender(sym, cant)
    except ErrorExchange as e:
        return {**upd, "estado": "error", "error": str(e)[:200]}, None
    costo = (costos.get(sym) or {}).get("costo")
    op = {"ts": int(time.time()), "simbolo": sym, "accion": acc, "cantidad": r["cantidad"], "precio": r["precio"],
          "total": round(r["total"], 2), "motivo": f"Orden {'de la IA' if o.get('origen') == 'ia' else 'tuya'}: {o.get('razon') or ''}".strip(": "),
          "simulada": simulado, "pnl": round((r["precio"] / costo - 1) * 100, 2) if acc == "VENDER" and costo else None,
          "orden": o["id"], "ia": o.get("ia")}
    return {**upd, "estado": "ejecutada", "resultado": {"precio": r["precio"], "cantidad": r["cantidad"], "total": round(r["total"], 2), "ts": int(time.time() * 1000)}}, op


def de_la_ia(cfg, opiniones, saldos, precios, pendientes):
    """Señales COMPRAR/VENDER con confianza suficiente → órdenes nuevas (sin repetir
    las que ya están pendientes)."""
    if cfg.get("ia") == "off" or cfg.get("ordenes_ia", "proponer") == "off":
        return []
    umbral = float(cfg.get("ia_conf_min") or 65)
    quote = cfg["quote"].upper()
    mn, mx = float(cfg.get("monto_min") or 5), float(cfg.get("monto_max") or 25)
    ya = {(o["simbolo"], o["accion"]) for o in pendientes}
    nuevas = []
    for sym, o in sorted(opiniones.items(), key=lambda kv: -kv[1].get("confianza", 0)):
        acc, conf = o.get("accion"), float(o.get("confianza") or 0)
        if acc not in ("COMPRAR", "VENDER") or conf < umbral or (sym, acc) in ya or sym not in precios:
            continue
        orden = {"simbolo": sym, "accion": acc, "origen": "ia", "razon": o.get("razon", ""), "confianza": int(conf),
                 "ia": {"accion": acc, "confianza": int(conf), "razon": o.get("razon", "")}}
        if acc == "COMPRAR":
            if saldos.get(quote, 0.0) < mn:
                continue
            f = (conf - umbral) / max(1.0, 100 - umbral)
            orden["monto"] = round(mn + (mx - mn) * f, 2)
        else:
            if saldos.get(sym, 0.0) * precios[sym] < mn:
                continue
            orden["pct"] = 100 if conf >= 85 else 50
        nuevas.append(orden)
        if len(nuevas) >= MAX_IA_CICLO:
            break
    return nuevas
