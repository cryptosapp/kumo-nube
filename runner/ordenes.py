"""Órdenes explícitas: las que propone la IA y las que crea o aprueba el usuario.

Viven en la nube (KV `ordenes`). Cada ciclo el runner recibe las aprobadas, las
ejecuta si se cumple su precio límite y devuelve qué pasó con cada una. También
convierte las señales fuertes de la IA en órdenes nuevas: «propuesta» (esperan
tu aprobación) o, en modo auto, ejecutadas en el mismo ciclo.
"""
import time

from exchanges import ErrorExchange
from predicciones import precio_minimo_venta

MAX_IA_CICLO = 2  # órdenes nuevas de la IA por ciclo


def _cantidad_venta(o, saldos):
    pct = max(1.0, min(100.0, float(o.get("pct") or 100)))
    return saldos.get(o["simbolo"], 0.0) * pct / 100


MIN_SPOT_HL = 10.5  # Hyperliquid pide ~10 USDC por orden spot


def _pagar_con(ex, o, cfg, costo):
    """Los mercados de predicción se pagan en USDC. Si falta USDC y elegiste pagar
    con otra moneda (p. ej. HYPE), vende SOLO lo necesario (+2 %, mínimo ~10 USDC).
    Devuelve (operación_de_venta|None, nota|None, error|None)."""
    moneda = str(o.get("pagar_con") or (cfg or {}).get("pred_pagar_con") or "").upper()
    if not moneda or moneda == "USDC":
        return None, None, None
    saldos = ex.saldos()
    usdc = saldos.get("USDC", 0.0)
    if usdc >= costo:
        return None, None, None
    precio = (ex.precios([moneda]).get(moneda) or {}).get("precio")
    if not precio:
        return None, None, f"No hay precio de {moneda} para pagar con él"
    vender_usdc = max((costo - usdc) * 1.02 + 0.05, MIN_SPOT_HL)
    cant = vender_usdc / precio
    if saldos.get(moneda, 0.0) < cant:
        return None, None, (f"Faltan {costo - usdc:.2f} USDC y no tienes suficiente {moneda} para cubrirlos "
                            f"(necesito vender {cant:.4g}, tienes {saldos.get(moneda, 0.0):.4g}). No se movió nada.")
    try:
        r = ex.vender(moneda, cant)
    except ErrorExchange as e:
        return None, None, f"No pude vender {moneda} para pagar: {str(e)[:150]}. No se movió nada."
    op = {"ts": int(time.time()), "simbolo": moneda, "accion": "VENDER", "cantidad": r["cantidad"], "precio": r["precio"], "total": round(r["total"], 2),
          "motivo": f"Pagar predicción {o.get('etiqueta') or o.get('coin')}", "simulada": False, "pnl": None, "orden": o.get("id")}
    return op, f"Vendí {r['cantidad']:.4g} {moneda} ({r['total']:.2f} USDC) para pagarla", None


def ejecutar_prediccion(ex, o, simulado, cfg=None):
    """Órdenes en mercados de predicción de Hyperliquid (solo en dinero real).
    Si en la respuesta viene «_op_pago», es la venta de la moneda con la que se pagó."""
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
    if not compra and not o.get("permitir_perdida"):
        # Nunca vender con pérdida, por mínima que sea (con la comisión incluida). Una
        # orden IOC se llena a tu límite o mejor: basta con que el límite no pierda.
        costo = (getattr(ex, "entradas", None) or {}).get(f"+{cod}")
        minimo = precio_minimo_venta(costo)
        if minimo is None and o.get("origen") == "ia":
            return {**upd, "estado": "error", "error": "No vendí: no sé a cuánto compraste esta predicción y la IA no vende si puede haber pérdida."}, None
        if minimo is not None and lim < minimo:
            return {**upd, "estado": "error", "error": f"No vendí: la compraste a {costo:.4g} y vender a {lim:g} sería con pérdida (sin pérdida desde {minimo:g}, comisión incluida). "
                                                       "Si quieres vender igual, crea la venta marcando «vender aunque sea con pérdida».", "min_venta": minimo}, None
    op_pago, nota_pago = None, None
    if compra and (o.get("pagar_con") or (cfg or {}).get("pred_pagar_con")):
        # Antes de vender tu moneda, comprueba que la predicción se puede llenar a tu límite.
        mejor = ex.mejor_precio_prediccion(cod, True) if hasattr(ex, "mejor_precio_prediccion") else None
        if mejor is not None and mejor.get("precio") and mejor["precio"] > lim:
            return {**upd, "estado": "error", "error": f"No se llenaría: el más barato vende a {mejor['precio']:g} y tu límite es {lim:g}. No vendí nada.", "mejor": mejor}, None
        op_pago, nota_pago, err = _pagar_con(ex, o, cfg, unidades * lim)
        if err:
            return {**upd, "estado": "error", "error": err}, None
        if op_pago:
            upd["_op_pago"] = op_pago
    try:
        r = ex.orden_prediccion(cod, compra, unidades, lim)
    except ErrorExchange as e:
        return {**upd, "estado": "error", "error": str(e)[:200] + (f" ({nota_pago}: esos USDC quedan libres)" if nota_pago else "")}, None
    if r["cantidad"] <= 0:
        mejor = r.get("mejor")
        if mejor and mejor.get("precio"):
            pista = (f" El más barato vendía a {mejor['precio']:g} ({mejor['unidades']:g} u.): reintenta con límite {mejor['precio']:g} o más." if compra
                     else f" El mejor comprador pagaba {mejor['precio']:g} ({mejor['unidades']:g} u.): reintenta con límite {mejor['precio']:g} o menos.")
        else:
            pista = f" No había {'vendedores' if compra else 'compradores'} en el libro: prueba más tarde."
        movido = f" {nota_pago}: esos USDC quedan libres." if nota_pago else " No se movió nada."
        return {**upd, "estado": "error", "error": f"No se llenó: nadie {'vendía' if compra else 'compraba'} a {lim:g} o mejor.{movido}{pista}", "mejor": mejor}, None
    etiqueta = o.get("etiqueta") or o["coin"]
    op = {"ts": int(time.time()), "simbolo": etiqueta, "accion": o["accion"], "cantidad": r["cantidad"], "precio": r["precio"],
          "total": round(r["total"], 2), "motivo": f"Predicción {etiqueta}", "simulada": False, "pnl": None, "orden": o["id"], "prediccion": o["coin"]}
    nota = "; ".join(x for x in (f"Se llenaron {r['cantidad']:g} de {unidades}" if r["cantidad"] < unidades else None, nota_pago) if x) or None
    return {**upd, "estado": "ejecutada", "nota": nota, "resultado": {"precio": r["precio"], "cantidad": r["cantidad"], "total": round(r["total"], 2), "ts": int(time.time() * 1000)}}, op


def ejecutar(ex, o, saldos, precios, costos, cfg, simulado):
    """Intenta ejecutar una orden aprobada. Devuelve (actualizacion, operacion|None).
    Si aún no se cumple su condición, la orden sigue «aprobada» con una nota."""
    if o.get("tipo") == "prediccion":
        return ejecutar_prediccion(ex, o, simulado, cfg)
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
